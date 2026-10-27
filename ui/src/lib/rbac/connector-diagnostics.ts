import { getAuditClient } from "@/lib/audit";
import {
  missingRouteMetadataMessage,
  noTuplesMessage,
  openFgaReadFailureMessage,
  staleRouteMetadataMessage,
} from "@/lib/rbac/connector-diagnostic-messages";

export type ConnectorKind = "slack_channel" | "webex_space";

export type ConnectorListenMode = "mention" | "message" | "all" | "unknown";

export interface ConnectorRouteMetadata {
  agent_id: string;
  priority?: number;
  users?: { listen?: string };
}

export interface ConnectorRuntimeRouteDiagnostic {
  agent_id: string;
  openfga_tuple: boolean;
  route_metadata: boolean;
  listen: ConnectorListenMode;
  priority: number;
  runtime_matches: { mention: boolean; message: boolean };
  warnings: string[];
}

export interface ConnectorLastRuntimeError {
  ts?: string;
  reason_code?: string;
  message?: string;
  action?: string;
}

export interface ConnectorDiagnostics {
  workspace_id: string;
  item_id: string;
  openfga: { reachable: boolean; tuple_count: number; error?: string };
  routes: ConnectorRuntimeRouteDiagnostic[];
  warnings: string[];
  last_runtime_error: ConnectorLastRuntimeError | null;
}

export interface ConnectorHealthSummary {
  warnings_count: number;
  openfga_reachable: boolean;
  last_runtime_error_ts: string | null;
}

export interface ConnectorHealthSummaryTarget {
  workspaceId: string;
  itemId: string;
}

interface ConnectorDiagnosticsOptions {
  lastRuntimeError?: ConnectorLastRuntimeError | null;
}

export interface ConnectorDiagnosticsAdapter {
  kind: ConnectorKind;
  // Display labels used inside warning text. botLabel is the prefix
  // for the OpenFGA-read failure ("Slack bot cannot read…"); runtimeLabel
  // is used for the no-tuples warning ("Slack runtime has no agent…");
  // tupleNoun is the relation noun in the no-tuples warning
  // ("channel-agent" / "space-agent"). Keeps the warning copy
  // byte-identical with what each panel rendered before.
  botLabel: string;
  runtimeLabel: string;
  tupleNoun: string;
  // The audit-service component value to query for
  // last_runtime_error. e.g. "slack_bot" / "webex_bot".
  auditComponent: string;
  // resource_ref the bot writes into audit-service — Slack uses
  // `slack_channel:<workspace>--<channel>`, Webex uses
  // `webex_space:<workspace>--<space>`.
  auditResourceRef: (workspaceId: string, itemId: string) => string;
  // Returns `agent_id`s the bot has OpenFGA tuples for. Slack's
  // implementation reads `slack_channel:<id>` as user; Webex reads
  // `webex_bot_installation:<bot>--<workspace>--<space>` as user. Both enumerate `agent:*`
  // objects.
  listOpenFgaAgentIds: (workspaceId: string, itemId: string) => Promise<string[]>;
  // Returns Mongo route metadata rows for this item. Each row needs
  // an agent_id, optional priority, optional users.listen.
  listRouteMetadata: (workspaceId: string, itemId: string) => Promise<ConnectorRouteMetadata[]>;
  // Optional: Webex suppresses last_runtime_error when OpenFGA is
  // currently reachable but the stored error reason was
  // OPENFGA_READ_FAILED. Slack does not.
  shouldSurfaceLastRuntimeError?: (
    lastError: ConnectorLastRuntimeError,
    openfgaError: string | undefined,
  ) => boolean;
  // Optional: Webex's per-route warnings include explicit
  // mention-only / message-only callouts that Slack does not surface
  // at the per-route level (Slack folds those into the ambiguous-route
  // warning instead). Each connector contributes its own extras.
  buildExtraRouteWarnings?: (route: ConnectorRuntimeRouteDiagnostic) => string[];
  // Slack flags ambiguous routes (two enabled tuples that fight for
  // the same incoming message at the same priority). Webex doesn't
  // ship that warning today; leave optional so Webex's diagnostics
  // stay byte-identical to the existing route handler.
  buildAmbiguousRouteWarnings?: (routes: ConnectorRuntimeRouteDiagnostic[]) => string[];
}

