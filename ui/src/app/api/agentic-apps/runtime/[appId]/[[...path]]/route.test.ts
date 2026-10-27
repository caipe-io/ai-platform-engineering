/** @jest-environment node */

import { NextRequest } from "next/server";
import { createHash } from "node:crypto";
import { proxyAgenticAppRequest } from "@/lib/agentic-apps/proxy";
import { verifyAgenticAppToken } from "@/lib/agentic-apps/tokens";

import type { ConfiguredAgenticApp } from "@/types/agentic-app";
import { normalizeLegacyAgenticAppManifest, validateAgenticAppManifest } from "../../../../../../../app-sdk/agentic-app-manifest.mjs";
import exampleManifest from "../../../../../../../examples/agentic-apps/shared/manifest.json";

const mockGetAuthenticatedUser = jest.fn();
const mockGetConfiguredAgenticApp = jest.fn();

jest.mock("@/lib/api-middleware", () => ({
  ApiError: class ApiError extends Error {
    statusCode = 401;
  },
  getAuthenticatedUser: (...args: unknown[]) => mockGetAuthenticatedUser(...args),
}));

jest.mock("@/lib/agentic-apps/config", () => ({
  isAgenticAppsEnabled: () => true,
  getConfiguredAgenticApp: (...args: unknown[]) => mockGetConfiguredAgenticApp(...args),
}));

import { GET, POST } from "./route";

const MockApiError = jest.requireMock("@/lib/api-middleware").ApiError as new (
  message?: string,
) => Error & { statusCode: number };

const configuredApp: ConfiguredAgenticApp = {
  manifest: normalizeLegacyAgenticAppManifest({
    id: "example-app",
    displayName: "Example App",
    description: "Example",
    apiVersion: "1.0",
    auth: { mode: "app-scoped-token" },
    runtime: {
      kind: "proxied-next-zone",
      origin: "http://example-app.example.svc",
      mountPath: "/apps/example-app",
    },
    surfaces: { showInHub: true },
    access: {
      requiredRoles: ["user"],
      tokenScopes: ["example-app:read"],
      policyActions: [
        {
          action: "proxy:GET",
          defaultEffect: "allow",
          requiredScopes: ["example-app:read"],
        },
      ],
    },
  }),
  installation: {
    appId: "example-app",
    packageId: "example-app",
    installed: true,
    enabled: true,
    visible: true,
    runtimeMountPath: "/apps/example-app",
  },
};

