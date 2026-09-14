#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0

import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { pathToFileURL } from "node:url";

import { createWeatherJwtVerifier } from "./auth.mjs";
import { fetchWeatherDashboard } from "./provider.mjs";

const APP_ID = "weather";
const PUBLIC_BASE_PATH = `/apps/${APP_ID}`;
const DEFAULT_PORT = 3020;
const MAX_REQUEST_BODY_BYTES = 8 * 1024;
const INDEX_TEMPLATE = readFileSync(new URL("./public/index.html", import.meta.url), "utf8");
const APP_CSS = readFileSync(new URL("./public/app.css", import.meta.url), "utf8");
const APP_JS = readFileSync(new URL("./public/app.js", import.meta.url), "utf8");

export function createWeatherServer({
  secret = process.env.AGENTIC_APP_TOKEN_SECRET,
  issuer = process.env.AGENTIC_APP_TOKEN_ISSUER,
  fetchImpl = globalThis.fetch,
  weatherProvider = fetchWeatherDashboard,
} = {}) {
  const verifyRequest = createWeatherJwtVerifier({ secret, issuer });
  const preferences = new Map();

  return createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
      const routePath = stripPublicBasePath(url.pathname);

      if (
        routePath === "/healthz" &&
        (request.method === "GET" || request.method === "HEAD")
      ) {
        return sendJson(request, response, 200, { ok: true, appId: APP_ID });
      }

      const requiredScope = scopeFor(request.method, routePath);
      const authorization = verifyRequest(request.headers, requiredScope);
      if (!authorization.ok) {
        return sendJson(
          request,
          response,
          authorization.status,
          {
            error: authorization.error,
            ...(authorization.requiredScope
              ? { requiredScope: authorization.requiredScope }
              : {}),
          },
          authorization.status === 401
            ? { "www-authenticate": 'Bearer realm="agentic-app:weather"' }
            : {},
        );
      }

      let publicBasePath;
      try {
        publicBasePath = resolvePublicBasePath(request.headers);
      } catch {
        return sendJson(request, response, 400, { error: "invalid_forwarded_prefix" });
      }

      if (request.method === "GET" || request.method === "HEAD") {
        if (routePath === "/" || routePath === "/dashboard") {
          const html = INDEX_TEMPLATE.replaceAll("__WEATHER_BASE_PATH__", publicBasePath);
          return send(request, response, 200, html, "text/html; charset=utf-8");
        }
        if (routePath === "/assets/app.css") {
          return send(request, response, 200, APP_CSS, "text/css; charset=utf-8");
        }
        if (routePath === "/assets/app.js") {
          return send(request, response, 200, APP_JS, "text/javascript; charset=utf-8");
        }
        if (routePath === "/api/preferences") {
          return sendJson(request, response, 200, {
            units: preferences.get(authorization.identity.subject) ?? "metric",
          });
        }
        if (routePath === "/api/weather") {
          if (request.method === "HEAD") return send(request, response, 200, "", "application/json");
          const city = String(url.searchParams.get("city") ?? "Berlin").trim();
          try {
            const dashboard = await weatherProvider(city, { fetchImpl });
            return sendJson(request, response, 200, dashboard);
          } catch (error) {
            return sendJson(request, response, 502, {
              error: "weather_provider_unavailable",
              message: error instanceof Error ? error.message : "weather provider unavailable",
            });
          }
        }
        return sendJson(request, response, 404, { error: "not_found" });
      }

      if (request.method === "POST" && routePath === "/api/preferences") {
        let body;
        try {
          body = await readJsonBody(request);
        } catch (error) {
          const tooLarge = error instanceof Error && error.message === "request_too_large";
          return sendJson(request, response, tooLarge ? 413 : 400, {
            error: tooLarge ? "request_too_large" : "invalid_json",
          });
        }
        if (!new Set(["metric", "us"]).has(body.units)) {
          return sendJson(request, response, 400, {
            error: "invalid_units",
            allowed: ["metric", "us"],
          });
        }
        preferences.set(authorization.identity.subject, body.units);
        return sendJson(request, response, 200, { units: body.units });
      }

      return sendJson(
        request,
        response,
        request.method === "POST" ? 404 : 405,
        { error: request.method === "POST" ? "not_found" : "method_not_allowed" },
        request.method === "POST" ? {} : { allow: "GET, HEAD, POST" },
      );
    } catch {
      return sendJson(request, response, 500, { error: "internal_error" });
    }
  });
}

function scopeFor(method, routePath) {
  if (method === "GET" || method === "HEAD") return "weather:read";
  if (method === "POST" && routePath === "/api/preferences") return "weather:write";
  return undefined;
}

function stripPublicBasePath(pathname) {
  if (pathname === PUBLIC_BASE_PATH || pathname === `${PUBLIC_BASE_PATH}/`) return "/";
  if (pathname.startsWith(`${PUBLIC_BASE_PATH}/`)) {
    return pathname.slice(PUBLIC_BASE_PATH.length) || "/";
  }
  return pathname;
}

function resolvePublicBasePath(headers) {
  const raw = headers?.["x-forwarded-prefix"];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (value === undefined) return PUBLIC_BASE_PATH;
  const normalized = String(value).trim().replace(/\/+$/, "");
  if (normalized !== PUBLIC_BASE_PATH) throw new Error("invalid_forwarded_prefix");
  return normalized;
}

async function readJsonBody(request) {
  const chunks = [];
  let total = 0;
  for await (const chunk of request) {
    total += chunk.length;
    if (total > MAX_REQUEST_BODY_BYTES) throw new Error("request_too_large");
    chunks.push(chunk);
  }
  if (!chunks.length) throw new Error("invalid_json");
  const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("invalid_json");
  }
  return parsed;
}

function sendJson(request, response, status, body, extraHeaders = {}) {
  return send(
    request,
    response,
    status,
    JSON.stringify(body),
    "application/json; charset=utf-8",
    extraHeaders,
  );
}

function send(request, response, status, body, contentType, extraHeaders = {}) {
  response.writeHead(status, {
    "content-type": contentType,
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "content-security-policy": [
      "default-src 'none'",
      "script-src 'self'",
      "style-src 'self'",
      "connect-src 'self'",
      "frame-ancestors 'self'",
      "base-uri 'none'",
      "form-action 'self'",
    ].join("; "),
    ...extraHeaders,
  });
  response.end(request.method === "HEAD" ? undefined : body);
}

function isMainModule() {
  return Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href;
}

if (isMainModule()) {
  const port = Number(process.env.WEATHER_APP_PORT ?? DEFAULT_PORT);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error("WEATHER_APP_PORT must be a valid TCP port");
  }
  const server = createWeatherServer();
  server.listen(port, "0.0.0.0", () => {
    console.log(`Weather example listening on http://0.0.0.0:${port}`);
  });
}