// assisted-by Codex Codex-sonnet-4-6
const RUNTIME_ERROR_LOOKBACK_MS = 24 * 60 * 60 * 1000;
const RUNTIME_ERROR_BATCH_LIMIT = 5_000;
const RUNTIME_ERROR_QUERY_TIMEOUT_MS = 2_000;

function listenMatches(listen: ConnectorListenMode, requested: "mention" | "message"): boolean {
  return listen === "all" || listen === requested;
}

function buildBaseRouteWarnings(
  route: ConnectorRuntimeRouteDiagnostic,
): string[] {
  const warnings: string[] = [];
  if (!route.openfga_tuple && route.route_metadata) {
    warnings.push(staleRouteMetadataMessage(route.agent_id));
  }
  if (route.openfga_tuple && !route.route_metadata) {
    warnings.push(missingRouteMetadataMessage(route.agent_id));
  }
  return warnings;
}

function runtimeErrorFromEvent(event: Record<string, unknown>): ConnectorLastRuntimeError {
  return {
    ts: event.ts instanceof Date ? event.ts.toISOString() : typeof event.ts === "string" ? event.ts : undefined,
    reason_code: typeof event.reason_code === "string" ? event.reason_code : undefined,
    message: typeof event.message === "string" ? event.message : undefined,
    action: typeof event.action === "string" ? event.action : undefined,
  };
}

async function latestRuntimeError(
  adapter: ConnectorDiagnosticsAdapter,
  workspaceId: string,
  itemId: string,
): Promise<ConnectorLastRuntimeError | null> {
  const resourceRef = adapter.auditResourceRef(workspaceId, itemId);
  try {
    const until = new Date();
    const since = new Date(until.getTime() - RUNTIME_ERROR_LOOKBACK_MS);
    const { records: rows } = await getAuditClient().queryPage({
      since,
      until,
      component: adapter.auditComponent,
      outcome: "error",
      resource_ref: resourceRef,
      limit: 1,
    }, { timeoutMs: RUNTIME_ERROR_QUERY_TIMEOUT_MS });
    const event = rows[0] as Record<string, unknown> | undefined;
    if (!event) return null;
    return runtimeErrorFromEvent(event);
  } catch (error) {
    console.warn(`[connector-audit] Runtime history unavailable for ${resourceRef}`, error);
    return null;
  }
}

function healthTargetKey(workspaceId: string, itemId: string): string {
  return `${workspaceId}\u0000${itemId}`;
}

async function latestRuntimeErrors(
  adapter: ConnectorDiagnosticsAdapter,
  targets: ConnectorHealthSummaryTarget[],
): Promise<Map<string, ConnectorLastRuntimeError>> {
  const targetByResourceRef = new Map<string, string>();
  for (const target of targets) {
    targetByResourceRef.set(
      adapter.auditResourceRef(target.workspaceId, target.itemId),
      healthTargetKey(target.workspaceId, target.itemId),
    );
  }
  const errorsByTarget = new Map<string, ConnectorLastRuntimeError>();
  if (targetByResourceRef.size === 0) return errorsByTarget;

  try {
    const until = new Date();
    const since = new Date(until.getTime() - RUNTIME_ERROR_LOOKBACK_MS);
    const { records: rows } = await getAuditClient().queryPage({
      since,
      until,
      component: adapter.auditComponent,
      outcome: "error",
      limit: RUNTIME_ERROR_BATCH_LIMIT,
    }, { timeoutMs: RUNTIME_ERROR_QUERY_TIMEOUT_MS });
    for (const event of rows) {
      const resourceRef = event.resource_ref;
      if (typeof resourceRef !== "string") continue;
      const targetKey = targetByResourceRef.get(resourceRef);
      if (!targetKey || errorsByTarget.has(targetKey)) continue;
      errorsByTarget.set(targetKey, runtimeErrorFromEvent(event));
    }
  } catch (error) {
    console.warn(`[connector-audit] Runtime history unavailable for ${adapter.auditComponent}`, error);
    return errorsByTarget;
  }
  return errorsByTarget;
}

