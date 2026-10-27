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
const mockClearHarnessGatewayBinding = jest.fn();
const mockResolveHarnessGatewayTarget = jest.fn();
jest.mock("@/lib/harness-gateway", () => ({
  clearHarnessGatewayBinding: (...args: unknown[]) => mockClearHarnessGatewayBinding(...args),
  resolveHarnessGatewayTarget: (...args: unknown[]) => mockResolveHarnessGatewayTarget(...args),
}));
const mockRequireAgentUsePermission = jest.fn();
const mockAuthorizeConversationWriteAccess = jest.fn();
const mockAuthorizeConversationReadAccess = jest.fn();

jest.mock("@/lib/da-proxy", () => ({
  authenticateRequest: (...args: unknown[]) => mockAuthenticateRequest(...args),
}));
jest.mock("@/lib/rbac/openfga-agent-authz", () => ({
  requireAgentUsePermission: (...args: unknown[]) => mockRequireAgentUsePermission(...args),
}));
jest.mock("@/app/api/v1/chat/_conversation-authz", () => ({
  authorizeConversationWriteAccess: (...args: unknown[]) => mockAuthorizeConversationWriteAccess(...args),
  authorizeConversationReadAccess: (...args: unknown[]) => mockAuthorizeConversationReadAccess(...args),
  resolveConversationRuntimeId: async (conversation: { _id: string }) => conversation._id,
}));

const ownedRun = {
  run_id: "run-1", owner_subject: "test-user", agent_id: "agent-example",
  conversation_id: "conversation-example", status: "running",
};

describe("Harness Engine BFF session routes", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.HARNESS_ENGINE_URL = "http://harness-engine:8010";
    process.env.HARNESS_ENGINE_INTERNAL_TOKEN = "internal-test-token";
    mockAuthenticateRequest.mockResolvedValue({
      subject: "test-user",
      email: "test-user@example.com",
      tenantId: "primary",
      bearerToken: "must-not-leave-bff",
    });
    mockRequireAgentUsePermission.mockResolvedValue(null);
    mockResolveHarnessGatewayTarget.mockResolvedValue({ kind: "harness_engine", harnessId: "agentcore" });
    mockAuthorizeConversationReadAccess.mockResolvedValue({ conversation: { _id: "conversation-example" }, denial: null });
    mockAuthorizeConversationWriteAccess.mockResolvedValue({
      conversation: { _id: "conversation-example" },
      denial: null,
    });
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
    const fetchMock = jest.spyOn(global, "fetch").mockImplementation(async input =>
      String(input).endsWith("/runs/run-1")
        ? NextResponse.json({ success: true, data: ownedRun })
        : new Response("id: 8\nevent: run.completed\ndata: {}\n\n", {
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
    expect(mockClearHarnessGatewayBinding).toHaveBeenCalledWith("agent-example", "test-user", "conversation-example");
    expect(mockRequireAgentUsePermission).toHaveBeenCalledWith(
      expect.objectContaining({ agentId: "agent-example", subject: "test-user" }),
    );
    expect(mockAuthorizeConversationWriteAccess).toHaveBeenCalledWith(
      expect.objectContaining({ subject: "test-user" }),
      "conversation-example",
      "agent-example",
    );
    expect(fetchMock).toHaveBeenCalledWith(
      "http://harness-engine:8010/api/v1/sessions/clear",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("keeps the routing pin when Engine session clear fails", async () => {
    jest.spyOn(global, "fetch").mockResolvedValue(new Response("unavailable", { status: 503 }));
    const response = await clearSession(new NextRequest("http://localhost/api/harness-engine/sessions/clear", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ agent_id: "agent-example", conversation_id: "conversation-example" }),
    }));
    expect(response.status).toBe(503);
    expect(mockClearHarnessGatewayBinding).not.toHaveBeenCalled();
  });

  it.each([
    ["runs", startRun],
    ["sessions/clear", clearSession],
  ])("preserves conversation write denials for %s", async (path, handler) => {
    const denial = NextResponse.json(
      { success: false, error: "Automated history is read-only" },
      { status: 409 },
    );
    mockAuthorizeConversationWriteAccess.mockResolvedValue({ conversation: null, denial });
    const fetchMock = jest.spyOn(global, "fetch");
    const response = await handler(new NextRequest(`http://localhost/api/harness-engine/${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ agent_id: "agent-example", conversation_id: "conversation-example" }),
    }));

    expect(response).toBe(denial);
    expect(fetchMock).not.toHaveBeenCalled();
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

  it.each(runHandlers)("rechecks revoked agent use before run %s", async (_name, handler) => {
    const denial = NextResponse.json({ error: "Agent use revoked" }, { status: 403 });
    mockRequireAgentUsePermission.mockResolvedValue(denial);
    const fetchMock = jest.spyOn(global, "fetch").mockImplementation(async () => NextResponse.json({ success: true, data: ownedRun }));
    const response = await handler(new NextRequest("https://example.test/api/harness-engine/runs/run-1"), {
      params: Promise.resolve({ runId: "run-1" }),
    });
    expect(response).toBe(denial);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0][0])).toBe("http://harness-engine:8010/api/v1/runs/run-1");
    expect(mockAuthorizeConversationReadAccess).not.toHaveBeenCalled();
    expect(mockAuthorizeConversationWriteAccess).not.toHaveBeenCalled();
  });

  it.each(runHandlers)("rechecks conversation permission before run %s", async (_name, handler, permission) => {
    const denial = NextResponse.json({ error: "Conversation access revoked" }, { status: 403 });
    const authorize = permission === "write" ? mockAuthorizeConversationWriteAccess : mockAuthorizeConversationReadAccess;
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
    expect(mockRequireAgentUsePermission).toHaveBeenCalledWith(expect.objectContaining({
      subject: "test-user", agentId: "agent-example", isServiceAccount: true,
    }));
    const authorize = permission === "write" ? mockAuthorizeConversationWriteAccess : mockAuthorizeConversationReadAccess;
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

  it("rejects direct Engine admission for a conversation pinned to native execution", async () => {
    mockResolveHarnessGatewayTarget.mockResolvedValue({ kind: "dynamic_agents", harnessId: "dynamic_agents" });
    const fetchMock = jest.spyOn(global, "fetch");
    const response = await startRun(new NextRequest("https://example.test/api/harness-engine/runs", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ agent_id: "agent-example", conversation_id: "conversation-example", message: "hello" }),
    }));
    expect(response.status).toBe(409);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
