/**
 * @jest-environment node
 */

import { NextRequest, NextResponse } from "next/server";

import { POST as startRun } from "../runs/route";
import { GET as getRun, DELETE as cancelRun } from "../runs/[runId]/route";
import { GET as getEvents } from "../runs/[runId]/events/route";
import { GET as streamRun } from "../runs/[runId]/events/stream/route";
import { POST as validateDraft } from "../agent-drafts/validate/route";
import { POST as clearSession } from "../sessions/clear/route";

const mockAuthenticateRequest = jest.fn();
const mockRequireAgentUsePermission = jest.fn();
const mockRequireConversationWriteAccess = jest.fn();
const mockRequireConversationReadAccess = jest.fn();
let mockSelectedHarness = "agentcore";
let mockVisibleConversation = { _id: "conversation-example", execution_context_id: "conversation-example" };
const ownedRun = { run_id: "run-1", owner_subject: "test-user", agent_id: "agent-example", conversation_id: "conversation-example" };

jest.mock("@/lib/da-proxy", () => ({
  authenticateRequest: (...args: unknown[]) => mockAuthenticateRequest(...args),
}));
jest.mock("@/lib/rbac/openfga-agent-authz", () => ({
  requireAgentUsePermission: (...args: unknown[]) => mockRequireAgentUsePermission(...args),
}));
jest.mock("@/app/api/v1/chat/_conversation-authz", () => ({
  authorizeConversationWriteAccess: (...args: unknown[]) => mockRequireConversationWriteAccess(...args),
  authorizeConversationReadAccess: (...args: unknown[]) => mockRequireConversationReadAccess(...args),
  resolveConversationRuntimeId: async (conversation: { _id: string; execution_context_id?: string }) => conversation.execution_context_id ?? conversation._id,
}));

jest.mock("@/lib/mongodb", () => ({
  getCollection: async (name: string) => ({ findOneAndUpdate: async (_query: unknown, update: { $setOnInsert: unknown }) => update.$setOnInsert, findOne: async () =>
    name === "dynamic_agents" ? { _id: "agent-example", execution_harness_id: mockSelectedHarness }
      : name === "conversations" ? mockVisibleConversation : null }),
}));

