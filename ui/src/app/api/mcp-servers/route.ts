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
import { CREDENTIAL_COLLECTIONS } from "@/lib/credentials/collections";
import { trustedInteractionFromRequest } from "@/lib/authz/trusted-interaction";
import { isPrivateResourcesEnabled } from "@/lib/feature-flags/private-resources";
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

type McpServerSortField = "name" | "transport" | "endpoint" | "status";
type SortDirection = "asc" | "desc";

const MCP_SERVER_SORT_FIELDS = new Set<McpServerSortField>([
  "name",
  "transport",
  "endpoint",
  "status",
]);

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
  "visibility",
  "owner_team_slug",
  "shared_with_teams",
] as const;

function normalizedTeamSlugs(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return Array.from(new Set(value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter(Boolean)));
}

interface SecretScopeDocument {
  id: string;
  owner?: { type?: string; id?: string };
  sharedWithTeams?: string[];
}

function normalizedMcpServerVisibility(
  server: MCPServerConfig,
): "private" | "team" | "global" {
  if (
    server.visibility === "private"
    || server.visibility === "team"
    || server.visibility === "global"
  ) return server.visibility;
  return "global";
}

function normalizedMcpServerScope(server: MCPServerConfig): MCPServerConfig {
  return { ...server, visibility: normalizedMcpServerVisibility(server) };
}

function isPrivateMcpServerVisibleToSession(
  server: MCPServerConfig,
  session: { sub?: unknown; isServiceAccount?: boolean },
): boolean {
  if (normalizedMcpServerVisibility(server) !== "private") return true;
  return session.isServiceAccount !== true
    && typeof session.sub === "string"
    && session.sub.trim().length > 0
    && server.owner_subject === session.sub.trim();
}

async function validateCredentialScopes(input: {
  visibility: "private" | "team" | "global";
  ownerSubject: string;
  credentialSources?: MCPCredentialSource[];
}): Promise<void> {
  const secretIds = (input.credentialSources ?? [])
    .filter((source) => source.kind === "secret_ref" && typeof source.secret_ref === "string")
    .map((source) => source.secret_ref!.trim())
    .filter(Boolean);
  if (secretIds.length === 0) return;
  const refs = await getCollection<SecretScopeDocument>(CREDENTIAL_COLLECTIONS.secretRefs);
  const secrets = await Promise.all(secretIds.map((id) => refs.findOne({ id })));
  for (const secret of secrets) {
    if (!secret) continue;
    const isPrivate = secret.owner?.type === "user" && (secret.sharedWithTeams?.length ?? 0) === 0;
    if (!isPrivate) continue;
    if (input.visibility !== "private" || secret.owner?.id !== input.ownerSubject) {
      throw new ApiError(
        "Private credentials can only be attached to a private MCP server owned by the same user.",
        400,
        "PRIVATE_DEPENDENCY_SCOPE_MISMATCH",
      );
    }
  }
}

async function canManageOrganization(
  session: Parameters<typeof requireResourcePermission>[0],
): Promise<boolean> {
  try {
    await requireResourcePermission(session, {
      type: "organization",
      id: caipeOrgKey(),
      action: "manage",
    });
    return true;
  } catch {
    return false;
  }
}

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

