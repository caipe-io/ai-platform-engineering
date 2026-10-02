/**
 * @jest-environment node
 */

import { NextRequest } from "next/server";
import { ApiError } from "@/lib/api-error";

const mockGetAuth = jest.fn();
const mockRequireAdminSurfaceManage = jest.fn();
const mockRequireBaselineAdminSurfaceRead = jest.fn();
const mockHasOrganizationAdmin = jest.fn();
const mockGetDirectSharingAccessConversationIds = jest.fn();
const mockGetReadableMessagingConversationScope = jest.fn();
const mockGetReadableConversationIds = jest.fn();
const mockGetOwnedAgents = jest.fn();
const mockGetOwnedAgentConversationIds = jest.fn();
const mockGetInsightsActorTeamSlugs = jest.fn();
const mockLoadTeamMembersForSlugs = jest.fn();
const mockFindUser = jest.fn();
const mockFindConversations = jest.fn();
const mockCountConversations = jest.fn();
const mockAggregateFeedback = jest.fn();
const mockFindFeedback = jest.fn();
const mockAggregateMessages = jest.fn();
const mockGetRealmUserById = jest.fn();
let messageRows: Record<string, unknown>[] = [];

let mongoConfigured = true;

jest.mock("@/lib/api-middleware", () => {
  const actual = jest.requireActual("@/lib/api-middleware");
  return {
    ...actual,
    getAuthFromBearerOrSession: (...args: unknown[]) => mockGetAuth(...args),
  };
});

jest.mock("@/lib/rbac/conversation-implicit-authz", () => ({
  getDirectSharingAccessConversationIds: (...args: unknown[]) =>
    mockGetDirectSharingAccessConversationIds(...args),
}));

jest.mock("@/lib/rbac/platform-admin", () => ({
  hasOrganizationAdmin: (...args: unknown[]) =>
    mockHasOrganizationAdmin(...args),
}));

jest.mock("@/lib/rbac/require-openfga", () => ({
  requireAdminSurfaceManage: (...args: unknown[]) =>
    mockRequireAdminSurfaceManage(...args),
  requireBaselineAdminSurfaceRead: (...args: unknown[]) =>
    mockRequireBaselineAdminSurfaceRead(...args),
}));

jest.mock("@/lib/rbac/user-insights-scope", () => ({
  getReadableMessagingConversationScope: (...args: unknown[]) =>
    mockGetReadableMessagingConversationScope(...args),
  getReadableConversationIds: (...args: unknown[]) =>
    mockGetReadableConversationIds(...args),
  getOwnedAgents: (...args: unknown[]) => mockGetOwnedAgents(...args),
  getOwnedAgentConversationIds: (...args: unknown[]) =>
    mockGetOwnedAgentConversationIds(...args),
  getInsightsActorTeamSlugs: (...args: unknown[]) =>
    mockGetInsightsActorTeamSlugs(...args),
}));

jest.mock("@/lib/rbac/team-membership-store", () => ({
  loadTeamMembersForSlugs: (...args: unknown[]) =>
    mockLoadTeamMembersForSlugs(...args),
}));

jest.mock("@/lib/rbac/keycloak-admin", () => ({
  getRealmUserById: (...args: unknown[]) => mockGetRealmUserById(...args),
}));

jest.mock("@/lib/mongodb", () => ({
  get isMongoDBConfigured() {
    return mongoConfigured;
  },
  getCollection: async (name: string) => {
    if (name === "users") {
      return { findOne: (...args: unknown[]) => mockFindUser(...args) };
    }
    if (name === "conversations") {
      return {
        find: (...args: unknown[]) => {
          mockFindConversations(...args);
          return {
            sort: () => ({
              limit: () => ({ toArray: () => mockFindConversations() }),
            }),
          };
        },
        countDocuments: (...args: unknown[]) => mockCountConversations(...args),
      };
    }
    if (name === "feedback") {
      return {
        aggregate: (...args: unknown[]) => {
          mockAggregateFeedback(...args);
          return { toArray: () => mockAggregateFeedback() };
        },
        find: (...args: unknown[]) => {
          mockFindFeedback(...args);
          return {
            sort: () => ({
              limit: () => ({ toArray: () => mockFindFeedback() }),
            }),
          };
        },
      };
    }
    if (name === "messages") {
      return {
        aggregate: (...args: unknown[]) => {
          mockAggregateMessages(...args);
          return { toArray: async () => messageRows };
        },
      };
    }
    throw new Error(`Unexpected collection: ${name}`);
  },
}));

