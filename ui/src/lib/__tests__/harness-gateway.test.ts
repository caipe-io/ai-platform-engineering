/** @jest-environment node */
import { NextResponse } from "next/server";
import { resolveHarnessGatewayTarget, replayHarnessGatewayRun, getHarnessGatewayRun, invokeHarnessGatewayRun } from "../harness-gateway";
import type { HarnessRun } from "@/types/harness-engine";

const findApp = jest.fn();
jest.mock("@/lib/agentic-apps/assistant-stream", () => ({
  findAgenticAppAssistantStream: (...args: unknown[]) => findApp(...args),
}));

const findAgent = jest.fn();
const findNative = jest.fn();
const findEngine = jest.fn();
const findCheckpoint = jest.fn();
const findClaim = jest.fn();
const findLegacyClaim = jest.fn();
const findDeleted = jest.fn();
const claimOwner = jest.fn();
jest.mock("@/lib/mongodb", () => ({ getCollection: async (name: string) => ({
  findOneAndUpdate: claimOwner,
  findOne: name === "harness_gateway_bindings" ? (query: { conversation_id?: string }) => query.conversation_id ? findLegacyClaim(query) : findClaim(query) : name === "native_acp_deleted_sessions" ? findDeleted : name === "native_acp_sessions" ? findNative : name === "harness_sessions" ? findEngine : name === "dynamic_agents" ? findAgent : findCheckpoint,
}) }));
const auth = { subject: "test-user" };
const context = { conversationId: "approved-runtime" };
const run: HarnessRun = {
  run_id: "run-example", agent_id: "agent-example", conversation_id: "approved-runtime",
  harness_id: "agentcore", profile_id: "primary", binding_id: "binding-example", agent_version: 1,
  protocol: "agui", client_request_id: "turn-example", status: "running", last_sequence: 0,
};
beforeEach(() => {
  jest.clearAllMocks();
  findApp.mockReturnValue(null);
  process.env.HARNESS_ENGINE_URL = "http://engine.example.test";
  process.env.HARNESS_ENGINE_INTERNAL_TOKEN = "internal-test-token";
  findAgent.mockResolvedValue({ _id: "agent-example" });
  findNative.mockResolvedValue(null);
  findEngine.mockResolvedValue(null);
  findCheckpoint.mockResolvedValue(null);
  findClaim.mockResolvedValue(null);
  findLegacyClaim.mockResolvedValue(null);
  findDeleted.mockResolvedValue(null);
  claimOwner.mockImplementation(async (_query, update) => update.$setOnInsert);
});
afterEach(() => jest.restoreAllMocks());

