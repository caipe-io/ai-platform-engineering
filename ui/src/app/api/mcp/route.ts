// CAIPE Platform MCP server — exposes CAIPE's own administrative surface
// (Phase 1: agent discovery; Phase 2: agent lifecycle writes) to MCP
// clients (Claude Code, Claude Desktop, Cursor, or another CAIPE agent)
// over the Streamable-HTTP transport (JSON-RPC 2.0 on a single POST).
//
//   POST /api/mcp   { jsonrpc, id, method, params }
//
// Everything goes through the BFF. Every tool re-enters an existing
// authenticated `/api/...` route with the caller's own credentials
// forwarded, so per-user RBAC is identical to the web UI — this route
// adds no new data path, no second authorization model, and holds no
// service identity of its own. See the "CAIPE Platform/Admin MCP server"
// proposal (github.com/caipe-io/ai-platform-engineering discussions #2818)
// for the full design and the phased tool-surface plan this PR follows.
//
// Hand-rolled rather than pulling in @modelcontextprotocol/sdk: the wire
// protocol is plain JSON-RPC and this route only implements initialize /
// ping / tools/list / tools/call, so a dependency isn't justified yet.
//
// --- Phase 2 safety-rail decisions (see discussion #2818 open questions) ---
//
// Immutability (is_system / config_driven / platform-default agents reject
// writes) is enforced by the routes these tools forward to
// (`ui/src/app/api/dynamic-agents/route.ts`), not reimplemented here — the
// same invariant as everything else on this endpoint: no second
// enforcement point to keep in sync.
//
// Two rails from the proposal are explicitly NOT implemented, rather than
// half-built:
//   - Self-modification guard (Q3): there is no mechanism today for this
//     route to tell whether the calling principal *is* the agent being
//     edited — a CAIPE agent has no login identity distinct from the human
//     or service account whose forwarded credentials it's using. A fake
//     check here would be worse than an honest gap. caipe_agent_set_prompt
//     says so in its own description instead of silently allowing it.
//   - Creation quotas (Q2): agent creation is already gated by
//     `requireResourcePermission(can_create_agent)` (real team-ownership
//     friction, not "anyone can spam-create"), but there is no numeric
//     rate limit. Not invented here ahead of that design call.
// Revision history / restore (the "immutable agent record" this needs for
// a real undo) is tracked separately as issue #2824 — independently useful
// for the web UI, not MCP-specific, and out of scope for this PR.
// caipe_agent_set_prompt's diff is computed in-flight for that one call;
// nothing is persisted.

import { NextRequest, NextResponse } from "next/server";

import { getAuthFromBearerOrSession } from "@/lib/api-middleware";
import { isPlatformMcpEnabled } from "@/lib/mcp/guard";

export const dynamic = "force-dynamic";

const PROTOCOL_VERSION = "2024-11-05";
const SERVER_INFO = { name: "caipe", version: "0.1.0" };
const MAX_TOOL_RESULT_BYTES = 200_000;

// --- JSON-RPC helpers -------------------------------------------------------

interface RpcRequest {
  jsonrpc: "2.0";
  id?: string | number | null;
  method: string;
  params?: Record<string, unknown>;
}

function rpcResult(id: RpcRequest["id"], result: unknown) {
  return { jsonrpc: "2.0" as const, id: id ?? null, result };
}

function rpcError(id: RpcRequest["id"], code: number, message: string) {
  return { jsonrpc: "2.0" as const, id: id ?? null, error: { code, message } };
}

function byteCount(text: string): number {
  return Buffer.byteLength(text, "utf8");
}

/** A tool result is a single text block (optionally flagged as an error). */
function toolText(text: string, isError = false) {
  return {
    content: [{ type: "text" as const, text }],
    ...(isError ? { isError: true } : {}),
  };
}

function boundToolResult(
  toolName: string,
  result: ReturnType<typeof toolText>,
): ReturnType<typeof toolText> {
  const bytes = result.content.reduce(
    (total, block) => total + byteCount(block.text),
    0,
  );
  if (bytes <= MAX_TOOL_RESULT_BYTES) return result;
  return toolText(
    `${toolName} produced ${bytes} bytes, which exceeds the ${MAX_TOOL_RESULT_BYTES}-byte ` +
      "MCP response limit. Narrow the request (e.g. page through results, or fetch a single " +
      "resource by id instead of listing).",
    true,
  );
}

/** Emit a finite JSON response with an explicit byte boundary. Some MCP
 *  harnesses keep HTTP connections alive, so EOF is not a reliable delimiter. */
