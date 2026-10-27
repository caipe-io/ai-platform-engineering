import { applyPublicationRequestAdapter } from "@/lib/publication-approval-adapters.server";
import { publicationResourceRevision } from "@/lib/publication-approval.server";
import type { PublicationRequestDocument } from "@/types/publication-approval";

const mockGetCollection = jest.fn();
const mockGetRbacCollection = jest.fn();
const mockCallSlackBotAdmin = jest.fn();
const mockCallWebexBotAdmin = jest.fn();
const mockApplySlackChannelOnboarding = jest.fn();
const mockOnboardWebexSpace = jest.fn();

jest.mock("@/lib/mongodb", () => ({
  getCollection: (...args: unknown[]) => mockGetCollection(...args),
}));

jest.mock("@/lib/rbac/mongo-collections", () => ({
  getRbacCollection: (...args: unknown[]) => mockGetRbacCollection(...args),
}));

jest.mock("@/lib/slack-bot-admin", () => ({
  callSlackBotAdmin: (...args: unknown[]) => mockCallSlackBotAdmin(...args),
}));

jest.mock("@/lib/webex-bot-admin", () => ({
  callWebexBotAdmin: (...args: unknown[]) => mockCallWebexBotAdmin(...args),
}));

jest.mock("@/app/api/admin/slack/channels/defaults/route", () => ({
  applySlackChannelOnboarding: (...args: unknown[]) =>
    mockApplySlackChannelOnboarding(...args),
}));

jest.mock("@/lib/rbac/webex-space-onboarding", () => ({
  onboardWebexSpace: (...args: unknown[]) => mockOnboardWebexSpace(...args),
}));

jest.mock("@/lib/rag-publication-approval.server", () => ({
  applyRagPublicationRequest: jest.fn(),
}));

jest.mock("@/lib/rag-collection-publication-approval.server", () => ({
  applyRagCollectionPublicationRequest: jest.fn(),
}));

function baseRequest(
  kind: "slack_channel" | "webex_space",
  requestedState: Record<string, unknown>,
  memberCount: number | undefined = 24,
): PublicationRequestDocument {
  return {
    _id: "request-primary",
    adapter_version: 1,
    resource: {
      kind,
      id: "resource-primary",
      label: "Example surface",
    },
    authorization_policy_id:
      `publication.${kind}.0123456789abcdef01234567.request-primary`,
    resource_revision: publicationResourceRevision({
      status: "not_onboarded",
      requested_state: requestedState,
    }),
    requested_state: requestedState,
    effective_state: {},
    risk_facts: {
      organization_wide: false,
      target_team_slugs: ["target-team"],
      ...(memberCount === undefined ? {} : { member_count: memberCount }),
      reasons: ["channel or space members"],
    },
    requester: {
      subject: "requester-subject",
      email: "requester@example.com",
    },
    requester_team_slugs: ["target-team"],
    approver_team_slugs: ["approver-team"],
    status: "applying",
    history: [],
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
  };
}

function slackRequest(memberCount: number | undefined = 24) {
  return baseRequest(
    "slack_channel",
    {
      team_slug: "target-team",
      agent_id: "agent-primary",
      create_routes: true,
      channel_defaults: [
        {
          workspace_id: "workspace-primary",
          channel_id: "channel-primary",
          channel_name: "Original Name",
          member_count: memberCount,
          team_slug: "target-team",
          agent_id: "agent-primary",
        },
      ],
    },
    memberCount,
  );
}

