/**
 * API routes for MCP Server management.
 *
 * All operations use local MongoDB directly.
 * The gateway owns all config writes — DA is a pure runtime reader.
 */

import {
ApiError,
getAuthFromBearerOrSession,
getPaginationParams,
successResponse,
withErrorHandler,
} from "@/lib/api-middleware";
import { getCollection } from "@/lib/mongodb";
import { agentGatewayMcpEndpointUrl } from "@/lib/rbac/agentgateway-mcp-discovery";
import {
  isAgentGatewayManagedEndpoint,
  resolveAgentGatewayUpstreamEndpoint,
} from "@/lib/rbac/agentgateway-upstream-resolver";
import { normalizeMcpEndpointForServer } from "@/lib/rbac/mcp-endpoint-normalizer";
import { caipeOrgKey } from "@/lib/rbac/organization";
import {
deleteAllMcpServerRelationshipTuples,
reconcileMcpServerRelationships,
} from "@/lib/rbac/openfga-owned-resources-reconcile";
import {
filterResourcesByPermission,
mcpServerRowPermissionsOrDefault,
requireResourcePermission,
resolveMcpServerListPermissions,
} from "@/lib/rbac/resource-authz";
import type {
MCPCredentialSource,
MCPServerConfig,
MCPServerConfigWithPermissions,
TransportType,
} from "@/types/dynamic-agent";
import { NextRequest, NextResponse } from "next/server";

const COLLECTION_NAME = "mcp_servers";

// ═══════════════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════════════

/** Mutable fields allowed in MCP server create/update requests. */
const SERVER_MUTABLE_FIELDS = [
  "name",
  "description",
  "transport",
  "endpoint",
  "command",
  "args",
  "env",
  "credential_sources",
  "enabled",
] as const;

async function requireOwnerTeamMembership(session: Parameters<typeof requireResourcePermission>[0], ownerTeamSlug: string): Promise<void> {
  try {
    await requireResourcePermission(session, { type: "team", id: ownerTeamSlug, action: "use" });
    return;
  } catch {
    // assisted-by Codex Codex-sonnet-4-6
    // A team admin/owner can manage the destination team even if older
    // OpenFGA projections did not materialize the can_use edge.
    await requireResourcePermission(session, { type: "team", id: ownerTeamSlug, action: "manage" });
  }
}

function normalizeString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function requireStableSubject(session: { sub?: unknown }): string {
  const subject = normalizeString(session.sub);
  if (!subject) {
    throw new ApiError("A stable user subject is required for MCP server ownership.", 401, "NO_SUBJECT");
  }
  return subject;
}

/**
 * Pick only allowed mutable fields from body, filtering out
 * undefined values. Prevents injection of server-controlled
 * fields like config_driven.
 */
function pickMutableFields(
  body: Record<string, unknown>,
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const field of SERVER_MUTABLE_FIELDS) {
    if (body[field] !== undefined) {
      result[field] = body[field];
    }
  }
  return result;
}

/**
 * Resolve the AgentGateway base URL for endpoint normalisation. Returns
 * just the origin (protocol://host:port), with no `/mcp` suffix —
 * `normalizeMcpEndpointForServer` constructs the rest.
 *
 * We re-derive from `agentGatewayMcpEndpointUrl()` rather than reading
 * env vars directly so the override hierarchy (AGENT_GATEWAY_URL ▶
 * AGENTGATEWAY_URL ▶ default) stays in one place.
 */
function agentGatewayBaseForNormalizer(): string {
  const withMcp = agentGatewayMcpEndpointUrl();
  return withMcp.replace(/\/mcp$/, "");
}

/**
 * Validate transport-specific required fields.
 *
 * - stdio: requires `command`
 * - sse/http: requires `endpoint`
 */
function validateTransportConfig(
  transport: TransportType,
  command?: string,
  endpoint?: string,
): void {
  if (transport === "stdio") {
    if (!command) {
      throw new ApiError("'command' is required for stdio transport", 400);
    }
  } else if (transport === "sse" || transport === "http") {
    if (!endpoint) {
      throw new ApiError("'endpoint' is required for sse/http transport", 400);
    }
  }
}

function isNetworkTransport(transport: TransportType): boolean {
  return transport === "http" || transport === "sse";
}

function isLockedConfigDrivenServer(server: MCPServerConfig): boolean {
  return server.config_driven === true && server.source !== "agentgateway";
}