function finiteJsonResponse(payload: unknown, status = 200): NextResponse {
  const body = JSON.stringify(payload);
  return new NextResponse(body, {
    status,
    headers: {
      "Cache-Control": "no-store",
      "Content-Length": String(byteCount(body)),
      "Content-Type": "application/json; charset=utf-8",
    },
  });
}

// --- internal route forwarding ----------------------------------------------

/** Origin to reach our own API routes from inside the route handler. Defaults
 *  to the request's own origin; override with CAIPE_MCP_INTERNAL_ORIGIN to
 *  hit the app directly (e.g. skip an ingress hop) in a given deployment. */
function selfOrigin(request: NextRequest): string {
  return (process.env.CAIPE_MCP_INTERNAL_ORIGIN || new URL(request.url).origin).replace(
    /\/$/,
    "",
  );
}

/** Forward the caller's own credentials so the target route re-authenticates
 *  as the same principal — per-resource RBAC stays identical to the web UI. */
function forwardHeaders(request: NextRequest): Record<string, string> {
  const h: Record<string, string> = { "Content-Type": "application/json" };
  const auth = request.headers.get("Authorization");
  const cookie = request.headers.get("cookie");
  if (auth) h.Authorization = auth;
  if (cookie) h.cookie = cookie;
  return h;
}

type Forward = (
  method: string,
  path: string,
  body?: unknown,
) => Promise<{ status: number; json: unknown; text: string }>;

