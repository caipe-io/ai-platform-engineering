/** @jest-environment node */
import { createHash } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { GET, POST } from "../sessions/migrate/route";

let mockBinding: Record<string, unknown> | null;
let mockAgent: Record<string, unknown> | null;
let mockLease: Record<string, unknown> | null;
let mockCheckpoint: Record<string, unknown> | null;
const mockLookup = jest.fn();
const mockInvoke = jest.fn();
const mockResolve = jest.fn();
const mockAuth = jest.fn();
const mockAgentAccess = jest.fn();
const mockConversationAccess = jest.fn();
const mockAppStream = jest.fn();
const mockConfig = jest.fn();
const mockFind = jest.fn(async (name: string, query: unknown) => {
  void query;
  if (name === "harness_gateway_bindings") return mockBinding;
  if (name === "dynamic_agents") return mockAgent;
  if (name === "execution_thread_leases") return mockLease;
  return mockCheckpoint;
});
const mockClaim = jest.fn(async (_filter, change) => {
  if (mockBinding?.transition_id) return null;
  mockBinding = { ...mockBinding, ...change.$set };
  return mockBinding;
});
const mockUpdate = jest.fn(async (filter, change) => {
  if (filter.transition_id !== mockBinding?.transition_id) return { matchedCount: 0 };
  Object.assign(mockBinding!, change.$set);
  for (const key of Object.keys(change.$unset ?? {})) delete mockBinding![key];
  return { matchedCount: 1 };
});
jest.mock("@/lib/da-proxy", () => ({ authenticateRequest: (...args: unknown[]) => mockAuth(...args) }));
jest.mock("@/lib/rbac/openfga-agent-authz", () => ({ requireAgentUsePermission: (...args: unknown[]) => mockAgentAccess(...args) }));
jest.mock("@/lib/agentic-apps/assistant-stream", () => ({ findAgenticAppAssistantStream: (...args: unknown[]) => mockAppStream(...args) }));
jest.mock("@/app/api/v1/chat/_conversation-authz", () => ({ authorizeConversationWriteAccess: (...args: unknown[]) => mockConversationAccess(...args), resolveConversationRuntimeId: async () => "example-thread" }));
jest.mock("@/lib/harness-engine-proxy", () => ({ getHarnessEngineConfig: () => mockConfig(), lookupHarnessSession: (...args: unknown[]) => mockLookup(...args) }));
jest.mock("@/lib/harness-gateway", () => ({ gatewayBindingId: () => "example", invokeHarnessGatewayRun: (...args: unknown[]) => mockInvoke(...args), resolveHarnessGatewayTarget: (...args: unknown[]) => mockResolve(...args) }));
jest.mock("@/lib/mongodb", () => ({ getCollection: async (name: string) => ({ findOne: (query: unknown) => mockFind(name, query), findOneAndUpdate: (...args: unknown[]) => mockClaim(...args as [unknown, unknown]), updateOne: (...args: unknown[]) => mockUpdate(...args as [unknown, unknown]) }) }));

const body = { agent_id: "example-agent", conversation_id: "example-thread", action: "adopt" };
const request = (value: unknown = body) => new NextRequest("https://example.test/api/harness-engine/sessions/migrate", { method: "POST", body: JSON.stringify(value) });
const inspect = () => new NextRequest("https://example.test/api/harness-engine/sessions/migrate?agent_id=example-agent&conversation_id=example-thread");
const originalFlag = process.env.HARNESS_ENGINE_DEEP_AGENTS_ENABLED;

