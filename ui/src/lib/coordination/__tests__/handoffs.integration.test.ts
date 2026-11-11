/** @jest-environment node */
import { MongoClient, type Db } from "mongodb";
import { enqueueHandoff, runHandoffsOnce, stopHandoffs } from "../handoffs.server";
import { handoffKey } from "../contracts";
import type { HarnessRun } from "@/types/harness-engine";

let mockDb: Db;
const mockFeatures = jest.fn();
jest.mock("@/lib/coordination/features.server", () => ({ getCoordinationFeatures: () => mockFeatures() }));
const mockAuth = { subject: "test-owner", email: "owner@example.test", bearerToken: "test-user-token" };
const mockPermission = jest.fn().mockResolvedValue(null);
const mockParent = jest.fn();
const mockStart = jest.fn();
const mockSession = jest.fn().mockResolvedValue({ sessionId: "test-login", accessToken: "test-user-token", expiresAt: Date.now() / 1000 + 3600 });
jest.mock("@/lib/mongodb", () => ({ getCollection: async (name: string) => mockDb.collection(name), isMongoDBConfigured: true }));
jest.mock("@/lib/da-proxy", () => ({ authenticateRequest: async () => mockAuth }));
jest.mock("@/lib/auth-token-store", () => ({ ...jest.requireActual("@/lib/auth-token-store"), getStoredSession: (...args: unknown[]) => mockSession(...args) }));
jest.mock("@/lib/auth-token-refresh", () => ({ exchangeRefreshToken: jest.fn() }));
jest.mock("@/lib/coordination/policy.server", () => ({ coordinationPolicy: async (id: string) => mockDb.collection("chat_coordination_policies").findOne({ _id: id as never }) }));
jest.mock("@/app/api/v1/chat/_conversation-authz", () => ({ authorizeConversationWriteAccess: async () => ({ conversation: await mockDb.collection("conversations").findOne({}) }) }));
jest.mock("@/lib/rbac/openfga-agent-authz", () => ({ requireAgentUsePermission: (...args: unknown[]) => mockPermission(...args) }));
jest.mock("@/lib/harness-engine-proxy", () => ({ getHarnessEngineConfig: () => ({}), proxyHarnessEngine: (...args: unknown[]) => mockParent(...args) }));
jest.mock("@/lib/harness-gateway", () => ({ resolveHarnessGatewayTarget: async () => ({ kind: "harness_engine", harnessId: "dynamic_agents" }), startHarnessGatewayRun: (...args: unknown[]) => mockStart(...args) }));