function request(identity: string, query = "") {
  return {
    request: new NextRequest(
      new URL(
        `/api/admin/users/activity/${encodeURIComponent(identity)}${query}`,
        "http://localhost:3000",
      ),
    ),
    context: { params: Promise.resolve({ identity }) },
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  mongoConfigured = true;
  messageRows = [];
  mockGetAuth.mockResolvedValue({
    session: {
      sub: "admin-sub",
      user: { email: "admin@example.com" },
    },
  });
  mockRequireAdminSurfaceManage.mockResolvedValue(undefined);
  mockRequireBaselineAdminSurfaceRead.mockResolvedValue(undefined);
  mockHasOrganizationAdmin.mockResolvedValue(true);
  mockGetDirectSharingAccessConversationIds.mockResolvedValue([]);
  mockGetReadableMessagingConversationScope.mockResolvedValue({
    slackChannelIds: [],
    webexSpaceIds: [],
  });
  mockGetReadableConversationIds.mockResolvedValue([]);
  mockGetOwnedAgents.mockResolvedValue([]);
  mockGetOwnedAgentConversationIds.mockResolvedValue({ ids: [], capped: false });
  mockGetInsightsActorTeamSlugs.mockResolvedValue([]);
  mockLoadTeamMembersForSlugs.mockResolvedValue(new Map());
  mockFindUser.mockResolvedValue({
    email: "test-user@example.com",
    name: "Test User",
    keycloak_sub: "target-sub",
    slack_user_id: "U123TEST",
    source: "web",
    avatar_url: null,
    created_at: new Date("2026-01-01T00:00:00.000Z"),
    last_login: new Date("2026-07-20T00:00:00.000Z"),
    metadata: { role: "user" },
  });
  mockFindConversations
    .mockReset()
    .mockResolvedValueOnce(undefined)
    .mockResolvedValueOnce([
      {
        _id: "conversation-1",
        title: "Example conversation",
        client_type: "slack",
        idempotency_key: "1775100000.123456",
        metadata: {
          channel_id: "C123TEST",
          channel_name: "example-channel",
          thread_ts: "1775100000.123456",
          workspace_url: "https://example.slack.com",
        },
        created_at: new Date("2026-07-20T10:00:00.000Z"),
        updated_at: new Date("2026-07-20T11:00:00.000Z"),
      },
    ]);
  mockCountConversations.mockReset().mockResolvedValue(3);
  mockAggregateFeedback
    .mockReset()
    .mockResolvedValueOnce(undefined)
    .mockResolvedValueOnce([{ total: 2, positive: 1, negative: 1 }]);
  mockFindFeedback
    .mockReset()
    .mockResolvedValueOnce(undefined)
    .mockResolvedValueOnce([
      {
        source: "web",
        rating: "positive",
        value: "thumbs_up",
        conversation_id: "conversation-1",
        created_at: new Date("2026-07-20T11:05:00.000Z"),
      },
    ]);
});

