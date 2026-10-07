import { ApiError } from "@/lib/api-middleware";
import { authOptions,isBootstrapAdmin } from "@/lib/auth-config";
import { getConfig } from "@/lib/config";
import { getCollection } from "@/lib/mongodb";
import { parseAdminSimulation } from "@/lib/rbac/admin-simulator";
import {
adminSurfaceObject,
BASELINE_ADMIN_SURFACES,
baselineBootstrapTuples,
getBaselineFgaProfile,
} from "@/lib/rbac/baseline-access";
import { batchCheckOpenFgaTuples,checkOpenFgaTuple,listOpenFgaObjects,writeOpenFgaTuples } from "@/lib/rbac/openfga";
import type { OpenFgaTupleKey } from "@/lib/rbac/openfga";
import { openFgaResourceObject } from "@/lib/rbac/openfga-resource-ids";
import { organizationObjectId } from "@/lib/rbac/organization";
import { getRealmUserByIdOrNull } from "@/lib/rbac/keycloak-admin";
import { slackChannelSubjectId } from "@/lib/rbac/slack-channel-grant-store";
import {
createJsonResponseCacheStore,
envTtlMs,
withJsonResponseCache,
} from "@/lib/server-response-cache";
import type {
  AdminTabGatesMap,
  AdminTabKey,
  IntegrationPanelModesMap,
} from "@/lib/rbac/types";
import { webexSpaceSubjectId } from "@/lib/rbac/webex-space-grant-store";
import { getServerSession } from "next-auth";
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";

const ALL_TABS: AdminTabKey[] = [
  "users",
  "teams",
  "roles",
  "identity_group_sync",
  "slack",
  "webex",
  "skills",
  "feedback",
  "stats",
  "metrics",
  "health",
  "credentials",
  "audit_logs",
  "dynamic_agent_conversations",
  "action_audit",
  "openfga",
  "migrations",
  "approvals",
  "service_accounts",
];

const DYNAMIC_AGENT_CONVERSATIONS_AUDIT_ID = "dynamic_agent_conversations";
const adminTabGatesCache = createJsonResponseCacheStore();

