/** @jest-environment node */

import { NextRequest, NextResponse } from "next/server";

import { GET, PATCH, PUT } from "../route";

const mockAuthenticateRequest = jest.fn();
const mockBuildBackendHeaders = jest.fn();
const mockGetDynamicAgentsConfig = jest.fn();

jest.mock("@/lib/da-proxy", () => ({
  authenticateRequest: (...args: unknown[]) => mockAuthenticateRequest(...args),
  buildBackendHeaders: (...args: unknown[]) => mockBuildBackendHeaders(...args),
  getDynamicAgentsConfig: (...args: unknown[]) => mockGetDynamicAgentsConfig(...args),
}));

describe("user memory proxy", () => {
  beforeEach(() => {
    jest.restoreAllMocks();
    jest.clearAllMocks();
    mockAuthenticateRequest.mockReset();
    mockBuildBackendHeaders.mockReset();
    mockGetDynamicAgentsConfig.mockReset();
    mockAuthenticateRequest.mockResolvedValue({ subject: "sub-a" });
    mockBuildBackendHeaders.mockReturnValue({ "X-User-Context": "encoded" });
    mockGetDynamicAgentsConfig.mockReturnValue({ dynamicAgentsUrl: "http://dynamic-agents:8000" });
  });

  it("preserves backend conflict status and etag", async () => {
    const fetchMock = jest.spyOn(global, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ detail: "changed" }), {
        status: 409,
        headers: { ETag: "etag-new", "Content-Type": "application/json" },
      }),
    );
    const request = new NextRequest("http://localhost/api/user/memories", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: "/memories/global/AGENTS.md", text: "x", owner: "attacker" }),
    });

    const response = await PUT(request);

    expect(response.status).toBe(409);
    expect(response.headers.get("etag")).toBe("etag-new");
    expect(fetchMock).toHaveBeenCalledWith(
      new URL("http://dynamic-agents:8000/api/v1/memories"),
      expect.objectContaining({ method: "PUT" }),
    );
  });

  it("returns the authentication envelope without contacting the backend", async () => {
    mockAuthenticateRequest.mockResolvedValue(
      NextResponse.json({ success: false, error: "sign in" }, { status: 401 }),
    );
    const fetchMock = jest.spyOn(global, "fetch");

    const response = await GET(new NextRequest("http://localhost/api/user/memories"));

    expect(response.status).toBe(401);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("forwards structured record updates as PATCH requests", async () => {
    const fetchMock = jest.spyOn(global, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ success: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    const body = {
      path: "/memories/global/AGENTS.md",
      memory_id: "mem_0123456789abcdefghij",
      title: "Preferred greeting",
      body: "Start with Howdy.",
      etag: "etag-old",
    };

    const response = await PATCH(new NextRequest("http://localhost/api/user/memories", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }));

    expect(response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledWith(
      new URL("http://dynamic-agents:8000/api/v1/memories"),
      expect.objectContaining({ method: "PATCH", body: JSON.stringify(body) }),
    );
  });

  it("maps an unreachable backend to a retryable 503", async () => {
    jest.spyOn(global, "fetch").mockRejectedValue(new Error("connect failed"));

    const response = await GET(new NextRequest("http://localhost/api/user/memories"));

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      success: false,
      error: "Memory storage is temporarily unavailable",
    });
  });
});
