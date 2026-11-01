/** @jest-environment node */
import { NextRequest } from "next/server";
import { createHmac } from "crypto";
const mockWrite = jest.fn();
jest.mock("@/lib/rbac/openfga", () => ({ writeOpenFgaTuples: (...args: unknown[]) => mockWrite(...args) }));
jest.mock("@/lib/mcp-credential-headers", () => ({ resolveMcpHeaderCredentials: async () => ({ headers: { Authorization: "Bearer caller-test-token" } }) }));
import { callHttpMcpTool, listHttpMcpTools } from "../mcp-http-server-client";
import type { MCPServerConfig } from "@/types/dynamic-agent";

const input = { request: new NextRequest("http://example.test"), session: { sub: "test-user", accessToken: "caller-test-token" },
  server: { _id: "example", source: "agentgateway", transport: "http", endpoint: "http://gateway.example.test/mcp/example" } as MCPServerConfig & { endpoint: string },
  serverId: "example", agentId: "agent-example" };

beforeEach(() => { jest.clearAllMocks(); process.env.CAIPE_AGENT_CONTEXT_HMAC_SECRET = "example-signing-key-for-unit-tests"; });

it("uses the real signed agent context without granting diagnostic access", async () => {
  const fetchMock = jest.spyOn(global, "fetch").mockResolvedValue(Response.json({ result: { tools: [{ name: "lookup", inputSchema: { type: "object" } }] } }));
  try {
    const result = await listHttpMcpTools(input);
    expect(result.tools[0].name).toBe("lookup");
    const headers = fetchMock.mock.calls[0][1]?.headers as Record<string, string>;
    const signed = JSON.parse(Buffer.from(headers["X-CAIPE-Agent-Context"], "base64url").toString());
    expect(signed).toMatchObject({ agent_id: "agent-example", kind: "dynamic" });
    expect(headers.Authorization).toBe("Bearer caller-test-token");
    expect(headers["X-CAIPE-Agent-Context-Signature"]).toBe(
      createHmac("sha256", "example-signing-key-for-unit-tests")
        .update(headers["X-CAIPE-Agent-Context"])
        .digest("hex"),
    );
    expect(mockWrite).not.toHaveBeenCalled();
  } finally { fetchMock.mockRestore(); }
});

it("never retries a side-effecting MCP call after an ambiguous failure", async () => {
  const fetchMock = jest.spyOn(global, "fetch").mockImplementation(async (_url, init) => {
    const method = JSON.parse(init?.body as string).method;
    if (method === "tools/call") return Response.json({ error: "unavailable" }, { status: 503 });
    return Response.json({ result: { protocolVersion: "2024-11-05" } });
  });
  try {
    await expect(callHttpMcpTool({ ...input, toolName: "lookup", args: {} })).rejects.toMatchObject({ code: "MCP_CALL_FAILED" });
    const methods = fetchMock.mock.calls.map(([, init]) => JSON.parse(init?.body as string).method);
    expect(methods).toEqual(["initialize", "notifications/initialized", "tools/call"]);
    expect(mockWrite).not.toHaveBeenCalled();
  } finally { fetchMock.mockRestore(); }
});
