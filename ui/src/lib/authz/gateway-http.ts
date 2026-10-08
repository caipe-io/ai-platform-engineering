import { createHash, randomUUID, timingSafeEqual } from "crypto";
import { NextRequest, NextResponse } from "next/server";

import { authorizeGateway } from "./index";
import { isGatewayIdentifier } from "./gateway-context";
import { HttpAuthzError, metaErrorResponse } from "./http";
import type { GatewayRequest } from "./gateway-contract";

const MAX_BODY_BYTES = 65536;

function reject(status: number, message: string): never {
  throw new HttpAuthzError(status, status === 503 ? "AUTHZ_UNAVAILABLE" :
    status === 401 ? "NOT_AUTHENTICATED" : "INVALID_REQUEST", message);
}

function authenticateGateway(request: NextRequest): void {
  const expected = process.env.CAIPE_GATEWAY_AUTHZ_TOKEN?.trim();
  if (!expected || expected.length < 32) reject(503, "Gateway authorization credential is not configured");
  const supplied = request.headers.get("authorization") ?? "";
  const actual = /^Bearer ([^\s]+)$/.exec(supplied)?.[1];
  const digest = (value: string) => createHash("sha256").update(value).digest();
  if (!actual || actual.length > 512 || !timingSafeEqual(digest(actual), digest(expected))) {
    reject(401, "Gateway workload authentication required");
  }
}

async function readBody(request: NextRequest): Promise<string> {
  const reader = request.body?.getReader();
  if (!reader) return "";
  let size = 0;
  const chunks: Uint8Array[] = [];
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BODY_BYTES) { await reader.cancel(); reject(413, "MCP request body is too large"); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  return Buffer.concat(chunks).toString("utf8");
}

/** Gateway-only HTTP framing. Product policy stays in authorizeGateway(). */
export async function checkGatewayAccess(request: NextRequest): Promise<NextResponse> {
  const correlationId = randomUUID();
  let response: NextResponse;
  try {
    authenticateGateway(request); // Never accept a browser cookie or an ordinary user bearer.
    const sub = request.headers.get("x-caipe-caller-sub");
    if (!isGatewayIdentifier(sub)) reject(400, "Verified gateway caller subject is required");
    const username = request.headers.get("x-caipe-caller-username") ?? "";
    const caller = { type: username.startsWith("service-account-") ? "service_account" as const : "user" as const, id: sub };
    const path = request.headers.get("x-caipe-mcp-path") ?? "";
    const match = /^\/mcp\/([A-Za-z0-9][A-Za-z0-9_.~-]{0,191})\/?$/.exec(path);
    if (!match) reject(400, "Verified MCP route is required");
    let operation: string;
    let toolName: string | undefined;
    if (request.method === "POST") {
      const text = await readBody(request);
      let payload: { jsonrpc?: unknown; method?: unknown; params?: { name?: unknown } };
      try { payload = JSON.parse(text); } catch { reject(400, "Complete MCP JSON-RPC body is required"); }
      if (!payload || Array.isArray(payload) || payload.jsonrpc !== "2.0" || typeof payload.method !== "string") {
        reject(400, "A single MCP JSON-RPC request is required");
      }
      operation = payload.method;
      if (operation === "tools/call") {
        if (typeof payload.params?.name !== "string") reject(400, "Tool name is required");
        toolName = payload.params.name;
      }
    } else if (request.method === "GET" || request.method === "DELETE") {
      operation = `http:${request.method.toLowerCase()}`;
    } else { reject(405, "Unsupported MCP transport method"); }
    const encoded = request.headers.get("x-caipe-agent-context") ?? "";
    const signature = request.headers.get("x-caipe-agent-context-signature") ?? "";
    const req: GatewayRequest = {
      caller, serverId: match[1], operation, ...(toolName !== undefined ? { toolName } : {}),
      ...(encoded || signature ? { signedContext: { encoded, signature } } : {}),
    };
    const result = await authorizeGateway(req, { correlationId });
    // HTTP ext_authz uses STATUS, not JSON decision: DENY must never be 2xx.
    const status = result.decision === "ALLOW" ? 200 : result.reason === "AUTHZ_UNAVAILABLE" ? 503 :
      result.reason === "INVALID_REQUEST" ? 400 : 403;
    response = NextResponse.json(result, { status });
    response.headers.set("x-caipe-decision-id", result.decision_id);
  } catch (err) {
    if (err instanceof HttpAuthzError) response = metaErrorResponse(err);
    else {
      console.error("[access/gateway] Check failed", { correlationId, name: err instanceof Error ? err.name : "UnknownError" });
      response = NextResponse.json({ error: "Gateway authorization unavailable", code: "AUTHZ_UNAVAILABLE", retriable: true }, { status: 503 });
    }
  }
  response.headers.set("Cache-Control", "no-store");
  response.headers.set("x-correlation-id", correlationId);
  return response;
}