beforeEach(() => {
  jest.clearAllMocks();
  process.env.HARNESS_ENGINE_DEEP_AGENTS_ENABLED = "true";
  mockBinding = { _id: "example", harness_id: "dynamic_agents", runtime: "dynamic_agents" };
  mockAgent = { _id: "example-agent", enabled: true };
  mockLease = null;
  mockCheckpoint = null;
  mockAuth.mockResolvedValue({ subject: "test-user", email: "user@example.test" });
  mockAgentAccess.mockResolvedValue(null);
  mockConversationAccess.mockResolvedValue({ conversation: {}, denial: null });
  mockAppStream.mockReturnValue(null);
  mockConfig.mockReturnValue({});
  mockLookup.mockResolvedValue({ active_run: null });
  mockResolve.mockResolvedValue({ kind: "dynamic_agents", harnessId: "dynamic_agents" });
  mockInvoke.mockResolvedValue(NextResponse.json({ success: true }));
});
afterAll(() => {
  if (originalFlag === undefined) delete process.env.HARNESS_ENGINE_DEEP_AGENTS_ENABLED;
  else process.env.HARNESS_ENGINE_DEEP_AGENTS_ENABLED = originalFlag;
});

it("inspects a legacy chat without creating a binding, native session, or run", async () => {
  const response = await GET(inspect());
  expect(await response.json()).toEqual({ success: true, data: { state: "available" } });
  expect(response.headers.get("Cache-Control")).toBe("no-store");
  expect(mockClaim).not.toHaveBeenCalled();
  expect(mockUpdate).not.toHaveBeenCalled();
  expect(mockResolve).not.toHaveBeenCalled();
  expect(mockInvoke).not.toHaveBeenCalled();
});

it.each([GET, POST])("enforces write permission before inspecting or changing execution", async handler => {
  mockConversationAccess.mockResolvedValue({ denial: NextResponse.json({ error: "Read only" }, { status: 403 }) });
  expect((await handler(handler === GET ? inspect() : request())).status).toBe(403);
  expect(mockFind).not.toHaveBeenCalled();
  expect(mockInvoke).not.toHaveBeenCalled();
});

it.each([GET, POST])("enforces agent permission independently of conversation access", async handler => {
  mockAgentAccess.mockResolvedValue(NextResponse.json({ error: "Agent denied" }, { status: 403 }));
  expect((await handler(handler === GET ? inspect() : request())).status).toBe(403);
  expect(mockConversationAccess).not.toHaveBeenCalled();
});

it.each([GET, POST])("requires an authenticated subject", async handler => {
  mockAuth.mockResolvedValue({});
  expect((await handler(handler === GET ? inspect() : request())).status).toBe(401);
  expect(mockFind).not.toHaveBeenCalled();
});

it.each(["claude_agent_sdk", "agentcore"])("does not offer native migration for %s", async harnessId => {
  mockAgent!.execution_harness_id = harnessId;
  expect((await (await GET(inspect())).json()).data.state).toBe("unavailable");
  expect(mockLookup).not.toHaveBeenCalled();
});

it("excludes app-owned assistants and disabled Engine integration", async () => {
  mockAppStream.mockReturnValue({});
  expect((await (await GET(inspect())).json()).data.state).toBe("unavailable");
  mockAppStream.mockReturnValue(null);
  process.env.HARNESS_ENGINE_DEEP_AGENTS_ENABLED = "false";
  expect((await (await GET(inspect())).json()).data.state).toBe("unavailable");
  expect(mockLookup).not.toHaveBeenCalled();
});

it("hides migration for already managed conversations", async () => {
  mockBinding!.runtime = "harness_engine";
  mockLookup.mockResolvedValue({ harness_id: "dynamic_agents", active_run: null });
  expect((await (await GET(inspect())).json()).data.state).toBe("managed");
});

it("does not offer migration for fresh chats that will already use Engine", async () => {
  mockBinding = null;
  expect((await (await GET(inspect())).json()).data.state).toBe("unavailable");
  mockCheckpoint = { _id: "checkpoint-example" };
  expect((await (await GET(inspect())).json()).data.state).toBe("available");
  expect(mockClaim).not.toHaveBeenCalled();
});

it("checks the actual native thread and per-agent checkpoint namespace for a live legacy producer", async () => {
  mockAgent!.backend = { config: { checkpoint_collection: "example_checkpoints" } };
  mockBinding!.native_thread_id = "native-example";
  mockLease = { active_run: "legacy-run" };
  expect((await (await GET(inspect())).json()).data.state).toBe("busy");
  const key = createHash("sha256").update("example_checkpoints\0native-example").digest("hex");
  expect(mockFind).toHaveBeenCalledWith("execution_thread_leases", { _id: key });
  expect((await POST(request())).status).toBe(409);
  expect(mockClaim).not.toHaveBeenCalled();
  expect(mockInvoke).not.toHaveBeenCalled();
});

