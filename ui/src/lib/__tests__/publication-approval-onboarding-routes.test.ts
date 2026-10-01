/** @jest-environment node */

import { NextRequest } from "next/server";

import type { PublicationRequestDocument } from "@/types/publication-approval";

const mockGetAuthFromBearerOrSession = jest.fn();
const mockRequireAdminSurfaceManage = jest.fn();
const mockRequireResourcePermission = jest.fn();
const mockCallSlackBotAdmin = jest.fn();
const mockCallWebexBotAdmin = jest.fn();
const mockPlanConnectorPublication = jest.fn();
const mockCreatePublicationRequest = jest.fn();
const mockReplacePendingConnectorPublicationRequest = jest.fn();
const mockOnboardWebexSpace = jest.fn();
const mockConfiguredSlackChannelsById = jest.fn();

jest.mock("@/lib/api-middleware", () => {
  const actual = jest.requireActual("@/lib/api-middleware");
  return {
    ...actual,
    getAuthFromBearerOrSession: (...args: unknown[]) =>
      mockGetAuthFromBearerOrSession(...args),
    successResponse: (data: unknown, status = 200) =>
      Response.json({ success: true, data }, { status }),
    withErrorHandler:
      <T>(handler: (request: NextRequest, context: T) => Promise<Response>) =>
      async (request: NextRequest, context: T) => {
        try {
          return await handler(request, context);
        } catch (error) {
          if (error instanceof actual.ApiError) {
            return Response.json(
              { success: false, error: error.message, code: error.code },
              { status: error.statusCode },
            );
          }
          throw error;
        }
      },
  };
});

jest.mock("@/lib/mongodb", () => ({ getCollection: jest.fn() }));

jest.mock("@/lib/publication-approval.server", () => ({
  createPublicationRequest: (...args: unknown[]) =>
    mockCreatePublicationRequest(...args),
  replacePendingConnectorPublicationRequest: (...args: unknown[]) =>
    mockReplacePendingConnectorPublicationRequest(...args),
  listPublicationActorTeamSlugs: jest
    .fn()
    .mockResolvedValue(["requester-team"]),
  planConnectorPublication: (...args: unknown[]) =>
    mockPlanConnectorPublication(...args),
  publicationActorFromSession: () => ({
    subject: "requester-subject",
    email: "requester@example.com",
    name: "Requesting User",
  }),
  publicationResourceRevision: () => "revision-primary",
  recordAutoApprovedPublication: jest.fn(),
}));

jest.mock("@/lib/publication-approval-settings", () => ({
  getPublicationApprovalSettings: jest.fn().mockResolvedValue({
    require_slack_onboarding_approval: true,
    require_webex_onboarding_approval: true,
  }),
}));

jest.mock("@/lib/rbac/require-openfga", () => ({
  requireAdminSurfaceManage: (...args: unknown[]) =>
    mockRequireAdminSurfaceManage(...args),
}));

jest.mock("@/lib/rbac/resource-authz", () => ({
  requireResourcePermission: (...args: unknown[]) =>
    mockRequireResourcePermission(...args),
}));

jest.mock("@/lib/rbac/slack-channel-configured-directory", () => ({
  configuredSlackChannelsById: (...args: unknown[]) =>
    mockConfiguredSlackChannelsById(...args),
}));

jest.mock("@/lib/rbac/keycloak-admin", () => ({
  ensureSlackBotOboPermissions: jest.fn(),
}));

jest.mock("@/lib/slack-bot-admin", () => ({
  callSlackBotAdmin: (...args: unknown[]) => mockCallSlackBotAdmin(...args),
}));

jest.mock("@/lib/webex-bot-admin", () => ({
  callWebexBotAdmin: (...args: unknown[]) => mockCallWebexBotAdmin(...args),
}));

jest.mock("@/lib/rbac/webex-space-onboarding", () => {
  const actual = jest.requireActual("@/lib/rbac/webex-space-onboarding");
  return {
    ...actual,
    onboardWebexSpace: (...args: unknown[]) => mockOnboardWebexSpace(...args),
  };
});

import { POST as onboardSlack } from "@/app/api/admin/slack/channels/defaults/route";
import { POST as onboardWebex } from "@/app/api/admin/webex/spaces/onboard/route";