describe("External App runtime route", () => {
  const previousSecret = process.env.AGENTIC_APP_TOKEN_SECRET;

  beforeAll(() => {
    process.env.AGENTIC_APP_TOKEN_SECRET = "dedicated-test-secret-long-enough";
  });

  beforeEach(() => {
    jest.clearAllMocks();
    mockGetAuthenticatedUser.mockResolvedValue({
      user: { email: "test-user@example.com", name: "Test User", role: "user" },
      session: { sub: "stable-subject", role: "user" },
    });
    mockGetConfiguredAgenticApp.mockReturnValue(configuredApp);
  });

  afterAll(() => {
    if (previousSecret === undefined) delete process.env.AGENTIC_APP_TOKEN_SECRET;
    else process.env.AGENTIC_APP_TOKEN_SECRET = previousSecret;
  });

  it("proxies iframe traffic with a new token and no caller identity headers", async () => {
    const fetchMock = jest.spyOn(global, "fetch").mockResolvedValueOnce(
      new Response("<html>app</html>", {
        headers: { "content-type": "text/html", "x-frame-options": "DENY" },
      }),
    );

    const response = await GET(
      new NextRequest("https://host.example/api/agentic-apps/runtime/example-app", {
        headers: {
          connection: "keep-alive, x-untrusted-hop",
          cookie: "untrusted=session",
          "keep-alive": "timeout=5",
          "sec-fetch-dest": "iframe",
          "x-example-app-position": "admin",
          "x-caipe-roles": "admin",
          "x-caipe-assistant-context": "forged-context",
          "x-untrusted-hop": "remove-me",
        },
      }),
      { params: Promise.resolve({ appId: "example-app", path: [] }) },
    );

    expect(response.status).toBe(200);
    const [, init] = fetchMock.mock.calls[0];
    const headers = new Headers(init?.headers);
    expect(fetchMock.mock.calls[0][0].toString()).toBe("http://example-app.example.svc/");
    expect(headers.get("authorization")).toMatch(/^Bearer /);
    expect(headers.get("x-forwarded-prefix")).toBe("/apps/example-app");
    expect(headers.get("cookie")).toBeNull();
    expect(headers.get("x-caipe-assistant-context")).toBeNull();
    expect(headers.get("keep-alive")).toBeNull();
    expect(headers.get("x-untrusted-hop")).toBeNull();
    expect(headers.get("x-example-app-position")).toBeNull();
    expect(headers.get("x-caipe-roles")).toBe("user");
    expect(response.headers.get("x-frame-options")).toBeNull();

    fetchMock.mockRestore();
  });

  it("signs the actual upstream bearer, body and runtime path for a validated Webex invocation", async () => {
    mockGetAuthenticatedUser.mockResolvedValueOnce({ user: { email: "test-user@example.com", role: "user" },
      session: { sub: "example-user", role: "user", accessToken: "example-obo-token" } });
    mockGetConfiguredAgenticApp.mockReturnValueOnce({ ...configuredApp, manifest: { ...configuredApp.manifest,
      auth: { mode: "forward-user-access-token" }, access: { ...configuredApp.manifest.access,
        policyActions: [{ action: "proxy:POST", defaultEffect: "allow" }] } } });
    const upstream = jest.spyOn(global, "fetch").mockResolvedValueOnce(new Response("data: example\n\n", { headers: { "content-type": "text/event-stream" } }));
    const body = '{"message":"Hello 🌍"}';
    try {
      const result = await proxyAgenticAppRequest(new Request("https://example.test/api/v1/chat/stream/start", {
        method: "POST", body, headers: { "x-caipe-assistant-context": "forged-proof", "x-caipe-roles": "admin" },
      }), { params: Promise.resolve({ appId: "example-app", path: ["api", "items"] }) }, undefined,
      { client: "webex", kind: "direct", conversationId: "example-chat", agentId: "example-agent",
        roomId: "example-room", spaceId: "example-space", threadId: "example-thread" });
      expect(result.status).toBe(200);
      const headers = new Headers(upstream.mock.calls[0][1]?.headers);
      expect(headers.get("authorization")).toBe("Bearer example-obo-token");
      expect(headers.get("x-caipe-roles")).toBe("user");
      const proof = await verifyAgenticAppToken(headers.get("x-caipe-assistant-context")!, "example-app");
      expect(proof).toMatchObject({ sub: "example-user", purpose: "assistant-stream", assistant_context: {
        client: "webex", kind: "direct", conversationId: "example-chat", path: "/api/items", method: "POST",
        bodyHash: createHash("sha256").update(body).digest("hex"), tokenHash: createHash("sha256").update("example-obo-token").digest("hex"),
      } });
      expect(proof.exp - Number(proof.iat)).toBe(60);
    } finally { upstream.mockRestore(); }
  });

  it("fails closed when an operational native API mount has no service origin", async () => {
    const manifest = validateAgenticAppManifest({
      ...exampleManifest,
      ui: { ...exampleManifest.ui, profiles: exampleManifest.ui.profiles.filter((profile) => profile.mode === "native-package") },
      runtime: undefined,
    });
    mockGetConfiguredAgenticApp.mockReturnValueOnce({ manifest, installation: configuredApp.installation });
    const upstream = jest.spyOn(global, "fetch");
    try {
      const response = await GET(new NextRequest("https://host.example/api/agentic-apps/runtime/example-app/api/items"), {
        params: Promise.resolve({ appId: "example-app", path: ["api", "items"] }),
      });
      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({ error: "app_runtime_unavailable" });
      expect(upstream).not.toHaveBeenCalled();
    } finally { upstream.mockRestore(); }
  });

  it("proxies a native API mount without runtime metadata when its service origin is bound", async () => {
    const manifest = validateAgenticAppManifest({
      ...exampleManifest,
      ui: { ...exampleManifest.ui, profiles: exampleManifest.ui.profiles.filter((profile) => profile.mode === "native-package") },
      runtime: undefined,
    });
    mockGetConfiguredAgenticApp.mockReturnValueOnce({
      manifest,
      installation: { ...configuredApp.installation, bindings: { runtimeOrigin: "https://runtime.example.test" } },
    });
    const upstream = jest.spyOn(global, "fetch").mockResolvedValueOnce(new Response('{"ok":true}'));
    try {
      const response = await GET(new NextRequest("https://host.example/api/agentic-apps/runtime/example-app/api/items"), {
        params: Promise.resolve({ appId: "example-app", path: ["api", "items"] }),
      });
      expect(response.status).toBe(200);
      expect(upstream.mock.calls[0][0].toString()).toBe("https://runtime.example.test/api/items");
    } finally { upstream.mockRestore(); }
  });

  it("forwards the server-side user access token for trusted apps", async () => {
    mockGetAuthenticatedUser.mockResolvedValueOnce({
      user: { email: "test-user@example.com", name: "Test User", role: "user" },
      session: {
        sub: "stable-subject",
        role: "user",
        accessToken: "keycloak-user-access-token",
      },
    });
    mockGetConfiguredAgenticApp.mockReturnValueOnce({
      ...configuredApp,
      manifest: {
        ...configuredApp.manifest,
        auth: { mode: "forward-user-access-token" },
      },
    } satisfies ConfiguredAgenticApp);
    const fetchMock = jest.spyOn(global, "fetch").mockResolvedValueOnce(
      new Response(JSON.stringify({ ok: true })),
    );

    const response = await GET(
      new NextRequest("https://host.example/api/agentic-apps/runtime/example-app/api/items", {
        headers: {
          authorization: "Bearer caller-controlled-token",
          cookie: "untrusted=session",
          "x-caipe-auth-mode": "app-scoped-token",
        },
      }),
      { params: Promise.resolve({ appId: "example-app", path: ["api", "items"] }) },
    );

    expect(response.status).toBe(200);
    const headers = new Headers(fetchMock.mock.calls[0][1]?.headers);
    expect(headers.get("authorization")).toBe("Bearer keycloak-user-access-token");
    expect(headers.get("x-caipe-auth-mode")).toBe("forward-user-access-token");
    expect(headers.get("cookie")).toBeNull();
    fetchMock.mockRestore();
  });

  it("fails closed when a trusted app session has no user access token", async () => {
    mockGetConfiguredAgenticApp.mockReturnValueOnce({
      ...configuredApp,
      manifest: {
        ...configuredApp.manifest,
        auth: { mode: "forward-user-access-token" },
      },
    } satisfies ConfiguredAgenticApp);
    const fetchMock = jest.spyOn(global, "fetch");

    const response = await GET(
      new NextRequest("https://host.example/api/agentic-apps/runtime/example-app"),
      { params: Promise.resolve({ appId: "example-app", path: [] }) },
    );

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "user_access_token_required" });
    expect(fetchMock).not.toHaveBeenCalled();
    fetchMock.mockRestore();
  });

  it("does not proxy a disabled installation", async () => {
    mockGetConfiguredAgenticApp.mockReturnValueOnce({
      ...configuredApp,
      installation: { ...configuredApp.installation, enabled: false },
    });
    const fetchMock = jest.spyOn(global, "fetch");
    const response = await GET(
      new NextRequest("https://host.example/api/agentic-apps/runtime/example-app"),
      { params: Promise.resolve({ appId: "example-app", path: [] }) },
    );
    expect(response.status).toBe(404);
    expect(fetchMock).not.toHaveBeenCalled();
    fetchMock.mockRestore();
  });

  it("permits hidden app API access while still enforcing caller role and request policy", async () => {
    const hidden = { ...configuredApp, installation: { ...configuredApp.installation, visible: false } };
    mockGetConfiguredAgenticApp.mockReturnValue(hidden);
    const fetchMock = jest.spyOn(global, "fetch").mockResolvedValue(new Response("ok"));
    const request = () => new NextRequest("https://host.example.test/api/agentic-apps/runtime/example-app");
    const context = { params: Promise.resolve({ appId: "example-app", path: [] }) };
    expect((await GET(request(), context)).status).toBe(200);
    mockGetAuthenticatedUser.mockResolvedValueOnce({ user: { role: "viewer" }, session: { sub: "test-user", role: "viewer" } });
    expect((await GET(request(), context)).status).toBe(403);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    fetchMock.mockRestore();
  });

  it("rejects unauthenticated runtime requests before resolving the app", async () => {
    mockGetAuthenticatedUser.mockRejectedValueOnce(new MockApiError("not signed in"));

    const response = await GET(
      new NextRequest("https://host.example/api/agentic-apps/runtime/example-app"),
      { params: Promise.resolve({ appId: "example-app", path: [] }) },
    );

    expect(response.status).toBe(401);
    expect(mockGetConfiguredAgenticApp).not.toHaveBeenCalled();
  });

  it("rewrites upstream runtime redirects to the canonical public app path", async () => {
    const fetchMock = jest.spyOn(global, "fetch").mockResolvedValueOnce(
      new Response(null, {
        status: 302,
        headers: {
          location: "http://example-app.example.svc/apps/example-app/login?next=%2F",
        },
      }),
    );

    const response = await GET(
      new NextRequest("https://host.example/api/agentic-apps/runtime/example-app"),
      { params: Promise.resolve({ appId: "example-app", path: [] }) },
    );

    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe(
      "/apps/example-app/login?next=%2F",
    );
    fetchMock.mockRestore();
  });

  it.each([
    { scenario: "its declared length", includeContentLength: true },
    { scenario: "the buffered body", includeContentLength: false },
  ])("rejects an app request that exceeds $scenario", async ({ includeContentLength }) => {
    const fetchMock = jest.spyOn(global, "fetch");
    mockGetConfiguredAgenticApp.mockReturnValue({
      ...configuredApp,
      manifest: {
        ...configuredApp.manifest,
        runtime: {
          ...configuredApp.manifest.runtime,
          maxRequestBodyBytes: 4,
        },
        access: {
          ...configuredApp.manifest.access,
          policyActions: [{ action: "proxy:POST", defaultEffect: "allow" }],
        },
      },
    } satisfies ConfiguredAgenticApp);

    const response = await POST(
      new NextRequest("https://host.example/api/agentic-apps/runtime/example-app/import", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(includeContentLength ? { "content-length": "5" } : {}),
        },
        body: "12345",
      }),
      { params: Promise.resolve({ appId: "example-app", path: ["import"] }) },
    );

    expect(response.status).toBe(413);
    expect(await response.json()).toEqual({
      error: "request_body_too_large",
      maxRequestBodyBytes: 4,
    });
    expect(fetchMock).not.toHaveBeenCalled();
    fetchMock.mockRestore();
  });

  it.each([
    ["Accept: text/html without Fetch Metadata", { accept: "text/html" }],
    ["Sec-Fetch-Dest: document", { "sec-fetch-dest": "document" }],
  ])("redirects an unauthenticated document navigation to a relative login URL (%s)", async (_name, headers) => {
    mockGetAuthenticatedUser.mockRejectedValueOnce(new MockApiError("Unauthorized"));

    const response = await GET(
      new NextRequest("https://0.0.0.0:3000/apps/example-app/reports?tab=1", { headers }),
      { params: Promise.resolve({ appId: "example-app", path: ["reports"] }) },
    );

    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toBe(
      "/login?callbackUrl=%2Fapps%2Fexample-app%2Freports%3Ftab%3D1",
    );
  });
});
