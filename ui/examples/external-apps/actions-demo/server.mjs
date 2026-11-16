#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0

import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { fileURLToPath, pathToFileURL } from "node:url";

import { createDemoJwtVerifier } from "./auth.mjs";

const APP_ID = "actions-demo";
const PUBLIC_BASE_PATH = `/apps/${APP_ID}`;
const DEFAULT_PORT = 3021;
const MAX_STREAM_BODY_BYTES = 64 * 1024;
// A message action carries up to 60,000 characters of text, up to four bytes each.
const MAX_ACTION_BODY_BYTES = 256 * 1024;
const MAX_RECORDED_CALLS = 20;
// Longer than the host's 30 s timeout, so the host's timeout path can be seen.
const DEFAULT_SLOW_MS = 35_000;
const SDK_DIR = fileURLToPath(new URL("../../../app-sdk/", import.meta.url));
// Served from the repo so the demo cannot drift from the SDK it exercises.
const SDK_FILES = new Map([
  ["/assets/sdk/iframe-bridge.mjs", "iframe-bridge.mjs"],
  ["/assets/sdk/assistant-options.mjs", "assistant-options.mjs"],
]);
const ACTIONS = new Map([
  ["/api/assistant/actions/flag", "flag-answer"],
  ["/api/assistant/actions/mark", "mark"],
]);
const INDEX_TEMPLATE = readFileSync(new URL("./public/index.html", import.meta.url), "utf8");
const APP_CSS = readFileSync(new URL("./public/app.css", import.meta.url), "utf8");
const APP_JS = readFileSync(new URL("./public/app.js", import.meta.url), "utf8");

export function createActionsDemoServer({
  secret = process.env.AGENTIC_APP_TOKEN_SECRET,
  issuer = process.env.AGENTIC_APP_TOKEN_ISSUER,
  slowMs = DEFAULT_SLOW_MS,
  sdkDir = process.env.ACTIONS_DEMO_SDK_DIR ?? SDK_DIR,
} = {}) {
  const verifyRequest = createDemoJwtVerifier({ secret, issuer });
  const received = [];

  return createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
      const routePath = stripPublicBasePath(url.pathname);

      if (routePath === "/healthz" && (request.method === "GET" || request.method === "HEAD")) {
        return sendJson(request, response, 200, { ok: true, appId: APP_ID });
      }

      const authorization = verifyRequest(request.headers, scopeFor(request.method));
      if (!authorization.ok) {
        return sendJson(
          request, response, authorization.status,
          { error: authorization.error, ...(authorization.requiredScope ? { requiredScope: authorization.requiredScope } : {}) },
          authorization.status === 401 ? { "www-authenticate": `Bearer realm="agentic-app:${APP_ID}"` } : {},
        );
      }

      if (request.method === "GET" || request.method === "HEAD") {
        if (routePath === "/" || routePath === "/dashboard") {
          const html = INDEX_TEMPLATE.replaceAll("__BASE_PATH__", PUBLIC_BASE_PATH);
          return send(request, response, 200, html, "text/html; charset=utf-8");
        }
        if (routePath === "/assets/app.css") return send(request, response, 200, APP_CSS, "text/css; charset=utf-8");
        if (routePath === "/assets/app.js") return send(request, response, 200, APP_JS, "text/javascript; charset=utf-8");
        if (SDK_FILES.has(routePath)) {
          const source = readFileSync(`${sdkDir}${SDK_FILES.get(routePath)}`, "utf8");
          return send(request, response, 200, source, "text/javascript; charset=utf-8");
        }
        if (routePath === "/api/assistant/actions/received") {
          return sendJson(request, response, 200, { calls: received });
        }
        return sendJson(request, response, 404, { error: "not_found" });
      }

      if (request.method === "POST" && routePath === "/api/assistant/stream") {
        return await streamAnswer(request, response);
      }

      if (request.method === "POST" && ACTIONS.has(routePath)) {
        return await handleAction(request, response, {
          actionId: ACTIONS.get(routePath), subject: authorization.identity.subject, received, slowMs,
        });
      }

      return sendJson(request, response, request.method === "POST" ? 404 : 405, {
        error: request.method === "POST" ? "not_found" : "method_not_allowed",
      });
    } catch {
      return sendJson(request, response, 500, { error: "internal_error" });
    }
  });
}