function decodeJwtPayload(token: string): Record<string, unknown> {
  try {
    const parts = token.split(".");
    if (parts.length < 2) return {};
    const b64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const json = Buffer.from(b64, "base64").toString("utf8");
    return JSON.parse(json) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function getSessionSubject(session: {
  accessToken?: string;
  sub?: string;
}): string | undefined {
  if (session.sub) return session.sub;
  const payload = session.accessToken ? decodeJwtPayload(session.accessToken) : {};
  return typeof payload.sub === "string" ? payload.sub : undefined;
}

async function hasOrganizationAdmin(session: {
  accessToken?: string;
  sub?: string;
  user?: { email?: string | null };
}): Promise<boolean> {
  const email = session.user?.email ?? "";
  if (isBootstrapAdmin(email)) return true;

  const subject = getSessionSubject(session);
  if (!subject) return false;

  try {
    const decision = await checkOpenFgaTuple({
      user: `user:${subject}`,
      relation: "can_manage",
      object: organizationObjectId(),
    });
    return decision.allowed;
  } catch {
    return false;
  }
}

/**
 * Feature-flag conjunctions: even if RBAC allows a tab, the corresponding
 * feature flag must also be enabled for these tabs.
 */
const TAB_FEATURE_FLAGS: Partial<Record<AdminTabKey, string>> = {
  feedback: "feedbackEnabled",
  audit_logs: "auditLogsEnabled",
  action_audit: "actionAuditEnabled",
  credentials: "credentialsEnabled",
};

const BASELINE_TABS = new Set<AdminTabKey>(BASELINE_ADMIN_SURFACES);

const INTEGRATION_PANEL_TABS = ["slack", "webex"] as const satisfies readonly AdminTabKey[];

function isIntegrationPanelTab(
  tab: AdminTabKey,
): tab is (typeof INTEGRATION_PANEL_TABS)[number] {
  return (INTEGRATION_PANEL_TABS as readonly AdminTabKey[]).includes(tab);
}

function integrationPanelModesFromSurfaceManage(
  gates: AdminTabGatesMap,
  hasSurfaceManage: (tab: (typeof INTEGRATION_PANEL_TABS)[number]) => boolean,
): IntegrationPanelModesMap {
  const modes: IntegrationPanelModesMap = {};
  for (const tab of INTEGRATION_PANEL_TABS) {
    if (!gates[tab]) continue;
    modes[tab] = hasSurfaceManage(tab) ? "full" : "self_service";
  }
  return modes;
}

const TAB_ADMIN_SURFACES: Partial<Record<AdminTabKey, string>> = {
  roles: "roles",
  identity_group_sync: "identity_group_sync",
  slack: "slack",
  webex: "webex",
  feedback: "feedback",
  stats: "stats",
  metrics: "metrics",
  audit_logs: "audit_logs",
  action_audit: "action_audit",
  openfga: "openfga",
  migrations: "migrations",
};

async function checkTupleAllowed(tuple: { user: string; relation: string; object: string }): Promise<boolean> {
  try {
    const result = await checkOpenFgaTuple(tuple);
    return result.allowed;
  } catch {
    return false;
  }
}

async function hasAdminSurfaceManage(openfgaUser: string, tab: AdminTabKey): Promise<boolean> {
  const surface = TAB_ADMIN_SURFACES[tab];
  if (!surface) return false;
  return checkTupleAllowed({
    user: openfgaUser,
    relation: "can_manage",
    object: adminSurfaceObject(surface),
  });
}

async function hasDynamicAgentConversationsRead(openfgaUser: string): Promise<boolean> {
  // assisted-by Codex Codex-sonnet-4-6
  // Mirrors /api/dynamic-agents/conversations, which gates this surface on
  // audit_log:dynamic_agent_conversations#can_read with org-admin bypass.
  return checkTupleAllowed({
    user: openfgaUser,
    relation: "can_read",
    object: openFgaResourceObject("audit_log", DYNAMIC_AGENT_CONVERSATIONS_AUDIT_ID),
  });
}

async function hasBaselineAdminSurfaceRead(openfgaUser: string, tab: AdminTabKey): Promise<boolean> {
  if (!BASELINE_TABS.has(tab)) return false;
  return checkTupleAllowed({
    user: openfgaUser,
    relation: "can_read",
    object: adminSurfaceObject(tab),
  });
}

interface SlackChannelMapping {
  slack_workspace_id?: string;
  slack_channel_id?: string;
  active?: boolean;
}

interface WebexSpaceMapping {
  webex_workspace_id?: string;
  webex_space_id?: string;
  active?: boolean;
}

// Skip the baseline-repair write RPC for users seen within the last 60 s.
// The Map is per-process (Next.js server instance); in multi-replica K8s each
// replica maintains its own cache, which is fine — the repair is idempotent.
const _baselineRepairSeen = new Map<string, number>();
const BASELINE_REPAIR_TTL_MS = 60_000;

async function repairCurrentUserBaseline(subject: string, isAdmin: boolean): Promise<void> {
  if (process.env.NODE_ENV !== "test") {
    const now = Date.now();
    const last = _baselineRepairSeen.get(subject);
    if (last !== undefined && now - last < BASELINE_REPAIR_TTL_MS) return;
    _baselineRepairSeen.set(subject, now);
  }
  try {
    const profile = await getBaselineFgaProfile();
    await writeOpenFgaTuples({
      writes: baselineBootstrapTuples(subject, isAdmin, profile),
      deletes: [],
    });
  } catch {
    // Evict the cache entry so the next request retries.
    _baselineRepairSeen.delete(subject);
  }
}

async function hasAccessibleSlackChannel(openfgaUser: string): Promise<boolean> {
  try {
    const mappings = await getCollection<SlackChannelMapping>("channel_team_mappings");
    const rows = await mappings
      .find({ active: { $ne: false } } as never)
      .limit(500)
      .toArray();

    // Batch all (can_read, can_manage) pairs in a single OpenFGA round-trip.
    // Team-shared channels show the tab for readers too; row controls still
    // depend on can_manage.
    const objects = rows
      .filter((r) => r.slack_channel_id)
      .map((r) => `slack_channel:${slackChannelSubjectId(r.slack_workspace_id ?? "", r.slack_channel_id!)}`);
    if (objects.length === 0) return false;
    const tuples = objects.flatMap((object) => [
      { user: openfgaUser, relation: "can_read" as const, object },
      { user: openfgaUser, relation: "can_manage" as const, object },
    ]);
    const results = await batchCheckOpenFgaTuples(tuples);
    return results.some(Boolean);
  } catch {
    return false;
  }
}

async function hasAccessibleWebexSpace(openfgaUser: string): Promise<boolean> {
  try {
    const mappings = await getCollection<WebexSpaceMapping>("webex_space_team_mappings");
    const rows = await mappings
      .find({ active: { $ne: false } } as never)
      .limit(500)
      .toArray();

    const objects = rows
      .filter((r) => r.webex_space_id)
      .map((r) => `webex_space:${webexSpaceSubjectId(r.webex_workspace_id ?? "", r.webex_space_id!)}`);
    if (objects.length === 0) return false;
    const tuples = objects.flatMap((object) => [
      { user: openfgaUser, relation: "can_read" as const, object },
      { user: openfgaUser, relation: "can_manage" as const, object },
    ]);
    const results = await batchCheckOpenFgaTuples(tuples);
    return results.some(Boolean);
  } catch {
    return false;
  }
}

/**
 * The Service Accounts tab is self-service for ANY team member (not admin-only)
 * — see research.md R-7 (T001). Visibility keys on "belongs to ≥1 team", mirroring
 * the non-admin, resource-scoped Slack/Webex gates. The real control is per-action
 * owning-team authorization on every BFF route. Fail-closed on error.
 */
async function isMemberOfAnyTeam(openfgaUser: string): Promise<boolean> {
  try {
    const result = await listOpenFgaObjects({
      user: openfgaUser,
      relation: "member",
      type: "team",
    });
    return result.objects.length > 0;
  } catch {
    return false;
  }
}

async function hasResourceScopedIntegrationAccess(openfgaUser: string, tab: AdminTabKey): Promise<boolean> {
  if (tab === "slack") return hasAccessibleSlackChannel(openfgaUser);
  if (tab === "webex") return hasAccessibleWebexSpace(openfgaUser);
  if (tab === "service_accounts") return isMemberOfAnyTeam(openfgaUser);
  return false;
}

/**
 * GET /api/rbac/admin-tab-gates
 *
 * Returns a map of { tab_key: boolean } indicating which admin tabs the
 * current user may see. This endpoint intentionally does not read CEL policy
 * storage; tab visibility follows the organization-level OpenFGA admin
 * relationship plus the bootstrap-admin break-glass fallback.
 */
export async function GET(request?: NextRequest) {
  if (!request) {
    return getAdminTabGates();
  }
  return withJsonResponseCache(request, adminTabGatesCache, () => getAdminTabGates(request), {
    ttlMs: envTtlMs("ADMIN_TAB_GATES_CACHE_TTL_MS", 10_000),
    cacheableStatus: (status) => status === 200 || status === 401 || status === 403,
    maxEntries: 512,
  });
}

async function getAdminTabGates(request?: NextRequest) {
  const session = (await getServerSession(authOptions)) as {
    accessToken?: string;
    sub?: string;
    role?: string;
    user?: { email?: string | null };
  } | null;

  if (!session?.user?.email) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const isAdmin = await hasOrganizationAdmin(session);
  let simulation;
  try {
    const searchParams = request ? new URL(request.url).searchParams : new URLSearchParams();
    simulation = parseAdminSimulation(searchParams);
  } catch (error) {
    if (error instanceof ApiError) {
      return NextResponse.json({ error: error.message }, { status: error.statusCode });
    }
    throw error;
  }

  if (simulation.active && !isAdmin) {
    return NextResponse.json(
      { error: "Simulation requires organization admin access" },
      { status: 403 }
    );
  }

  // A simulation URL only contains the stable Keycloak subject. Resolve the
  // canonical identity here so the client can render a human name after a
  // refresh instead of falling back to the opaque UUID. A raw OpenFGA id is
  // still supported; failed lookups intentionally keep the id fallback.
  let simulatedBaselineObjects = new Set<string>();
  if (simulation.subject?.type === "user") {
    const simulatedSubject = simulation.subject;
    const [profile, realmUser] = await Promise.all([
      getBaselineFgaProfile(),
      getRealmUserByIdOrNull(simulatedSubject.id).catch((error) => {
        console.warn("[AdminTabGates] Failed to resolve simulated user identity", {
          userId: simulatedSubject.id,
          error,
        });
        return null;
      }),
    ]);
    simulatedBaselineObjects = new Set(
      baselineBootstrapTuples(simulatedSubject.id, false, profile)
        .filter((tuple) => tuple.relation === "reader")
        .map((tuple) => tuple.object),
    );

    if (realmUser) {
      const firstName = String(realmUser.firstName ?? "").trim();
      const lastName = String(realmUser.lastName ?? "").trim();
      const email = String(realmUser.email ?? "").trim();
      const username = String(realmUser.username ?? "").trim();
      const displayName = [firstName, lastName].filter(Boolean).join(" ") || username || email;
      simulation = {
        ...simulation,
        subject: {
          ...simulatedSubject,
          ...(displayName ? { display_name: displayName } : {}),
          ...(email ? { email } : {}),
        },
      };
    }
  }

  const simulatedUser = simulation.subject?.openfga_user;
  const currentSubject = getSessionSubject(session);
  const currentUser = currentSubject ? `user:${currentSubject}` : undefined;
  const bootstrapAdmin = isBootstrapAdmin(session.user.email ?? "");
  const simulatedOrganizationAdmin = simulatedUser
    ? await checkTupleAllowed({
        user: simulatedUser,
        relation: "can_manage",
        object: organizationObjectId(),
      })
    : false;

  if (simulation.subject) {
    simulation = {
      ...simulation,
      subject: {
        ...simulation.subject,
        organization_admin: simulatedOrganizationAdmin,
      },
    };
  }

  // ── Common (non-simulated) path: resolve all primary checks in one batch ──
  // Simulated-user path falls through to the per-check evaluateTab() below.
  if (!simulatedUser && currentUser) {
    // Build the batch: one entry per tab that issues a single /check call.
    // Tabs without an FGA primary check (credentials → isAdmin,
    // service_accounts → listOpenFgaObjects) are excluded from the batch and
    // resolved separately below.
    type BatchEntry = {
      tab: AdminTabKey;
      purpose: "primary" | "integration_manage";
      tuple: OpenFgaTupleKey;
    };
    const batchEntries: BatchEntry[] = [];

    for (const tab of ALL_TABS) {
      if (tab === "credentials" || tab === "service_accounts") continue;
      if (tab === "approvals") {
        // Everyone can review the status of their own requests. The queue API
        // separately decides whether the viewer may see and act on other
        // people's requests.
        continue;
      }
      if (tab === "dynamic_agent_conversations") {
        if (!isAdmin) {
          batchEntries.push({
            tab,
            purpose: "primary",
            tuple: {
              user: currentUser,
              relation: "can_read",
              object: openFgaResourceObject("audit_log", DYNAMIC_AGENT_CONVERSATIONS_AUDIT_ID),
            },
          });
        }
        continue;
      }
      if (BASELINE_TABS.has(tab)) {
        batchEntries.push({
          tab,
          purpose: "primary",
          tuple: { user: currentUser, relation: "can_read", object: adminSurfaceObject(tab) },
        });
      } else if (!bootstrapAdmin && TAB_ADMIN_SURFACES[tab]) {
        batchEntries.push({
          tab,
          purpose: "primary",
          tuple: { user: currentUser, relation: "can_manage", object: adminSurfaceObject(tab) },
        });
      }

      // Slack and Webex are baseline read surfaces, but their panels still
      // need a separate manage decision to distinguish configured-only mode
      // from the full onboarding and advanced controls.
      if (!bootstrapAdmin && isIntegrationPanelTab(tab)) {
        batchEntries.push({
          tab,
          purpose: "integration_manage",
          tuple: { user: currentUser, relation: "can_manage", object: adminSurfaceObject(tab) },
        });
      }
    }

    // Single HTTP round-trip for all primary checks + baseline repair in parallel.
    const [batchResults] = await Promise.all([
      batchCheckOpenFgaTuples(batchEntries.map((e) => e.tuple)),
      repairCurrentUserBaseline(currentSubject!, isAdmin),
    ]);

    const primaryAllowed = new Map<AdminTabKey, boolean>();
    const integrationSurfaceManage = new Map<(typeof INTEGRATION_PANEL_TABS)[number], boolean>();
    batchEntries.forEach((entry, i) => {
      if (entry.purpose === "primary") {
        primaryAllowed.set(entry.tab, batchResults[i]);
      } else if (isIntegrationPanelTab(entry.tab)) {
        integrationSurfaceManage.set(entry.tab, batchResults[i]);
      }
    });

    // Resolve each tab using batch results; run secondary checks in parallel
    // for the handful of tabs that need resource-scoped fallback.
    const gates: AdminTabGatesMap = {} as AdminTabGatesMap;
    const secondaryChecks: Promise<void>[] = [];

    for (const tab of ALL_TABS) {
      if (tab === "credentials") {
        gates[tab] = isAdmin && !!getConfig("credentialsEnabled");
        continue;
      }
      if (tab === "service_accounts") {
        gates[tab] = isAdmin;
        if (!gates[tab]) {
          secondaryChecks.push(
            isMemberOfAnyTeam(currentUser).then((allowed) => {
              gates[tab] = allowed;
            }),
          );
        }
        continue;
      }
      if (tab === "approvals") {
        gates[tab] = true;
        continue;
      }
      if (tab === "dynamic_agent_conversations") {
        gates[tab] = isAdmin || (primaryAllowed.get(tab) ?? false);
        continue;
      }

      const allowed = bootstrapAdmin || (primaryAllowed.get(tab) ?? false);

      // Resource-scoped fallback for slack / webex / service_accounts.
      if (!allowed) {
        const t = tab;
        secondaryChecks.push(
          hasResourceScopedIntegrationAccess(currentUser, t).then((v) => { if (v) gates[t] = true; })
        );
      }

      const flagKey = TAB_FEATURE_FLAGS[tab];
      gates[tab] = flagKey && allowed ? !!getConfig(flagKey as Parameters<typeof getConfig>[0]) : allowed;
    }

    await Promise.all(secondaryChecks);

    const integrationPanelModes = integrationPanelModesFromSurfaceManage(
      gates,
      (tab) => bootstrapAdmin || (integrationSurfaceManage.get(tab) ?? false),
    );
    return NextResponse.json({ gates, simulation, integration_panel_modes: integrationPanelModes });
  }

  // ── Simulated-user path: per-check parallel fan-out (low frequency) ────────
  async function evaluateTab(tab: AdminTabKey): Promise<boolean> {
    const actor = simulatedUser ?? currentUser;
    let allowed: boolean;

    if (tab === "dynamic_agent_conversations") {
      if (simulatedUser) {
        allowed = simulatedOrganizationAdmin || await hasDynamicAgentConversationsRead(simulatedUser);
      } else {
        allowed = isAdmin || (actor ? await hasDynamicAgentConversationsRead(actor) : false);
      }
    } else if (tab === "approvals") {
      allowed = Boolean(actor);
    } else if (tab === "service_accounts" && simulatedUser) {
      allowed = simulatedOrganizationAdmin || await isMemberOfAnyTeam(simulatedUser);
    } else {
      allowed =
        tab === "credentials"
          ? simulatedUser
            ? simulatedOrganizationAdmin
            : isAdmin
          : BASELINE_TABS.has(tab) && actor
            ? simulatedBaselineObjects.has(adminSurfaceObject(tab)) ||
              await hasBaselineAdminSurfaceRead(actor, tab)
            : simulatedUser
              ? await hasAdminSurfaceManage(simulatedUser, tab)
              : bootstrapAdmin || (actor ? await hasAdminSurfaceManage(actor, tab) : false);
    }

    const supportsSimulatedResourceScope =
      !simulatedUser || tab === "slack" || tab === "webex";
    if (!allowed && actor && supportsSimulatedResourceScope) {
      allowed = await hasResourceScopedIntegrationAccess(actor, tab);
    }

    const flagKey = TAB_FEATURE_FLAGS[tab];
    if (flagKey && allowed) {
      allowed = !!getConfig(flagKey as Parameters<typeof getConfig>[0]);
    }

    return allowed;
  }

  const [tabResults] = await Promise.all([
    Promise.all(ALL_TABS.map(evaluateTab)),
    currentSubject && !simulatedUser
      ? repairCurrentUserBaseline(currentSubject, isAdmin)
      : Promise.resolve(),
  ]);

  const gates: AdminTabGatesMap = {} as AdminTabGatesMap;
  ALL_TABS.forEach((tab, i) => { gates[tab] = tabResults[i]; });

  const actor = simulatedUser ?? currentUser;
  const integrationPanelModes: IntegrationPanelModesMap = {};
  if (actor) {
    await Promise.all(
      INTEGRATION_PANEL_TABS.map(async (tab) => {
        if (!gates[tab]) return;
        const surfaceManage =
          (!simulatedUser && bootstrapAdmin) || (await hasAdminSurfaceManage(actor, tab));
        integrationPanelModes[tab] = surfaceManage ? "full" : "self_service";
      }),
    );
  }

  return NextResponse.json({ gates, simulation, integration_panel_modes: integrationPanelModes });
}