function makeForward(request: NextRequest): Forward {
  const origin = selfOrigin(request);
  const headers = forwardHeaders(request);
  return async (method, path, body) => {
    const res = await fetch(`${origin}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let json: unknown = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      /* non-JSON (e.g. an HTML error page) — leave json null, expose text */
    }
    return { status: res.status, json, text };
  };
}

interface BffEnvelope {
  success?: boolean;
  data?: unknown;
  error?: string;
  message?: string;
}

/** Throw a compact message when a forwarded call failed, so the tool surfaces
 *  a useful error instead of a raw status. On success, unwrap the shared
 *  `{ success, data }` envelope so callers see the payload directly. */
function ensureOk(r: { status: number; json: unknown; text: string }, what: string): unknown {
  if (r.status < 200 || r.status >= 300) {
    const envelope = r.json as BffEnvelope | null;
    const detail = envelope?.error || envelope?.message || r.text.slice(0, 300) || "(no body)";
    throw new Error(`${what} failed (${r.status}): ${detail}`);
  }
  const envelope = r.json as BffEnvelope | null;
  return envelope && typeof envelope === "object" && "data" in envelope
    ? envelope.data
    : envelope;
}

function schema(
  properties: Record<string, unknown>,
  required: string[] = [],
): Record<string, unknown> {
  return { type: "object", properties, required, additionalProperties: false };
}

/** Above this, an O(n·m) LCS diff gets expensive enough to skip. System
 *  prompts are normally a handful of paragraphs; this is a generous ceiling
 *  against a pathological input, not a realistic one. */
const MAX_DIFF_CELLS = 4_000_000;

/**
 * Minimal unified line diff (no dependency — this is the only caller).
 * Classic LCS via dynamic programming, then a straight backtrack into
 * `- removed` / `+ added` / `  unchanged` lines. No context windowing:
 * prompts are short enough that showing every line is more useful than a
 * hunk-truncated view.
 */
function diffLines(before: string, after: string): string {
  const a = before.split("\n");
  const b = after.split("\n");
  const n = a.length;
  const m = b.length;
  if (n * m > MAX_DIFF_CELLS) {
    return (
      "(prompt too large to diff)\n\n--- before\n" +
      before +
      "\n\n+++ after\n" +
      after
    );
  }

  const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }

  const lines: string[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      lines.push(`  ${a[i]}`);
      i++;
      j++;
    } else if (lcs[i + 1][j] >= lcs[i][j + 1]) {
      lines.push(`- ${a[i]}`);
      i++;
    } else {
      lines.push(`+ ${b[j]}`);
      j++;
    }
  }
  while (i < n) {
    lines.push(`- ${a[i]}`);
    i++;
  }
  while (j < m) {
    lines.push(`+ ${b[j]}`);
    j++;
  }
  return lines.join("\n");
}

// --- tool registry -----------------------------------------------------------

interface ToolContext {
  request: NextRequest;
  fwd: Forward;
  user: { email: string; name: string; role: string };
  session: Record<string, unknown>;
}

interface ToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  handler: (ctx: ToolContext, args: Record<string, unknown>) => Promise<ReturnType<typeof toolText>>;
}

const TOOLS: ToolDef[] = [
  {
    name: "caipe_whoami",
    description:
      "Show the identity, role and admin flags this MCP session is authenticated as. " +
      "Call this first to confirm which CAIPE principal every other tool call will act as.",
    inputSchema: schema({}),
    handler: async (ctx) =>
      toolText(
        JSON.stringify(
          {
            email: ctx.user.email,
            name: ctx.user.name,
            role: ctx.user.role,
            is_admin: ctx.user.role === "admin",
            auth_method: ctx.session.authMethod ?? null,
            principal_type: ctx.session.principalType ?? "user",
          },
          null,
          2,
        ),
      ),
  },
  {
    name: "caipe_agent_list",
    description:
      "List the CAIPE dynamic agents the authenticated caller can see, permission-filtered " +
      "identically to the web UI's agent picker. Use this to resolve an agent's id before " +
      "calling caipe_agent_get.",
    inputSchema: schema({
      search: { type: "string", description: "Filter by name/description substring." },
      enabled_only: { type: "boolean", description: "Only agents usable in a new chat." },
    }),
    handler: async (ctx, args) => {
      const params = new URLSearchParams();
      if (typeof args.search === "string" && args.search.trim()) {
        params.set("search", args.search.trim());
      }
      if (args.enabled_only === true) params.set("enabled_only", "true");
      const qs = params.toString();
      const data = ensureOk(
        await ctx.fwd("GET", `/api/dynamic-agents${qs ? `?${qs}` : ""}`),
        "list agents",
      );
      return toolText(JSON.stringify(data, null, 2));
    },
  },
  {
    name: "caipe_agent_get",
    description:
      "Get a single CAIPE dynamic agent's full configuration by id — name, system_prompt, " +
      "allowed_tools, subagents, skills, model, visibility — if the caller has access to it.",
    inputSchema: schema({ agent_id: { type: "string" } }, ["agent_id"]),
    handler: async (ctx, args) => {
      const agentId = String(args.agent_id ?? "").trim();
      if (!agentId) return toolText("agent_id is required.", true);
      const data = ensureOk(
        await ctx.fwd("GET", `/api/dynamic-agents/agents/${encodeURIComponent(agentId)}`),
        "get agent",
      );
      return toolText(JSON.stringify(data, null, 2));
    },
  },
  {
    name: "caipe_agent_available_tools",
    description:
      "List the built-in tool types an agent can be given. Pass agent_id to also list the " +
      "agents eligible as its subagents (requires manage access on that agent). Call this " +
      "before caipe_agent_create or caipe_agent_update when composing allowed_tools or " +
      "subagents, so you pass real names/ids instead of guessing them.",
    inputSchema: schema({
      agent_id: {
        type: "string",
        description: "Optional. Also list agents eligible as this agent's subagents.",
      },
    }),
    handler: async (ctx, args) => {
      const builtinTools = ensureOk(
        await ctx.fwd("GET", "/api/dynamic-agents/builtin-tools"),
        "list builtin tools",
      );
      const agentId = typeof args.agent_id === "string" ? args.agent_id.trim() : "";
      const availableSubagents = agentId
        ? ensureOk(
            await ctx.fwd(
              "GET",
              `/api/dynamic-agents/available-subagents?id=${encodeURIComponent(agentId)}`,
            ),
            "list available subagents",
          )
        : undefined;
      return toolText(
        JSON.stringify({ builtin_tools: builtinTools, available_subagents: availableSubagents }, null, 2),
      );
    },
  },
  {
    name: "caipe_agent_create",
    description:
      "Create a new CAIPE dynamic agent. Requires name, system_prompt, and model " +
      "({ id, provider }). Team-visibility agents (the default) also require " +
      "owner_team_slug — call caipe_whoami first to see which teams you belong to. Rejects " +
      "global visibility unless the caller is a platform admin. Call " +
      "caipe_agent_available_tools first for valid allowed_tools server names.",
    inputSchema: schema(
      {
        name: { type: "string" },
        system_prompt: { type: "string" },
        model: {
          type: "object",
          description: "{ id: string, provider: string, reasoning_effort?: 'low'|'medium'|'high'|'max' }",
        },
        description: { type: "string" },
        owner_team_slug: {
          type: "string",
          description: "Required unless visibility is 'global'.",
        },
        visibility: { type: "string", enum: ["team", "global"] },
        allowed_tools: {
          type: "object",
          description: "server_id -> tool names[], true (all tools), or false (disabled).",
        },
        subagents: {
          type: "array",
          items: { type: "object" },
          description: "[{ agent_id, name, description }]",
        },
        skills: { type: "array", items: { type: "string" } },
        enabled: { type: "boolean" },
      },
      ["name", "system_prompt", "model"],
    ),
    handler: async (ctx, args) => {
      const data = ensureOk(await ctx.fwd("POST", "/api/dynamic-agents", args), "create agent");
      return toolText(JSON.stringify(data, null, 2));
    },
  },
  {
    name: "caipe_agent_update",
    description:
      "Update a CAIPE dynamic agent's mutable fields. Pass agent_id plus only the fields " +
      "you want to change — omitted fields are left as-is. Rejected for system or " +
      "config-driven agents (edit config.yaml instead); config-driven means it was loaded " +
      "from a YAML file rather than created through the UI/API. For system_prompt " +
      "specifically, prefer caipe_agent_set_prompt, which returns a diff of the change.",
    inputSchema: schema(
      {
        agent_id: { type: "string" },
        name: { type: "string" },
        description: { type: "string" },
        system_prompt: { type: "string" },
        allowed_tools: { type: "object" },
        model: { type: "object" },
        visibility: { type: "string", enum: ["team", "global"] },
        shared_with_teams: { type: "array", items: { type: "string" } },
        subagents: { type: "array", items: { type: "object" } },
        skills: { type: "array", items: { type: "string" } },
        datasource_ids: { type: "array", items: { type: "string" } },
        rag_collection_ids: { type: "array", items: { type: "string" } },
        enabled: { type: "boolean" },
      },
      ["agent_id"],
    ),
    handler: async (ctx, args) => {
      const { agent_id, ...fields } = args;
      const agentId = typeof agent_id === "string" ? agent_id.trim() : "";
      if (!agentId) return toolText("agent_id is required.", true);
      if (Object.keys(fields).length === 0) {
        return toolText("Nothing to update — pass at least one field besides agent_id.", true);
      }
      const data = ensureOk(
        await ctx.fwd("PUT", `/api/dynamic-agents?id=${encodeURIComponent(agentId)}`, fields),
        "update agent",
      );
      return toolText(JSON.stringify(data, null, 2));
    },
  },
  {
    name: "caipe_agent_set_prompt",
    description:
      "Replace a CAIPE dynamic agent's system_prompt and return a unified diff of the " +
      "change. Rejected for system or config-driven agents. There is no persisted revision " +
      "history yet (github.com/caipe-io/ai-platform-engineering issue #2824) — read the " +
      "returned diff before trusting the write; there is nothing to restore from if it's " +
      "wrong. If the caller is itself the agent being edited, this is a self-modification " +
      "with no programmatic guard today (discussion #2818, open question).",
    inputSchema: schema(
      { agent_id: { type: "string" }, system_prompt: { type: "string" } },
      ["agent_id", "system_prompt"],
    ),
    handler: async (ctx, args) => {
      const agentId = typeof args.agent_id === "string" ? args.agent_id.trim() : "";
      const nextPrompt = typeof args.system_prompt === "string" ? args.system_prompt : "";
      if (!agentId) return toolText("agent_id is required.", true);
      const current = (await ensureOk(
        await ctx.fwd("GET", `/api/dynamic-agents/agents/${encodeURIComponent(agentId)}`),
        "get agent",
      )) as { system_prompt?: string; name?: string };
      const label = current.name || agentId;
      const previousPrompt = typeof current.system_prompt === "string" ? current.system_prompt : "";
      if (previousPrompt === nextPrompt) {
        return toolText(`${label}'s system_prompt is already exactly this. No change made.`);
      }
      await ensureOk(
        await ctx.fwd("PUT", `/api/dynamic-agents?id=${encodeURIComponent(agentId)}`, {
          system_prompt: nextPrompt,
        }),
        "update agent prompt",
      );
      return toolText(
        `Updated ${label}'s system_prompt.\n\n--- before\n+++ after\n${diffLines(previousPrompt, nextPrompt)}`,
      );
    },
  },
  {
    name: "caipe_agent_delete",
    description:
      "Permanently delete a CAIPE dynamic agent. Irreversible — there is no revision " +
      "history to restore from yet (issue #2824). Rejected for system, config-driven, and " +
      "platform-default agents (clear the platform default in Settings first).",
    inputSchema: schema({ agent_id: { type: "string" } }, ["agent_id"]),
    handler: async (ctx, args) => {
      const agentId = typeof args.agent_id === "string" ? args.agent_id.trim() : "";
      if (!agentId) return toolText("agent_id is required.", true);
      const data = ensureOk(
        await ctx.fwd("DELETE", `/api/dynamic-agents?id=${encodeURIComponent(agentId)}`),
        "delete agent",
      );
      return toolText(JSON.stringify(data, null, 2));
    },
  },
];

