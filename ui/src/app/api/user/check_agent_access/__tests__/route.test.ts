/**
 * @jest-environment node
 *
 * Tests for `POST /api/user/check_agent_access` (Phase 2 of spec
 * 2026-05-24-derive-team-from-channel).
 *
 * The bots call this endpoint **for every DM / 1:1 message** to decide
 * whether the dispatched agent is allowed for the signed-in user.
 * Contract:
 *
 *   POST /api/user/check_agent_access
 *   Authorization: Bearer <OBO token>
 *   { "agent_id": "<id>" }
 *
 *   → 200 { data: { allowed: true | false, reason: <code>, path: <path> } }
 *   → 400 invalid body
 *   → 401 unauthenticated
 *   → 502 PDP unreachable (so callers fail-closed)
 *
 * The bot never re-derives team subjects; the route resolves user → teams
 * → agent via `evaluateAgentAccess` (PDP).
 */

import { createHmac } from "crypto";
import { NextRequest } from "next/server";

const mockGetAuth = jest.fn();
const mockGetCollection = jest.fn();
const mockEvaluateAgentAccess = jest.fn();

jest.mock("@/lib/api-middleware", () => {
  const actual = jest.requireActual("@/lib/api-middleware");
  return {
    ...actual,
    getAuthFromBearerOrSession: (...args: unknown[]) => mockGetAuth(...args),
  };
});

jest.mock("@/lib/rbac/pdp-shared", () => ({
  evaluateAgentAccess: (...args: unknown[]) => mockEvaluateAgentAccess(...args),
}));

jest.mock("@/lib/mongodb", () => ({
  getCollection: (...args: unknown[]) => mockGetCollection(...args),
}));

import { POST } from "../route";

