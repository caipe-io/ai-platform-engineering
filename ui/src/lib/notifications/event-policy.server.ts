import { ApiError } from "@/lib/api-error";
import { getCollection } from "@/lib/mongodb";
import { getConfiguredAgenticApp, loadConfiguredAgenticApps } from "@/lib/agentic-apps/config";
import { hasOrganizationAdmin } from "@/lib/rbac/platform-admin";
import { NOTIFICATION_CHANNELS, type NotificationChannel, type NotificationTypeRegistration } from "./channels";
import { NOTIFICATION_EVENT_TYPES, NOTIFICATION_EVENT_CATALOG, isNotificationEventType } from "./taxonomy";
import { NOTIFICATION_EVENT_COPY } from "./copy";
import type { NotificationEventPolicy } from "./event-policy";
import type { User } from "@/types/mongodb";

interface PolicyDocument extends NotificationEventPolicy { _id: string; updatedAt: Date; updatedBy: string; }
interface Registration { _id: string; label: string; events?: NotificationTypeRegistration[]; operatorEvents?: NotificationTypeRegistration[]; }
const key = (source: string, event: string): string => JSON.stringify([source, event]);

/** Approval requests keep their existing workflow's reviewer/organization-admin audience. */
const APPROVAL_EVENT = "approval.requested";
export async function notificationEventPolicy(sourceId: string, eventType: string): Promise<NotificationEventPolicy> {
  const stored = await (await getCollection<PolicyDocument>("notification_event_policies")).findOne({ _id: key(sourceId, eventType) });
  let definition: NotificationTypeRegistration | undefined;
  let defaultEnabled = true;
  const locked = sourceId === "platform" && eventType === APPROVAL_EVENT;
  if (sourceId === "platform" && eventType === "notification.test") {
    definition = { id: eventType, label: "Delivery test", description: "A signed-in user tests delivery to their own account." };
  } else if (locked) {
    definition = { id: APPROVAL_EVENT, label: "Approval requested", description: "Slack/Webex publication and other approval requests. Only authorized reviewers and organization admins receive these; inbox delivery is required." };
  } else if (sourceId === "platform" && isNotificationEventType(eventType)) {
    definition = { id: eventType, ...NOTIFICATION_EVENT_COPY[eventType] };
    defaultEnabled = NOTIFICATION_EVENT_CATALOG[eventType].defaultEnabled;
  } else if (sourceId.startsWith("app:")) {
    const app = getConfiguredAgenticApp(sourceId.slice(4));
    if (!app?.installation.installed || !app.installation.enabled) throw new ApiError("Installed app required", 404);
    const registration = await (await getCollection<Registration>("notification_sources")).findOne({ _id: sourceId });
    definition = [...(registration?.events ?? []), ...(registration?.operatorEvents ?? [])].find((event) => event.id === eventType);
  }
  if (!definition && sourceId.startsWith("app:") && stored?.retired) definition = { id: eventType, label: stored.label, description: stored.description };
  if (!definition) throw new ApiError("Unknown notification event", 404);
  const base: NotificationEventPolicy = {
    sourceId, eventType, label: definition.label, description: definition.description ?? "",
    enabled: true, defaultEnabled,
    audience: locked ? "approval_reviewers" : sourceId === "platform" && eventType.startsWith("service.") ? "organization_admins" : "recipients",
    allowedChannels: locked ? ["in_app"] : [...NOTIFICATION_CHANNELS], revision: 0, locked,
  };
  if (!stored || locked) return base;
  // Publisher identity, event identifiers and built-in audience restrictions are never operator-editable.
  return { ...base, label: stored.label, description: stored.description, enabled: stored.enabled,
    defaultEnabled: stored.defaultEnabled, allowedChannels: stored.allowedChannels,
    audience: base.audience === "organization_admins" ? base.audience : stored.audience,
    revision: stored.revision, retired: stored.retired === true, deliveryGeneration: stored.deliveryGeneration ?? 0 };
}