const parent = { run_id: "parent-run", owner_subject: "test-owner", agent_id: "primary-agent", conversation_id: "example-chat", status: "running", last_sequence: 0 } as HarnessRun;
const args = { handle: "helper", message: "Verify the sample without external tools." };
const run = process.env.COORDINATION_MONGO_TEST === "1" ? describe : describe.skip;
run("durable agent assignments", () => {
  let client: MongoClient;
  beforeAll(async () => {
    client = await new MongoClient(process.env.COORDINATION_MONGODB_URI!).connect();
    mockDb = client.db(`handoff_test_${process.pid}`);
  });
  afterAll(async () => { await mockDb.dropDatabase(); await client.close(); });
  beforeEach(async () => {
    await mockDb.dropDatabase(); jest.clearAllMocks();
    mockFeatures.mockResolvedValue({ enabled: true, team: true });
    mockPermission.mockResolvedValue(null);
    await mockDb.collection("conversations").insertOne({ _id: "example-chat" as never, owner_id: "owner@example.test", participants: [{ type: "agent", id: "primary-agent" }], coordination_agents: [{ agent_id: "helper-agent", handle: "helper", name: "Helper" }] });
    await mockDb.collection("chat_coordination_policies").insertOne({ _id: "example-chat" as never, generation: "generation-1", owner: "test-owner", sessionId: "test-login", mode: "team", expiresAt: new Date(Date.now() + 3600_000) });
    mockParent.mockImplementation(async (_config, _auth, path: string) => {
      if (path.includes("/events")) return Response.json({ data: { events: [{ event_type: "result.updated", data: { content: "Verified sample." } }], next_cursor: 1 } });
      return Response.json({ data: path.includes("child-run") ? { ...parent, run_id: "child-run", agent_id: "helper-agent", status: "completed", last_sequence: 1 } : { ...parent, status: "completed" } });
    });
    mockStart.mockResolvedValue({ config: {}, run: { run_id: "child-run" } });
  });
  it("disables tools and queued delivery while still saving an already admitted response", async () => {
    await enqueueHandoff(parent, mockAuth, args);
    mockFeatures.mockResolvedValue({ enabled: true, team: false });
    await expect(enqueueHandoff(parent, mockAuth, { ...args, message: "Another task" })).rejects.toThrow("active owner run");
    await runHandoffsOnce();
    expect(mockStart).not.toHaveBeenCalled();
    expect((await mockDb.collection("chat_agent_handoffs").findOne({}))?.lastError).toBe("coordination_disabled");
    await mockDb.collection("chat_agent_handoffs").updateOne({}, { $set: { status: "pending", runId: "child-run", availableAt: new Date(0) } });
    await runHandoffsOnce();
    expect((await mockDb.collection("chat_agent_handoffs").findOne({}))?.status).toBe("delivered");
    expect(mockStart).not.toHaveBeenCalled();
  });
  it("deduplicates concurrent acceptance and executes without notification services", async () => {
    await Promise.all([enqueueHandoff(parent, mockAuth, args), enqueueHandoff(parent, mockAuth, args)]);
    expect(await mockDb.collection("chat_agent_handoffs").countDocuments({ summary: { $ne: true } })).toBe(1);
    await Promise.all([runHandoffsOnce(), runHandoffsOnce()]);
    expect(mockStart).toHaveBeenCalledTimes(1);
    const job = await mockDb.collection("chat_agent_handoffs").findOne({});
    expect(job?.status).toBe("delivered");
    await runHandoffsOnce(); expect(mockStart.mock.calls.filter(([body]) => body.agent_id === "helper-agent")).toHaveLength(1);
    expect(await mockDb.collection("messages").countDocuments()).toBe(2);
  });
  it("holds work until the sender completes and skips it after Stop", async () => {
    await enqueueHandoff(parent, mockAuth, args);
    mockParent.mockResolvedValue(Response.json({ data: parent }));
    await runHandoffsOnce(); expect(mockStart).not.toHaveBeenCalled();
    await mockDb.collection("chat_agent_handoffs").updateMany({}, { $set: { availableAt: new Date(0) } });
    mockParent.mockImplementation(async () => Response.json({ data: { ...parent, status: "cancelled" } }));
    await runHandoffsOnce(); expect(mockStart).not.toHaveBeenCalled();
    expect((await mockDb.collection("chat_agent_handoffs").findOne({}))?.status).toBe("skipped");
  });
  it("precreates one canonical answer shared with browser recovery", async () => {
    await enqueueHandoff(parent, mockAuth, args);
    mockParent.mockImplementation(async (_config, _auth, path: string) => Response.json({ data: path.includes("child-run")
      ? { ...parent, run_id: "child-run", agent_id: "helper-agent", status: "running" } : { ...parent, status: "completed" } }));
    await runHandoffsOnce();
    const id = handoffKey(parent.run_id, "helper-agent", args.message);
    const answer = await mockDb.collection("messages").findOne({ message_id: `handoff-${id}-assistant` });
    expect(answer?.metadata.is_final).toBe(false);
    expect(await mockDb.collection("messages").countDocuments({ role: "assistant" })).toBe(1);
  });
  it("recovers an ambiguous admission with the identical request key", async () => {
    await enqueueHandoff(parent, mockAuth, args);
    mockStart.mockRejectedValueOnce(new Error("network outcome unknown"));
    await runHandoffsOnce();
    await mockDb.collection("chat_agent_handoffs").updateMany({}, { $set: { availableAt: new Date(0) } });
    await runHandoffsOnce();
    expect(mockStart.mock.calls.filter(([body]) => body.agent_id === "helper-agent")).toHaveLength(2);
    expect(mockStart.mock.calls[0][0]).toEqual(mockStart.mock.calls[1][0]);
    expect(mockStart.mock.calls[0][0].client_request_id).toBe(`handoff-${handoffKey(parent.run_id, "helper-agent", args.message)}`);
  });
  it("rechecks revoked access and never substitutes a service credential", async () => {
    await enqueueHandoff(parent, mockAuth, args);
    mockPermission.mockResolvedValue({ denied: true } as never);
    await runHandoffsOnce(); expect(mockStart).not.toHaveBeenCalled();
    expect((await mockDb.collection("chat_agent_handoffs").findOne({}))?.lastError).toBe("access_denied");
  });
  it("invalidates old queued work when team mode changes generation", async () => {
    await enqueueHandoff(parent, mockAuth, args);
    await mockDb.collection("chat_coordination_policies").updateMany({}, { $set: { generation: "generation-2" } });
    await runHandoffsOnce(); expect(mockStart).not.toHaveBeenCalled();
  });
  it("rejects unknown targets, self-handoffs and a ninth assignment", async () => {
    await expect(enqueueHandoff(parent, mockAuth, { ...args, handle: "outsider" })).rejects.toThrow();
    await expect(enqueueHandoff(parent, mockAuth, { ...args, handle: "primary" })).rejects.toThrow();
    for (let index = 0; index < 8; index++) await enqueueHandoff(parent, mockAuth, { ...args, message: `Assignment ${index}` });
    await expect(enqueueHandoff(parent, mockAuth, { ...args, message: "Ninth assignment" })).rejects.toThrow("task limit");
  });
  it("waits for all assignments and resumes the primary exactly once with their results", async () => {
    await enqueueHandoff(parent, mockAuth, args);
    await enqueueHandoff(parent, mockAuth, { ...args, message: "Verify another sample" });
    mockStart.mockImplementation(async body => ({ config: {}, run: { run_id: body.agent_id === "primary-agent" ? "summary-run" : "child-run" } }));
    mockParent.mockImplementation(async (_config, _auth, path: string) => {
      if (path.includes("/events")) return Response.json({ data: { events: [{ event_type: "result.updated", data: { content: "Verified sample." } }], next_cursor: 1 } });
      return Response.json({ data: { ...parent, status: "completed", last_sequence: 1,
        ...(path.includes("child-run") ? { run_id: "child-run", agent_id: "helper-agent" } : path.includes("summary-run") ? { run_id: "summary-run" } : {}),
      } });
    });
    await runHandoffsOnce();
    expect(mockStart.mock.calls.filter(([body]) => body.agent_id === "primary-agent")).toHaveLength(0);
    await mockDb.collection("chat_agent_handoffs").updateMany({}, { $set: { availableAt: new Date(0) } });
    await Promise.all([runHandoffsOnce(), runHandoffsOnce()]);
    const summaries = mockStart.mock.calls.filter(([body]) => body.agent_id === "primary-agent");
    expect(summaries).toHaveLength(1);
    expect(summaries[0][0].message).toContain("Verified sample.");
    expect(summaries[0][3]).toEqual({ summary: true });
    expect(await mockDb.collection("messages").countDocuments({ "metadata.coordination_kind": "summary", role: "assistant" })).toBe(1);
    await runHandoffsOnce();
    expect(mockStart.mock.calls.filter(([body]) => body.agent_id === "primary-agent")).toHaveLength(1);
  });
  it("does not start queued teammates or a summary after Stop team", async () => {
    await enqueueHandoff(parent, mockAuth, args);
    const chat = await mockDb.collection("conversations").findOne({});
    await stopHandoffs(mockAuth, chat as never);
    await runHandoffsOnce();
    expect(mockStart).not.toHaveBeenCalled();
    expect(await mockDb.collection("chat_agent_handoffs").countDocuments({ status: "skipped" })).toBe(2);
  });
  it("does not summarize while a teammate is still waiting for input", async () => {
    await enqueueHandoff(parent, mockAuth, args);
    mockParent.mockImplementation(async (_config, _auth, path: string) => Response.json({ data: path.includes("child-run")
      ? { ...parent, run_id: "child-run", agent_id: "helper-agent", status: "paused" } : { ...parent, status: "completed" } }));
    await runHandoffsOnce();
    await mockDb.collection("chat_agent_handoffs").updateMany({}, { $set: { availableAt: new Date(0) } });
    await runHandoffsOnce();
    expect(mockStart.mock.calls.filter(([body]) => body.agent_id === "primary-agent")).toHaveLength(0);
  });

  it("freezes summary input across an ambiguous admission and rechecks revoked peer access", async () => {
    await enqueueHandoff(parent, mockAuth, args);
    mockStart.mockImplementation(async body => {
      if (body.agent_id === "primary-agent") throw new Error("Unknown admission outcome");
      return { config: {}, run: { run_id: "child-run" } };
    });
    await runHandoffsOnce();
    await mockDb.collection("chat_agent_handoffs").updateMany({}, { $set: { availableAt: new Date(0) } });
    await runHandoffsOnce();
    const first = mockStart.mock.calls.find(([body]) => body.agent_id === "primary-agent")![0];
    await mockDb.collection("messages").updateMany({ role: "assistant" }, { $set: { content: "Later changed text" } });
    await mockDb.collection("chat_agent_handoffs").updateMany({}, { $set: { availableAt: new Date(0) } });
    await runHandoffsOnce();
    const retries = mockStart.mock.calls.filter(([body]) => body.agent_id === "primary-agent");
    expect(retries).toHaveLength(2); expect(retries[1][0]).toEqual(first);
    mockPermission.mockImplementation(async ({ agentId }) => agentId === "helper-agent" ? { denied: true } : null);
    await mockDb.collection("chat_agent_handoffs").updateMany({}, { $set: { availableAt: new Date(0) } });
    await runHandoffsOnce();
    expect(mockStart.mock.calls.filter(([body]) => body.agent_id === "primary-agent")).toHaveLength(2);
    expect((await mockDb.collection("chat_agent_handoffs").findOne({ summary: true }))?.lastError).toBe("access_denied");
  });

  it("follows a resumed teammate even if the BFF lost its admission acknowledgement", async () => {
    await enqueueHandoff(parent, mockAuth, args);
    mockParent.mockImplementation(async (_config, _auth, path: string) => Response.json({ data: path.includes("child-run")
      ? { ...parent, run_id: "child-run", agent_id: "helper-agent", status: "paused" } : { ...parent, status: "completed" } }));
    await runHandoffsOnce();
    await mockDb.collection("chat_agent_handoffs").updateOne({ summary: { $ne: true } }, { $set: { resumeRequestId: "example-resume-request", availableAt: new Date(0) } });
    mockParent.mockImplementation(async (_config, _auth, path: string) => {
      if (path.includes("run-requests/lookup")) return Response.json({ data: { ...parent, run_id: "resumed-run", agent_id: "helper-agent", resumes_run_id: "child-run", status: "completed", last_sequence: 1 } });
      if (path.includes("/events")) return Response.json({ data: { events: [{ event_type: "result.updated", data: { content: "Completed after input" } }], next_cursor: 1 } });
      return Response.json({ data: path.includes("resumed-run") ? { ...parent, run_id: "resumed-run", agent_id: "helper-agent", status: "completed", last_sequence: 1 } : { ...parent, status: "completed" } });
    });
    await runHandoffsOnce();
    const job = await mockDb.collection("chat_agent_handoffs").findOne({ summary: { $ne: true } });
    expect(job?.runId).toBe("resumed-run"); expect(job?.status).toBe("delivered");
    expect((await mockDb.collection("messages").findOne({ message_id: `handoff-${job?._id}-assistant` }))?.content).toBe("Completed after input");
  });

});
