/**
 * @jest-environment node
 */

import { NextRequest } from "next/server";

import { ApiError } from "@/lib/api-middleware";

const mockAuthorizeFileNamespace = jest.fn();
const mockGetDynamicAgentsConfig = jest.fn();
const mockProxyRequest = jest.fn();

jest.mock("@/lib/file-namespace-authorization", () => ({
  authorizeFileNamespace: (...args: unknown[]) => mockAuthorizeFileNamespace(...args),
}));

jest.mock("@/lib/da-proxy", () => ({
  getDynamicAgentsConfig: () => mockGetDynamicAgentsConfig(),
  proxyRequest: (...args: unknown[]) => mockProxyRequest(...args),
}));

const namespace = ["agent-primary", "conversation-primary", "filesystem"];
const authResult = { bearerToken: "token-primary" };

describe("generic file routes", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockAuthorizeFileNamespace.mockResolvedValue({ namespace, authResult });
    mockGetDynamicAgentsConfig.mockReturnValue({
      dynamicAgentsUrl: "http://dynamic-agents:8000",
    });
    mockProxyRequest.mockResolvedValue(Response.json({ success: true }));
  });

  it.each([
    ["GET", "read"],
    ["DELETE", "write"],
  ])("maps content %s to namespace %s authorization", async (method, action) => {
    const route = await import("../content/route");
    const request = new NextRequest(
      "http://localhost/api/files/content" +
        `?fs_namespace=${encodeURIComponent(JSON.stringify(namespace))}&path=report.txt`,
      { method },
    );

    const handler = method === "GET" ? route.GET : route.DELETE;
    const response = await handler(request);

    expect(response.status).toBe(200);
    expect(mockAuthorizeFileNamespace).toHaveBeenCalledWith(
      request,
      JSON.stringify(namespace),
      action,
    );
  });

  it("canonicalizes the authorized namespace in a write body", async () => {
    const { PUT } = await import("../content/route");
    const request = new NextRequest("http://localhost/api/files/content", {
      method: "PUT",
      body: JSON.stringify({
        fs_namespace: ["client", "supplied", "filesystem"],
        path: "report.txt",
        content: "example",
      }),
    });

    await PUT(request);

    expect(mockAuthorizeFileNamespace).toHaveBeenCalledWith(
      request,
      ["client", "supplied", "filesystem"],
      "write",
    );
    expect(JSON.parse(mockProxyRequest.mock.calls[0][4])).toMatchObject({
      fs_namespace: namespace,
      path: "report.txt",
      content: "example",
    });
  });

  it("never builds or proxies a backend request after object denial", async () => {
    mockAuthorizeFileNamespace.mockRejectedValue(
      new ApiError("Permission denied", 403, "NAMESPACE_FORBIDDEN"),
    );
    const { GET } = await import("../list/route");
    const request = new NextRequest(
      "http://localhost/api/files/list" +
        `?fs_namespace=${encodeURIComponent(JSON.stringify(namespace))}`,
    );

    const response = await GET(request);

    expect(response.status).toBe(403);
    expect(mockGetDynamicAgentsConfig).not.toHaveBeenCalled();
    expect(mockProxyRequest).not.toHaveBeenCalled();
  });

  it("validates required query parameters before authorization", async () => {
    const { GET } = await import("../content/route");
    const request = new NextRequest("http://localhost/api/files/content");

    const response = await GET(request);

    expect(response.status).toBe(400);
    expect(mockAuthorizeFileNamespace).not.toHaveBeenCalled();
    expect(mockProxyRequest).not.toHaveBeenCalled();
  });
});