it.each([undefined, "dynamic_agents", "langchain-deepagents", "langchain_deepagents"])("keeps legacy/native alias %s usable without Engine", async (id) => {
  delete process.env.HARNESS_ENGINE_URL;
  findAgent.mockResolvedValue({ _id: "agent-example", execution_harness_id: id });
  expect(await resolveHarnessGatewayTarget("agent-example", context)).toEqual({ kind: "dynamic_agents", harnessId: "dynamic_agents" });
});
it("fails closed for an explicit SDK selection when Engine is absent", async () => {
  delete process.env.HARNESS_ENGINE_URL;
  findAgent.mockResolvedValue({ _id: "agent-example", execution_harness_id: "agentcore" });
  expect((await resolveHarnessGatewayTarget("agent-example", context) as NextResponse).status).toBe(503);
});
it("keeps an authorized native context native after the mutable agent selects SDK", async () => {
  findNative.mockResolvedValue({ runtime_kind: "native", protocol: "acp" });
  findAgent.mockResolvedValue({ execution_harness_id: "agentcore" });
  expect(await resolveHarnessGatewayTarget("agent-example", context)).toEqual({ kind: "dynamic_agents", harnessId: "dynamic_agents" });
  expect(findNative).toHaveBeenCalledWith({ agent_id: "agent-example", session_id: "approved-runtime" }, expect.anything());
  expect(findAgent).not.toHaveBeenCalled();
});
it("retains the saved Engine provider after configuration changes, including a closed epoch", async () => {
  findEngine.mockResolvedValueOnce({ harness_id: "agentcore" }).mockResolvedValueOnce(null);
  expect(await resolveHarnessGatewayTarget("agent-example", context)).toEqual({ kind: "harness_engine", harnessId: "agentcore" });
  expect(findAgent).not.toHaveBeenCalled();
});
it("rejects ambiguous saved providers instead of selecting a different state store", async () => {
  findNative.mockResolvedValue({ runtime_kind: "native", protocol: "acp" });
  findEngine.mockResolvedValue({ harness_id: "agentcore" });
  expect((await resolveHarnessGatewayTarget("agent-example", context) as NextResponse).status).toBe(409);
});
it("rejects conflicting Engine bindings even when callers differ", async () => {
  findEngine.mockResolvedValueOnce({ harness_id: "agentcore" }).mockResolvedValueOnce({ harness_id: "claude_agent_sdk" });
  expect((await resolveHarnessGatewayTarget("agent-example", context) as NextResponse).status).toBe(409);
});
it("rejects combining an SDK selection with an ACP sandbox selection", async () => {
  findAgent.mockResolvedValue({ execution_harness_id: "agentcore", execution: { kind: "sandbox" } });
  expect((await resolveHarnessGatewayTarget("agent-example", context) as NextResponse).status).toBe(409);
});
it("does not expose a same-owner run belonging to another execution context", async () => {
  jest.spyOn(global, "fetch").mockResolvedValue(new Response(JSON.stringify({ success: true, data: { ...run, conversation_id: "other-context" } })));
  expect((await getHarnessGatewayRun(auth, { agentId: run.agent_id, conversationId: run.conversation_id }, run.run_id) as NextResponse).status).toBe(404);
});
it("replays a partially delivered AG-UI event with stable standard frames and no new run", async () => {
  const providerFrames = [
    [1, "run.started", {}],
    [2, "tool.started", { tool_call_id: "tool-example", tool_name: "inspect", arguments: { path: "/logical.txt" } }],
    [3, "content.delta", { text: "answer" }],
    [4, "run.completed", {}],
  ].map(([id, event, data]) => `id: ${id}\nevent: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join("");
  const fetchMock = jest.spyOn(global, "fetch").mockResolvedValue(new Response(providerFrames));
  const response = await replayHarnessGatewayRun(run, auth, "e:2:1:2");
  const body = await response.text();
  expect(response.headers.get("X-CAIPE-Cursor-Format")).toBe("engine-v1");
  expect(body).toContain("id: run-example:e:2:2:2\nevent: TOOL_CALL_ARGS");
  expect(body).not.toContain("event: TOOL_CALL_START");
  expect(body).not.toContain("event: RUN_STARTED");
  expect(body).toContain("event: TEXT_MESSAGE_CONTENT");
  expect(body).toContain("id: run-example:e:4:2:2\nevent: RUN_FINISHED");
  expect(fetchMock).toHaveBeenCalledTimes(1);
  expect(fetchMock).toHaveBeenCalledWith("http://engine.example.test/api/v1/runs/run-example/events/stream?after=1", expect.objectContaining({ method: "GET" }));
});

it("retains legacy native checkpoint contexts before their first ACP binding", async () => {
  findCheckpoint.mockResolvedValue({ _id: "checkpoint-example" });
  findAgent.mockResolvedValue({ execution_harness_id: "agentcore" });
  expect(await resolveHarnessGatewayTarget("agent-example", context)).toEqual({ kind: "dynamic_agents", harnessId: "dynamic_agents" });
  expect(findCheckpoint).toHaveBeenCalledWith({ thread_id: "approved-runtime" }, expect.anything());
});
it("retains a legacy agent's explicitly configured checkpoint collection", async () => {
  findAgent.mockResolvedValue({ execution_harness_id: "agentcore", backend: { config: { checkpoint_collection: "approved_checkpoints" } } });
  findCheckpoint.mockResolvedValueOnce(null).mockResolvedValueOnce({ _id: "checkpoint-example" });
  expect(await resolveHarnessGatewayTarget("agent-example", context)).toEqual({ kind: "dynamic_agents", harnessId: "dynamic_agents" });
});

it("drains all committed event pages before returning a completed invoke", async () => {
  const fetchMock = jest.spyOn(global, "fetch")
    .mockResolvedValueOnce(new Response(JSON.stringify({ success: true, data: run }), { status: 202 }))
    .mockResolvedValueOnce(new Response(JSON.stringify({ success: true, data: {
      run: { ...run, status: "completed", last_sequence: 4 }, next_cursor: 2,
      events: [{ sequence: 1, event_type: "content.delta", data: { text: "first" } }, { sequence: 2, event_type: "content.delta", data: { text: " second" } }],
    } })))
    .mockResolvedValueOnce(new Response(JSON.stringify({ success: true, data: {
      run: { ...run, status: "completed", last_sequence: 4 }, next_cursor: 4,
      events: [{ sequence: 3, event_type: "content.delta", data: { text: " third" } }, { sequence: 4, event_type: "run.completed", data: {} }],
    } })));
  const response = await invokeHarnessGatewayRun({ agent_id: run.agent_id, conversation_id: run.conversation_id, message: "inspect", turn_id: "turn-example" }, auth);
  expect(await response.json()).toMatchObject({ success: true, content: "first second third" });
  expect(fetchMock.mock.calls.filter(([, options]) => options?.method === "POST")).toHaveLength(1);
  expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body))).toMatchObject({ client_request_id: "turn-example" });
});

it("does not choose permanent placement merely by reading an empty chat", async () => {
  await resolveHarnessGatewayTarget("agent-example", context);
  expect(claimOwner).not.toHaveBeenCalled();
});
it("rejects a routing reference that contradicts an existing provider binding", async () => {
  findClaim.mockResolvedValue({ agent_id: "agent-example", session_id: context.conversationId, harness_id: "agentcore" });
  findNative.mockResolvedValue({ protocol: "acp", runtime_kind: "native" });
  expect((await resolveHarnessGatewayTarget("agent-example", context) as NextResponse).status).toBe(409);
});
it("does not admit an already authorized late request after permanent deletion", async () => {
  findDeleted.mockResolvedValueOnce(null).mockResolvedValueOnce({ _id: context.conversationId });
  expect((await resolveHarnessGatewayTarget("agent-example", { ...context, admit: true }) as NextResponse).status).toBe(409);
});

it("preserves a post-subscription replay gap as a non-cursor AG-UI error", async () => {
  jest.spyOn(global, "fetch").mockResolvedValue(new Response('event: run.failed\ndata: {"code":"replay_unavailable","message":"Saved events expired"}\n\n'));
  const response = await replayHarnessGatewayRun(run, auth, "0");
  const body = await response.text();
  expect(body).toContain("event: RUN_ERROR");
  expect(body).toContain('"message":"Saved events expired"');
  expect(body).not.toContain("id:");
});

it("rejects unsupported invoke attachments before accepting an external run", async () => {
  const fetchMock = jest.spyOn(global, "fetch");
  const response = await invokeHarnessGatewayRun({ agent_id: run.agent_id, conversation_id: run.conversation_id, message: "read this", files: [{ name: "example.txt" }] }, auth);
  expect(response.status).toBe(409);
  expect(fetchMock).not.toHaveBeenCalled();
});


describe("app claims and retained execution owners", () => {
  it.each(["dynamic_agents", "agentcore"])("keeps a retained %s owner before a new app claim", async (harnessId) => {
    findApp.mockReturnValue({ appId: "example-app", path: ["api", "stream"] });
    findClaim.mockResolvedValue({ agent_id: "agent-example", session_id: context.conversationId, harness_id: harnessId });
    expect(await resolveHarnessGatewayTarget("agent-example", context)).toEqual({
      kind: harnessId === "dynamic_agents" ? "dynamic_agents" : "harness_engine", harnessId,
    });
    expect(findApp).not.toHaveBeenCalled();
    expect(claimOwner).not.toHaveBeenCalled();
  });

  it("returns no retained owner without admitting a native binding for an app", async () => {
    findAgent.mockResolvedValue(null);
    expect(await resolveHarnessGatewayTarget("agent-example", { ...context, retainedOnly: true })).toBeNull();
    expect(claimOwner).not.toHaveBeenCalled();
    expect(findApp).not.toHaveBeenCalled();
  });

  it("rejects invoke for an unbound app before creating a provider binding", async () => {
    findApp.mockReturnValue({ appId: "example-app", path: ["api", "stream"] });
    const response = await resolveHarnessGatewayTarget("agent-example", { ...context, admit: true });
    expect(response).toBeInstanceOf(NextResponse);
    expect((response as NextResponse).status).toBe(501);
    expect(await (response as NextResponse).json()).toMatchObject({ code: "APP_STREAM_REQUIRED" });
    expect(claimOwner).not.toHaveBeenCalled();
  });
});
