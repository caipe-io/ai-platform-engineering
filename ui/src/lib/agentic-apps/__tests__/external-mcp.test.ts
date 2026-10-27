/** @jest-environment node */
import { NextRequest } from "next/server";
import { normalizeLegacyAgenticAppManifest } from "../../../../app-sdk/agentic-app-manifest.mjs";
import { ApiError } from "@/lib/api-error";
import { proxyAgenticAppRequest } from "../proxy";
import { appForMcpResource, externalMcpRoute } from "../mcp-routing";
import type { ConfiguredAgenticApp } from "@/types/agentic-app";

const mockAuth = jest.fn();
const mockApp = jest.fn();
jest.mock("@/lib/api-middleware", () => ({
  ApiError: jest.requireActual("@/lib/api-error").ApiError,
  getAuthenticatedUser: (...args: unknown[]) => mockAuth(...args),
}));
jest.mock("@/lib/agentic-apps/config", () => ({
  isAgenticAppsEnabled: () => true,
  getConfiguredAgenticApp: () => mockApp(),
}));
jest.mock("@/native-extensions/runtime", () => ({ nativeExtensionById: () => null }));

function app(): ConfiguredAgenticApp {
  const manifest = normalizeLegacyAgenticAppManifest({
    id: "example", displayName: "Example", description: "Example", apiVersion: "1.0",
    auth: { mode: "forward-user-access-token" },
    runtime: { kind: "proxied-next-zone", origin: "http://example.internal", mountPath: "/apps/example" },
    surfaces: { showInHub: true },
    access: { tokenScopes: ["example:read"], policyActions: [
      { action: "proxy:GET", defaultEffect: "allow" }, { action: "proxy:POST", defaultEffect: "allow" },
    ] },
  });
  manifest.api.mcp = { path: "/api/example/mcp", metadataPath: "/.well-known/oauth-protected-resource/api/example/mcp", apiKeyHeader: "x-example-token" };
  return { manifest, installation: { appId: "example", packageId: "example", installed: true, enabled: true, visible: true } };
}
let fetchMock: jest.SpyInstance;
beforeEach(() => {
  jest.clearAllMocks(); mockApp.mockReturnValue(app()); mockAuth.mockRejectedValue(new ApiError("Unauthorized", 401));
  fetchMock = jest.spyOn(global, "fetch").mockResolvedValue(new Response("Unauthorized", {
    status: 401, headers: { "WWW-Authenticate": 'Bearer resource_metadata="https://example.test/discovery"', "set-cookie": "untrusted=1" },
  }));
});
afterEach(() => fetchMock.mockRestore());
function proxy(path: string, headers?: HeadersInit, body?: string) {
  return proxyAgenticAppRequest(new NextRequest(`https://example.test/apps/example${path}`, {
    method: body !== undefined ? "POST" : "GET", headers, ...(body !== undefined ? { body } : {}),
  }), { params: Promise.resolve({ appId: "example", path: path.slice(1).split("/") }) });
}

it("preserves the unauthenticated OAuth challenge without minting or forwarding identity", async () => {
  const response = await proxy("/api/example/mcp", { "x-caipe-user": "forged", "x-caipe-roles": "admin" }, "{}");
  expect(response.status).toBe(401);
  expect(response.headers.get("www-authenticate")).toContain("resource_metadata");
  expect(response.headers.has("set-cookie")).toBe(false);
  expect(mockAuth).not.toHaveBeenCalled();
  const headers = new Headers(fetchMock.mock.calls[0][1].headers);
  for (const name of ["authorization", "cookie", "x-caipe-user", "x-caipe-roles", "x-caipe-app-id", "x-caipe-auth-mode"])
    expect(headers.has(name)).toBe(false);
});

it("does not replace a bad external bearer with a valid browser identity", async () => {
  mockAuth.mockResolvedValue({ user: { role: "admin" }, session: { accessToken: "browser-secret" } });
  expect((await proxy("/api/example/mcp", { authorization: "Bearer invalid", cookie: "session=valid", "x-example-token": "example-key", "mcp-session-id": "example-session" }, "{}")).status).toBe(401);
  const headers = new Headers(fetchMock.mock.calls[0][1].headers);
  expect(headers.get("authorization")).toBe("Bearer invalid");
  expect(headers.get("x-example-token")).toBe("example-key");
  expect(headers.get("mcp-session-id")).toBe("example-session");
  expect(headers.has("cookie")).toBe(false);
  expect(mockAuth).not.toHaveBeenCalled();
});

it("exposes only the declared metadata GET and never forwards credentials to discovery", async () => {
  await proxy("/.well-known/oauth-protected-resource/api/example/mcp", { authorization: "Bearer secret", "x-example-token": "key", cookie: "session=valid" });
  const headers = new Headers(fetchMock.mock.calls[0][1].headers);
  expect(headers.has("authorization")).toBe(false);
  expect(headers.has("x-example-token")).toBe(false);
  expect(mockAuth).not.toHaveBeenCalled();
});