const TOOLS_BY_NAME = new Map(TOOLS.map((t) => [t.name, t]));

// --- JSON-RPC dispatch --------------------------------------------------------

async function dispatch(rpc: RpcRequest, ctx: ToolContext) {
  switch (rpc.method) {
    case "initialize": {
      const requested = (rpc.params?.protocolVersion as string) || PROTOCOL_VERSION;
      return rpcResult(rpc.id, {
        protocolVersion: requested,
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
      });
    }
    case "ping":
      return rpcResult(rpc.id, {});
    case "tools/list":
      return rpcResult(rpc.id, {
        tools: TOOLS.map((t) => ({
          name: t.name,
          description: t.description,
          inputSchema: t.inputSchema,
        })),
      });
    case "tools/call": {
      const name = rpc.params?.name as string;
      const args = (rpc.params?.arguments as Record<string, unknown>) ?? {};
      const tool = TOOLS_BY_NAME.get(name);
      if (!tool) return rpcError(rpc.id, -32602, `Unknown tool: ${name}`);
      try {
        const result = await tool.handler(ctx, args);
        return rpcResult(rpc.id, boundToolResult(name, result));
      } catch (e) {
        // Tool-level failures are reported as a tool result with isError, not
        // a protocol error, so the model can read and react to the message.
        return rpcResult(rpc.id, toolText(e instanceof Error ? e.message : String(e), true));
      }
    }
    default:
      return rpcError(rpc.id, -32601, `Method not found: ${rpc.method}`);
  }
}

