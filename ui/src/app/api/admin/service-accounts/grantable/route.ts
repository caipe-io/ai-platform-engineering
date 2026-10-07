// assisted-by Codex Codex-sonnet-4-6
import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth-config";
import { listOpenFgaObjects } from "@/lib/rbac/openfga";
import { listRebacCatalog } from "@/lib/rbac/resource-catalog";
import { getCollection, isMongoDBConfigured } from "@/lib/mongodb";
import { hasOrganizationAdmin } from "@/lib/rbac/platform-admin";
import { authenticateRequest, buildBackendHeaders } from "@/lib/da-proxy";
import {
  cacheMcpToolCatalog,
  listCachedMcpTools,
} from "@/lib/rbac/mcp-tool-catalog";
import type { MCPToolInfo } from "@/types/dynamic-agent";
import {
  RAG_COLLECTIONS_COLLECTION,
  type RagCollection,
} from "@/types/rag-collection";

/**
 * GET /api/admin/service-accounts/grantable
 *
 * Returns the agents, tools, and RAG knowledge the caller can grant, to populate the create /
 * add-scope picker (FR-009). Normal users can only delegate their own holdings
 * (FR-007). Platform admins can grant from the full enabled platform catalog,
 * because org-admin authority is administrative and may not be materialized as
 * per-tool `can_call` tuples for list-objects.
 *
 * Backed by `listOpenFgaObjects(user:<caller>, can_use, agent)` and the tool
 * equivalent (`can_call`, `tool`). See research.md R-8.
 *
 * Response: { success, data: { agents, tools, datasources, collections } }
 * Credential material is never involved here.
 */

interface GrantableItem {
  ref: string;
  name: string;
}

interface DynamicAgentLite {
  _id: string;
  name?: string;
  enabled?: boolean;
}

interface MCPServerLite {
  _id: string;
  name?: string;
  enabled?: boolean;
}

const DYNAMIC_AGENTS_URL =
  process.env.DYNAMIC_AGENTS_URL || "http://localhost:8100";

function getRagServerUrl(): string {
  return (
    process.env.RAG_SERVER_URL ||
    process.env.NEXT_PUBLIC_RAG_URL ||
    "http://localhost:9446"
  );
}

/** Strip the OpenFGA `<type>:` prefix, returning the bare object id. */
function stripType(object: string, type: string): string {
  const prefix = `${type}:`;
  return object.startsWith(prefix) ? object.slice(prefix.length) : object;
}

/** Best-effort human label for a tool ref like "jira/search" or "jira/*". */
function humanizeToolRef(ref: string): string {
  const slash = ref.indexOf("/");
  if (slash < 0) return ref;
  const server = ref.slice(0, slash);
  const tool = ref.slice(slash + 1);
  return tool === "*" ? `${server}: all tools` : `${server}: ${tool}`;
}

function isValidToolName(value: string): boolean {
  return /^[A-Za-z0-9._-]+$/.test(value);
}

function toolNameForProbeResult(
  serverId: string,
  tool: Partial<MCPToolInfo>,
): string | null {
  const raw = tool.name || tool.namespaced_name;
  if (!raw) return null;
  const name = raw.startsWith(`${serverId}/`)
    ? raw.slice(serverId.length + 1)
    : raw;
  return isValidToolName(name) ? name : null;
}

function grantableItemsForProbeTools(
  serverId: string,
  tools: Array<Partial<MCPToolInfo>>,
): GrantableItem[] {
  const byRef = new Map<string, GrantableItem>();
  for (const tool of tools) {
    const toolName = toolNameForProbeResult(serverId, tool);
    if (!toolName) continue;
    const ref = `${serverId}/${toolName}`;
    const label = tool.namespaced_name || tool.name || toolName;
    byRef.set(ref, {
      ref,
      name: label.includes("/") ? label : `${serverId}: ${label}`,
    });
  }
  return [...byRef.values()].sort((a, b) => a.name.localeCompare(b.name));
}

