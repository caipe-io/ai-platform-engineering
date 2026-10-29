/** @jest-environment node */
import { NextResponse } from "next/server";
import { clearHarnessGatewayBinding, resolveHarnessGatewayTarget } from "../harness-gateway";

const mockFindAppStream = jest.fn();
jest.mock("@/lib/agentic-apps/assistant-stream", () => ({ findAgenticAppAssistantStream: (...args: unknown[]) => mockFindAppStream(...args) }));
const mockFindAgent = jest.fn();
const mockLookupSession = jest.fn();
const mockFindNativeContext = jest.fn();
const mockNativeCollection = jest.fn();
const bindings = new Map<string, Record<string, unknown>>();
jest.mock("@/lib/mongodb", () => ({
  getCollection: async (name: string) => {
    if (name === "dynamic_agents") return { findOne: mockFindAgent };
    if (name !== "harness_gateway_bindings") {
      mockNativeCollection(name);
      return { findOne: mockFindNativeContext };
    }
    return {
    findOne: async (key: { _id: string }) => bindings.get(key._id) ?? null,
    findOneAndUpdate: async (key: { _id: string }, update: { $setOnInsert: Record<string, unknown> }) => {
      if (!bindings.has(key._id)) bindings.set(key._id, update.$setOnInsert);
      return bindings.get(key._id);
    },
      deleteOne: async (key: { _id: string }) => bindings.delete(key._id),
    };
  },
}));
jest.mock("@/lib/harness-engine-proxy", () => ({
  ...jest.requireActual("@/lib/harness-engine-proxy"),
  lookupHarnessSession: (...args: unknown[]) => mockLookupSession(...args),
}));

const context = { subject: "test-user", conversationId: "conversation-example" };

beforeEach(() => {
  jest.resetAllMocks();
  bindings.clear();
  mockFindAppStream.mockReturnValue(null);
  process.env.HARNESS_ENGINE_URL = "http://harness-engine:8010";
  process.env.HARNESS_ENGINE_INTERNAL_TOKEN = "test-internal-token";
  mockFindAgent.mockResolvedValue({ _id: "agent-example", execution_harness_id: "dynamic_agents" });
  mockLookupSession.mockResolvedValue({ harness_id: null });
  mockFindNativeContext.mockResolvedValue(null);
});

it.each(["agentcore", "claude_agent_sdk"])("fails closed for saved %s agents when either service setting is absent", async (harnessId) => {
  mockFindAgent.mockResolvedValue({ _id: "agent-example", execution_harness_id: harnessId });
  for (const missing of ["HARNESS_ENGINE_URL", "HARNESS_ENGINE_INTERNAL_TOKEN"]) {
    const original = process.env[missing];
    delete process.env[missing];
    const target = await resolveHarnessGatewayTarget("agent-example", context);
    expect(target).toBeInstanceOf(NextResponse);
    expect((target as NextResponse).status).toBe(503);
    process.env[missing] = original;
  }
});

it.each([undefined, "dynamic_agents"])("keeps legacy/default marker %s available without Engine configuration", async (harnessId) => {
  delete process.env.HARNESS_ENGINE_URL;
  delete process.env.HARNESS_ENGINE_INTERNAL_TOKEN;
  mockFindAgent.mockResolvedValue({ _id: "agent-example", execution_harness_id: harnessId });
  expect(await resolveHarnessGatewayTarget("agent-example", context)).toEqual({ kind: "dynamic_agents", harnessId: "dynamic_agents" });
});

it("adopts old Engine sessions and pins later turns until an explicit clear", async () => {
  mockLookupSession.mockResolvedValue({ harness_id: "claude_agent_sdk" });
  const pinned = { kind: "harness_engine", harnessId: "claude_agent_sdk" };
  expect(await resolveHarnessGatewayTarget("agent-example", context)).toEqual(pinned);
  expect(mockLookupSession).toHaveBeenCalledWith(expect.anything(), context, "agent-example", "conversation-example");
  mockLookupSession.mockResolvedValue({ harness_id: null });
  expect(await resolveHarnessGatewayTarget("agent-example", context)).toEqual(pinned);
  await clearHarnessGatewayBinding("agent-example", context.subject, context.conversationId);
  expect(await resolveHarnessGatewayTarget("agent-example", context)).toEqual({ kind: "dynamic_agents", harnessId: "dynamic_agents" });
});

