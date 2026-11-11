/** @jest-environment node */
import { NextResponse } from "next/server";
import { clearHarnessGatewayBinding, getHarnessGatewayStatus, getPinnedHarnessGatewayTarget, resolveHarnessGatewayTarget } from "../harness-gateway";

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
      updateOne: async (key: { _id: string }, update: { $set?: object }) => {
        if (update.$set) bindings.set(key._id, { ...bindings.get(key._id), ...update.$set });
        return { matchedCount: 1 };
      },
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

it("adopts old Engine sessions and retains execution ownership across clear", async () => {
  mockLookupSession.mockResolvedValue({ harness_id: "claude_agent_sdk" });
  const pinned = { kind: "harness_engine", harnessId: "claude_agent_sdk" };
  expect(await resolveHarnessGatewayTarget("agent-example", context)).toEqual(pinned);
  expect(mockLookupSession).toHaveBeenCalledWith(expect.anything(), context, "agent-example", "conversation-example");
  mockLookupSession.mockResolvedValue({ harness_id: null });
  expect(await resolveHarnessGatewayTarget("agent-example", context)).toEqual(pinned);
  await clearHarnessGatewayBinding("agent-example", context.subject, context.conversationId);
  expect(await resolveHarnessGatewayTarget("agent-example", context)).toEqual({ kind: "harness_engine", harnessId: "dynamic_agents" });
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

it.each(["false", "true"])("keeps an unbound chat unpinned during an Engine outage with opt-in=%s", async enabled => {
  const previous = process.env.HARNESS_ENGINE_DEEP_AGENTS_ENABLED;
  process.env.HARNESS_ENGINE_DEEP_AGENTS_ENABLED = enabled;
  try {
    mockLookupSession.mockResolvedValue(NextResponse.json({ success: false }, { status: 503 }));
    expect((await resolveHarnessGatewayTarget("agent-example", context) as NextResponse).status).toBe(503);
    expect(bindings.size).toBe(0);
    mockLookupSession.mockResolvedValue({ harness_id: null });
    expect(await resolveHarnessGatewayTarget("agent-example", context)).toEqual({
      kind: enabled === "true" ? "harness_engine" : "dynamic_agents", harnessId: "dynamic_agents",
    });
    expect(bindings.size).toBe(1);
  } finally {
    if (previous === undefined) delete process.env.HARNESS_ENGINE_DEEP_AGENTS_ENABLED;
    else process.env.HARNESS_ENGINE_DEEP_AGENTS_ENABLED = previous;
  }
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


it("fences pinned-only callers while a session handoff is in progress", async () => {
  await resolveHarnessGatewayTarget("agent-example", context);
  const key = [...bindings.keys()][0];
  bindings.set(key, { ...bindings.get(key), transition_id: "example-transition" });
  expect((await getPinnedHarnessGatewayTarget("agent-example", context.subject, context.conversationId) as NextResponse).status).toBe(409);
});

it("forwards the owner's retained sandbox details without resolving a mutable agent profile", async () => {
  const sandbox = { instance_id: "sandbox-1", display_name: "Pinned environment", portal_url: "https://sandbox.example.test/environments/1",
    policy_revision: "v1", policy_summary: "Private", status: "configured" };
  mockLookupSession.mockResolvedValue({ harness_id: "claude_code_acp", sandbox });
  const response = await getHarnessGatewayStatus({ agent_id: "agent-example", conversation_id: context.conversationId }, { subject: context.subject });
  expect((await response.json()).data.sandbox).toEqual(sandbox);
  expect(mockLookupSession).toHaveBeenCalledWith(expect.anything(), { subject: context.subject }, "agent-example", context.conversationId);
  expect(mockFindAgent).not.toHaveBeenCalled();
});