function toNextRequest(request: NextRequest | Request): NextRequest {
  if (request instanceof NextRequest) return request;
  return new NextRequest(request.url, {
    headers: request.headers,
    method: request.method,
  });
}

async function hydrateMissingMcpToolCatalog(
  request: NextRequest | Request | undefined,
  serverIds: string[],
): Promise<Map<string, GrantableItem[]>> {
  const discovered = new Map<string, GrantableItem[]>();
  if (!request || serverIds.length === 0) return discovered;

  const nextRequest = toNextRequest(request);
  const auth = await authenticateRequest(nextRequest);
  if (auth instanceof NextResponse) return discovered;
  const headers = buildBackendHeaders("application/json", auth);

  const uniqueServerIds = [...new Set(serverIds.filter(isValidToolName))];
  const batchSize = 4;
  for (let i = 0; i < uniqueServerIds.length; i += batchSize) {
    const batch = uniqueServerIds.slice(i, i + batchSize);
    await Promise.all(
      batch.map(async (serverId) => {
        try {
          // assisted-by Codex Codex-sonnet-4-6
          // Super-admin grantable lists should show individual tools without
          // requiring a prior manual Probe click in the MCP Servers tab.
          const response = await fetch(
            `${DYNAMIC_AGENTS_URL}/api/v1/mcp-servers/${encodeURIComponent(serverId)}/probe`,
            { method: "POST", headers },
          );
          if (!response.ok) return;
          const payload = await response.json().catch(() => null);
          const probeResult = (payload?.data ?? payload) as {
            success?: boolean;
            tools?: unknown;
          } | null;
          if (
            !probeResult ||
            probeResult.success === false ||
            !Array.isArray(probeResult.tools)
          )
            return;

          const tools = probeResult.tools as Array<Partial<MCPToolInfo>>;
          const items = grantableItemsForProbeTools(serverId, tools);
          if (items.length > 0) discovered.set(serverId, items);

          try {
            await cacheMcpToolCatalog({ serverId, tools, source: "probe" });
          } catch (cacheError) {
            console.warn(
              "[service-accounts/grantable] failed to cache hydrated tool catalog:",
              cacheError,
            );
          }
        } catch (error) {
          console.warn(
            `[service-accounts/grantable] tool discovery skipped for ${serverId}:`,
            error instanceof Error ? error.message : error,
          );
        }
      }),
    );
  }

  return discovered;
}