/** One finished answer, in the AG-UI frames the host chat expects. */
async function streamAnswer(request, response) {
  let body;
  try {
    body = await readJsonBody(request, MAX_STREAM_BODY_BYTES);
  } catch (error) {
    return sendBodyError(request, response, error);
  }
  if (typeof body.message !== "string" || typeof body.conversation_id !== "string") {
    return sendJson(request, response, 400, { error: "invalid_request" });
  }
  const frames = [
    ["RUN_STARTED", { runId: "demo-run", threadId: body.conversation_id }],
    ["TEXT_MESSAGE_START", { messageId: "demo-message", role: "assistant" }],
    ["TEXT_MESSAGE_CONTENT", { messageId: "demo-message", delta: `Demo answer to: ${body.message}` }],
    ["TEXT_MESSAGE_END", { messageId: "demo-message" }],
    ["RUN_FINISHED", { runId: "demo-run", threadId: body.conversation_id }],
  ];
  response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", "x-content-type-options": "nosniff" });
  // The parser splits on a blank line and takes the event name only from the `event:` line.
  response.end(frames.map(([type, data]) => `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`).join(""));
}

/** Records the call, then answers by the submitted text so every host error path can be tried. */
async function handleAction(request, response, { actionId, subject, received, slowMs }) {
  let body;
  try {
    body = await readJsonBody(request, MAX_ACTION_BODY_BYTES);
  } catch (error) {
    return sendBodyError(request, response, error);
  }
  const fields = ["conversation_id", "message_id", "turn_id", "action_id"];
  if (fields.some((field) => typeof body[field] !== "string" || !body[field]) ||
      (body.text !== undefined && typeof body.text !== "string") || body.action_id !== actionId) {
    return sendJson(request, response, 400, { error: "invalid_request", code: "DEMO_INVALID_REQUEST" });
  }
  received.unshift({
    receivedAt: new Date().toISOString(), subject, actionId: body.action_id,
    conversationId: body.conversation_id, messageId: body.message_id, turnId: body.turn_id,
    ...(body.text !== undefined ? { text: body.text } : {}),
  });
  received.length = Math.min(received.length, MAX_RECORDED_CALLS);

  const text = (body.text ?? "").toLowerCase();
  if (text.includes("fail")) return sendJson(request, response, 422, { error: "Demo failure", code: "DEMO_FAILURE" });
  if (text.includes("expired")) return sendJson(request, response, 401, { error: "Demo token expired", code: "DEMO_EXPIRED" });
  if (text.includes("html")) return send(request, response, 200, "<p>not json</p>", "text/html; charset=utf-8");
  if (text.includes("redirect")) return send(request, response, 302, "", "text/plain", { location: "https://other.example.test/elsewhere" });
  if (text.includes("slow")) {
    await new Promise((resolve) => {
      const timer = setTimeout(resolve, slowMs);
      request.on("close", () => { clearTimeout(timer); resolve(); });
    });
    if (response.destroyed || response.writableEnded) return undefined;
  }
  return sendJson(request, response, 200, { message: "Recorded" });
}

function scopeFor(method) {
  return method === "GET" || method === "HEAD" ? `${APP_ID}:read` : `${APP_ID}:write`;
}

function stripPublicBasePath(pathname) {
  if (pathname === PUBLIC_BASE_PATH || pathname === `${PUBLIC_BASE_PATH}/`) return "/";
  if (pathname.startsWith(`${PUBLIC_BASE_PATH}/`)) return pathname.slice(PUBLIC_BASE_PATH.length) || "/";
  return pathname;
}

async function readJsonBody(request, limit) {
  const chunks = [];
  let total = 0;
  for await (const chunk of request) {
    total += chunk.length;
    if (total > limit) throw new Error("request_too_large");
    chunks.push(chunk);
  }
  if (!chunks.length) throw new Error("invalid_json");
  const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("invalid_json");
  return parsed;
}

function sendBodyError(request, response, error) {
  const tooLarge = error instanceof Error && error.message === "request_too_large";
  return sendJson(request, response, tooLarge ? 413 : 400, { error: tooLarge ? "request_too_large" : "invalid_json" });
}

function sendJson(request, response, status, body, extraHeaders = {}) {
  return send(request, response, status, JSON.stringify(body), "application/json; charset=utf-8", extraHeaders);
}

function send(request, response, status, body, contentType, extraHeaders = {}) {
  response.writeHead(status, {
    "content-type": contentType,
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "content-security-policy": [
      "default-src 'none'", "script-src 'self'", "style-src 'self'", "connect-src 'self'",
      "frame-ancestors 'self'", "base-uri 'none'", "form-action 'self'",
    ].join("; "),
    ...extraHeaders,
  });
  response.end(request.method === "HEAD" ? undefined : body);
}

if (Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number(process.env.ACTIONS_DEMO_PORT ?? DEFAULT_PORT);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error("ACTIONS_DEMO_PORT must be a valid TCP port");
  }
  // Loopback only: the host proxies to it, and the demo records submitted text.
  createActionsDemoServer().listen(port, "127.0.0.1", () => {
    console.log(`Actions demo listening on http://127.0.0.1:${port}`);
  });
}
