/** @jest-environment node */
import { startHarnessGatewayRun } from "../harness-gateway";
import { NextResponse } from "next/server";
const mockConnection = jest.fn();
jest.mock("@/lib/harness-mcp-readiness", () => ({ checkHarnessMcpReadiness: (...args: unknown[]) => mockConnection(...args) }));
const mockFindAgent = jest.fn();
const mockReadiness = jest.fn();
const mockSession = jest.fn();
jest.mock("@/lib/mongodb", () => ({ getCollection: async () => ({ findOne: mockFindAgent, updateOne: async () => ({ matchedCount: 1 }) }) }));
jest.mock("@/lib/harness-tool-readiness", () => ({ CLAUDE_TOOL_RUNTIMES: new Set(["claude_code_cli_acp"]), getHarnessToolReadiness: (...args: unknown[]) => mockReadiness(...args) }));
jest.mock("@/lib/harness-engine-proxy", () => ({ ...jest.requireActual("@/lib/harness-engine-proxy"), lookupHarnessSession: (...args: unknown[]) => mockSession(...args) }));
const request = { agent_id: "example", conversation_id: "chat", message: "What is your harness?", client_request_id: "request-example" };
const auth = { subject: "test-user", bearerToken: "test-token" };
beforeEach(() => {
  jest.resetAllMocks();
  process.env.HARNESS_ENGINE_URL = "http://engine:8010";
  process.env.HARNESS_ENGINE_INTERNAL_TOKEN = "internal-test";
  mockFindAgent.mockResolvedValue({ _id: "example", execution_blueprint_version: 2 });
  mockSession.mockResolvedValue({ harness_id: "claude_code_cli_acp", agent_version: 1 });
  mockReadiness.mockResolvedValue(new Map([["example", { ready: false, code: "HARNESS_AGENT_NOT_READY", message: "Dependency unavailable. Nothing was executed." }]]));
});
afterEach(() => jest.restoreAllMocks());
it("rejects a broken pinned configuration before run admission", async () => {
  const fetcher = jest.spyOn(global, "fetch").mockImplementation(async url => String(url).includes("run-requests")
    ? Response.json({ success: true, data: null }) : Response.json({ success: true, data: { version: { blueprint: { tools: { bindings: [{ tool_id: "primary.old" }] } } } } }));
  const result = await startHarnessGatewayRun(request, auth, "claude_code_cli_acp");
  expect(result).toBeInstanceOf(NextResponse);
  expect((result as NextResponse).status).toBe(409);
  expect(await (result as Response).json()).toMatchObject({ code: "HARNESS_AGENT_NOT_READY" });
  expect(fetcher.mock.calls.some(([url]) => String(url).endsWith("/api/v1/runs"))).toBe(false);
  expect(fetcher.mock.calls.some(([url]) => String(url).endsWith("?version=1"))).toBe(true);
  expect(mockReadiness).toHaveBeenCalledWith([expect.objectContaining({ _id: "example" })], ["primary.old"]);
});
it("preserves known request replay and lets Engine validate its fingerprint", async () => {
  const fetcher = jest.spyOn(global, "fetch").mockImplementation(async url => String(url).includes("run-requests")
    ? Response.json({ success: true, data: { run_id: "prior" } }) : Response.json({ success: true, data: { run_id: "prior", status: "completed" } }));
  const result = await startHarnessGatewayRun(request, auth, "claude_code_cli_acp");
  expect(result).not.toBeInstanceOf(NextResponse);
  expect(mockReadiness).not.toHaveBeenCalled();
  expect(fetcher).toHaveBeenCalledWith("http://engine:8010/api/v1/runs", expect.objectContaining({ method: "POST" }));
});
it("does not block session recovery controls with tool readiness", async () => {
  jest.spyOn(global, "fetch").mockResolvedValue(Response.json({ success: true, data: { run_id: "reconcile", status: "completed" } }));
  await startHarnessGatewayRun({ ...request, command: "reconcile" }, auth, "claude_code_cli_acp");
  expect(mockReadiness).not.toHaveBeenCalled();
});

it("rejects a live catalog failure before admitting a provider run", async () => {
  mockReadiness.mockResolvedValue(new Map([["example", { ready: true }]]));
  mockConnection.mockResolvedValue({ ready: false, code: "HARNESS_AGENT_NOT_READY", message: "MCP unavailable" });
  const fetcher = jest.spyOn(global, "fetch").mockImplementation(async url => String(url).includes("run-requests")
    ? Response.json({ success: true, data: null }) : Response.json({ success: true, data: { version: { blueprint: { tools: { bindings: [{ tool_id: "primary.lookup" }] } } } } }));
  expect((await startHarnessGatewayRun(request, auth, "claude_code_cli_acp") as Response).status).toBe(409);
  expect(mockConnection).toHaveBeenCalledWith("example", ["primary.lookup"], auth);
  expect(fetcher.mock.calls.some(([url]) => String(url).endsWith("/api/v1/runs"))).toBe(false);
});
