// CAIPE Platform MCP server — exposes CAIPE's own administrative surface
// (today: agent discovery; more in follow-up PRs) to MCP clients (Claude
// Code, Claude Desktop, Cursor, or another CAIPE agent) over the
// Streamable-HTTP transport (JSON-RPC 2.0 on a single POST).
//
//   POST /api/mcp   { jsonrpc, id, method, params }
//
// Everything goes through the BFF. Every tool re-enters an existing
// authenticated `/api/...` route with the caller's own credentials
// forwarded, so per-user RBAC is identical to the web UI — this route
// adds no new data path, no second authorization model, and holds no
// service identity of its own. See the "CAIPE Platform/Admin MCP server"
// proposal (github.com/caipe-io/ai-platform-engineering discussions) for
// the full design and the phased tool-surface plan this PR starts.
//
// Hand-rolled rather than pulling in @modelcontextprotocol/sdk: the wire
// protocol is plain JSON-RPC and this route only implements initialize /
// ping / tools/list / tools/call, so a dependency isn't justified yet.

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
