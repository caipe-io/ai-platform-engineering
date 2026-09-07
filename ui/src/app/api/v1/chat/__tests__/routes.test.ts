/**
 * @jest-environment node
 */

import { NextRequest, NextResponse } from "next/server";

import { POST as invokePost } from "../invoke/route";
import { POST as cancelPost } from "../stream/cancel/route";
import { POST as resumePost } from "../stream/resume/route";
import { POST as startPost } from "../stream/start/route";

const mockAuthenticateRequest = jest.fn();
const mockGetDynamicAgentsConfig = jest.fn();
const mockProxySSEStream = jest.fn();
const mockProxyJSONRequest = jest.fn();
const mockRequireAgentUsePermission = jest.fn();
const mockRequireResourcePermission = jest.fn();
const mockRequireConversationResourcePermission = jest.fn();
const mockGetCollection = jest.fn();
const mockIsSchedulerTokenConfigured = jest.fn();
const mockIsSchedulerTokenValid = jest.fn();
const mockResolveScheduledRunContext = jest.fn();
const mockMintScheduledOwnerToken = jest.fn();

jest.mock("@/lib/da-proxy", () => ({
  authenticateRequest: (...args: unknown[]) => mockAuthenticateRequest(...args),
  getDynamicAgentsInvokeProxyOptions: () => ({}),
  getDynamicAgentsConfig: (...args: unknown[]) => mockGetDynamicAgentsConfig(...args),
  proxySSEStream: (...args: unknown[]) => mockProxySSEStream(...args),
  proxyJSONRequest: (...args: unknown[]) => mockProxyJSONRequest(...args),
}));

jest.mock("@/lib/scheduled-run-auth", () => ({
  isSchedulerTokenConfigured: (...args: unknown[]) => mockIsSchedulerTokenConfigured(...args),
  isSchedulerTokenValid: (...args: unknown[]) => mockIsSchedulerTokenValid(...args),
  resolveScheduledRunContext: (...args: unknown[]) => mockResolveScheduledRunContext(...args),
  mintScheduledOwnerToken: (...args: unknown[]) => mockMintScheduledOwnerToken(...args),
}));

jest.mock("@/lib/rbac/openfga-agent-authz", () => ({
  requireAgentUsePermission: (...args: unknown[]) => mockRequireAgentUsePermission(...args),
}));

jest.mock("@/lib/rbac/resource-authz", () => ({
  requireResourcePermission: (...args: unknown[]) => mockRequireResourcePermission(...args),
}));

jest.mock("@/lib/rbac/conversation-implicit-authz", () => ({
  requireConversationResourcePermission: (...args: unknown[]) =>
    mockRequireConversationResourcePermission(...args),
}));

jest.mock("@/lib/mongodb", () => ({
  getCollection: (...args: unknown[]) => mockGetCollection(...args),
  isMongoDBConfigured: true,
}));