it("keeps native conversations pinned after the agent changes to an SDK harness", async () => {
  const native = { kind: "dynamic_agents", harnessId: "dynamic_agents" };
  expect(await resolveHarnessGatewayTarget("agent-example", context)).toEqual(native);
  mockFindAgent.mockResolvedValue({ _id: "agent-example", execution_harness_id: "agentcore" });
  expect(await resolveHarnessGatewayTarget("agent-example", context)).toEqual(native);
  expect(await resolveHarnessGatewayTarget("agent-example", { ...context, subject: "another-user" })).toEqual({ kind: "harness_engine", harnessId: "agentcore" });
});

it("fails closed for a pinned Engine conversation if configuration is removed after an agent edit", async () => {
  mockLookupSession.mockResolvedValue({ harness_id: "agentcore" });
  await resolveHarnessGatewayTarget("agent-example", context);
  delete process.env.HARNESS_ENGINE_INTERNAL_TOKEN;
  const target = await resolveHarnessGatewayTarget("agent-example", context);
  expect(target).toBeInstanceOf(NextResponse);
  expect((target as NextResponse).status).toBe(503);
});

it("does not choose a new backend if authoritative session lookup is unavailable", async () => {
  mockLookupSession.mockResolvedValue(NextResponse.json({ success: false }, { status: 503 }));
  expect((await resolveHarnessGatewayTarget("agent-example", context) as NextResponse).status).toBe(503);
  expect(bindings.size).toBe(0);
});

it("adopts existing native checkpoints before a mutable SDK default", async () => {
  mockFindAgent.mockResolvedValue({ _id: "agent-example", execution_harness_id: "agentcore" });
  mockFindNativeContext.mockResolvedValue({ _id: "checkpoint-example" });
  expect(await resolveHarnessGatewayTarget("agent-example", context)).toEqual({ kind: "dynamic_agents", harnessId: "dynamic_agents" });
  expect(mockNativeCollection).toHaveBeenCalledWith("checkpoints_conversation");
  expect(mockFindNativeContext).toHaveBeenCalledWith(
    { thread_id: context.conversationId }, { projection: { _id: 1 } },
  );
  expect([...bindings.values()][0].harness_id).toBe("dynamic_agents");
});

it.each(["missing", "unavailable"])("keeps known native context usable when Engine is %s", async (mode) => {
  mockFindAgent.mockResolvedValue({ _id: "agent-example", execution_harness_id: "claude_agent_sdk" });
  mockFindNativeContext.mockResolvedValue({ _id: "checkpoint-example" });
  if (mode === "missing") delete process.env.HARNESS_ENGINE_URL;
  else mockLookupSession.mockResolvedValue(NextResponse.json({ success: false }, { status: 503 }));
  expect(await resolveHarnessGatewayTarget("agent-example", context)).toEqual({ kind: "dynamic_agents", harnessId: "dynamic_agents" });
});

it("rejects contradictory native and Engine contexts without pinning either owner", async () => {
  mockFindNativeContext.mockResolvedValue({ _id: "checkpoint-example" });
  mockLookupSession.mockResolvedValue({ harness_id: "agentcore" });
  expect((await resolveHarnessGatewayTarget("agent-example", context) as NextResponse).status).toBe(409);
  expect(bindings.size).toBe(0);
});

it("uses the native checkpoint collection configured for the agent", async () => {
  mockFindAgent.mockResolvedValue({ _id: "agent-example", execution_harness_id: "agentcore", backend: { config: { checkpoint_collection: "example_checkpoints" } } });
  mockFindNativeContext.mockResolvedValue({ _id: "checkpoint-example" });
  expect(await resolveHarnessGatewayTarget("agent-example", context)).toEqual({ kind: "dynamic_agents", harnessId: "dynamic_agents" });
  expect(mockNativeCollection).toHaveBeenCalledWith("example_checkpoints");
});