export async function listNotificationEventPolicies(): Promise<Array<{ id: string; label: string; events: NotificationEventPolicy[] }>> {
  const ids = loadConfiguredAgenticApps().filter((app) => app.installation.installed && app.installation.enabled).map((app) => `app:${app.manifest.id}`);
  const sources = await (await getCollection<Registration>("notification_sources")).find({ _id: { $in: ids } }).limit(100).toArray();
  const retired = await (await getCollection<PolicyDocument>("notification_event_policies")).find({ sourceId: { $in: ids }, retired: true }).limit(3000).toArray();
  for (const policy of retired) {
    let source = sources.find((entry) => entry._id === policy.sourceId);
    if (!source) {
      const app = getConfiguredAgenticApp(policy.sourceId.slice(4));
      source = { _id: policy.sourceId, label: app!.manifest.displayName, events: [] }; sources.push(source);
    }
    if (![...(source.events ?? []), ...(source.operatorEvents ?? [])].some((event) => event.id === policy.eventType))
      source.events = [...(source.events ?? []), { id: policy.eventType, label: policy.label, description: policy.description }];
  }
  const platform = { _id: "platform", label: "CAIPE", events: [...NOTIFICATION_EVENT_TYPES, APPROVAL_EVENT, "notification.test"].map((id) => ({ id, label: id })) };
  const known = new Map(sources.map((source) => [source._id, source]));
  for (const app of loadConfiguredAgenticApps()) {
    if (app.installation.installed && app.installation.enabled && !known.has(`app:${app.manifest.id}`))
      known.set(`app:${app.manifest.id}`, { _id: `app:${app.manifest.id}`, label: app.manifest.displayName, events: [] });
  }
  return Promise.all([platform, ...known.values()].map(async (source) => ({ id: source._id, label: source.label,
    events: await Promise.all([...new Map([...(source.events ?? []), ...("operatorEvents" in source ? source.operatorEvents ?? [] : [])].map((event) => [event.id, event])).values()].map((event) => notificationEventPolicy(source._id, event.id))) })));
}

export async function updateNotificationEventPolicy(input: unknown, actor: string): Promise<NotificationEventPolicy> {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new ApiError("Policy object required", 400);
  const raw = input as Record<string, unknown>;
  if (Object.keys(raw).some((field) => !["sourceId", "eventType", "label", "description", "enabled", "defaultEnabled", "audience", "allowedChannels", "revision"].includes(field))) throw new ApiError("Unknown policy setting", 400);
  if (typeof raw.sourceId !== "string" || typeof raw.eventType !== "string") throw new ApiError("Registered source and event required", 400);
  const current = await notificationEventPolicy(raw.sourceId, raw.eventType);
  if (current.locked) throw new ApiError("Approval notification policy is managed by the approval workflow", 403);
  if (current.retired) throw new ApiError("Restore this event before editing its policy", 409);
  if (typeof raw.label !== "string" || !raw.label.trim() || raw.label.length > 100 || typeof raw.description !== "string" || raw.description.length > 300 || typeof raw.enabled !== "boolean" || typeof raw.defaultEnabled !== "boolean" || !Number.isSafeInteger(raw.revision) || Number(raw.revision) < 0) throw new ApiError("Invalid event policy", 400);
  if (typeof raw.audience !== "string" || !["recipients", "organization_admins"].includes(raw.audience) || (current.sourceId === "platform" && current.eventType.startsWith("service.") && raw.audience !== "organization_admins")) throw new ApiError("Cannot broaden this event audience", 400);
  if (!Array.isArray(raw.allowedChannels) || raw.allowedChannels.length < 1 || raw.allowedChannels.some((channel) => !NOTIFICATION_CHANNELS.includes(channel as NotificationChannel)) || new Set(raw.allowedChannels).size !== raw.allowedChannels.length) throw new ApiError("Select permitted delivery channels", 400);
  const { locked: _locked, ...next } = { ...current, label: raw.label.trim(), description: raw.description.trim(), enabled: raw.enabled,
    defaultEnabled: raw.defaultEnabled, audience: raw.audience as "recipients" | "organization_admins", allowedChannels: raw.allowedChannels as NotificationChannel[], revision: Number(raw.revision) + 1 };
  void _locked;
  return persistEventPolicy(current, { ...next, locked: false }, Number(raw.revision), actor);
}