describe("Harness Engine BFF session routes", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockSelectedHarness = "agentcore";
    mockVisibleConversation = { _id: "conversation-example", execution_context_id: "conversation-example" };
    process.env.HARNESS_ENGINE_URL = "http://harness-engine:8010";
    process.env.HARNESS_ENGINE_INTERNAL_TOKEN = "internal-test-token";
    mockAuthenticateRequest.mockResolvedValue({
      subject: "test-user",
      email: "test-user@example.com",
      tenantId: "primary",
      bearerToken: "must-not-leave-bff",
    });
    mockRequireAgentUsePermission.mockResolvedValue(null);
    mockRequireConversationWriteAccess.mockResolvedValue({ conversation: { _id: "conversation-example" }, denial: null });
    mockRequireConversationReadAccess.mockResolvedValue({ conversation: { _id: "conversation-example" }, denial: null });
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("starts a detached run with service credentials, not the user bearer token", async () => {
    const fetchMock = jest.spyOn(global, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ success: true, data: { run_id: "run-1" } }), {
        status: 202,
        headers: { "Content-Type": "application/json" },
      }),
    );
    const request = new NextRequest("http://localhost/api/harness-engine/runs", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer must-not-leave-bff" },
      body: JSON.stringify({
        agent_id: "agent-example",
        conversation_id: "conversation-example",
        message: "hello",
      }),
    });

    const response = await startRun(request);

    expect(response.status).toBe(202);
    expect(fetchMock).toHaveBeenCalledWith(
      "http://harness-engine:8010/api/v1/runs",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          Authorization: "Bearer internal-test-token",
          "X-Harness-Engine-Subject": "test-user",
        }),
      }),
    );
    expect(JSON.stringify(fetchMock.mock.calls[0][1]?.headers)).not.toContain("must-not-leave-bff");
  });

  it("resumes an SSE subscription from Last-Event-ID without owning provider execution", async () => {
    const fetchMock = jest.spyOn(global, "fetch").mockResolvedValueOnce(
      new Response(JSON.stringify({ success: true, data: { run_id: "run-1", owner_subject: "test-user", agent_id: "agent-example", conversation_id: "conversation-example" } })),
    ).mockResolvedValueOnce(
      new Response("id: 8\nevent: run.completed\ndata: {}\n\n", {
        headers: { "Content-Type": "text/event-stream" },
      }),
    );
    const request = new NextRequest(
      "http://localhost/api/harness-engine/runs/run-1/events/stream",
      { headers: { "Last-Event-ID": "7" } },
    );

    const response = await streamRun(request, { params: Promise.resolve({ runId: "run-1" }) });

    expect(response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledWith(
      "http://harness-engine:8010/api/v1/runs/run-1/events/stream?after=7",
      expect.objectContaining({ method: "GET" }),
    );
  });

  it("validates portable blueprints with the service identity", async () => {
    const fetchMock = jest.spyOn(global, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ success: true, data: { valid: true } }), {
        headers: { "Content-Type": "application/json" },
      }),
    );
    const request = new NextRequest(
      "http://localhost/api/harness-engine/agent-drafts/validate",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ blueprint: { id: "agent-example" } }),
      },
    );

    const response = await validateDraft(request);

    expect(response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledWith(
      "http://harness-engine:8010/api/v1/agent-drafts/validate",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          Authorization: "Bearer internal-test-token",
          "X-Harness-Engine-Subject": "test-user",
        }),
      }),
    );
  });

  it("authorizes and clears a CAIPE-managed agent session", async () => {
    const fetchMock = jest.spyOn(global, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ success: true, data: { cleared: true } }), {
        headers: { "Content-Type": "application/json" },
      }),
    );
    const request = new NextRequest(
      "http://localhost/api/harness-engine/sessions/clear",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          agent_id: "agent-example",
          conversation_id: "conversation-example",
        }),
      },
    );

    const response = await clearSession(request);

    expect(response.status).toBe(200);
    expect(mockRequireAgentUsePermission).not.toHaveBeenCalled();
    expect(mockRequireConversationWriteAccess).toHaveBeenCalledWith(
      expect.objectContaining({ subject: "test-user" }),
      "conversation-example",
      "agent-example",
    );
    expect(fetchMock).toHaveBeenCalledWith(
      "http://harness-engine:8010/api/v1/sessions/clear",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("fails closed when the independent service is not configured", async () => {
    delete process.env.HARNESS_ENGINE_URL;
    delete process.env.HARNESS_ENGINE_INTERNAL_TOKEN;
    const request = new NextRequest("http://localhost/api/harness-engine/runs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        agent_id: "agent-example",
        conversation_id: "conversation-example",
        message: "hello",
      }),
    });
    const response = await startRun(request);
    expect(response.status).toBe(503);
  });