function webexRequest() {
  return baseRequest("webex_space", {
    bot_id: "primary",
    workspace_id: "workspace-primary",
    space_id: "space-primary",
    space_name: "Original Name",
    team_slug: "target-team",
    agent_id: "agent-primary",
    create_route: true,
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  mockGetCollection.mockResolvedValue({
    findOne: jest.fn().mockResolvedValue(null),
  });
  mockGetRbacCollection.mockResolvedValue({
    findOne: jest.fn().mockResolvedValue(null),
  });
  mockApplySlackChannelOnboarding.mockResolvedValue({ ok: true });
  mockOnboardWebexSpace.mockResolvedValue({ ok: true });
});

describe("publication approval domain adapters", () => {
  it("re-verifies Slack provider state and applies the route-owned onboarding writer", async () => {
    mockCallSlackBotAdmin.mockResolvedValue({
      workspace_id: "workspace-primary",
      channel_id: "channel-primary",
      channel_name: "Current Provider Name",
      member_count: 20,
    });

    await applyPublicationRequestAdapter(slackRequest(), {});

    expect(mockApplySlackChannelOnboarding).toHaveBeenCalledWith(
      expect.objectContaining({
        channel_defaults: [
          expect.objectContaining({
            channel_name: "Current Provider Name",
            member_count: 20,
          }),
        ],
      }),
      "publication:request-primary",
    );
  });

  it("requires a fresh decision when an unknown Slack audience becomes measurable", async () => {
    mockCallSlackBotAdmin.mockResolvedValue({
      workspace_id: "workspace-primary",
      channel_id: "channel-primary",
      channel_name: "Current Provider Name",
      member_count: 200,
    });

    const request = slackRequest(24);
    const riskFactsWithoutCount = { ...request.risk_facts };
    delete (riskFactsWithoutCount as { member_count?: number }).member_count;
    request.risk_facts = riskFactsWithoutCount;

    const error = await applyPublicationRequestAdapter(request, {}).catch((caught) => caught);
    expect(error).toMatchObject({
      code: "PUBLICATION_DRIFT",
      drift: expect.arrayContaining([
        expect.objectContaining({ field: "member_count", before: null, after: 200 }),
      ]),
    });
    expect(mockApplySlackChannelOnboarding).not.toHaveBeenCalled();
  });

  it("requires a fresh decision when Slack membership grows after review", async () => {
    mockCallSlackBotAdmin.mockResolvedValue({
      workspace_id: "workspace-primary",
      channel_id: "channel-primary",
      channel_name: "Current Provider Name",
      member_count: 25,
    });

    const error = await applyPublicationRequestAdapter(slackRequest(24), {}).catch(
      (caught) => caught,
    );
    expect(error).toMatchObject({
      code: "PUBLICATION_DRIFT",
      drift: expect.arrayContaining([
        expect.objectContaining({ field: "member_count", before: 24, after: 25 }),
      ]),
    });
    expect(mockApplySlackChannelOnboarding).not.toHaveBeenCalled();
  });

  it("applies the Slack approval once the drift fingerprint is acknowledged", async () => {
    mockCallSlackBotAdmin.mockResolvedValue({
      workspace_id: "workspace-primary",
      channel_id: "channel-primary",
      channel_name: "Current Provider Name",
      member_count: 25,
    });

    const firstAttempt = await applyPublicationRequestAdapter(slackRequest(24), {}).catch(
      (caught) => caught,
    );
    const fingerprint = firstAttempt.fingerprint;
    expect(typeof fingerprint).toBe("string");

    await applyPublicationRequestAdapter(slackRequest(24), {}, { acknowledgedFingerprint: fingerprint });

    expect(mockApplySlackChannelOnboarding).toHaveBeenCalledWith(
      expect.objectContaining({
        channel_defaults: [expect.objectContaining({ member_count: 25 })],
      }),
      "publication:request-primary",
    );
  });

  it("re-drifts when the fingerprint was acknowledged but membership moved again", async () => {
    mockCallSlackBotAdmin.mockResolvedValue({
      workspace_id: "workspace-primary",
      channel_id: "channel-primary",
      channel_name: "Current Provider Name",
      member_count: 25,
    });
    const stale = await applyPublicationRequestAdapter(slackRequest(24), {}).catch(
      (caught) => caught,
    );

    mockCallSlackBotAdmin.mockResolvedValue({
      workspace_id: "workspace-primary",
      channel_id: "channel-primary",
      channel_name: "Current Provider Name",
      member_count: 26,
    });
    const error = await applyPublicationRequestAdapter(
      slackRequest(24),
      {},
      { acknowledgedFingerprint: stale.fingerprint },
    ).catch((caught) => caught);

    expect(error).toMatchObject({ code: "PUBLICATION_DRIFT" });
    expect(error.fingerprint).not.toBe(stale.fingerprint);
    expect(mockApplySlackChannelOnboarding).not.toHaveBeenCalled();
  });

  it("keeps a channel already onboarded by another actor as a hard conflict", async () => {
    mockCallSlackBotAdmin.mockResolvedValue({
      workspace_id: "workspace-primary",
      channel_id: "channel-primary",
      channel_name: "Original Name",
      member_count: 24,
    });
    mockGetCollection.mockResolvedValue({
      findOne: jest.fn().mockResolvedValue({
        updated_by: "publication:someone-else",
        team_slug: "target-team",
      }),
    });

    await expect(
      applyPublicationRequestAdapter(slackRequest(24), {}),
    ).rejects.toMatchObject({ code: "PUBLICATION_REVISION_CONFLICT" });
    expect(mockApplySlackChannelOnboarding).not.toHaveBeenCalled();
  });

  it("re-verifies Webex provider state and applies the shared onboarding writer", async () => {
    mockCallWebexBotAdmin.mockResolvedValue({
      bot_id: "primary",
      space_id: "space-primary",
      space_name: "Current Provider Space",
      member_count: 20,
    });

    await applyPublicationRequestAdapter(webexRequest(), {});

    expect(mockOnboardWebexSpace).toHaveBeenCalledWith(
      expect.objectContaining({
        space_name: "Current Provider Space",
        actor: "publication:request-primary",
      }),
    );
  });

  it("requires a fresh decision when Webex membership grows after review, then applies once acknowledged", async () => {
    mockCallWebexBotAdmin.mockResolvedValue({
      bot_id: "primary",
      space_id: "space-primary",
      space_name: "Original Name",
      member_count: 30,
    });

    const drifted = await applyPublicationRequestAdapter(webexRequest(), {}).catch(
      (caught) => caught,
    );
    expect(drifted).toMatchObject({
      code: "PUBLICATION_DRIFT",
      drift: [expect.objectContaining({ field: "member_count", before: 24, after: 30 })],
    });
    expect(mockOnboardWebexSpace).not.toHaveBeenCalled();

    await applyPublicationRequestAdapter(
      webexRequest(),
      {},
      { acknowledgedFingerprint: drifted.fingerprint },
    );
    expect(mockOnboardWebexSpace).toHaveBeenCalledWith(
      expect.objectContaining({ space_name: "Original Name" }),
    );
  });

  it("re-drifts a Webex space when the fingerprint was acknowledged but membership moved again", async () => {
    mockCallWebexBotAdmin.mockResolvedValue({
      bot_id: "primary",
      space_id: "space-primary",
      space_name: "Original Name",
      member_count: 30,
    });
    const stale = await applyPublicationRequestAdapter(webexRequest(), {}).catch(
      (caught) => caught,
    );

    mockCallWebexBotAdmin.mockResolvedValue({
      bot_id: "primary",
      space_id: "space-primary",
      space_name: "Original Name",
      member_count: 31,
    });
    const error = await applyPublicationRequestAdapter(
      webexRequest(),
      {},
      { acknowledgedFingerprint: stale.fingerprint },
    ).catch((caught) => caught);

    expect(error).toMatchObject({ code: "PUBLICATION_DRIFT" });
    expect(error.fingerprint).not.toBe(stale.fingerprint);
    expect(mockOnboardWebexSpace).not.toHaveBeenCalled();
  });

  it("keeps a Webex space already onboarded by another actor as a hard conflict", async () => {
    mockCallWebexBotAdmin.mockResolvedValue({
      bot_id: "primary",
      space_id: "space-primary",
      space_name: "Original Name",
      member_count: 24,
    });
    mockGetRbacCollection.mockResolvedValue({
      findOne: jest.fn().mockResolvedValue({
        updated_by: "publication:someone-else",
        team_slug: "target-team",
      }),
    });

    await expect(
      applyPublicationRequestAdapter(webexRequest(), {}),
    ).rejects.toMatchObject({ code: "PUBLICATION_REVISION_CONFLICT" });
    expect(mockOnboardWebexSpace).not.toHaveBeenCalled();
  });
});