function isAgentGatewayEndpoint(endpoint: string | undefined): boolean {
  return isAgentGatewayManagedEndpoint(endpoint);
}

async function normalizeNetworkServerForAgentGateway(input: {
  serverId: string;
  transport: TransportType;
  endpoint?: string;
  existingTargetEndpoint?: string;
  pickedTargetEndpoint?: string;
  credentialSources?: unknown;
}): Promise<{
  endpoint?: string;
  agentgateway_target_endpoint?: string;
  source?: "agentgateway";
  agentgateway_discovered?: boolean;
  credential_sources?: MCPCredentialSource[];
}> {
  if (!isNetworkTransport(input.transport)) {
    return {
      endpoint: input.endpoint,
      credential_sources: normalizeCredentialSourcesForAgentGateway(input.credentialSources),
    };
  }

  const upstreamEndpoint = isAgentGatewayEndpoint(input.endpoint)
    ? await resolveAgentGatewayUpstreamEndpoint({
        endpoint: input.endpoint,
        pickedTargetEndpoint: input.pickedTargetEndpoint,
        existingTargetEndpoint: input.existingTargetEndpoint,
      })
    : normalizeMcpEndpointForServer({
        endpoint: input.endpoint,
        serverId: input.serverId,
        agentGatewayBaseUrl: agentGatewayBaseForNormalizer(),
        directEndpointDefaultPath: input.transport === "http" ? "/mcp" : undefined,
      });

  return {
    endpoint: agentGatewayRouteFor(input.serverId),
    agentgateway_target_endpoint: upstreamEndpoint,
    source: "agentgateway",
    agentgateway_discovered: false,
    credential_sources: normalizeCredentialSourcesForAgentGateway(input.credentialSources),
  };
}

function agentGatewayRouteFor(serverId: string): string {
  return agentGatewayMcpEndpointUrl(`/mcp/${serverId}`);
}

function normalizeCredentialSourcesForAgentGateway(value: unknown): MCPCredentialSource[] | undefined {
  if (!Array.isArray(value)) return undefined;

  return value
    .filter((source): source is MCPCredentialSource => Boolean(source) && typeof source === "object")
    .map((source) => {
      if (source.target !== "header") return source;

      const headerName = typeof source.name === "string" ? source.name.trim() : "";
      if (/^(authorization|x-caipe-token)$/i.test(headerName)) {
        // assisted-by Codex Codex-sonnet-4-6
        // Dynamic Agents must keep Authorization for the user's Keycloak token
        // to AgentGateway. Provider secrets ride this header and the gateway
        // rewrites it to upstream Authorization for the MCP target.
        return { ...source, name: "X-CAIPE-Provider-Token" };
      }
      return source;
    });
}

// ═══════════════════════════════════════════════════════════════
// GET — list MCP servers
// ═══════════════════════════════════════════════════════════════

/**
 * GET /api/mcp-servers
 * List MCP server configurations visible to the current user.
 */
export const GET = withErrorHandler(async (request: NextRequest) => {
  const { session } = await getAuthFromBearerOrSession(request);

    const collection = await getCollection<MCPServerConfig>(COLLECTION_NAME);
    const listTarget = {
      type: "mcp_server" as const,
      action: "read" as const,
      id: (server: MCPServerConfig) => String(server._id),
    };
    const permissionOptions = { bypassForOrgAdmin: true as const };
    const requestedId = new URL(request.url).searchParams.get("id")?.trim();

    if (requestedId) {
      const server = await collection.findOne({ _id: requestedId });
      if (!server) throw new ApiError("MCP server not found", 404);

      const visibleItems = await filterResourcesByPermission(
        session,
        [server],
        listTarget,
        permissionOptions,
      );
      if (visibleItems.length === 0) throw new ApiError("MCP server not found", 404);

      const { rows } = await resolveMcpServerListPermissions(
        session,
        [requestedId],
        permissionOptions,
      );
      const result: MCPServerConfigWithPermissions = {
        ...server,
        permissions: mcpServerRowPermissionsOrDefault(rows, requestedId),
      };
      return successResponse(result);
    }

    const { page, pageSize, skip } = getPaginationParams(request);
    const allItems = await collection.find({}).sort({ name: 1 }).toArray();
    const visibleItems = await filterResourcesByPermission(session, allItems, listTarget, permissionOptions);
    const pageItems = visibleItems.slice(skip, skip + pageSize);
    const { rows, capabilities } = await resolveMcpServerListPermissions(
      session,
      pageItems.map((server) => String(server._id)),
      permissionOptions,
    );
    const items: MCPServerConfigWithPermissions[] = pageItems.map((server) => ({
      ...server,
      permissions: mcpServerRowPermissionsOrDefault(rows, String(server._id)),
    }));

    return NextResponse.json({
      success: true,
      data: {
        items,
        capabilities,
        total: visibleItems.length,
        page,
        page_size: pageSize,
        has_more: page * pageSize < visibleItems.length,
      },
    });
});

