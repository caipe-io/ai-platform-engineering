/** @jest-environment node */

import { NextRequest } from "next/server";

import { isAgenticAppsEnabled, loadConfiguredAgenticApps } from "@/lib/agentic-apps/config";
import { proxy } from "./proxy";

jest.mock("@/lib/agentic-apps/config", () => ({
  isAgenticAppsEnabled: jest.fn(),
  loadConfiguredAgenticApps: jest.fn(),
}));

beforeEach(() => {
  jest.mocked(isAgenticAppsEnabled).mockReturnValue(false);
  jest.mocked(loadConfiguredAgenticApps).mockReset();
});

describe("External Apps request routing", () => {
  it("keeps a top-level document request on the canonical host page", () => {
    const response = proxy(
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
  ])("rewrites %s requests to the private runtime route", (_name, method, headers) => {
    const response = proxy(
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
  ])("never rewrites reserved or non-app path %s", (url) => {
    const response = proxy(
      new NextRequest(url, { headers: { "sec-fetch-dest": "iframe" } }),
    );

    expect(response.headers.get("x-middleware-next")).toBe("1");
    expect(response.headers.get("x-middleware-rewrite")).toBeNull();
  });
});

describe("External Apps configuration failures", () => {
  beforeEach(() => {
    jest.mocked(isAgenticAppsEnabled).mockReturnValue(true);
    jest.mocked(loadConfiguredAgenticApps).mockImplementation(() => {
      throw new Error("Invalid application configuration");
    });
  });

  it.each(["/", "/login", "/chat", "/chat/example-chat", "/settings/account", "/api", "/api/health"])(
    "keeps reserved host path %s available without loading app configuration",
    (pathname) => {
      const response = proxy(new NextRequest(`https://host.example.test${pathname}`));
      expect(response.headers.get("x-middleware-next")).toBe("1");
      expect(loadConfiguredAgenticApps).not.toHaveBeenCalled();
    },
  );

  it("keeps canonical iframe runtime routing available", () => {
    const response = proxy(new NextRequest("https://host.example.test/apps/example-app/report", {
      headers: { "sec-fetch-dest": "iframe" },
    }));
    expect(response.headers.get("x-middleware-rewrite")).toBe(
      "https://host.example.test/api/agentic-apps/runtime/example-app/report",
    );
    expect(loadConfiguredAgenticApps).not.toHaveBeenCalled();
  });

  it("still fails closed for candidate app routes", async () => {
    const response = proxy(new NextRequest("https://host.example.test/example/report"));
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "Application route configuration unavailable" });
  });

  it("does not treat a shared prefix as a reserved host path", () => {
    jest.mocked(loadConfiguredAgenticApps).mockReturnValue([]);
    const response = proxy(new NextRequest("https://host.example.test/chat-example/report"));
    expect(response.headers.get("x-middleware-next")).toBe("1");
    expect(loadConfiguredAgenticApps).toHaveBeenCalledTimes(1);
  });
});