function nextRequest(path: string, body: Record<string, unknown>): NextRequest {
  return new NextRequest(`http://localhost${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  mockGetAuthFromBearerOrSession.mockResolvedValue({
    user: { email: "requester@example.com" },
    session: {
      sub: "requester-subject",
      user: { email: "requester@example.com", name: "Requesting User" },
    },
  });
  mockRequireAdminSurfaceManage.mockRejectedValue(new Error("not admin"));
  mockRequireResourcePermission.mockResolvedValue(undefined);
  mockConfiguredSlackChannelsById.mockResolvedValue(new Map());
  mockPlanConnectorPublication.mockReturnValue({
    requires_approval: true,
    reason: "Approval required: connector onboarding policy.",
    effective_state: {},
    risk_facts: {
      organization_wide: false,
      target_team_slugs: ["target-team"],
      member_count: 24,
      reasons: ["24 channel or space members"],
    },
    approver_team_slugs: ["approver-team"],
    requester_team_slugs: ["requester-team"],
  });
  mockCreatePublicationRequest.mockImplementation(
    async (input: {
      resource: PublicationRequestDocument["resource"];
      requestedState: Record<string, unknown>;
      effectiveState: Record<string, unknown>;
      riskFacts: PublicationRequestDocument["risk_facts"];
      requester: PublicationRequestDocument["requester"];
      requesterTeamSlugs: string[];
      approverTeamSlugs: string[];
    }): Promise<PublicationRequestDocument> => ({
      _id: "request-primary",
      adapter_version: 1,
      resource: input.resource,
      authorization_policy_id:
        `publication.${input.resource.kind}.0123456789abcdef01234567.request-primary`,
      resource_revision: "revision-primary",
      requested_state: input.requestedState,
      effective_state: input.effectiveState,
      risk_facts: input.riskFacts,
      requester: input.requester,
      requester_team_slugs: input.requesterTeamSlugs,
      approver_team_slugs: input.approverTeamSlugs,
      status: "pending",
      history: [],
      created_at: "2026-01-01T00:00:00.000Z",
      updated_at: "2026-01-01T00:00:00.000Z",
    }),
  );
  mockReplacePendingConnectorPublicationRequest.mockResolvedValue(0);
});

describe("self-service connector publication", () => {
  it("verifies Slack metadata, checks team and agent access, and queues onboarding", async () => {
    mockCallSlackBotAdmin.mockResolvedValue({
      workspace_id: "workspace-provider",
      channel_id: "channel-primary",
      channel_name: "provider-name",
      member_count: 24,
    });

    const response = await onboardSlack(
      nextRequest("/api/admin/slack/channels/defaults", {
        team_slug: "target-team",
        agent_id: "agent-primary",
        create_routes: true,
        channel_defaults: [
          {
            workspace_id: "workspace-browser",
            channel_id: "channel-primary",
            channel_name: "browser-name",
            member_count: 1,
            team_slug: "target-team",
            agent_id: "agent-primary",
          },
        ],
      }),
    );
    const body = await response.json();

    expect(response.status).toBe(202);
    expect(body.data.summary).toEqual({ pending: 1, onboarded: 0 });
    expect(mockConfiguredSlackChannelsById).toHaveBeenCalledTimes(1);
    expect(mockConfiguredSlackChannelsById).toHaveBeenCalledWith([
      "channel-primary",
    ]);
    expect(mockRequireResourcePermission).toHaveBeenCalledWith(
      expect.anything(),
      { type: "team", id: "target-team", action: "use" },
    );
    expect(mockRequireResourcePermission).toHaveBeenCalledWith(
      expect.anything(),
      { type: "agent", id: "agent-primary", action: "use" },
    );
    expect(mockCreatePublicationRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        requestedState: expect.objectContaining({
          channel_defaults: [
            expect.objectContaining({
              workspace_id: "workspace-provider",
              channel_name: "provider-name",
              member_count: 24,
            }),
          ],
        }),
      }),
    );
  });

  it("rejects a Slack channel that another team already configured", async () => {
    mockCallSlackBotAdmin.mockResolvedValue({
      workspace_id: "workspace-provider",
      channel_id: "channel-primary",
      channel_name: "provider-name",
      member_count: 24,
    });
    mockConfiguredSlackChannelsById.mockResolvedValue(
      new Map([
        [
          "channel-primary",
          {
            channelId: "channel-primary",
            teamSlug: "existing-team",
            teamName: "Existing Team",
          },
        ],
      ]),
    );

    const response = await onboardSlack(
      nextRequest("/api/admin/slack/channels/defaults", {
        team_slug: "target-team",
        agent_id: "agent-primary",
        create_routes: true,
        channel_defaults: [
          {
            channel_id: "channel-primary",
            team_slug: "target-team",
            agent_id: "agent-primary",
          },
        ],
      }),
    );
    const body = await response.json();

    expect(response.status).toBe(409);
    expect(body).toMatchObject({
      success: false,
      code: "CHANNEL_ALREADY_CONFIGURED",
      error: "#provider-name is already configured by Existing Team",
    });
    expect(mockCreatePublicationRequest).not.toHaveBeenCalled();
    expect(mockRequireResourcePermission).not.toHaveBeenCalled();
  });

  it("verifies Webex metadata, checks team and agent access, and queues onboarding", async () => {
    mockCallWebexBotAdmin.mockResolvedValue({
      bot_id: "primary",
      space_id: "space-primary",
      space_name: "Provider Space",
      member_count: 24,
    });

    const response = await onboardWebex(
      nextRequest("/api/admin/webex/spaces/onboard", {
        workspace_id: "workspace-primary",
        bot_id: "primary",
        space_id: "space-primary",
        space_name: "Browser Space",
        team_slug: "target-team",
        agent_id: "agent-primary",
        create_route: true,
      }),
    );
    const body = await response.json();

    expect(response.status).toBe(202);
    expect(body.data.pending_approval).toBe(true);
    expect(mockRequireResourcePermission).toHaveBeenCalledWith(
      expect.anything(),
      { type: "team", id: "target-team", action: "use" },
    );
    expect(mockRequireResourcePermission).toHaveBeenCalledWith(
      expect.anything(),
      { type: "agent", id: "agent-primary", action: "use" },
    );
    expect(mockCreatePublicationRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        requestedState: expect.objectContaining({
          space_name: "Provider Space",
        }),
      }),
    );
    expect(mockOnboardWebexSpace).not.toHaveBeenCalled();
  });
});