// ═══════════════════════════════════════════════════════════════
// POST — create MCP server
// ═══════════════════════════════════════════════════════════════

/**
 * POST /api/mcp-servers
 * Create a new MCP server configuration.
 */
export const POST = withErrorHandler(async (request: NextRequest) => {
  const { session, user } = await getAuthFromBearerOrSession(request);
  const ownerSubject = requireStableSubject(session);

    // Org members (or org admins) may register MCP servers; owner tuples are
    // written immediately after insert via CAS reconcileTupleDiff.
    await requireResourcePermission(
      session,
      { type: "organization", id: caipeOrgKey(), action: "use" },
      { bypassForOrgAdmin: true },
    );

    const body = await request.json();

    if (!body.id || typeof body.id !== "string") {
      throw new ApiError("Server ID is required", 400);
    }
    if (!body.name || typeof body.name !== "string") {
      throw new ApiError("Server name is required", 400);
    }
    if (!body.transport || typeof body.transport !== "string") {
      throw new ApiError("Transport type is required", 400);
    }

    const collection = await getCollection<MCPServerConfig>(COLLECTION_NAME);

    // Silently prepend mcp- prefix to user-provided ID
    const serverId = body.id.startsWith("mcp-") ? body.id as string : `mcp-${body.id as string}`;
    const ownerTeamSlug = normalizeString(body.owner_team_slug);
    if (ownerTeamSlug) {
      await requireOwnerTeamMembership(session, ownerTeamSlug);
    }

    // Uniqueness check
    const existing = await collection.findOne({ _id: serverId });
    if (existing) {
      throw new ApiError(
        `MCP server with ID '${serverId}' already exists`,
        409,
      );
    }

    // Transport validation
    validateTransportConfig(
      body.transport as TransportType,
      body.command as string | undefined,
      body.endpoint as string | undefined,
    );

    const gatewayManaged = await normalizeNetworkServerForAgentGateway({
      serverId,
      transport: body.transport as TransportType,
      endpoint: body.endpoint as string | undefined,
      pickedTargetEndpoint:
        typeof body.agentgateway_target_endpoint === "string"
          ? body.agentgateway_target_endpoint
          : undefined,
      credentialSources: body.credential_sources,
    });

    // Build document with explicit field allowlist (Security VII)
    const now = new Date();
    const doc: MCPServerConfig = {
      _id: serverId,
      name: body.name as string,
      description: (body.description as string) ?? "",
      transport: body.transport as TransportType,
      endpoint: gatewayManaged.endpoint,
      command: body.command as string | undefined,
      args: body.args as string[] | undefined,
      env: body.env as Record<string, string> | undefined,
      credential_sources: gatewayManaged.credential_sources,
      enabled: (body.enabled as boolean) ?? true,
      source: gatewayManaged.source ?? "manual",
      agentgateway_discovered: gatewayManaged.agentgateway_discovered,
      agentgateway_target_endpoint: gatewayManaged.agentgateway_target_endpoint,
      owner_id: user.email,
      owner_subject: ownerSubject,
      owner_team_slug: ownerTeamSlug ?? undefined,
      // Server-controlled — never from request body
      config_driven: false,
      created_at: now.toISOString(),
      updated_at: now.toISOString(),
    };

    const ownerSubjectKind =
      session.isServiceAccount === true ? ("service_account" as const) : ("user" as const);

    await reconcileMcpServerRelationships(
      {
        serverId,
        ownerSubject,
        ownerSubjectKind,
        ownerTeamSlug,
      },
      {
        caller: { type: ownerSubjectKind, id: ownerSubject },
        source: "mcp_server_create",
      },
    );

    await collection.insertOne(doc);

    return successResponse(doc, 201);
});

// ═══════════════════════════════════════════════════════════════
// PUT — update MCP server
// ═══════════════════════════════════════════════════════════════