function jsonRequest(
  path: string,
  body: Record<string, unknown> = {},
  headers: Record<string, string> = {},
): NextRequest {
  return new NextRequest(new URL(path, "http://localhost:3000"), {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

async function jsonBody(response: Response): Promise<Record<string, unknown>> {
  return (await response.json()) as Record<string, unknown>;
}

describe("Dynamic Agent chat Web UI backend routes", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockAuthenticateRequest.mockResolvedValue({
      subject: "alice-sub",
      email: "alice@example.com",
      tenantId: "default",
      bearerToken: "token",
    });
    mockGetDynamicAgentsConfig.mockReturnValue({ dynamicAgentsUrl: "http://dynamic-agents:8000" });
    mockRequireAgentUsePermission.mockResolvedValue(null);
    mockRequireResourcePermission.mockResolvedValue(undefined);
    mockRequireConversationResourcePermission.mockResolvedValue(undefined);
    mockGetCollection.mockResolvedValue({
      findOne: jest.fn(async () => ({
        _id: "conv-1",
        owner_id: "alice@example.com",
        owner_subject: "alice-sub",
      })),
    });
    mockProxySSEStream.mockResolvedValue(new Response("event: done\n\n", { status: 200 }));
    mockProxyJSONRequest.mockResolvedValue(NextResponse.json({ success: true }));
    // Scheduled-run defaults: token configured + valid, owner resolves, mint ok.
    mockIsSchedulerTokenConfigured.mockReturnValue(true);
    mockIsSchedulerTokenValid.mockReturnValue(true);
    mockResolveScheduledRunContext.mockResolvedValue({
      sub: "owner-sub",
      email: "owner@example.com",
      agentId: "agent-persisted",
      projectId: "pod-safe",
      scheduleTitle: "Persisted schedule title",
    });
    mockMintScheduledOwnerToken.mockResolvedValue("owner-bearer-token");
  });

  it.each([
    [
      "start",
      startPost,
      "/api/v1/chat/stream/start",
      { message: "hi", conversation_id: "conv-1", agent_id: "agent-1" },
      mockProxySSEStream,
    ],
    [
      "invoke",
      invokePost,
      "/api/v1/chat/invoke",
      { message: "hi", conversation_id: "conv-1", agent_id: "agent-1" },
      mockProxyJSONRequest,
    ],
    [
      "resume",
      resumePost,
      "/api/v1/chat/stream/resume",
      { conversation_id: "conv-1", agent_id: "agent-1", resume_data: "{}" },
      mockProxySSEStream,
    ],
  ])("checks OpenFGA before proxying %s requests", async (_name, handler, path, body, proxy) => {
    const response = await handler(jsonRequest(path, body));

    expect(response.status).toBe(200);
    expect(mockRequireAgentUsePermission).toHaveBeenCalledWith(
      expect.objectContaining({
        subject: "alice-sub",
        agentId: "agent-1",
        email: "alice@example.com",
        tenantId: "default",
        traceparent: expect.stringMatching(/^00-[a-f0-9]{32}-[a-f0-9]{16}-01$/),
      }),
    );
    expect(proxy).toHaveBeenCalledTimes(1);
    expect(mockRequireConversationResourcePermission).toHaveBeenCalledWith(
      expect.objectContaining({ sub: "alice-sub", user: { email: "alice@example.com" } }),
      "alice@example.com",
      expect.objectContaining({ _id: "conv-1" }),
      "write",
    );
    expect(proxy.mock.calls[0][2]).toEqual(
      expect.objectContaining({
        traceparent: expect.stringMatching(/^00-[a-f0-9]{32}-[a-f0-9]{16}-01$/),
      }),
    );
  });

  it("threads isServiceAccount into the conversation write check so SA callers graph as service_account:<sub>", async () => {
    // Regression: requireConversationWriteAccess dropped isServiceAccount, so an
    // SA-routed Slack request was graphed as user:<sub> and 403'd conversation#write
    // even though the SA held the writer grant on the conversation it created.
    mockAuthenticateRequest.mockResolvedValue({
      subject: "sa-sub",
      email: "service-account-anon@noreply",
      tenantId: "default",
      bearerToken: "token",
      isServiceAccount: true,
    });

    const response = await startPost(
      jsonRequest("/api/v1/chat/stream/start", {
        message: "hi",
        conversation_id: "conv-1",
        agent_id: "agent-1",
      }),
    );

    expect(response.status).toBe(200);
    expect(mockRequireConversationResourcePermission).toHaveBeenCalledWith(
      expect.objectContaining({ sub: "sa-sub", isServiceAccount: true }),
      expect.anything(),
      expect.objectContaining({ _id: "conv-1" }),
      "write",
    );
  });

  it("bypasses the conversation#write check for Slack conversations so any thread participant can invoke", async () => {
    // Slack threads are multi-participant. A non-owner (bob) must be able to
    // invoke the agent within the thread. agent#can_use is still enforced first;
    // the conversation#write ReBAC check is skipped for client_type === 'slack'.
    mockAuthenticateRequest.mockResolvedValue({
      subject: "bob-sub",
      email: "bob@example.com",
      tenantId: "default",
      bearerToken: "token",
    });
    mockGetCollection.mockResolvedValue({
      findOne: jest.fn(async () => ({
        _id: "conv-1",
        owner_id: "alice@example.com",
        owner_subject: "alice-sub",
        client_type: "slack",
      })),
    });

    const response = await startPost(
      jsonRequest("/api/v1/chat/stream/start", {
        message: "hi",
        conversation_id: "conv-1",
        agent_id: "agent-1",
      }),
    );

    expect(response.status).toBe(200);
    expect(mockRequireAgentUsePermission).toHaveBeenCalledTimes(1);
    // The write check is short-circuited for Slack conversations.
    expect(mockRequireConversationResourcePermission).not.toHaveBeenCalled();
    expect(mockProxySSEStream).toHaveBeenCalledTimes(1);
  });

  it("still enforces the conversation#write check for non-Slack conversations", async () => {
    // Regression guard: the Slack bypass must not leak to webui conversations.
    mockRequireConversationResourcePermission.mockRejectedValue(
      Object.assign(new Error("denied"), { statusCode: 403, code: "conversation#write" }),
    );
    mockGetCollection.mockResolvedValue({
      findOne: jest.fn(async () => ({
        _id: "conv-1",
        owner_id: "alice@example.com",
        owner_subject: "alice-sub",
        client_type: "webui",
      })),
    });

    const response = await startPost(
      jsonRequest("/api/v1/chat/stream/start", {
        message: "hi",
        conversation_id: "conv-1",
        agent_id: "agent-1",
      }),
    );

    expect(response.status).toBe(403);
    expect(mockRequireConversationResourcePermission).toHaveBeenCalledTimes(1);
    expect(mockProxySSEStream).not.toHaveBeenCalled();
  });

  it.each([
    ["start", startPost, "/api/v1/chat/stream/start", { message: "hi", conversation_id: "conv-1", agent_id: "agent-1" }],
    ["invoke", invokePost, "/api/v1/chat/invoke", { message: "hi", conversation_id: "conv-1", agent_id: "agent-1" }],
    ["resume", resumePost, "/api/v1/chat/stream/resume", { conversation_id: "conv-1", agent_id: "agent-1", resume_data: "{}" }],
  ])("returns OpenFGA denial before proxying %s requests", async (_name, handler, path, body) => {
    mockRequireAgentUsePermission.mockResolvedValue(
      NextResponse.json(
        { success: false, code: "agent#use", reason: "pdp_denied", action: "contact_admin" },
        { status: 403 },
      ),
    );

    const response = await handler(jsonRequest(path, body));

    expect(response.status).toBe(403);
    expect(await jsonBody(response)).toMatchObject({ reason: "pdp_denied", action: "contact_admin" });
    expect(mockProxySSEStream).not.toHaveBeenCalled();
    expect(mockProxyJSONRequest).not.toHaveBeenCalled();
  });

  it("does not call OpenFGA when authentication fails", async () => {
    mockAuthenticateRequest.mockResolvedValue(
      NextResponse.json(
        { success: false, code: "NOT_SIGNED_IN", reason: "not_signed_in", action: "sign_in" },
        { status: 401 },
      ),
    );

    const response = await startPost(
      jsonRequest("/api/v1/chat/stream/start", {
        message: "hi",
        conversation_id: "conv-1",
        agent_id: "agent-1",
      }),
    );

    expect(response.status).toBe(401);
    expect(mockRequireAgentUsePermission).not.toHaveBeenCalled();
    expect(mockRequireResourcePermission).not.toHaveBeenCalled();
    expect(mockRequireConversationResourcePermission).not.toHaveBeenCalled();
    expect(mockProxySSEStream).not.toHaveBeenCalled();
  });

  it("returns OpenFGA unavailable responses before proxying protected requests", async () => {
    mockRequireAgentUsePermission.mockResolvedValue(
      NextResponse.json(
        { success: false, code: "PDP_UNAVAILABLE", reason: "pdp_unavailable", action: "retry" },
        { status: 503 },
      ),
    );

    const response = await startPost(
      jsonRequest("/api/v1/chat/stream/start", {
        message: "hi",
        conversation_id: "conv-1",
        agent_id: "agent-1",
      }),
    );

    expect(response.status).toBe(503);
    expect(await jsonBody(response)).toMatchObject({
      code: "PDP_UNAVAILABLE",
      reason: "pdp_unavailable",
      action: "retry",
    });
    expect(mockProxySSEStream).not.toHaveBeenCalled();
  });

  it.each([
    ["start", startPost, "/api/v1/chat/stream/start", { message: "hi", agent_id: "agent-1" }],
    ["invoke", invokePost, "/api/v1/chat/invoke", { message: "hi", conversation_id: "conv-1" }],
    ["resume", resumePost, "/api/v1/chat/stream/resume", { conversation_id: "conv-1", agent_id: "agent-1" }],
    ["cancel", cancelPost, "/api/v1/chat/stream/cancel", { conversation_id: "conv-1" }],
  ])("returns 400 before any OpenFGA check when required %s fields are missing", async (_name, handler, path, body) => {
    const response = await handler(jsonRequest(path, body));

    expect(response.status).toBe(400);
    expect(mockRequireAgentUsePermission).not.toHaveBeenCalled();
    expect(mockRequireResourcePermission).not.toHaveBeenCalled();
    expect(mockRequireConversationResourcePermission).not.toHaveBeenCalled();
    expect(mockProxySSEStream).not.toHaveBeenCalled();
    expect(mockProxyJSONRequest).not.toHaveBeenCalled();
  });

  it("does not check conversation access when the agent use gate denies first", async () => {
    mockRequireAgentUsePermission.mockResolvedValue(
      NextResponse.json({ success: false, reason: "pdp_denied" }, { status: 403 }),
    );

    const response = await invokePost(
      jsonRequest("/api/v1/chat/invoke", {
        message: "hi",
        conversation_id: "conv-1",
        agent_id: "agent-1",
      }),
    );

    expect(response.status).toBe(403);
    expect(mockRequireResourcePermission).not.toHaveBeenCalled();
    expect(mockRequireConversationResourcePermission).not.toHaveBeenCalled();
    expect(mockProxyJSONRequest).not.toHaveBeenCalled();
  });

  it("mints an owner bearer and enforces agent#use as the owner for scheduler-token invoke runs", async () => {
    const findOne = jest.fn(async () => null);
    const updateOne = jest.fn(async () => ({ acknowledged: true }));
    const countDocuments = jest.fn(async () => 1);
    mockGetCollection.mockResolvedValue({ findOne, updateOne, countDocuments });

    const response = await invokePost(
      jsonRequest(
        "/api/v1/chat/invoke",
        {
          message: "run scheduled prep",
          conversation_id: "scheduled-sched_123-run_456",
          agent_id: "agent-1",
          project_id: "pod-caller-controlled",
          owner_user_id: "owner@example.com",
          trace_id: "scheduled-sched_123-run_456",
          client_context: {
            source: "scheduler",
            schedule_id: "sched_123",
            schedule_title: "Daily platform report",
          },
        },
        {
          "X-Scheduler-Token": "service-token",
          "X-Client-Source": "caipe-cron-runner",
        },
      ),
    );

    expect(response.status).toBe(200);
    // The interactive session auth path is NOT used for scheduled runs.
    expect(mockAuthenticateRequest).not.toHaveBeenCalled();
    // Owner is resolved from the schedule DB record (by schedule_id), and a
    // real owner bearer is minted via Keycloak token exchange.
    expect(mockResolveScheduledRunContext).toHaveBeenCalledWith("sched_123");
    expect(mockMintScheduledOwnerToken).toHaveBeenCalledWith("owner-sub");
    // agent#use IS enforced as the owner (no scheduled-run authz bypass).
    expect(mockRequireAgentUsePermission).toHaveBeenCalledWith(
      expect.objectContaining({
        subject: "owner-sub",
        agentId: "agent-persisted",
        email: "owner@example.com",
        isServiceAccount: false,
      }),
    );
    // The interactive conversation-write gate is skipped (the route owns the
    // idempotent scheduled-conversation creation).
    expect(mockRequireConversationResourcePermission).not.toHaveBeenCalled();
    expect(mockProxyJSONRequest).toHaveBeenCalledTimes(1);
    expect(mockProxyJSONRequest.mock.calls[0][0]).toBe("http://dynamic-agents:8000/api/v1/chat/invoke");
    // The owner bearer (not a shared token) is forwarded to Dynamic Agents.
    expect(mockProxyJSONRequest.mock.calls[0][2]).toEqual(
      expect.objectContaining({
        subject: "owner-sub",
        bearerToken: "owner-bearer-token",
        traceparent: expect.stringMatching(/^00-[a-f0-9]{32}-[a-f0-9]{16}-01$/),
      }),
    );

    const proxiedBody = JSON.parse(mockProxyJSONRequest.mock.calls[0][1] as string) as Record<string, unknown>;
    expect(proxiedBody.conversation_id).not.toBe("scheduled-sched_123-run_456");
    expect(proxiedBody.conversation_id).toEqual(expect.any(String));
    expect(proxiedBody.agent_id).toBe("agent-persisted");
    expect(proxiedBody.project_id).toBe("pod-safe");
    expect(proxiedBody.owner_user_id).toBe("owner@example.com");
    expect(proxiedBody.client_context).toEqual(
      expect.objectContaining({
        source: "scheduler",
        schedule_id: "sched_123",
        schedule_title: "Persisted schedule title",
        run_id: "scheduled-sched_123-run_456",
        actor_client_id: "caipe-scheduler-runner",
      }),
    );
    expect(updateOne).toHaveBeenCalled();
    expect(countDocuments).toHaveBeenCalled();
  });

  it("fails a scheduler-token invoke closed when the owner cannot be resolved", async () => {
    mockResolveScheduledRunContext.mockResolvedValue(null);

    const response = await invokePost(
      jsonRequest(
        "/api/v1/chat/invoke",
        {
          message: "run scheduled prep",
          conversation_id: "scheduled-sched_123-run_456",
          agent_id: "agent-1",
          client_context: { source: "scheduler", schedule_id: "sched_123" },
        },
        {
          "X-Scheduler-Token": "service-token",
          "X-Client-Source": "caipe-cron-runner",
        },
      ),
    );

    expect(response.status).toBe(403);
    expect(mockMintScheduledOwnerToken).not.toHaveBeenCalled();
    expect(mockRequireAgentUsePermission).not.toHaveBeenCalled();
    expect(mockProxyJSONRequest).not.toHaveBeenCalled();
  });

  it("fails a scheduler-token invoke closed on a scheduled conversation owner mismatch", async () => {
    mockGetCollection.mockResolvedValue({
      findOne: jest.fn().mockResolvedValue({
        _id: "existing-conversation",
        idempotency_key: "scheduler:scheduled-sched_123-run_456",
        owner_id: "different-owner@example.com",
        owner_subject: "different-owner-sub",
      }),
    });

    const response = await invokePost(
      jsonRequest(
        "/api/v1/chat/invoke",
        {
          message: "run scheduled report",
          conversation_id: "scheduled-sched_123-run_456",
          agent_id: "caller-controlled-agent",
          client_context: { source: "scheduler", schedule_id: "sched_123" },
        },
        { "X-Scheduler-Token": "service-token" },
      ),
    );

    expect(response.status).toBe(502);
    expect(mockRequireAgentUsePermission).toHaveBeenCalledWith(
      expect.objectContaining({ agentId: "agent-persisted" }),
    );
    expect(mockProxyJSONRequest).not.toHaveBeenCalled();
  });

  it("rejects a scheduler-token invoke with an invalid scheduler token", async () => {
    mockIsSchedulerTokenValid.mockReturnValue(false);

    const response = await invokePost(
      jsonRequest(
        "/api/v1/chat/invoke",
        {
          message: "run scheduled prep",
          conversation_id: "scheduled-sched_123-run_456",
          agent_id: "agent-1",
          client_context: { source: "scheduler", schedule_id: "sched_123" },
        },
        { "X-Scheduler-Token": "wrong-token" },
      ),
    );

    expect(response.status).toBe(401);
    expect(mockResolveScheduledRunContext).not.toHaveBeenCalled();
    expect(mockProxyJSONRequest).not.toHaveBeenCalled();
  });

  it("checks conversation and agent permission before proxying cancel", async () => {
    const response = await cancelPost(
      jsonRequest("/api/v1/chat/stream/cancel", {
        conversation_id: "conv-1",
        agent_id: "agent-1",
      }),
    );

    expect(response.status).toBe(200);
    expect(mockAuthenticateRequest).toHaveBeenCalledTimes(1);
    expect(mockRequireAgentUsePermission).toHaveBeenCalledWith(
      expect.objectContaining({ subject: "alice-sub", agentId: "agent-1" }),
    );
    expect(mockRequireConversationResourcePermission).toHaveBeenCalledWith(
      expect.objectContaining({ sub: "alice-sub", user: { email: "alice@example.com" } }),
      "alice@example.com",
      expect.objectContaining({ _id: "conv-1" }),
      "write",
    );
    expect(mockProxyJSONRequest).toHaveBeenCalledTimes(1);
  });

  it("returns conversation denial before proxying", async () => {
    mockRequireConversationResourcePermission.mockRejectedValue(
      Object.assign(new Error("denied"), { statusCode: 403, code: "conversation#write" }),
    );

    const response = await invokePost(
      jsonRequest("/api/v1/chat/invoke", {
        message: "hi",
        conversation_id: "conv-1",
        agent_id: "agent-1",
      }),
    );

    expect(response.status).toBe(403);
    expect(await jsonBody(response)).toMatchObject({
      success: false,
      error: "denied",
      code: "conversation#write",
    });
    expect(mockProxyJSONRequest).not.toHaveBeenCalled();
  });

  it("returns conversation denial before proxying cancel", async () => {
    mockRequireConversationResourcePermission.mockRejectedValue(
      Object.assign(new Error("cancel denied"), { statusCode: 403, code: "conversation#write" }),
    );

    const response = await cancelPost(
      jsonRequest("/api/v1/chat/stream/cancel", {
        conversation_id: "conv-1",
        agent_id: "agent-1",
      }),
    );

    expect(response.status).toBe(403);
    expect(await jsonBody(response)).toMatchObject({
      success: false,
      error: "cancel denied",
      code: "conversation#write",
    });
    expect(mockProxyJSONRequest).not.toHaveBeenCalled();
  });

  it("returns 404 before proxying when the conversation does not exist", async () => {
    mockGetCollection.mockResolvedValue({
      findOne: jest.fn(async () => null),
    });

    const response = await startPost(
      jsonRequest("/api/v1/chat/stream/start", {
        message: "hi",
        conversation_id: "missing-conv",
        agent_id: "agent-1",
      }),
    );

    expect(response.status).toBe(404);
    expect(await jsonBody(response)).toMatchObject({
      success: false,
      error: "Conversation not found",
      code: "conversation#write",
    });
    expect(mockRequireConversationResourcePermission).not.toHaveBeenCalled();
    expect(mockProxySSEStream).not.toHaveBeenCalled();
  });
});