async function listFullPlatformCatalog(
  request?: NextRequest | Request,
): Promise<{ agents: GrantableItem[]; tools: GrantableItem[] }> {
  if (!isMongoDBConfigured) {
    throw new Error("MongoDB not configured");
  }

  const agentsCol = await getCollection<DynamicAgentLite>("dynamic_agents");
  const mcpCol = await getCollection<MCPServerLite>("mcp_servers");
  const [allAgents, initialServers] = await Promise.all([
    agentsCol
      .find({ enabled: { $ne: false } } as never, {
        projection: { _id: 1, name: 1 },
      })
      .sort({ name: 1 })
      .toArray(),
    mcpCol
      .find({ enabled: { $ne: false } } as never, {
        projection: { _id: 1, name: 1 },
      })
      .sort({ name: 1 })
      .toArray(),
  ]);
  let allServers = initialServers;
  if (allServers.length === 0) {
    try {
      // assisted-by Codex Codex-sonnet-4-6
      // Match the MCP Servers tab: AgentGateway-discovered servers are runtime
      // state, so a grantable catalog request should recover them if startup
      // seeded zero YAML-backed servers.
      const { syncSelectedAgentGatewayMcpServers } = await import(
        "@/app/api/mcp-servers/agentgateway/_lib"
      );
      await syncSelectedAgentGatewayMcpServers();
      allServers = await mcpCol
        .find({ enabled: { $ne: false } } as never, {
          projection: { _id: 1, name: 1 },
        })
        .sort({ name: 1 })
        .toArray();
    } catch (error) {
      console.warn(
        "[service-accounts/grantable] AgentGateway MCP self-heal skipped:",
        error instanceof Error ? error.message : error,
      );
    }
  }

  const agents = allAgents.map((agent) => ({
    ref: agent._id,
    name: agent.name ?? agent._id,
  }));
  const cachedToolCatalog = await listCachedMcpTools(
    allServers.map((server) => server._id),
  );
  const missingToolServerIds = allServers
    .filter(
      (server) =>
        (cachedToolCatalog.toolsByServer.get(server._id)?.length ?? 0) === 0,
    )
    .map((server) => server._id);
  const hydratedToolsByServer = await hydrateMissingMcpToolCatalog(
    request,
    missingToolServerIds,
  );
  const tools = allServers.flatMap((server) => {
    const wildcardRef = `${server._id}/*`;
    const wildcardItem = {
      ref: wildcardRef,
      name: humanizeToolRef(wildcardRef),
    };
    const cached = cachedToolCatalog.toolsByServer.get(server._id);
    if (cached && cached.length > 0) {
      return [
        wildcardItem,
        ...cached.map((tool) => ({ ref: tool.ref, name: tool.name })),
      ];
    }
    const hydrated = hydratedToolsByServer.get(server._id);
    if (hydrated && hydrated.length > 0) {
      return [wildcardItem, ...hydrated];
    }
    return [wildcardItem];
  });

  agents.sort((a, b) => a.name.localeCompare(b.name));
  tools.sort((a, b) => a.name.localeCompare(b.name));
  return { agents, tools };
}