/**
 * PUT /api/mcp-servers?id=<server_id>
 * Update an MCP server configuration.
 * Requires resource write access. Config-driven servers cannot be modified.
 */
export const PUT = withErrorHandler(async (request: NextRequest) => {
  const { searchParams } = new URL(request.url);
  const id = searchParams.get("id");

  if (!id) {
    throw new ApiError("Server ID is required", 400);
  }

  const { session } = await getAuthFromBearerOrSession(request);

    const body = await request.json();
    const collection = await getCollection<MCPServerConfig>(COLLECTION_NAME);

    // Verify server exists
    const server = await collection.findOne({ _id: id });
    if (!server) {
      throw new ApiError("MCP server not found", 404);
    }
    const updateTarget = {
      type: "mcp_server" as const,
      id,
      action: "manage" as const,
    };
    await requireResourcePermission(session, updateTarget);

    // Config-driven guard
    if (isLockedConfigDrivenServer(server)) {
      throw new ApiError(
        "Config-driven MCP servers cannot be modified. Update config.yaml instead.",
        403,
      );
    }

    // Build update with explicit field allowlist
    const updateData = pickMutableFields(body);
    if (Object.keys(updateData).length === 0) {
      // No fields to update — return current state
      return successResponse(server);
    }

    const nextTransport = (updateData.transport as TransportType | undefined) ?? server.transport;
    if (isNetworkTransport(nextTransport)) {
      const gatewayManaged = await normalizeNetworkServerForAgentGateway({
        serverId: String(id),
        transport: nextTransport,
        endpoint:
          typeof updateData.endpoint === "string"
            ? updateData.endpoint
            : (server.agentgateway_target_endpoint || server.endpoint),
        existingTargetEndpoint: server.agentgateway_target_endpoint,
        pickedTargetEndpoint:
          typeof body.agentgateway_target_endpoint === "string"
            ? body.agentgateway_target_endpoint
            : undefined,
        credentialSources: updateData.credential_sources ?? server.credential_sources,
      });
      updateData.endpoint = gatewayManaged.endpoint;
      updateData.source = gatewayManaged.source;
      updateData.agentgateway_discovered = gatewayManaged.agentgateway_discovered;
      updateData.agentgateway_target_endpoint = gatewayManaged.agentgateway_target_endpoint;
      updateData.credential_sources = gatewayManaged.credential_sources;
    } else if (updateData.credential_sources !== undefined) {
      updateData.credential_sources = normalizeCredentialSourcesForAgentGateway(updateData.credential_sources);
    }

    updateData.updated_at = new Date().toISOString();

    const updated = await collection.findOneAndUpdate(
      { _id: id },
      { $set: updateData },
      { returnDocument: "after" },
    );

    if (!updated) {
      throw new ApiError("Failed to update MCP server", 500);
    }

    return successResponse(updated);
});

// ═══════════════════════════════════════════════════════════════
// DELETE — delete MCP server
// ═══════════════════════════════════════════════════════════════

/**
 * DELETE /api/mcp-servers?id=<server_id>
 * Delete an MCP server configuration.
 * Requires resource delete access. Config-driven servers cannot be deleted.
 */
export const DELETE = withErrorHandler(async (request: NextRequest) => {
  const { searchParams } = new URL(request.url);
  const id = searchParams.get("id");

  if (!id) {
    throw new ApiError("Server ID is required", 400);
  }

  const { session } = await getAuthFromBearerOrSession(request);

    const collection = await getCollection<MCPServerConfig>(COLLECTION_NAME);

    // Verify server exists
    const server = await collection.findOne({ _id: id });
    if (!server) {
      throw new ApiError("MCP server not found", 404);
    }
    const deleteTarget = {
      type: "mcp_server" as const,
      id,
      action: "delete" as const,
    };
    await requireResourcePermission(session, deleteTarget);

    // Config-driven guard
    if (isLockedConfigDrivenServer(server)) {
      throw new ApiError(
        "Config-driven MCP servers cannot be deleted. Remove from config.yaml instead.",
        403,
      );
    }

    await deleteAllMcpServerRelationshipTuples(id, {
      caller: session.sub
        ? {
            type: session.isServiceAccount === true ? "service_account" : "user",
            id: String(session.sub).trim(),
          }
        : undefined,
      source: "mcp_server_delete",
    });
    await collection.deleteOne({ _id: id });

    return successResponse({ deleted: id });
});