describe("GET /api/admin/users/activity/[identity]", () => {
  it("rejects callers who cannot read the Insights surface", async () => {
    mockRequireAdminSurfaceManage.mockRejectedValue(new Error("not manager"));
    mockHasOrganizationAdmin.mockResolvedValue(false);
    mockRequireBaselineAdminSurfaceRead.mockRejectedValue(
      new ApiError(
        "You do not have permission to view this read-only dashboard surface.",
        403,
      ),
    );
    const { GET } = await import("../route");
    const { request: req,context } = request("test-user@example.com");

    const response = await GET(req, context);

    expect(response.status).toBe(403);
    expect(mockRequireBaselineAdminSurfaceRead).toHaveBeenCalledWith(
      {
        sub: "admin-sub",
        user: { email: "admin@example.com" },
      },
      "stats",
    );
    expect(mockFindUser).not.toHaveBeenCalled();
  });

  it("loads activity by analytics identity without treating the email as a Keycloak id", async () => {
    const { GET } = await import("../route");
    const { request: req,context } = request("test-user@example.com");

    const response = await GET(req, context);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(mockRequireAdminSurfaceManage).toHaveBeenCalledWith(
      {
        sub: "admin-sub",
        user: { email: "admin@example.com" },
      },
      "stats",
    );
    expect(mockGetRealmUserById).not.toHaveBeenCalled();
    expect(mockCountConversations).toHaveBeenCalledWith({
      owner_id: {
        $in: expect.arrayContaining(["test-user@example.com", "U123TEST"]),
      },
    });
    expect(body.data).toMatchObject({
      profile: {
        email: "test-user@example.com",
        name: "Test User",
        slack_user_id: "U123TEST",
      },
      stats: {
        total_conversations: 3,
        visible_conversations: 3,
        feedback_given: 2,
        feedback_positive: 1,
        feedback_negative: 1,
      },
      recent_conversations: [
        {
          id: "conversation-1",
          source: "slack",
          channel_id: "C123TEST",
          channel_name: "example-channel",
          slack_permalink:
            "https://example.slack.com/archives/C123TEST/p1775100000123456",
        },
      ],
      can_view_conversations: true,
    });
  });

  it("opens an admin drawer for an identity represented only by message analytics", async () => {
    mockFindUser.mockResolvedValue(null);
    mockFindConversations
      .mockReset()
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce([]);
    mockCountConversations.mockResolvedValue(0);
    mockAggregateFeedback
      .mockReset()
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce([]);
    mockFindFeedback
      .mockReset()
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce([]);
    messageRows = [{ _id: "message-1" }];

    const { GET } = await import("../route");
    const { request: req,context } = request("message-user@example.com");
    const response = await GET(req, context);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(mockAggregateMessages).toHaveBeenCalled();
    expect(body.data.profile).toMatchObject({
      email: "message-user@example.com",
      name: "message-user@example.com",
    });
  });

  it("shows a scoped teammate only readable Slack-channel conversations", async () => {
    mockGetAuth.mockResolvedValue({
      session: {
        sub: "member-sub",
        user: { email: "member@example.com" },
      },
    });
    mockRequireAdminSurfaceManage.mockRejectedValue(new Error("not manager"));
    mockHasOrganizationAdmin.mockResolvedValue(false);
    mockGetReadableMessagingConversationScope.mockResolvedValue({
      slackChannelIds: ["C123TEST"],
      webexSpaceIds: [],
    });
    mockGetOwnedAgents.mockResolvedValue([
      { id: "agent-owned", name: "Owned Agent" },
    ]);
    mockGetOwnedAgentConversationIds.mockResolvedValue({
      ids: ["conversation-1"],
      capped: false,
    });
    mockCountConversations
      .mockReset()
      .mockResolvedValueOnce(3)
      .mockResolvedValueOnce(1);
    mockGetInsightsActorTeamSlugs.mockResolvedValue(["primary"]);
    mockLoadTeamMembersForSlugs.mockResolvedValue(new Map([
      ["primary", [{
        identity_key: "target-sub",
        user_subject: "target-sub",
        user_email: "test-user@example.com",
        role: "member",
        source_types: ["manual"],
        provider_ids: [],
      }]],
    ]));
    mockFindFeedback
      .mockReset()
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce([
        {
          source: "slack",
          rating: "positive",
          value: "thumbs_up",
          channel_id: "C123TEST",
          channel_name: "example-channel",
          conversation_id: "conversation-1",
          slack_permalink:
            "https://example.slack.com/archives/C123TEST/p1775100000123456",
          created_at: new Date("2026-07-20T11:05:00.000Z"),
        },
        {
          source: "web",
          rating: "positive",
          value: "thumbs_up",
          conversation_id: "conversation-private",
          created_at: new Date("2026-07-20T11:06:00.000Z"),
        },
        {
          source: "slack",
          rating: "positive",
          value: "thumbs_up",
          channel_id: "COTHER",
          channel_name: "example-channel",
          conversation_id: "conversation-other-channel",
          slack_permalink:
            "https://example.slack.com/archives/COTHER/p1775100000123456",
          created_at: new Date("2026-07-20T11:07:00.000Z"),
        },
      ]);

    const { GET } = await import("../route");
    const { request: req,context } = request("test-user@example.com");
    const response = await GET(req, context);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(mockRequireBaselineAdminSurfaceRead).toHaveBeenCalledWith(
      {
        sub: "member-sub",
        user: { email: "member@example.com" },
      },
      "stats",
    );
    expect(body.data.can_view_conversations).toBe(true);
    expect(body.data.stats.visible_conversations).toBe(1);
    expect(body.data.recent_conversations).toEqual([
      expect.objectContaining({
        id: "conversation-1",
        source: "slack",
        channel_name: "example-channel",
      }),
    ]);
    expect(body.data.recent_feedback).toEqual([
      expect.objectContaining({
        conversation_id: null,
        slack_permalink:
          "https://example.slack.com/archives/C123TEST/p1775100000123456",
      }),
      expect.objectContaining({
        source: "web",
        conversation_id: null,
        slack_permalink: null,
      }),
      expect.objectContaining({
        source: "slack",
        conversation_id: null,
        slack_permalink: null,
      }),
    ]);
    expect(mockAggregateFeedback.mock.calls[0]?.[0]).toEqual(
      expect.arrayContaining([
        {
          $match: expect.objectContaining({
            $and: expect.arrayContaining([
              expect.objectContaining({
                $or: expect.arrayContaining([
                  {
                    source: "slack",
                    channel_id: "C123TEST",
                  },
                ]),
              }),
            ]),
          }),
        },
      ]),
    );
    // Slack titles are fetched only through a channel-id clause. The explicit
    // source and DM exclusions prevent owned agents and same-named channels
    // from widening the conversation list.
    expect(mockFindConversations.mock.calls[0]?.[0]).toEqual({
      $and: [
        {
          owner_id: {
            $in: expect.arrayContaining([
              "test-user@example.com",
              "U123TEST",
            ]),
          },
        },
        {
          $or: expect.arrayContaining([
            {
              $and: [
                { $or: [{ source: "slack" }, { client_type: "slack" }] },
                { channel_type: { $ne: "dm" } },
                { "metadata.channel_type": { $ne: "dm" } },
                {
                  $or: [
                    { channel_id: "C123TEST" },
                    { "metadata.channel_id": "C123TEST" },
                    { "slack_meta.channel_id": "C123TEST" },
                  ],
                },
              ],
            },
            {
              $and: [
                { client_type: { $nin: ["slack", "webex"] } },
                { source: { $nin: ["slack", "webex"] } },
                {
                  $or: expect.arrayContaining([
                    { owner_id: "member@example.com" },
                    { "sharing.shared_with": "member@example.com" },
                  ]),
                },
              ],
            },
          ]),
        },
      ],
    });
    expect(mockCountConversations).toHaveBeenCalledWith({
      $and: [
        {
          owner_id: {
            $in: expect.arrayContaining([
              "test-user@example.com",
              "U123TEST",
            ]),
          },
        },
        {
          $or: expect.arrayContaining([
            expect.objectContaining({
              $and: expect.any(Array),
            }),
            { owner_id: "member@example.com" },
          ]),
        },
      ],
    });
  });

  it("does not let full Insights management bypass channel-level conversation RBAC", async () => {
    mockHasOrganizationAdmin.mockResolvedValue(false);
    mockGetReadableMessagingConversationScope.mockResolvedValue({
      slackChannelIds: ["C123TEST"],
      webexSpaceIds: [],
    });
    mockCountConversations
      .mockReset()
      .mockResolvedValueOnce(8)
      .mockResolvedValueOnce(1);

    const { GET } = await import("../route");
    const { request: req,context } = request("test-user@example.com");
    const response = await GET(req, context);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.data.stats).toMatchObject({
      total_conversations: 8,
      visible_conversations: 1,
    });
    expect(mockFindConversations.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({
        $and: expect.arrayContaining([
          expect.objectContaining({
            $or: expect.arrayContaining([
              expect.objectContaining({
                $and: expect.arrayContaining([
                  { "metadata.channel_type": { $ne: "dm" } },
                ]),
              }),
            ]),
          }),
        ]),
      }),
    );
    // Full Insights aggregate access does not grant access to personal web
    // conversation ids when organization audit access is absent.
    expect(body.data.recent_feedback[0]).toMatchObject({
      source: "web",
      conversation_id: null,
      slack_permalink: null,
    });
  });

  it("shows conversations from mapped Webex spaces but not unmapped direct spaces", async () => {
    mockGetAuth.mockResolvedValue({
      session: {
        sub: "member-sub",
        user: { email: "member@example.com" },
      },
    });
    mockRequireAdminSurfaceManage.mockRejectedValue(new Error("not manager"));
    mockHasOrganizationAdmin.mockResolvedValue(false);
    mockGetReadableMessagingConversationScope.mockResolvedValue({
      slackChannelIds: [],
      webexSpaceIds: ["space-shared"],
    });
    mockCountConversations
      .mockReset()
      .mockResolvedValueOnce(1)
      .mockResolvedValueOnce(1);
    mockFindConversations
      .mockReset()
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce([
        {
          _id: "conversation-webex",
          title: "Example Webex thread",
          client_type: "webex",
          metadata: {
            webex_space_id: "space-shared",
            webex_message_id: "message-1",
          },
          created_at: new Date("2026-07-20T10:00:00.000Z"),
          updated_at: new Date("2026-07-20T11:00:00.000Z"),
        },
      ]);
    const { GET } = await import("../route");
    const { request: req,context } = request("test-user@example.com");
    const response = await GET(req, context);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(mockFindConversations.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({
        $and: expect.arrayContaining([
          expect.objectContaining({
            $or: expect.arrayContaining([
              {
                $and: [
                  { $or: [{ source: "webex" }, { client_type: "webex" }] },
                  { "metadata.webex_space_id": "space-shared" },
                ],
              },
            ]),
          }),
        ]),
      }),
    );
    expect(body.data.recent_conversations).toEqual([
      expect.objectContaining({
        id: "conversation-webex",
        source: "webex",
        channel_id: "space-shared",
        webex_permalink: "webexteams://im?space=space-shared",
      }),
    ]);
  });

  it("shows web conversations shared through existing conversation RBAC", async () => {
    mockGetAuth.mockResolvedValue({
      session: {
        sub: "member-sub",
        user: { email: "member@example.com" },
      },
    });
    mockRequireAdminSurfaceManage.mockRejectedValue(new Error("not manager"));
    mockHasOrganizationAdmin.mockResolvedValue(false);
    mockGetDirectSharingAccessConversationIds.mockResolvedValue([
      "conversation-shared",
    ]);
    mockCountConversations
      .mockReset()
      .mockResolvedValueOnce(1)
      .mockResolvedValueOnce(1);
    mockFindConversations
      .mockReset()
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce([
        {
          _id: "conversation-shared",
          title: "Shared web conversation",
          client_type: "webui",
          created_at: new Date("2026-07-20T10:00:00.000Z"),
          updated_at: new Date("2026-07-20T11:00:00.000Z"),
        },
      ]);
    mockFindFeedback
      .mockReset()
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce([
        {
          source: "web",
          rating: "positive",
          value: "thumbs_up",
          conversation_id: "conversation-shared",
          created_at: new Date("2026-07-20T11:05:00.000Z"),
        },
      ]);

    const { GET } = await import("../route");
    const { request: req,context } = request("test-user@example.com");
    const response = await GET(req, context);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(mockGetDirectSharingAccessConversationIds).toHaveBeenCalledWith(
      "member@example.com",
      expect.any(Function),
    );
    expect(mockFindConversations.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({
        $and: expect.arrayContaining([
          expect.objectContaining({
            $or: expect.arrayContaining([
              expect.objectContaining({
                $and: expect.arrayContaining([
                  expect.objectContaining({
                    $or: expect.arrayContaining([
                      { _id: { $in: ["conversation-shared"] } },
                    ]),
                  }),
                ]),
              }),
            ]),
          }),
        ]),
      }),
    );
    expect(body.data.recent_conversations).toEqual([
      expect.objectContaining({
        id: "conversation-shared",
        source: "web",
      }),
    ]);
    expect(body.data.recent_feedback).toEqual([
      expect.objectContaining({
        source: "web",
        conversation_id: "conversation-shared",
      }),
    ]);
  });

});
