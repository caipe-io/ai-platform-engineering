/** @jest-environment node */

import { NextRequest } from "next/server";

import { proxy } from "./proxy";

const mockGetToken = jest.fn();

jest.mock("next-auth/jwt", () => ({
  getToken: (...args: unknown[]) => mockGetToken(...args),
}));

describe("External Apps request routing", () => {
  it("keeps a top-level document request on the canonical host page", async () => {
    const response = await proxy(
      new NextRequest("https://host.example/apps/example-app/report?range=week", {
        headers: { "sec-fetch-dest": "document" },
      }),
    );

    expect(response.headers.get("x-middleware-next")).toBe("1");
    expect(response.headers.get("x-middleware-rewrite")).toBeNull();
  });

  it.each([
    ["iframe", "GET", { "sec-fetch-dest": "iframe" }],
    ["script", "GET", { "sec-fetch-dest": "script" }],
    ["browser fetch", "GET", { "sec-fetch-dest": "empty" }],
    ["API mutation", "POST", { "content-type": "application/json" }],
  ])("rewrites %s requests to the private runtime route", async (_name, method, headers) => {
    const response = await proxy(
      new NextRequest("https://host.example/apps/example-app/api/items?range=week", {
        method,
        headers,
      }),
    );

    expect(response.headers.get("x-middleware-next")).toBeNull();
    expect(response.headers.get("x-middleware-rewrite")).toBe(
      "https://host.example/api/agentic-apps/runtime/example-app/api/items?range=week",
    );
    expect(response.headers.get("x-frame-options")).toBe("SAMEORIGIN");
  });

  it.each([
    "https://host.example/apps",
    "https://host.example/apps/",
    "https://host.example/apps/embed/example-app",
    "https://host.example/apps/Invalid_App",
  ])("never rewrites reserved or non-app path %s", async (url) => {
    const response = await proxy(
      new NextRequest(url, { headers: { "sec-fetch-dest": "iframe" } }),
    );

    expect(response.headers.get("x-middleware-next")).toBe("1");
    expect(response.headers.get("x-middleware-rewrite")).toBeNull();
  });
});

describe("impersonation read-only enforcement", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetToken.mockResolvedValue({
      impersonation: { targetSub: "target-sub" },
    });
  });

  function request(path: string, method = "GET"): NextRequest {
    return new NextRequest(`https://host.example${path}`, {
      method,
      headers: { cookie: "next-auth.session-token=encrypted-session" },
    });
  }

  it("allows ordinary reads", async () => {
    const response = await proxy(request("/api/chat/conversations"));

    expect(response.headers.get("x-middleware-next")).toBe("1");
    expect(mockGetToken).not.toHaveBeenCalled();
  });

  it("blocks mutations from an impersonated browser session", async () => {
    const response = await proxy(request("/api/chat/conversations", "POST"));

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({
      code: "IMPERSONATION_READ_ONLY",
    });
  });

  it("blocks mutations sent through page and embedded-app routes", async () => {
    const pageResponse = await proxy(request("/settings", "POST"));
    const appResponse = await proxy(request("/apps/example-app/api/items", "POST"));

    expect(pageResponse.status).toBe(403);
    expect(appResponse.status).toBe(403);
  });

  it("blocks connected credential reads while impersonating", async () => {
    const response = await proxy(request("/api/credentials/connections"));

    expect(response.status).toBe(403);
  });

  it("allows the session update and sign-out requests needed to exit", async () => {
    const updateResponse = await proxy(request("/api/auth/session", "POST"));
    const signOutResponse = await proxy(request("/api/auth/signout", "POST"));

    expect(updateResponse.headers.get("x-middleware-next")).toBe("1");
    expect(signOutResponse.headers.get("x-middleware-next")).toBe("1");
    expect(mockGetToken).not.toHaveBeenCalled();
  });

  it("does not block an ordinary session", async () => {
    mockGetToken.mockResolvedValue({ sub: "ordinary-user" });

    const response = await proxy(request("/api/settings", "PUT"));

    expect(response.headers.get("x-middleware-next")).toBe("1");
  });
});
