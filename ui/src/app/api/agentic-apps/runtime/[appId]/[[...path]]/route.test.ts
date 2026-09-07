/** @jest-environment node */

import { NextRequest } from "next/server";

import type { ConfiguredAgenticApp } from "@/types/agentic-app";

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

import { GET } from "./route";

const configuredApp: ConfiguredAgenticApp = {
  manifest: {
    id: "example-app",
    displayName: "Example App",
    description: "Example",
    apiVersion: "1.0",
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
  },
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
    expect(headers.get("keep-alive")).toBeNull();
    expect(headers.get("x-untrusted-hop")).toBeNull();
    expect(headers.get("x-example-app-position")).toBeNull();
    expect(response.headers.get("x-frame-options")).toBeNull();

    fetchMock.mockRestore();
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
});