it("also rejects an active Engine run before claiming a handoff", async () => {
  mockLookup.mockResolvedValue({ active_run: { run_id: "example-run" } });
  expect((await (await GET(inspect())).json()).data.state).toBe("busy");
  expect((await POST(request())).status).toBe(409);
  expect(mockClaim).not.toHaveBeenCalled();
});

it("offers recovery only for an adoption handoff", async () => {
  mockBinding!.transition_id = "original-transition";
  mockBinding!.transition_action = "adopt";
  expect((await (await GET(inspect())).json()).data.state).toBe("recoverable");
  mockBinding!.transition_action = "rollback";
  expect((await (await GET(inspect())).json()).data.state).toBe("unavailable");
  expect(mockInvoke).not.toHaveBeenCalled();
});

it("migrates an idle thread without sending a prompt or approval", async () => {
  mockLookup.mockResolvedValueOnce({ active_run: null }).mockResolvedValueOnce({ native_thread_id: "native-example", active_run: null, pending_interrupt: { interrupt_id: "interrupt-example" } });
  const response = await POST(request());
  expect(response.status).toBe(200);
  expect(mockInvoke).toHaveBeenCalledWith(expect.objectContaining({ command: "reconcile", handoff_owner: "harness_engine", client_request_id: expect.any(String) }), expect.any(Object));
  expect(mockInvoke.mock.calls[0][0]).not.toHaveProperty("message");
  expect(mockInvoke.mock.calls[0][0]).not.toHaveProperty("resume_data");
  expect(mockBinding).toMatchObject({ runtime: "harness_engine", native_thread_id: "native-example" });
  expect((await response.json()).data.pending_interrupt).toEqual({ interrupt_id: "interrupt-example" });
});

it("rejects a changed runtime before dispatching a reconciliation", async () => {
  mockAgent!.execution_harness_id = "claude_agent_sdk";
  expect((await POST(request())).status).toBe(409);
  expect(mockClaim).not.toHaveBeenCalled();
});

it("retains an ambiguous handoff and recovers it after a BFF restart using the same run key", async () => {
  mockBinding = { _id: "example", transition_id: "original-transition", transition_action: "adopt" };
  mockInvoke.mockResolvedValueOnce(NextResponse.json({ error: "timeout" }, { status: 503 }));
  mockLookup.mockResolvedValueOnce({ active_run: { run_id: "example-run" } });
  expect((await POST(request())).status).toBe(503);
  expect(mockBinding.transition_id).toBe("original-transition");
  expect(mockUpdate).not.toHaveBeenCalled();
  mockInvoke.mockResolvedValueOnce(NextResponse.json({ success: true }));
  mockLookup.mockResolvedValueOnce({ native_thread_id: "native-example", active_run: null });
  expect((await POST(request())).status).toBe(200);
  expect(mockInvoke.mock.calls.map(call => call[0].client_request_id)).toEqual(["original-transition", "original-transition"]);
  expect(mockBinding).toMatchObject({ runtime: "harness_engine", native_thread_id: "native-example" });
  expect(mockBinding.transition_id).toBeUndefined();
  expect(mockResolve).not.toHaveBeenCalled();
});

it("does not publish a handoff whose transition changed while reconciling", async () => {
  mockBinding = { _id: "example", transition_id: "original", transition_action: "adopt" };
  mockInvoke.mockImplementationOnce(async () => { mockBinding!.transition_id = "competing"; return NextResponse.json({ success: true }); });
  mockLookup.mockResolvedValueOnce({ native_thread_id: "native-example", active_run: null });
  expect((await POST(request())).status).toBe(409);
  expect(mockBinding.transition_id).toBe("competing");
  expect(mockBinding.runtime).toBeUndefined();
});