it.each(["dynamic_agents", "agentcore"])("retains a pinned %s owner before later app declarations", async (harnessId) => {
  mockLookupSession.mockResolvedValue({ harness_id: harnessId });
  const expected = await resolveHarnessGatewayTarget("agent-example", context);
  mockFindAppStream.mockReturnValue({ appId: "example-app", path: ["api", "example", "start"] });
  mockFindAppStream.mockClear(); mockLookupSession.mockClear(); mockFindNativeContext.mockClear();
  expect(await resolveHarnessGatewayTarget("agent-example", { ...context, retainedOnly: true })).toEqual(expected);
  expect(mockFindAppStream).not.toHaveBeenCalled(); expect(mockLookupSession).not.toHaveBeenCalled();
  expect(mockFindNativeContext).not.toHaveBeenCalled();
});

it("does not create a native owner or query Engine for a fresh app/default-native context", async () => {
  mockFindAppStream.mockReturnValue({ appId: "example-app", path: ["api", "example", "start"] });
  mockLookupSession.mockResolvedValue(NextResponse.json({}, { status: 503 }));
  expect(await resolveHarnessGatewayTarget("agent-example", { ...context, retainedOnly: true })).toBeNull();
  expect(mockLookupSession).not.toHaveBeenCalled(); expect(bindings.size).toBe(0);
});

it("adopts old native checkpoints before a new app claim", async () => {
  mockFindNativeContext.mockResolvedValue({ _id: "native-checkpoint" });
  mockFindAppStream.mockReturnValue({ appId: "example-app", path: ["api", "example", "start"] });
  expect(await resolveHarnessGatewayTarget("agent-example", { ...context, retainedOnly: true }))
    .toEqual({ kind: "dynamic_agents", harnessId: "dynamic_agents" });
  expect(bindings.size).toBe(1); expect(mockFindAppStream).not.toHaveBeenCalled();
});

it("recovers a pre-gateway SDK session before an app claim when its SDK default is retained", async () => {
  mockFindAgent.mockResolvedValue({ _id: "agent-example", execution_harness_id: "agentcore" });
  mockLookupSession.mockResolvedValue({ harness_id: "claude_agent_sdk" });
  mockFindAppStream.mockReturnValue({ appId: "example-app", path: ["api", "example", "start"] });
  expect(await resolveHarnessGatewayTarget("agent-example", { ...context, retainedOnly: true }))
    .toEqual({ kind: "harness_engine", harnessId: "claude_agent_sdk" });
  expect(mockFindAppStream).not.toHaveBeenCalled();
});

it("does not pin an SDK default during discovery when no session exists", async () => {
  mockFindAgent.mockResolvedValue({ _id: "agent-example", execution_harness_id: "agentcore" });
  expect(await resolveHarnessGatewayTarget("agent-example", { ...context, retainedOnly: true })).toBeNull();
  expect(bindings.size).toBe(0);
});

it("does not assign a new app conversation to Engine through an unsupported entry point", async () => {
  mockFindAppStream.mockReturnValue({ appId: "example-app", path: ["api", "example", "start"] });
  expect((await resolveHarnessGatewayTarget("agent-example", context) as NextResponse).status).toBe(501);
  expect(bindings.size).toBe(0);
});

it("rejects a malformed saved owner rather than normalizing it into a new runtime", async () => {
  await resolveHarnessGatewayTarget("agent-example", context);
  [...bindings.values()][0].owner_subject = "other-user";
  expect((await resolveHarnessGatewayTarget("agent-example", { ...context, retainedOnly: true }) as NextResponse).status).toBe(409);
});

it("permits discovery of a logical app assistant without a native agent row", async () => {
  mockFindAgent.mockResolvedValue(null);
  mockFindAppStream.mockReturnValue({ appId: "example-app", path: ["api", "example", "start"] });
  expect(await resolveHarnessGatewayTarget("agent-example", { ...context, retainedOnly: true })).toBeNull();
  expect(mockLookupSession).not.toHaveBeenCalled(); expect(bindings.size).toBe(0);
  expect((await resolveHarnessGatewayTarget("agent-example", context) as NextResponse).status).toBe(404);
});

it("still detects pre-gateway native state if its agent row was removed", async () => {
  mockFindAgent.mockResolvedValue(null);
  mockFindNativeContext.mockResolvedValue({ _id: "native-checkpoint" });
  expect(await resolveHarnessGatewayTarget("agent-example", { ...context, retainedOnly: true }))
    .toEqual({ kind: "dynamic_agents", harnessId: "dynamic_agents" });
});