function makeRequest(body: unknown, extraHeaders: Record<string, string> = {}): NextRequest {
  return new NextRequest("http://localhost:3000/api/user/check_agent_access", {
    method: "POST",
    headers: { "content-type": "application/json", ...extraHeaders },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

function signedBotHeaders(kind: "direct" | "group"): Record<string, string> {
  const timestamp = String(Math.floor(Date.now() / 1000));
  const payload = ["slack", kind, timestamp, "POST", "/api/user/check_agent_access"].join("\n");
  return {
    "x-client-source": "slack-bot",
    "x-caipe-interaction-source": "slack",
    "x-caipe-interaction-kind": kind,
    "x-caipe-interaction-timestamp": timestamp,
    "x-caipe-interaction-signature": createHmac("sha256", "test-slack-secret")
      .update(payload)
      .digest("hex"),
  };
}

async function bodyOf(response: Response): Promise<Record<string, unknown>> {
  return (await response.json()) as Record<string, unknown>;
}

describe("POST /api/user/check_agent_access", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.PRIVATE_RESOURCES_ENABLED = "true";
    process.env.SLACK_LINK_HMAC_SECRET = "test-slack-secret";
    mockGetAuth.mockResolvedValue({
      user: { email: "alice@example.com", name: "Alice", role: "user" },
      session: { sub: "alice-sub", org: "default" },
    });
    mockGetCollection.mockResolvedValue({
      findOne: jest.fn().mockResolvedValue({
        _id: "argocd-agent",
        enabled: true,
      }),
    });
  });

  it("allows when PDP grants direct access", async () => {
    mockEvaluateAgentAccess.mockResolvedValue({
      allowed: true,
      path: "direct_user_grant",
      reasonCode: "ALLOW_DIRECT",
    });

    const response = await POST(makeRequest({ agent_id: "argocd-agent" }));

    expect(response.status).toBe(200);
    const json = await bodyOf(response);
    expect(json).toMatchObject({ success: true });
    expect(json.data).toEqual({
      allowed: true,
      reason: "ALLOW_DIRECT",
      path: "direct_user_grant",
    });
    expect(mockEvaluateAgentAccess).toHaveBeenCalledWith({
      subject: "alice-sub",
      agentId: "argocd-agent",
    });
  });

  it("allows the owner to use a private agent from the authenticated web UI", async () => {
    mockGetCollection.mockResolvedValue({
      findOne: jest.fn().mockResolvedValue({
        _id: "private-agent",
        enabled: true,
        visibility: "private",
      }),
    });
    mockEvaluateAgentAccess.mockResolvedValue({
      allowed: true,
      path: "direct_user_grant",
      reasonCode: "ALLOW_DIRECT",
    });

    const response = await POST(makeRequest({ agent_id: "private-agent" }));

    expect(response.status).toBe(200);
    const json = await bodyOf(response);
    expect(json.data).toEqual({
      allowed: true,
      reason: "ALLOW_DIRECT",
      path: "direct_user_grant",
    });
  });

  it("allows a private agent in a verified Slack DM", async () => {
    mockGetCollection.mockResolvedValue({
      findOne: jest.fn().mockResolvedValue({
        _id: "private-agent",
        enabled: true,
        visibility: "private",
      }),
    });
    mockEvaluateAgentAccess.mockResolvedValue({
      allowed: true,
      path: "direct_user_grant",
      reasonCode: "ALLOW_DIRECT",
    });

    const response = await POST(makeRequest(
      { agent_id: "private-agent" },
      signedBotHeaders("direct"),
    ));

    expect(response.status).toBe(200);
    expect((await bodyOf(response)).data).toMatchObject({ allowed: true });
    expect(mockEvaluateAgentAccess).toHaveBeenCalledTimes(1);
  });

  it("denies a private agent in a verified Slack channel before OpenFGA", async () => {
    mockGetCollection.mockResolvedValue({
      findOne: jest.fn().mockResolvedValue({
        _id: "private-agent",
        enabled: true,
        visibility: "private",
      }),
    });

    const response = await POST(makeRequest(
      { agent_id: "private-agent" },
      signedBotHeaders("group"),
    ));

    expect(response.status).toBe(200);
    expect((await bodyOf(response)).data).toEqual({
      allowed: false,
      reason: "PRIVATE_RESOURCE_CONTEXT_DENIED",
      path: "private_dm_required",
    });
    expect(mockEvaluateAgentAccess).not.toHaveBeenCalled();
  });

  it("denies an unsigned Slack bot request instead of treating it as web", async () => {
    mockGetCollection.mockResolvedValue({
      findOne: jest.fn().mockResolvedValue({
        _id: "private-agent",
        enabled: true,
        visibility: "private",
      }),
    });

    const response = await POST(makeRequest(
      { agent_id: "private-agent" },
      { "x-client-source": "slack-bot" },
    ));

    expect((await bodyOf(response)).data).toMatchObject({
      allowed: false,
      reason: "PRIVATE_RESOURCE_CONTEXT_DENIED",
    });
    expect(mockEvaluateAgentAccess).not.toHaveBeenCalled();
  });

  it("leaves legacy behavior unchanged while the rollout flag is disabled", async () => {
    process.env.PRIVATE_RESOURCES_ENABLED = "false";
    mockGetCollection.mockResolvedValue({
      findOne: jest.fn().mockResolvedValue({
        _id: "private-agent",
        enabled: true,
        visibility: "private",
      }),
    });
    mockEvaluateAgentAccess.mockResolvedValue({
      allowed: true,
      path: "direct_user_grant",
      reasonCode: "ALLOW_DIRECT",
    });

    const response = await POST(makeRequest(
      { agent_id: "private-agent" },
      { "x-client-source": "slack-bot" },
    ));

    expect((await bodyOf(response)).data).toMatchObject({ allowed: true });
    expect(mockEvaluateAgentAccess).toHaveBeenCalledTimes(1);
  });

  it("allows via team union and surfaces the matched slug", async () => {
    mockEvaluateAgentAccess.mockResolvedValue({
      allowed: true,
      path: "team_union",
      matchedTeamSlug: "platform-eng",
      reasonCode: "ALLOW_TEAM_UNION",
    });

    const response = await POST(makeRequest({ agent_id: "argocd-agent" }));

    expect(response.status).toBe(200);
    const json = await bodyOf(response);
    expect(json.data).toEqual({
      allowed: true,
      reason: "ALLOW_TEAM_UNION",
      path: "team_union",
      matched_team_slug: "platform-eng",
    });
  });

  it("passes an explicit team scope to the shared PDP", async () => {
    mockEvaluateAgentAccess.mockResolvedValue({
      allowed: true,
      path: "team_union",
      matchedTeamSlug: "platform-eng",
      reasonCode: "ALLOW_TEAM_UNION",
    });

    const response = await POST(makeRequest({
      agent_id: "argocd-agent",
      team_slug: "platform-eng",
    }));

    expect(response.status).toBe(200);
    expect(mockEvaluateAgentAccess).toHaveBeenCalledWith({
      subject: "alice-sub",
      agentId: "argocd-agent",
      teamSlug: "platform-eng",
    });
  });

  it("denies with stable reason code when PDP denies", async () => {
    mockEvaluateAgentAccess.mockResolvedValue({
      allowed: false,
      path: "denied",
      reasonCode: "DENY_NO_CAPABILITY",
    });

    const response = await POST(makeRequest({ agent_id: "argocd-agent" }));

    expect(response.status).toBe(200);
    const json = await bodyOf(response);
    expect(json.data).toEqual({
      allowed: false,
      reason: "DENY_NO_CAPABILITY",
      path: "denied",
    });
  });

  it("denies a deleted agent before consulting OpenFGA", async () => {
    mockGetCollection.mockResolvedValue({
      findOne: jest.fn().mockResolvedValue(null),
    });

    const response = await POST(makeRequest({ agent_id: "deleted-agent" }));

    expect(response.status).toBe(200);
    const json = await bodyOf(response);
    expect(json.data).toEqual({
      allowed: false,
      reason: "DENY_AGENT_NOT_FOUND",
      path: "denied",
    });
    expect(mockEvaluateAgentAccess).not.toHaveBeenCalled();
  });

  it("returns 401 when the caller is not signed in", async () => {
    mockGetAuth.mockResolvedValue({
      user: { email: "x", name: "y", role: "user" },
      session: {},
    });

    const response = await POST(makeRequest({ agent_id: "agent-x" }));

    expect(response.status).toBe(401);
    const json = await bodyOf(response);
    expect(json.code).toBe("NOT_SIGNED_IN");
    expect(mockEvaluateAgentAccess).not.toHaveBeenCalled();
  });

  it("returns 400 when agent_id is missing", async () => {
    const response = await POST(makeRequest({}));

    expect(response.status).toBe(400);
    const json = await bodyOf(response);
    expect(json.code).toBe("INVALID_BODY");
    expect(mockEvaluateAgentAccess).not.toHaveBeenCalled();
  });

  it("returns 400 when agent_id is not an OpenFGA-safe string", async () => {
    const response = await POST(makeRequest({ agent_id: "bad/agent id" }));

    expect(response.status).toBe(400);
    const json = await bodyOf(response);
    expect(json.code).toBe("INVALID_BODY");
  });

  it("returns 400 when team_slug is not an OpenFGA-safe string", async () => {
    const response = await POST(makeRequest({
      agent_id: "argocd-agent",
      team_slug: "bad/team",
    }));

    expect(response.status).toBe(400);
    expect(mockEvaluateAgentAccess).not.toHaveBeenCalled();
  });

  it("returns 400 when body is not valid JSON", async () => {
    const response = await POST(makeRequest("not-json"));

    expect(response.status).toBe(400);
    const json = await bodyOf(response);
    expect(json.code).toBe("INVALID_BODY");
  });

  it("returns 502 when the PDP throws (fail-closed for the bot)", async () => {
    mockEvaluateAgentAccess.mockRejectedValue(new Error("openfga down"));

    const response = await POST(makeRequest({ agent_id: "argocd-agent" }));

    expect(response.status).toBe(502);
    const json = await bodyOf(response);
    expect(json.code).toBe("PDP_UNAVAILABLE");
  });
});