async function persistEventPolicy(current: NotificationEventPolicy, next: NotificationEventPolicy, revision: number, actor: string): Promise<NotificationEventPolicy> {
  const collection = await getCollection<PolicyDocument>("notification_event_policies");
  if (revision === 0) {
    try { await collection.insertOne({ ...next, _id: key(current.sourceId, current.eventType), updatedAt: new Date(), updatedBy: actor }); }
    catch (error) { if ((error as { code?: number }).code === 11000) throw new ApiError("Policy changed; reload before saving", 409); throw error; }
  } else {
    const result = await collection.updateOne({ _id: key(current.sourceId, current.eventType), revision }, { $set: { ...next, updatedAt: new Date(), updatedBy: actor } });
    if (!result.matchedCount) throw new ApiError("Policy changed; reload before saving", 409);
  }
  return next;
}

/** Retirement is an operator-owned tombstone; publishers cannot undo it by registering again. */
export async function changeNotificationEventLifecycle(input: unknown, actor: string): Promise<NotificationEventPolicy> {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new ApiError("Lifecycle action required", 400);
  const raw = input as Record<string, unknown>;
  if (Object.keys(raw).some((field) => !["action", "sourceId", "eventType", "revision"].includes(field)) || !["retire", "restore"].includes(String(raw.action)) || typeof raw.action !== "string" || typeof raw.sourceId !== "string" || typeof raw.eventType !== "string" || !Number.isSafeInteger(raw.revision) || Number(raw.revision) < 0) throw new ApiError("Invalid lifecycle action", 400);
  if (!raw.sourceId.startsWith("app:")) throw new ApiError("Built-in platform events cannot be retired", 403);
  const current = await notificationEventPolicy(raw.sourceId, raw.eventType);
  if (current.revision !== raw.revision || Boolean(current.retired) === (raw.action === "retire")) throw new ApiError("Event changed; reload before continuing", 409);
  if (raw.action === "restore") {
    const registration = await (await getCollection<Registration>("notification_sources")).findOne({ _id: raw.sourceId });
    if (![...(registration?.events ?? []), ...(registration?.operatorEvents ?? [])].some((event) => event.id === raw.eventType)) throw new ApiError("Register this event again before restoring it", 409);
  }
  return persistEventPolicy(current, { ...current, retired: raw.action === "retire", deliveryGeneration: (current.deliveryGeneration ?? 0) + 1, revision: Number(raw.revision) + 1 }, Number(raw.revision), actor);
}

export async function notificationPolicyAllows(sourceId: string, eventType: string, subject: string, channel?: NotificationChannel, options: { history?: boolean; eventGeneration?: number } = {}): Promise<boolean> {
  const policy = await notificationEventPolicy(sourceId, eventType);
  if (!options.history && (policy.retired || (options.eventGeneration !== undefined && options.eventGeneration !== (policy.deliveryGeneration ?? 0)))) return false;
  if (!policy.enabled || (channel && !policy.allowedChannels.includes(channel))) return false;
  // Workflow-only events cannot be fabricated by generic publishers.
  if (policy.audience === "approval_reviewers") return false;
  if (policy.audience !== "organization_admins") return true;
  const user = await (await getCollection<User>("users")).findOne({ $or: [{ keycloak_sub: subject }, { "metadata.keycloak_sub": subject }] } as never);
  return Boolean(user && await hasOrganizationAdmin({ sub: subject, user: { email: user.email } }));
}

/** Shared rows retain their original recipient checks; policy can only narrow visibility. */
export async function notificationPolicyInboxFilter(subject: string, organizationAdmin: boolean): Promise<Record<string, unknown>> {
  const sources = await listNotificationEventPolicies();
  const denied = sources.flatMap((source) => source.events.filter((event) => !event.locked && (!event.enabled || !event.allowedChannels.includes("in_app") || (event.audience === "organization_admins" && !organizationAdmin))).map((event) => source.id === "platform" ? { $or: [{ source_id: "platform" }, { source_id: { $exists: false } }], event_type: event.eventType } : { source_id: source.id, event_type: event.eventType }));
  void subject;
  return denied.length ? { $nor: denied } : {};
}