export async function computeConnectorDiagnostics(
  adapter: ConnectorDiagnosticsAdapter,
  workspaceId: string,
  itemId: string,
  options: ConnectorDiagnosticsOptions = {},
): Promise<ConnectorDiagnostics> {
  const metadataRoutes = await adapter.listRouteMetadata(workspaceId, itemId);
  const warnings: string[] = [];
  let openfgaAgentIds: string[] = [];
  let openfgaError: string | undefined;

  try {
    openfgaAgentIds = await adapter.listOpenFgaAgentIds(workspaceId, itemId);
  } catch (error) {
    openfgaError = error instanceof Error ? error.message : "OpenFGA tuple read failed";
    warnings.push(openFgaReadFailureMessage(adapter.botLabel, openfgaError));
  }

  const allAgentIds = Array.from(
    new Set([...openfgaAgentIds, ...metadataRoutes.map((route) => route.agent_id)]),
  ).sort();
  const metadataByAgentId = new Map(metadataRoutes.map((route) => [route.agent_id, route]));
  const openfgaAgentSet = new Set(openfgaAgentIds);
  const routes = allAgentIds.map((agentId): ConnectorRuntimeRouteDiagnostic => {
    const metadata = metadataByAgentId.get(agentId);
    const listen = (metadata?.users?.listen ?? "mention") as ConnectorListenMode;
    const priority = typeof metadata?.priority === "number" ? metadata.priority : 100;
    const route: ConnectorRuntimeRouteDiagnostic = {
      agent_id: agentId,
      openfga_tuple: openfgaAgentSet.has(agentId),
      route_metadata: Boolean(metadata),
      listen,
      priority,
      runtime_matches: {
        mention: listenMatches(listen, "mention"),
        message: listenMatches(listen, "message"),
      },
      warnings: [],
    };
    const baseWarnings = buildBaseRouteWarnings(route);
    const extra = adapter.buildExtraRouteWarnings?.(route) ?? [];
    route.warnings = [...baseWarnings, ...extra];
    warnings.push(...route.warnings);
    return route;
  });

  if (adapter.buildAmbiguousRouteWarnings) {
    warnings.push(...adapter.buildAmbiguousRouteWarnings(routes));
  }

  if (!openfgaError && openfgaAgentIds.length === 0) {
    warnings.push(noTuplesMessage(adapter.tupleNoun, adapter.runtimeLabel));
  }

  const lastError = Object.prototype.hasOwnProperty.call(options, "lastRuntimeError")
    ? options.lastRuntimeError ?? null
    : await latestRuntimeError(adapter, workspaceId, itemId);
  const surfacedLastError =
    lastError && (adapter.shouldSurfaceLastRuntimeError?.(lastError, openfgaError) ?? true)
      ? lastError
      : null;

  return {
    workspace_id: workspaceId,
    item_id: itemId,
    openfga: {
      reachable: !openfgaError,
      tuple_count: openfgaAgentIds.length,
      ...(openfgaError ? { error: openfgaError } : {}),
    },
    routes,
    warnings: Array.from(new Set(warnings)),
    last_runtime_error: surfacedLastError,
  };
}

export async function computeConnectorHealthSummary(
  adapter: ConnectorDiagnosticsAdapter,
  workspaceId: string,
  itemId: string,
  options: ConnectorDiagnosticsOptions = {},
): Promise<ConnectorHealthSummary> {
  const diagnostics = await computeConnectorDiagnostics(adapter, workspaceId, itemId, options);
  return {
    warnings_count: diagnostics.warnings.length,
    openfga_reachable: diagnostics.openfga.reachable,
    last_runtime_error_ts: diagnostics.last_runtime_error?.ts ?? null,
  };
}

export async function computeConnectorHealthSummaries(
  adapter: ConnectorDiagnosticsAdapter,
  targets: ConnectorHealthSummaryTarget[],
): Promise<ConnectorHealthSummary[]> {
  const errorsByTarget = await latestRuntimeErrors(adapter, targets);
  return Promise.all(
    targets.map(async (target) =>
      computeConnectorHealthSummary(adapter, target.workspaceId, target.itemId, {
        lastRuntimeError: errorsByTarget.get(healthTargetKey(target.workspaceId, target.itemId)) ?? null,
      }).catch(
        (): ConnectorHealthSummary => ({
          warnings_count: 0,
          openfga_reachable: false,
          last_runtime_error_ts: null,
        }),
      ),
    ),
  );
}
