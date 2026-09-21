import {
type ConnectorDiagnostics,
type ConnectorDiagnosticsAdapter,
type ConnectorHealthSummary,
type ConnectorRouteMetadata,
type ConnectorRuntimeRouteDiagnostic,
computeConnectorDiagnostics,
computeConnectorHealthSummary,
computeConnectorHealthSummaries,
} from "@/lib/rbac/connector-diagnostics";
import {
listOpenFgaWebexBotAgentIds,
webexSpaceOpenFgaUser,
} from "@/lib/rbac/webex-space-openfga";
import { listWebexSpaceAgentRoutes } from "@/lib/rbac/webex-space-route-store";

export type WebexRuntimeRouteDiagnostic = ConnectorRuntimeRouteDiagnostic;

export type WebexSpaceLastRuntimeError = NonNullable<ConnectorDiagnostics["last_runtime_error"]>;

export interface WebexSpaceDiagnostics extends Omit<ConnectorDiagnostics, "item_id"> {
  space_id: string;
}

export type WebexSpaceHealthSummary = ConnectorHealthSummary;

export interface WebexSpaceHealthSummaryTarget {
  workspaceId: string;
  spaceId: string;
}

function webexDiagnosticsAdapter(botId: string): ConnectorDiagnosticsAdapter {
  return {
  kind: "webex_space",
  botLabel: "Webex bot",
  runtimeLabel: "Webex runtime",
  tupleNoun: "space-agent",
  auditComponent: "webex_bot",
  auditResourceRef: (workspaceId, spaceId) => webexSpaceOpenFgaUser(workspaceId, spaceId),
  listOpenFgaAgentIds: async (workspaceId, spaceId) => {
    const [agentIds, routes] = await Promise.all([
      listOpenFgaWebexBotAgentIds(botId, workspaceId, spaceId),
      listWebexSpaceAgentRoutes(workspaceId, spaceId, botId),
    ]);
    const routeAgentIds = new Set(routes.map((route) => route.agent_id));
    return agentIds.filter((agentId) => routeAgentIds.has(agentId));
  },
  listRouteMetadata: async (workspaceId, spaceId): Promise<ConnectorRouteMetadata[]> => {
    const rows = await listWebexSpaceAgentRoutes(workspaceId, spaceId, botId);
    return rows.map((route) => ({
      agent_id: route.agent_id,
      priority: route.priority,
      users: route.users ? { listen: route.users.listen } : undefined,
    }));
  },
  shouldSurfaceLastRuntimeError: (lastError, openfgaError) => {
    // The Webex bot logs OPENFGA_READ_FAILED through audit-service when
    // tuple reads fail. Once OpenFGA is reachable again, the stored
    // error is stale — suppress it so the diagnostics panel doesn't
    // light up red after the underlying issue cleared.
    if (!openfgaError && lastError.reason_code === "OPENFGA_READ_FAILED") return false;
    return true;
  },
  };
}

export async function computeWebexSpaceDiagnostics(
  workspaceId: string,
  spaceId: string,
  botId: string,
): Promise<WebexSpaceDiagnostics> {
  const diagnostics = await computeConnectorDiagnostics(webexDiagnosticsAdapter(botId), workspaceId, spaceId);
  return {
    workspace_id: diagnostics.workspace_id,
    space_id: diagnostics.item_id,
    openfga: diagnostics.openfga,
    routes: diagnostics.routes,
    warnings: diagnostics.warnings,
    last_runtime_error: diagnostics.last_runtime_error,
  };
}

export async function computeWebexSpaceHealthSummary(
  workspaceId: string,
  spaceId: string,
  botId: string,
): Promise<WebexSpaceHealthSummary> {
  return computeConnectorHealthSummary(webexDiagnosticsAdapter(botId), workspaceId, spaceId);
}

export async function computeWebexSpaceHealthSummaries(
  targets: WebexSpaceHealthSummaryTarget[],
  botId: string,
): Promise<WebexSpaceHealthSummary[]> {
  return computeConnectorHealthSummaries(
    webexDiagnosticsAdapter(botId),
    targets.map((target) => ({ workspaceId: target.workspaceId, itemId: target.spaceId })),
  );
}
