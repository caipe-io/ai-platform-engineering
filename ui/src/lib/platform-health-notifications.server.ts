import { randomUUID } from "node:crypto";

import {
  createInAppNotification,
  resolveInAppNotification,
} from "@/lib/in-app-notifications.server";
import { getCollection,isMongoDBConfigured } from "@/lib/mongodb";

type CapabilityStatus = "healthy" | "degraded" | "down" | "disabled";

export interface PlatformHealthCapabilitySnapshot {
  id: string;
  label: string;
  status: CapabilityStatus;
  required: boolean;
  detail: string;
}

interface PlatformHealthResponseSnapshot {
  checked_at?: string;
  capabilities?: PlatformHealthCapabilitySnapshot[];
}

interface PlatformHealthNotificationStateDocument {
  _id: string;
  component_id: string;
  component_label: string;
  current_status: CapabilityStatus;
  current_detail: string;
  issue_streak: number;
  recovery_streak: number;
  active_incident_id?: string;
  active_event_key?: string;
  incident_opened_at?: string;
  last_observed_at: string;
  last_resolved_at?: string;
  last_resolution_type?: "automatic_audit" | "human";
  updated_at: string;
}

interface PlatformHealthAuditDocument {
  _id: "global";
  next_audit_at: string;
  last_started_at: string;
  last_completed_at?: string;
  last_error?: string;
  updated_at: string;
}

const STATE_COLLECTION = "platform_health_notification_states";
const AUDIT_COLLECTION = "platform_health_notification_audits";
const PLATFORM_SOURCE_LABEL = "Platform";

