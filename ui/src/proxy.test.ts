/** @jest-environment node */

import { NextRequest } from "next/server";

import { proxy } from "./proxy";

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