async function listGrantableDatasources(input: {
  caller: string;
  accessToken?: string;
  org?: string;
  platformAdmin?: boolean;
}): Promise<GrantableItem[]> {
  const objects = await listOpenFgaObjects({
    user: input.caller,
    relation: "can_read",
    type: "data_source",
  });
  let ids = objects.objects.map((object) => stripType(object, "data_source"));

  const names = new Map<string, string>();
  if (input.accessToken && (input.platformAdmin || ids.length > 0)) {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${input.accessToken}`,
      "Content-Type": "application/json",
    };
    if (input.org) headers["X-Tenant-Id"] = input.org;
    try {
      const response = await fetch(`${getRagServerUrl()}/v1/datasources`, {
        method: "GET",
        headers,
      });
      if (response.ok) {
        const payload = (await response.json()) as { datasources?: unknown };
        if (Array.isArray(payload.datasources)) {
          const registryIds: string[] = [];
          for (const raw of payload.datasources) {
            if (!raw || typeof raw !== "object") continue;
            const row = raw as Record<string, unknown>;
            const id =
              typeof row.datasource_id === "string" ? row.datasource_id : "";
            if (!id) continue;
            registryIds.push(id);
            const label =
              typeof row.name === "string" && row.name.trim()
                ? row.name.trim()
                : id;
            names.set(id, label);
          }
          // Org-admin access to RAG is an intentional policy bypass and is not
          // necessarily materialized as one data_source tuple per object. The
          // admin catalog therefore uses the server's own admin-filtered list,
          // while normal callers remain restricted to their OpenFGA objects.
          if (input.platformAdmin) {
            ids = Array.from(new Set([...ids, ...registryIds]));
          }
        }
      }
    } catch {
      // Labels are decorative. The OpenFGA result remains authoritative and
      // raw ids keep the picker functional while RAG is temporarily offline.
    }
  }

  return ids
    .map((ref) => ({ ref, name: names.get(ref) ?? ref }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

async function listGrantableCollections(input: {
  caller: string;
  platformAdmin?: boolean;
}): Promise<GrantableItem[]> {
  let ids: string[] = [];
  if (!input.platformAdmin) {
    const readable = await listOpenFgaObjects({
      user: input.caller,
      relation: "can_read",
      type: "rag_collection",
    });
    ids = readable.objects.map((object) => stripType(object, "rag_collection"));
  }
  const names = new Map<string, string>();

  if (isMongoDBConfigured && (input.platformAdmin || ids.length > 0)) {
    try {
      const collection = await getCollection<RagCollection>(
        RAG_COLLECTIONS_COLLECTION,
      );
      const query = input.platformAdmin ? {} : { _id: { $in: ids } };
      const rows = await collection
        .find(query as never, { projection: { _id: 1, name: 1 } })
        .toArray();
      for (const row of rows) {
        const ref = String(row._id);
        names.set(ref, row.name || ref);
      }
      if (input.platformAdmin) ids = rows.map((row) => String(row._id));
    } catch (error) {
      console.warn(
        "[service-accounts/grantable] collection labels unavailable:",
        error instanceof Error ? error.message : error,
      );
    }
  }

  return Array.from(new Set(ids))
    .map((ref) => ({ ref, name: names.get(ref) ?? ref }))
    .sort((left, right) => left.name.localeCompare(right.name));
}

export async function GET(request?: NextRequest | Request) {
  const session = (await getServerSession(authOptions)) as {
    sub?: string;
    accessToken?: string;
    org?: string;
    user?: { email?: string | null };
  } | null;

  if (!session?.user?.email || !session.sub) {
    return NextResponse.json(
      { success: false, error: "Unauthorized" },
      { status: 401 },
    );
  }

  const caller = `user:${session.sub}`;
  const url = request ? new URL(request.url) : null;
  const isUnlinkedContext = url?.searchParams.get("context") === "unlinked";

  try {
    const platformAdmin = await hasOrganizationAdmin(session);
    if (platformAdmin) {
      const [catalog, datasources, collections] = await Promise.all([
        listFullPlatformCatalog(request),
        listGrantableDatasources({
          caller,
          accessToken: session.accessToken,
          org: session.org,
          platformAdmin: true,
        }),
        listGrantableCollections({ caller, platformAdmin: true }),
      ]);
      return NextResponse.json({
        success: true,
        data: { ...catalog, datasources, collections },
      });
    }

    if (isUnlinkedContext) {
      return NextResponse.json(
        { success: false, error: "Forbidden" },
        { status: 403 },
      );
    }

    const [agentObjects, toolObjects, datasources, collections] =
      await Promise.all([
        listOpenFgaObjects({
          user: caller,
          relation: "can_use",
          type: "agent",
        }),
        listOpenFgaObjects({
          user: caller,
          relation: "can_call",
          type: "tool",
        }),
        listGrantableDatasources({
          caller,
          accessToken: session.accessToken,
          org: session.org,
        }),
        listGrantableCollections({ caller }),
      ]);

    // Resolve friendly names best-effort from the ReBAC resource catalog;
    // fall back to the ref itself so the picker is always usable even if the
    // catalog is unavailable.
    const nameByAgentId = new Map<string, string>();
    try {
      const catalog = await listRebacCatalog({ type: "agent" });
      for (const r of catalog.resources) {
        if (r.type === "agent") nameByAgentId.set(r.id, r.display_name);
      }
    } catch {
      // Names are decorative; ignore catalog failures.
    }

    const agents: GrantableItem[] = agentObjects.objects.map((object) => {
      const ref = stripType(object, "agent");
      return { ref, name: nameByAgentId.get(ref) ?? ref };
    });

    const tools: GrantableItem[] = toolObjects.objects.map((object) => {
      const ref = stripType(object, "tool");
      return { ref, name: humanizeToolRef(ref) };
    });

    // Stable ordering for a predictable picker.
    agents.sort((a, b) => a.name.localeCompare(b.name));
    tools.sort((a, b) => a.name.localeCompare(b.name));

    return NextResponse.json({
      success: true,
      data: { agents, tools, datasources, collections },
    });
  } catch (error) {
    console.error("[service-accounts/grantable] failed:", error);
    return NextResponse.json(
      { success: false, error: "Failed to list grantable resources" },
      { status: 503 },
    );
  }
}
