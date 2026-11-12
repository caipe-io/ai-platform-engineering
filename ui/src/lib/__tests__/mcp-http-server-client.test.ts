/** @jest-environment node */
import { NextRequest } from "next/server";
import { callHttpMcpTool, listHttpMcpTools } from "../mcp-http-server-client";
import { resolveMcpHeaderCredentials } from "@/lib/mcp-credential-headers";

jest.mock("@/lib/api-middleware", () => ({ ApiError: jest.requireActual("@/lib/api-error").ApiError }));
jest.mock("@/lib/mcp-credential-headers", () => ({
  resolveMcpHeaderCredentials: jest.fn(async () => ({ headers: { Authorization: "Bearer example-user-token" } })),
  isMcpCredentialUnavailableError: (error: unknown) => error instanceof Error && error.message === "MCP_CREDENTIAL_UNAVAILABLE",
}));
jest.mock("@/lib/rbac/openfga", () => ({ writeOpenFgaTuples: jest.fn() }));

const originalFetch = global.fetch;
const originalSecret = process.env.CAIPE_AGENT_CONTEXT_HMAC_SECRET;
const fetchMock = jest.fn();
const input = {
  request: new NextRequest("https://example.test/api/harness-engine/runs/run-example/tools"),
  session: { sub: "test-user", accessToken: "example-user-token" },
  server: { _id: "example", name: "Example", transport: "http", enabled: true, source: "agentgateway", endpoint: "http://gateway.example.test/mcp/example" } as const,
  serverId: "example", agentId: "agent-example", toolName: "lookup", args: {},
};

beforeEach(() => {
  fetchMock.mockReset();
  global.fetch = fetchMock;
  process.env.CAIPE_AGENT_CONTEXT_HMAC_SECRET = "example-signing-secret";
});

afterAll(() => {
  global.fetch = originalFetch;
  if (originalSecret === undefined) delete process.env.CAIPE_AGENT_CONTEXT_HMAC_SECRET;
  else process.env.CAIPE_AGENT_CONTEXT_HMAC_SECRET = originalSecret;
});

it.each([0, 1, 2].flatMap(stage => [401, 403].map(status => ({ stage, status }))))(
  "preserves HTTP $status at MCP stage $stage without dispatching or retrying later stages",
  async ({ stage, status }) => {
    fetchMock.mockImplementation(async () => {
      const step = fetchMock.mock.calls.length - 1;
      if (step === stage) return Response.json({ error: "private-upstream-detail" }, { status });
      if (step === 0) return Response.json({ jsonrpc: "2.0", result: { protocolVersion: "2024-11-05" } });
      return new Response(null, { status: 202 });
    });
    await expect(callHttpMcpTool(input)).rejects.toMatchObject({
      statusCode: status, code: status === 403 ? "MCP_TOOL_ACCESS_DENIED" : "MCP_AUTH_REQUIRED",
    });
    expect(fetchMock).toHaveBeenCalledTimes(stage + 1);
  },
);

it("reports a missing caller provider connection before making any upstream request", async () => {
  jest.mocked(resolveMcpHeaderCredentials).mockRejectedValueOnce(new Error("MCP_CREDENTIAL_UNAVAILABLE"));
  await expect(listHttpMcpTools(input)).rejects.toMatchObject({ statusCode: 401, code: "MCP_CREDENTIAL_UNAVAILABLE" });
  expect(fetchMock).not.toHaveBeenCalled();
});

it("keeps an upstream failure ambiguous, sanitizes its body and never repeats the call", async () => {
  fetchMock.mockResolvedValueOnce(Response.json({ jsonrpc: "2.0", result: {} }))
    .mockResolvedValueOnce(new Response(null, { status: 202 }))
    .mockResolvedValueOnce(Response.json({ error: "private-upstream-detail" }, { status: 502 }));
  await expect(callHttpMcpTool(input)).rejects.toMatchObject({
    statusCode: 502, code: "MCP_CALL_FAILED", message: "MCP tool invocation failed; the request was not retried",
  });
  expect(fetchMock).toHaveBeenCalledTimes(3);
});

it.each([0, 1, 2].flatMap(stage => [401, 403].map(status => ({ stage, status }))))(
  "preserves catalog HTTP $status at stage $stage without retrying authentication",
  async ({ stage, status }) => {
    fetchMock.mockImplementation(async () => {
      const step = fetchMock.mock.calls.length - 1;
      if (step === stage) return Response.json({ error: "private-upstream-detail" }, { status });
      if (step === 0) return new Response(null, { status: 422 });
      return Response.json({ result: {} }, { headers: { "mcp-session-id": "example-session" } });
    });
    await expect(listHttpMcpTools(input)).rejects.toMatchObject({
      statusCode: status, code: status === 403 ? "MCP_TOOL_ACCESS_DENIED" : "MCP_AUTH_REQUIRED",
    });
    expect(fetchMock).toHaveBeenCalledTimes(stage + 1);
  },
);