it("denies event replay after the conversation read grant is revoked", async () => {
  mockRequireConversationReadAccess.mockResolvedValue({ conversation: null, denial: new Response(JSON.stringify({ error: "Denied" }), { status: 403 }) });
  const fetchMock = jest.spyOn(global, "fetch").mockResolvedValue(new Response(JSON.stringify({ success: true, data: { run_id: "run-1", owner_subject: "test-user", agent_id: "agent-example", conversation_id: "conversation-example" } })));
  const response = await streamRun(new NextRequest("http://localhost/api/harness-engine/runs/run-1/events/stream"), { params: Promise.resolve({ runId: "run-1" }) });
  expect(response.status).toBe(403);
  expect(fetchMock).toHaveBeenCalledTimes(1);
  expect(String(fetchMock.mock.calls[0][0])).not.toContain("events/stream");
});

  it("cannot bypass a native context's gateway owner through direct Engine admission", async () => {
    mockSelectedHarness = "dynamic_agents";
    const fetchMock = jest.spyOn(global, "fetch");
    const response = await startRun(new NextRequest("http://localhost/api/harness-engine/runs", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ agent_id: "agent-example", conversation_id: "conversation-example", message: "inspect", expected_harness_id: "agentcore" }),
    }));
    expect(response.status).toBe(409);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("cannot bypass a retained app owner through direct Engine admission", async () => {
    mockRequireConversationWriteAccess.mockResolvedValue({ conversation: {
      _id: "conversation-example", app_binding: { app_id: "app-primary", agent_id: "agent-example" },
    }, denial: null });
    const fetchMock = jest.spyOn(global, "fetch");
    const response = await startRun(new NextRequest("https://example.test/api/harness-engine/runs", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ agent_id: "agent-example", conversation_id: "conversation-example", message: "Inspect" }),
    }));
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: "APP_BINDING_CONFLICT" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("admits a provider-backed overlay whose metadata does not claim app execution", async () => {
    mockRequireConversationWriteAccess.mockResolvedValue({ conversation: {
      _id: "conversation-example", participants: [{ type: "agent", id: "agent-example" }], metadata: {
        conversation_surface: "agentic-app", agentic_app_id: "app-primary", agentic_app_agent_id: "agent-example",
      },
    }, denial: null });
    const fetchMock = jest.spyOn(global, "fetch").mockResolvedValue(new Response(JSON.stringify({ success: true, data: ownedRun }), { status: 202 }));
    const response = await startRun(new NextRequest("https://example.test/api/harness-engine/runs", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ agent_id: "agent-example", conversation_id: "conversation-example", message: "Inspect" }),
    }));
    expect(response.status).toBe(202);
    expect(fetchMock).toHaveBeenCalledWith("http://harness-engine:8010/api/v1/runs", expect.objectContaining({ method: "POST" }));
  });

  it("rejects unsupported direct Engine attachments instead of silently dropping them", async () => {
    const fetchMock = jest.spyOn(global, "fetch");
    const response = await startRun(new NextRequest("http://localhost/api/harness-engine/runs", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ agent_id: "agent-example", conversation_id: "conversation-example", message: "inspect", files: [{ name: "example.txt" }] }),
    }));
    expect(response.status).toBe(409);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([["runs", startRun], ["sessions/clear", clearSession]])("preserves conversation write denials for %s", async (path, handler) => {
    const denial = NextResponse.json({ success: false, error: "Automated history is read-only" }, { status: 409 });
    mockRequireConversationWriteAccess.mockResolvedValue({ conversation: null, denial });
    const fetchMock = jest.spyOn(global, "fetch");
    const response = await handler(new NextRequest(`http://localhost/api/harness-engine/${path}`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ agent_id: "agent-example", conversation_id: "conversation-example", message: "inspect" }),
    }));
    expect(response).toBe(denial);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  const runHandlers = [
    ["detail", getRun, "read"],
    ["events", getEvents, "read"],
    ["stream", streamRun, "read"],
    ["cancel", cancelRun, "write"],
  ] as const;

  it.each(runHandlers)("requires authentication for run %s", async (_name, handler) => {
    mockAuthenticateRequest.mockResolvedValue(NextResponse.json({ error: "Unauthorized" }, { status: 401 }));
    const fetchMock = jest.spyOn(global, "fetch");
    const response = await handler(new NextRequest("https://example.test/api/harness-engine/runs/run-1"), {
      params: Promise.resolve({ runId: "run-1" }),
    });
    expect(response.status).toBe(401);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each(runHandlers.filter(([, , permission]) => permission === "read"))("rechecks revoked agent use before run %s", async (_name, handler) => {
    const denial = NextResponse.json({ error: "Agent use revoked" }, { status: 403 });
    mockRequireAgentUsePermission.mockResolvedValue(denial);
    const fetchMock = jest.spyOn(global, "fetch").mockImplementation(async () => NextResponse.json({ success: true, data: ownedRun }));
    const response = await handler(new NextRequest("https://example.test/api/harness-engine/runs/run-1"), {
      params: Promise.resolve({ runId: "run-1" }),
    });
    expect(response).toBe(denial);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0][0])).toBe("http://harness-engine:8010/api/v1/runs/run-1");
    expect(mockRequireConversationReadAccess).not.toHaveBeenCalled();
    expect(mockRequireConversationWriteAccess).not.toHaveBeenCalled();
  });

  it.each(runHandlers)("rechecks conversation permission before run %s", async (_name, handler, permission) => {
    const denial = NextResponse.json({ error: "Conversation access revoked" }, { status: 403 });
    const authorize = permission === "write" ? mockRequireConversationWriteAccess : mockRequireConversationReadAccess;
    authorize.mockResolvedValue({ conversation: null, denial });
    const fetchMock = jest.spyOn(global, "fetch").mockImplementation(async () => NextResponse.json({ success: true, data: ownedRun }));
    const response = await handler(new NextRequest("https://example.test/api/harness-engine/runs/run-1"), {
      params: Promise.resolve({ runId: "run-1" }),
    });
    expect(response).toBe(denial);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(authorize).toHaveBeenCalledWith(expect.objectContaining({ subject: "test-user" }), "conversation-example", "agent-example");
  });

  it.each(runHandlers)("keeps Engine owner denial private for run %s", async (_name, handler) => {
    const fetchMock = jest.spyOn(global, "fetch").mockImplementation(async () => NextResponse.json({ detail: "Run not found" }, { status: 404 }));
    const response = await handler(new NextRequest("https://example.test/api/harness-engine/runs/run-1"), {
      params: Promise.resolve({ runId: "run-1" }),
    });
    expect(response.status).toBe(404);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(mockRequireAgentUsePermission).not.toHaveBeenCalled();
  });

  it.each(runHandlers)("allows currently authorized run %s with service-account classification", async (name, handler, permission) => {
    mockAuthenticateRequest.mockResolvedValue({ subject: "test-user", isServiceAccount: true });
    const fetchMock = jest.spyOn(global, "fetch").mockImplementation(async input => {
      if (String(input).endsWith("/runs/run-1")) return NextResponse.json({ success: true, data: ownedRun });
      if (name === "stream") return new Response("data: {}\n\n", { headers: { "Content-Type": "text/event-stream" } });
      return NextResponse.json({ success: true, data: { events: [] } });
    });
    const response = await handler(new NextRequest("https://example.test/api/harness-engine/runs/run-1?after=7&wait=2", {
      headers: { "Last-Event-ID": "7" },
    }), { params: Promise.resolve({ runId: "run-1" }) });
    expect(response.status).toBe(200);
    if (permission === "read") expect(mockRequireAgentUsePermission).toHaveBeenCalledWith(expect.objectContaining({
      subject: "test-user", agentId: "agent-example", isServiceAccount: true,
    }));
    else expect(mockRequireAgentUsePermission).not.toHaveBeenCalled();
    const authorize = permission === "write" ? mockRequireConversationWriteAccess : mockRequireConversationReadAccess;
    expect(authorize).toHaveBeenCalledWith(expect.objectContaining({ isServiceAccount: true }), "conversation-example", "agent-example");
    expect(fetchMock).toHaveBeenCalledTimes(name === "detail" ? 1 : 2);
  });

  it.each([
    { ...ownedRun, owner_subject: "another-user" },
    { ...ownedRun, agent_id: null },
    { ...ownedRun, run_id: "another-run" },
  ])("rejects inconsistent Engine run metadata", async data => {
    jest.spyOn(global, "fetch").mockImplementation(async () => NextResponse.json({ success: true, data }));
    const response = await getRun(new NextRequest("https://example.test/api/harness-engine/runs/run-1"), {
      params: Promise.resolve({ runId: "run-1" }),
    });
    expect(response.status).toBe(502);
    expect(mockRequireAgentUsePermission).not.toHaveBeenCalled();
  });


  it("can still Stop an owned run after its agent-use grant was revoked", async () => {
    mockRequireAgentUsePermission.mockResolvedValue(NextResponse.json({ error: "Agent use revoked" }, { status: 403 }));
    const fetchMock = jest.spyOn(global, "fetch").mockImplementation(async () => NextResponse.json({ success: true, data: ownedRun }));
    const result = await cancelRun(new NextRequest("https://example.test/api/harness-engine/runs/run-1", { method: "DELETE" }), { params: Promise.resolve({ runId: "run-1" }) });
    expect(result.status).toBe(200);
    expect(mockRequireAgentUsePermission).not.toHaveBeenCalled();
    expect(mockRequireConversationWriteAccess).toHaveBeenCalled();
    expect(fetchMock).toHaveBeenLastCalledWith("http://harness-engine:8010/api/v1/runs/run-1", expect.objectContaining({ method: "DELETE" }));
  });

  it("checks visible conversation grants when an Engine run uses an isolated execution context", async () => {
    mockVisibleConversation = { _id: "visible-example", execution_context_id: "runtime-example" };
    jest.spyOn(global, "fetch").mockResolvedValue(NextResponse.json({ success: true, data: { ...ownedRun, conversation_id: "runtime-example" } }));
    const result = await getRun(new NextRequest("https://example.test/api/harness-engine/runs/run-1"), { params: Promise.resolve({ runId: "run-1" }) });
    expect(result.status).toBe(200);
    expect(mockRequireConversationReadAccess).toHaveBeenCalledWith(
      expect.objectContaining({ subject: "test-user" }), "visible-example", "agent-example",
    );
  });

  it("rejects a visible conversation whose runtime no longer matches the retained run", async () => {
    mockVisibleConversation = { _id: "visible-example", execution_context_id: "another-runtime" };
    jest.spyOn(global, "fetch").mockResolvedValue(NextResponse.json({ success: true, data: ownedRun }));
    const result = await getRun(new NextRequest("https://example.test/api/harness-engine/runs/run-1"), { params: Promise.resolve({ runId: "run-1" }) });
    expect(result.status).toBe(404);
    expect(mockRequireConversationReadAccess).not.toHaveBeenCalled();
  });
});