// --- auth / discovery ---------------------------------------------------------

/** RFC 9728 protected-resource metadata URL a client should fetch after a 401,
 *  to discover the authorization server and self-register (RFC 7591 DCR). */
function resourceMetadataUrl(request: NextRequest): string {
  const configured = process.env.NEXTAUTH_URL;
  let origin: string;
  try {
    origin = configured ? new URL(configured).origin : new URL(request.url).origin;
  } catch {
    origin = new URL(request.url).origin;
  }
  const xfHost = request.headers.get("x-forwarded-host");
  if (!configured && xfHost) {
    origin = `${request.headers.get("x-forwarded-proto") || "https"}://${xfHost}`;
  }
  return `${origin}/.well-known/oauth-protected-resource/api/mcp`;
}

function unauthorizedResponse(request: NextRequest): NextResponse {
  return NextResponse.json(
    rpcError(null, -32001, "Unauthorized: authenticate, or provide a valid bearer token."),
    {
      status: 401,
      headers: {
        "WWW-Authenticate": `Bearer realm="caipe-mcp", resource_metadata="${resourceMetadataUrl(request)}"`,
      },
    },
  );
}

export async function POST(request: NextRequest) {
  // Feature gate: 404 (not 401/403) when disabled, so a deployment that
  // hasn't opted in doesn't advertise the surface.
  if (!isPlatformMcpEnabled()) {
    return new NextResponse("Not found", { status: 404 });
  }

  let auth: { user: { email: string; name: string; role: string }; session: Record<string, unknown> };
  try {
    const resolved = await getAuthFromBearerOrSession(request);
    auth = { user: resolved.user, session: resolved.session as Record<string, unknown> };
  } catch {
    return unauthorizedResponse(request);
  }

  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return finiteJsonResponse(rpcError(null, -32700, "Parse error"), 400);
  }

  const fwd = makeForward(request);
  const ctx = { request, fwd, user: auth.user, session: auth.session };

  // Support JSON-RPC batches as well as single requests.
  const isBatch = Array.isArray(payload);
  const items = (isBatch ? payload : [payload]) as RpcRequest[];

  const responses = [];
  for (const rpc of items) {
    if (!rpc || rpc.jsonrpc !== "2.0" || typeof rpc.method !== "string") {
      responses.push(rpcError(rpc?.id ?? null, -32600, "Invalid Request"));
      continue;
    }
    // Notifications (no id, e.g. notifications/initialized) get no response.
    const isNotification = rpc.id === undefined || rpc.id === null;
    const res = await dispatch(rpc, ctx);
    if (!isNotification) responses.push(res);
  }

  if (!responses.length) {
    return new NextResponse(null, {
      status: 202,
      headers: { "Cache-Control": "no-store", "Content-Length": "0" },
    });
  }
  return finiteJsonResponse(isBatch ? responses : responses[0]);
}

// Exported for tests and for a future REST/OpenAPI facade over the same
// tool registry (mirroring the pattern this route's own header describes).
export function getPlatformMcpTools(): readonly ToolDef[] {
  return TOOLS;
}

export function getPlatformMcpTool(name: string): ToolDef | undefined {
  return TOOLS_BY_NAME.get(name);
}