function mcpServerAddress(server: MCPServerConfig): string | undefined {
  const value = server.transport === "stdio" ? server.command : server.endpoint;
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function compareOptionalStrings(
  left: string | undefined,
  right: string | undefined,
  direction: SortDirection,
): number {
  if (left === undefined && right === undefined) return 0;
  if (left === undefined) return 1;
  if (right === undefined) return -1;
  return left.localeCompare(right, undefined, {
    numeric: true,
    sensitivity: "base",
  }) * (direction === "asc" ? 1 : -1);
}

function sortMcpServers(
  servers: MCPServerConfig[],
  field: McpServerSortField,
  direction: SortDirection,
): MCPServerConfig[] {
  const multiplier = direction === "asc" ? 1 : -1;
  return [...servers].sort((left, right) => {
    let comparison = 0;
    switch (field) {
      case "name":
        comparison = left.name.localeCompare(right.name, undefined, {
          numeric: true,
          sensitivity: "base",
        });
        break;
      case "transport":
        comparison = left.transport.localeCompare(right.transport);
        break;
      case "endpoint":
        comparison = compareOptionalStrings(
          mcpServerAddress(left),
          mcpServerAddress(right),
          direction,
        );
        if (comparison !== 0) return comparison;
        break;
      case "status":
        comparison = Number(left.enabled) - Number(right.enabled);
        break;
    }

    if (comparison !== 0) return comparison * multiplier;
    return left.name.localeCompare(right.name, undefined, {
      numeric: true,
      sensitivity: "base",
    });
  });
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

async function selfHealAgentGatewayMcpServersForList(
  collection: Awaited<ReturnType<typeof getCollection<MCPServerConfig>>>,
): Promise<void> {
  try {
    const discoveredCount = await collection.countDocuments({ source: "agentgateway" } as never);
    if (discoveredCount > 0) return;

    // assisted-by Codex Codex-sonnet-4-6
    // Startup self-heal can miss AgentGateway readiness; list-time recovery
    // keeps built-in routes like knowledge-base visible in MCP pickers.
    const { syncSelectedAgentGatewayMcpServers } = await import("./agentgateway/_lib");
    await syncSelectedAgentGatewayMcpServers();
  } catch (error) {
    console.warn(
      "[mcp-servers] AgentGateway MCP list self-heal skipped:",
      error instanceof Error ? error.message : error,
    );
  }
}

// ═══════════════════════════════════════════════════════════════
// GET — list MCP servers
// ═══════════════════════════════════════════════════════════════

/**
 * GET /api/mcp-servers
 * List MCP server configurations visible to the current user.
 *
 * Query params:
 * - sort_by=name|transport|endpoint|status: Sort the full visible result set
 * - sort_order=asc|desc: Sort direction (defaults to name ascending)
 */
export const GET = withErrorHandler(async (request: NextRequest) => {
  const { session } = await getAuthFromBearerOrSession(request);

    const collection = await getCollection<MCPServerConfig>(COLLECTION_NAME);
    await selfHealAgentGatewayMcpServersForList(collection);

    const listTarget = {
      type: "mcp_server" as const,
      action: "read" as const,
      id: (server: MCPServerConfig) => String(server._id),
    };
    const permissionOptions = {
      bypassForOrgAdmin: true as const,
      trustedContext: { interaction: trustedInteractionFromRequest(request) },
    };
    const { searchParams } = new URL(request.url);
    const requestedId = searchParams.get("id")?.trim();

    if (requestedId) {
      const server = await collection.findOne({ _id: requestedId });
      if (!server) throw new ApiError("MCP server not found", 404);
      if (!isPrivateMcpServerVisibleToSession(server, session)) {
        throw new ApiError("MCP server not found", 404);
      }

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
        ...normalizedMcpServerScope(server),
        permissions: mcpServerRowPermissionsOrDefault(rows, requestedId),
      };
      return successResponse(result);
    }

    const { page, pageSize, skip } = getPaginationParams(request);
    const requestedSortField = searchParams.get("sort_by") as McpServerSortField | null;
    const hasValidSortField = Boolean(
      requestedSortField && MCP_SERVER_SORT_FIELDS.has(requestedSortField),
    );
    const sortField: McpServerSortField = hasValidSortField
      ? requestedSortField as McpServerSortField
      : "name";
    const sortDirection: SortDirection = hasValidSortField && searchParams.get("sort_order") === "desc"
      ? "desc"
      : "asc";
    const allItems = await collection.find({}).sort({ name: 1 }).toArray();
    // The org-admin bypass is intentionally retained for healthy shared and
    // global MCP inventory. Private MCPs are non-discoverable to every
    // non-owner, including org admins, so scope them out before that bypass.
    const scopedItems = allItems.filter((server) => isPrivateMcpServerVisibleToSession(server, session));
    const visibleItems = await filterResourcesByPermission(session, scopedItems, listTarget, permissionOptions);
    const sortedItems = sortMcpServers(visibleItems, sortField, sortDirection);
    const pageItems = sortedItems.slice(skip, skip + pageSize);
    const { rows, capabilities } = await resolveMcpServerListPermissions(
      session,
      pageItems.map((server) => String(server._id)),
      permissionOptions,
    );
    const items: MCPServerConfigWithPermissions[] = pageItems.map((server) => ({
      ...normalizedMcpServerScope(server),
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
    const visibility: "private" | "team" | "global" = body.visibility === "global"
      ? "global"
      : body.visibility === "team" ? "team" : "private";
    if (visibility === "private" && !isPrivateResourcesEnabled()) {
      throw new ApiError("Private MCP servers are not enabled for this deployment", 409, "PRIVATE_RESOURCES_DISABLED");
    }
    if (visibility === "private" && session.isServiceAccount === true) {
      throw new ApiError("Service accounts cannot own private MCP servers", 403, "PRIVATE_OWNER_MUST_BE_USER");
    }
    if (visibility === "global" && !(await canManageOrganization(session))) {
      throw new ApiError(
        "Only platform admins can create global MCP servers",
        403,
        "GLOBAL_MCP_SERVER_FORBIDDEN",
      );
    }
    const ownerTeamSlug = visibility === "team" ? normalizeString(body.owner_team_slug) : null;
    if (visibility === "team" && !ownerTeamSlug) {
      throw new ApiError("Owner team is required for team MCP servers", 400, "OWNER_TEAM_REQUIRED");
    }
    if (ownerTeamSlug) {
      await requireOwnerTeamMembership(session, ownerTeamSlug);
    }
    const sharedTeamSlugs = visibility === "team"
      ? normalizedTeamSlugs(body.shared_with_teams).filter((slug) => slug !== ownerTeamSlug)
      : [];
    for (const slug of sharedTeamSlugs) await requireOwnerTeamMembership(session, slug);

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
    await validateCredentialScopes({
      visibility,
      ownerSubject,
      credentialSources: gatewayManaged.credential_sources,
    });
    const ownerSubjectKind =
      session.isServiceAccount === true ? ("service_account" as const) : ("user" as const);

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
      owner_subject: visibility === "private" ? ownerSubject : undefined,
      owner_subject_kind: visibility === "private" ? "user" : undefined,
      creator_subject: ownerSubjectKind === "user" ? ownerSubject : undefined,
      owner_team_slug: ownerTeamSlug ?? undefined,
      visibility,
      shared_with_teams: sharedTeamSlugs,
      // Server-controlled — never from request body
      config_driven: false,
      created_at: now.toISOString(),
      updated_at: now.toISOString(),
    };

    await reconcileMcpServerRelationships(
      {
        serverId,
        ownerSubject: visibility === "private" ? ownerSubject : null,
        ownerSubjectKind,
        ownerTeamSlug,
        creatorSubject: ownerSubjectKind === "user" ? ownerSubject : null,
        personalOwnerAccess: visibility === "private",
        nextSharedTeamSlugs: sharedTeamSlugs,
        ...(visibility === "global" ? { globalOrganizationAccess: true } : {}),
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

    const previousVisibility = normalizedMcpServerVisibility(server);
    const nextVisibility: "private" | "team" | "global" = updateData.visibility === "global"
      ? "global"
      : updateData.visibility === "team"
        ? "team"
        : updateData.visibility === "private"
          ? "private"
          : previousVisibility;
    if (
      nextVisibility === "private"
      && previousVisibility !== "private"
      && !isPrivateResourcesEnabled()
    ) {
      throw new ApiError("Private MCP servers are not enabled for this deployment", 409, "PRIVATE_RESOURCES_DISABLED");
    }
    if (nextVisibility === "private" && session.isServiceAccount === true) {
      throw new ApiError("Service accounts cannot own private MCP servers", 403, "PRIVATE_OWNER_MUST_BE_USER");
    }
    if (nextVisibility === "global" && !(await canManageOrganization(session))) {
      throw new ApiError(
        "Only platform admins can make MCP servers global",
        403,
        "GLOBAL_MCP_SERVER_FORBIDDEN",
      );
    }
    const nextOwnerTeamSlug = nextVisibility === "team"
      ? normalizeString(updateData.owner_team_slug) ?? normalizeString(server.owner_team_slug)
      : null;
    if (nextVisibility === "team" && !nextOwnerTeamSlug) {
      throw new ApiError("Owner team is required for team MCP servers", 400, "OWNER_TEAM_REQUIRED");
    }
    if (nextOwnerTeamSlug && nextOwnerTeamSlug !== server.owner_team_slug) {
      await requireOwnerTeamMembership(session, nextOwnerTeamSlug);
    }
    const nextSharedTeamSlugs = nextVisibility === "team"
      ? normalizedTeamSlugs(updateData.shared_with_teams ?? server.shared_with_teams)
        .filter((slug) => slug !== nextOwnerTeamSlug)
      : [];
    for (const slug of nextSharedTeamSlugs) await requireOwnerTeamMembership(session, slug);
    updateData.visibility = nextVisibility;
    updateData.shared_with_teams = nextSharedTeamSlugs;
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

    const ownerSubject = requireStableSubject(session);
    const storedOwnerSubject = server.owner_subject ?? ownerSubject;
    const storedOwnerSubjectKind = server.owner_subject_kind
      ?? (server.owner_subject === ownerSubject && session.isServiceAccount === true
        ? "service_account"
        : "user");
    const previousPersonalOwnerAccess = previousVisibility === "private"
      || (server.visibility === undefined && Boolean(server.owner_subject));
    await validateCredentialScopes({
      visibility: nextVisibility,
      ownerSubject: nextVisibility === "private" ? ownerSubject : storedOwnerSubject,
      credentialSources: (updateData.credential_sources ?? server.credential_sources) as MCPCredentialSource[] | undefined,
    });
    await reconcileMcpServerRelationships(
      {
        serverId: id,
        ownerSubject: nextVisibility === "private"
          ? ownerSubject
          : previousPersonalOwnerAccess ? storedOwnerSubject : null,
        ownerSubjectKind: nextVisibility === "private" ? "user" : storedOwnerSubjectKind,
        ownerTeamSlug: nextOwnerTeamSlug,
        previousOwnerTeamSlug: server.owner_team_slug,
        creatorSubject: server.creator_subject
          ?? (storedOwnerSubjectKind === "user" ? storedOwnerSubject : null),
        personalOwnerAccess: nextVisibility === "private",
        previousPersonalOwnerAccess,
        nextSharedTeamSlugs,
        previousSharedTeamSlugs: server.shared_with_teams ?? [],
        globalOrganizationAccess: nextVisibility === "global",
        previousGlobalOrganizationAccess: previousVisibility === "global",
      },
      {
        caller: { type: session.isServiceAccount === true ? "service_account" : "user", id: ownerSubject },
        source: "mcp_server_update",
      },
    );

    const updated = await collection.findOneAndUpdate(
      { _id: id },
      nextVisibility === "private"
        ? {
            $set: {
              ...updateData,
              owner_subject: ownerSubject,
              owner_subject_kind: "user",
              shared_with_teams: [],
            },
            $unset: { owner_team_slug: "" },
          }
        : nextVisibility === "team"
          ? {
            $set: { ...updateData, owner_team_slug: nextOwnerTeamSlug },
            $unset: { owner_subject: "", owner_subject_kind: "" },
          }
          : {
            $set: { ...updateData, visibility: "global", shared_with_teams: [] },
            $unset: { owner_subject: "", owner_subject_kind: "", owner_team_slug: "" },
          },
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