it.each(["/api/example/projects", "/api/example/mcp/other", "/api/example/mcp2", "/.well-known/oauth-protected-resource/other"])("keeps %s behind host session authentication", async path => {
  expect((await proxy(path, { authorization: "Bearer invalid" })).status).toBe(401);
  expect(mockAuth).toHaveBeenCalled(); expect(fetchMock).not.toHaveBeenCalled();
});

it("still enforces installation, method policy, and request size", async () => {
  const configured = app(); configured.installation.enabled = false; mockApp.mockReturnValue(configured);
  expect((await proxy("/api/example/mcp", undefined, "{}")).status).toBe(404);
  configured.installation.enabled = true;
  configured.manifest.access.policyActions = [];
  expect((await proxy("/api/example/mcp", undefined, "{}")).status).toBe(403);
  configured.manifest.access.policyActions = [{ action: "proxy:POST", defaultEffect: "allow" }];
  configured.manifest.runtime!.maxRequestBodyBytes = 2;
  expect((await proxy("/api/example/mcp", undefined, "too big")).status).toBe(413);
  expect(fetchMock).not.toHaveBeenCalled();
});

it("cancels an oversized body without content-length before reading the remaining chunks", async () => {
  const configured = app();
  configured.manifest.runtime!.maxRequestBodyBytes = 3;
  mockApp.mockReturnValue(configured);
  const chunks = ["ab", "cd", "ef"].map(chunk => new TextEncoder().encode(chunk));
  const cancel = jest.fn();
  let index = 0;
  const pull = jest.fn((controller: ReadableStreamDefaultController<Uint8Array>) => {
    if (index < chunks.length) controller.enqueue(chunks[index++]);
    else controller.close();
  });
  const stream = new ReadableStream({ pull, cancel }, { highWaterMark: 0 });
  const request = new Request("https://example.test/apps/example/api/example/mcp", {
    method: "POST", body: stream, duplex: "half",
  } as RequestInit & { duplex: "half" });

  expect(request.headers.has("content-length")).toBe(false);
  const response = await proxyAgenticAppRequest(request, {
    params: Promise.resolve({ appId: "example", path: ["api", "example", "mcp"] }),
  });

  expect(response.status).toBe(413);
  expect(pull).toHaveBeenCalledTimes(2);
  expect(cancel).toHaveBeenCalledTimes(1);
  expect(stream.locked).toBe(false);
  expect(fetchMock).not.toHaveBeenCalled();
});

it("forwards a streamed body at the limit without changing its bytes", async () => {
  const configured = app();
  configured.manifest.runtime!.maxRequestBodyBytes = 3;
  mockApp.mockReturnValue(configured);
  const chunks = [new Uint8Array([0]), new Uint8Array([127, 255])];
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      const chunk = chunks.shift();
      if (chunk) controller.enqueue(chunk);
      else controller.close();
    },
  }, { highWaterMark: 0 });
  const request = new Request("https://example.test/apps/example/api/example/mcp", {
    method: "POST", body: stream, duplex: "half",
  } as RequestInit & { duplex: "half" });

  await proxyAgenticAppRequest(request, {
    params: Promise.resolve({ appId: "example", path: ["api", "example", "mcp"] }),
  });

  expect(fetchMock).toHaveBeenCalledTimes(1);
  expect(new Uint8Array(fetchMock.mock.calls[0][1].body)).toEqual(new Uint8Array([0, 127, 255]));
  expect(stream.locked).toBe(false);
});

it("preserves many tiny chunks without retaining their reusable source buffer", async () => {
  const configured = app();
  configured.manifest.runtime!.maxRequestBodyBytes = 5000;
  mockApp.mockReturnValue(configured);
  const size = 4097;
  const chunk = new Uint8Array(1);
  let offset = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (offset === size) {
        controller.close();
        return;
      }
      chunk[0] = offset++ % 256;
      controller.enqueue(chunk);
    },
  }, { highWaterMark: 0 });
  const request = new Request("https://example.test/apps/example/api/example/mcp", {
    method: "POST", body: stream, duplex: "half",
  } as RequestInit & { duplex: "half" });

  await proxyAgenticAppRequest(request, {
    params: Promise.resolve({ appId: "example", path: ["api", "example", "mcp"] }),
  });

  expect(fetchMock).toHaveBeenCalledTimes(1);
  expect(new Uint8Array(fetchMock.mock.calls[0][1].body)).toEqual(
    Uint8Array.from({ length: size }, (_, index) => index % 256),
  );
  expect(stream.locked).toBe(false);
});

it("routes only a known native or iframe resource to discovery", () => {
  const configured = app();
  expect(appForMcpResource([configured], "/apps/example/api/example/mcp")).toBe(configured);
  expect(appForMcpResource([configured], "/api/example/mcp")).toBeNull();
  configured.manifest.api.mounts = ["/api/example"];
  expect(appForMcpResource([configured], "/api/example/mcp")).toBe(configured);
  expect(appForMcpResource([configured], "/api/example/other")).toBeNull();
  expect(externalMcpRoute(configured.manifest, "PUT", configured.manifest.api.mcp!.metadataPath)).toBeNull();
  expect(() => appForMcpResource([configured, configured], "/api/example/mcp")).toThrow("Ambiguous");
});