function positiveEnvironmentInteger(name: string,fallback: number): number {
  const parsed = Number.parseInt(process.env[name] ?? "",10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function auditIntervalMs(): number {
  return positiveEnvironmentInteger("PLATFORM_HEALTH_NOTIFICATION_AUDIT_INTERVAL_MS",30_000);
}

function failureThreshold(): number {
  return positiveEnvironmentInteger("PLATFORM_HEALTH_NOTIFICATION_FAILURE_THRESHOLD",2);
}

function recoveryThreshold(): number {
  return positiveEnvironmentInteger("PLATFORM_HEALTH_NOTIFICATION_RECOVERY_THRESHOLD",2);
}

function isDuplicateKeyError(error: unknown): boolean {
  return typeof error === "object"
    && error !== null
    && "code" in error
    && (error as { code?: unknown }).code === 11000;
}

async function claimAudit(now: Date): Promise<boolean> {
  const collection = await getCollection<PlatformHealthAuditDocument>(AUDIT_COLLECTION);
  const nowIso = now.toISOString();
  const nextAuditAt = new Date(now.getTime() + auditIntervalMs()).toISOString();
  try {
    const result = await collection.updateOne(
      {
        _id: "global",
        next_audit_at: { $lte: nowIso },
      } as never,
      {
        $set: {
          next_audit_at: nextAuditAt,
          last_started_at: nowIso,
          updated_at: nowIso,
        },
        $unset: { last_error: "" },
      } as never,
      { upsert: true },
    );
    return result.modifiedCount > 0 || result.upsertedCount > 0;
  } catch (error) {
    if (isDuplicateKeyError(error)) return false;
    throw error;
  }
}

async function completeAudit(now: Date,error?: unknown): Promise<void> {
  const collection = await getCollection<PlatformHealthAuditDocument>(AUDIT_COLLECTION);
  const nowIso = now.toISOString();
  await collection.updateOne(
    { _id: "global" } as never,
    error
      ? {
          $set: {
            last_error: error instanceof Error ? error.message : "health audit failed",
            updated_at: nowIso,
          },
        } as never
      : {
          $set: {
            last_completed_at: nowIso,
            updated_at: nowIso,
          },
          $unset: { last_error: "" },
        } as never,
  );
}

function incidentSeverity(capability: PlatformHealthCapabilitySnapshot): "warning" | "error" {
  return capability.status === "down" && capability.required ? "error" : "warning";
}

function incidentTitle(capability: PlatformHealthCapabilitySnapshot): string {
  return `${capability.label} ${capability.status === "down" ? "is unavailable" : "is degraded"}`;
}

async function openIncident(
  capability: PlatformHealthCapabilitySnapshot,
  observedAt: string,
  state: PlatformHealthNotificationStateDocument | null,
  issueStreak: number,
): Promise<void> {
  const collection = await getCollection<PlatformHealthNotificationStateDocument>(STATE_COLLECTION);
  const incidentId = randomUUID();
  const eventKey = `platform-health:${capability.id}:${incidentId}:opened`;
  await collection.updateOne(
    { _id: capability.id } as never,
    {
      $set: {
        component_id: capability.id,
        component_label: capability.label,
        current_status: capability.status,
        current_detail: capability.detail,
        issue_streak: issueStreak,
        recovery_streak: 0,
        active_incident_id: incidentId,
        active_event_key: eventKey,
        incident_opened_at: observedAt,
        last_observed_at: observedAt,
        updated_at: observedAt,
      },
      $setOnInsert: {
        _id: capability.id,
      },
    } as never,
    { upsert: true },
  );
  await createInAppNotification({
    eventKey,
    recipientOrganizationAdmins: true,
    title: incidentTitle(capability),
    message: capability.detail,
    href: "/admin/operations/health",
    severity: incidentSeverity(capability),
    category: "platform_health",
    sourceLabel: PLATFORM_SOURCE_LABEL,
    correlationKey: `platform-health:${capability.id}`,
    lifecycleStatus: "active",
  });
  if (state?.active_event_key && state.active_event_key !== eventKey) {
    await resolveInAppNotification({
      eventKey: state.active_event_key,
      resolvedAt: observedAt,
      resolutionType: "automatic_audit",
      resolutionNote: "Superseded by a new platform health incident.",
    });
  }
}

async function closeIncident(input: {
  state: PlatformHealthNotificationStateDocument;
  observedAt: string;
  resolutionType: "automatic_audit" | "human";
  resolvedBySubject?: string;
  resolutionNote?: string;
  recoveredStatus?: CapabilityStatus;
}): Promise<void> {
  if (!input.state.active_event_key || !input.state.active_incident_id) return;
  const collection = await getCollection<PlatformHealthNotificationStateDocument>(STATE_COLLECTION);
  await resolveInAppNotification({
    eventKey: input.state.active_event_key,
    resolvedAt: input.observedAt,
    resolutionType: input.resolutionType,
    ...(input.resolvedBySubject
      ? { resolvedBySubject: input.resolvedBySubject }
      : {}),
    ...(input.resolutionNote ? { resolutionNote: input.resolutionNote } : {}),
  });

  const automatic = input.resolutionType === "automatic_audit";
  const monitoringDisabled = input.recoveredStatus === "disabled";
  const title = automatic
    ? monitoringDisabled
      ? `${input.state.component_label} monitoring disabled`
      : `${input.state.component_label} recovered`
    : `${input.state.component_label} notification resolved`;
  const message = automatic
    ? monitoringDisabled
      ? "A platform health audit confirmed that this capability is no longer enabled."
      : "A platform health audit confirmed that this capability returned to normal."
    : input.resolutionNote?.trim() || "Resolved by an authorized platform administrator.";
  await createInAppNotification({
    eventKey: `${input.state.active_event_key}:resolved`,
    recipientOrganizationAdmins: true,
    title,
    message,
    href: "/admin/operations/health",
    severity: automatic && !monitoringDisabled ? "success" : "info",
    category: "platform_health",
    sourceLabel: PLATFORM_SOURCE_LABEL,
    correlationKey: `platform-health:${input.state.component_id}`,
    lifecycleStatus: "resolved",
  });

  await collection.updateOne(
    { _id: input.state.component_id,active_incident_id: input.state.active_incident_id } as never,
    {
      $set: {
        issue_streak: 0,
        recovery_streak: 0,
        last_resolved_at: input.observedAt,
        last_resolution_type: input.resolutionType,
        updated_at: input.observedAt,
      },
      $unset: {
        active_incident_id: "",
        active_event_key: "",
        incident_opened_at: "",
      },
    } as never,
  );
}

async function reconcileCapability(
  capability: PlatformHealthCapabilitySnapshot,
  observedAt: string,
): Promise<void> {
  const collection = await getCollection<PlatformHealthNotificationStateDocument>(STATE_COLLECTION);
  const state = await collection.findOne({ _id: capability.id } as never);
  const issue = capability.status === "degraded" || capability.status === "down";
  const recoveryCandidate = capability.status === "healthy" || capability.status === "disabled";
  const issueStreak = issue ? (state?.issue_streak ?? 0) + 1 : 0;
  const recoveryStreak = recoveryCandidate && state?.active_incident_id
    ? (state.recovery_streak ?? 0) + 1
    : 0;

  if (issue && !state?.active_incident_id && issueStreak >= failureThreshold()) {
    await openIncident(capability,observedAt,state,issueStreak);
    return;
  }

  if (
    recoveryCandidate
    && state?.active_incident_id
    && recoveryStreak >= recoveryThreshold()
  ) {
    await closeIncident({
      state,
      observedAt,
      resolutionType: "automatic_audit",
      recoveredStatus: capability.status,
    });
  }

  await collection.updateOne(
    { _id: capability.id } as never,
    {
      $set: {
        component_id: capability.id,
        component_label: capability.label,
        current_status: capability.status,
        current_detail: capability.detail,
        issue_streak: issueStreak,
        recovery_streak: recoveryStreak,
        last_observed_at: observedAt,
        updated_at: observedAt,
      },
      $setOnInsert: { _id: capability.id },
    } as never,
    { upsert: true },
  );
}

export async function reconcilePlatformHealthNotifications(input: {
  checkedAt: string;
  capabilities: PlatformHealthCapabilitySnapshot[];
}): Promise<void> {
  for (const capability of input.capabilities) {
    if (!capability.id?.trim() || !capability.label?.trim()) continue;
    await reconcileCapability(capability,input.checkedAt);
  }
}

export async function resolvePlatformHealthNotification(input: {
  componentId: string;
  actorSubject: string;
  note?: string;
}): Promise<boolean> {
  const collection = await getCollection<PlatformHealthNotificationStateDocument>(STATE_COLLECTION);
  const state = await collection.findOne({
    _id: input.componentId,
    active_incident_id: { $exists: true },
  } as never);
  if (!state?.active_incident_id || !state.active_event_key) return false;
  await closeIncident({
    state,
    observedAt: new Date().toISOString(),
    resolutionType: "human",
    resolvedBySubject: input.actorSubject,
    ...(input.note?.trim() ? { resolutionNote: input.note.trim() } : {}),
  });
  return true;
}

export async function runPlatformHealthNotificationAudit(origin: string): Promise<void> {
  if (!isMongoDBConfigured) return;
  const startedAt = new Date();
  if (!await claimAudit(startedAt)) return;

  try {
    const healthUrl = new URL("/api/platform/health",origin);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(),7_000);
    let response: Response;
    try {
      response = await fetch(healthUrl,{
        method: "GET",
        cache: "no-store",
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeout);
    }
    const snapshot = (await response.json()) as PlatformHealthResponseSnapshot;
    if (!Array.isArray(snapshot.capabilities)) {
      throw new Error("Platform health response did not include capabilities");
    }
    await reconcilePlatformHealthNotifications({
      checkedAt: snapshot.checked_at ?? new Date().toISOString(),
      capabilities: snapshot.capabilities,
    });
    await completeAudit(new Date());
  } catch (error) {
    console.error("[platform-health-notifications] audit failed",error);
    await completeAudit(new Date(),error).catch(() => undefined);
  }
}
