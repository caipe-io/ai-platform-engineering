/** @jest-environment node */
import { checkHarnessMcpReadiness } from "../harness-mcp-readiness";
import { ApiError } from "@/lib/api-error";
const mockList = jest.fn();
const mockServers = jest.fn();
const mockPermission = jest.fn();
jest.mock("@/lib/mongodb", () => ({ getCollection: async () => ({ find: () => ({ toArray: async () => mockServers() }) }) }));
jest.mock("@/lib/mcp-http-server-client", () => ({ listHttpMcpTools: (...args: unknown[]) => mockList(...args) }));
jest.mock("@/lib/rbac/resource-authz", () => ({ filterResourcesByPermission: (...args: unknown[]) => mockPermission(...args) }));
const auth = { subject: "test-user", bearerToken: "caller-token", authenticatedUser: { session: { sub: "test-user", accessToken: "caller-token" } } } as never;
beforeEach(() => { jest.resetAllMocks(); mockServers.mockReturnValue([{ _id: "primary", endpoint: "https://upstream.example.test/mcp", enabled: true }]); process.env.AGENT_GATEWAY_URL = "http://gateway.example.test:4000"; mockPermission.mockImplementation(async (_session, servers) => servers); mockList.mockResolvedValue({ tools: [{ name: "lookup" }] }); });
it("lists once per authorized server with the real caller and agent, without invoking tools", async () => {
  expect(await checkHarnessMcpReadiness("example", ["primary.lookup", "primary.lookup"], auth)).toBeUndefined();
  expect(mockList).toHaveBeenCalledTimes(1);
  expect(mockList).toHaveBeenCalledWith(expect.objectContaining({ agentId: "example", session: expect.objectContaining({ sub: "test-user" }), server: expect.objectContaining({ endpoint: "http://gateway.example.test:4000/mcp/primary" }) }));
});
it.each([new ApiError("private endpoint detail", 502, "MCP_INIT_FAILED"), new Error("private endpoint detail")])("reports unreachable catalogs without exposing upstream details", async error => {
  mockList.mockRejectedValue(error);
  const result = await checkHarnessMcpReadiness("example", ["primary.lookup"], auth);
  expect(result).toMatchObject({ ready: false, code: "HARNESS_AGENT_NOT_READY" });
  expect(JSON.stringify(result)).not.toContain("private endpoint detail");
});
it("blocks missing tools without dispatching a run", async () => {
  mockList.mockResolvedValue({ tools: [] });
  expect((await checkHarnessMcpReadiness("example", ["primary.lookup"], auth))?.ready).toBe(false);
});
it("does not probe unauthorized servers or manufacture diagnostic access", async () => {
  mockPermission.mockResolvedValue([]);
  expect(await checkHarnessMcpReadiness("example", ["primary.lookup"], auth)).toBeUndefined();
  expect(mockList).not.toHaveBeenCalled();
});
it.each(["MCP_AUTH_REQUIRED", "MCP_CREDENTIAL_UNAVAILABLE", "MCP_TOOL_ACCESS_DENIED"])("preserves existing unavailable-tool handling for %s", async code => {
  mockList.mockRejectedValue(new ApiError("Denied", 401, code));
  expect(await checkHarnessMcpReadiness("example", ["primary.lookup"], auth)).toBeUndefined();
});
it("does not connect for tool-free conversations", async () => {
  expect(await checkHarnessMcpReadiness("example", [], auth)).toBeUndefined();
  expect(mockList).not.toHaveBeenCalled();
});

it("checks only each server's own pinned tools when IDs share a prefix", async () => {
  mockServers.mockReturnValue([{ _id: "primary", enabled: true }, { _id: "primary.child", enabled: true }]);
  expect(await checkHarnessMcpReadiness("example", ["primary.lookup", "primary.child.lookup"], auth)).toBeUndefined();
  expect(mockList).toHaveBeenCalledTimes(2);
});
it("aborts catalog requests when the admission check budget expires", async () => {
  jest.useFakeTimers();
  try {
    mockList.mockImplementation(({ signal }: { signal: AbortSignal }) => new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(new Error("Timeout")))));
    const check = checkHarnessMcpReadiness("example", ["primary.lookup"], auth);
    await jest.runAllTimersAsync();
    expect((await check)?.ready).toBe(false);
    expect(mockList).toHaveBeenCalledTimes(1);
  } finally { jest.useRealTimers(); }
});
