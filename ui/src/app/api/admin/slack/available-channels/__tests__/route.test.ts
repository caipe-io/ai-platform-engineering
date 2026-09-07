/**
 * @jest-environment node
 *
 * Regression coverage for GitHub issue #1506: Slack Integration channel
 * discovery returning irrelevant results + no caching.
 *
 * Verifies that the `available-channels` route:
 *   - Uses `users.conversations` (Tier 3) for every request, so
 *     workspaces with thousands of channels don't trip Slack's Tier-2 rate
 *     limit on `conversations.list`.
 *   - Ignores legacy `member_only=0` callers instead of using `conversations.list`.
 *   - Caches results per bot token and serves repeat requests from cache
 *     without calling Slack again.
 *   - Honors `refresh=1` to force a re-fetch.
 *   - Defaults `is_member=true` for rows from `users.conversations` (which
 *     omits the field per Slack's docs).
 *
 * assisted-by Claude Claude-opus-4-7
 */

import { NextRequest } from "next/server";

const mockGetAuthFromBearerOrSession = jest.fn();
const mockRequireResourcePermission = jest.fn();
const mockConfiguredSlackChannelsById = jest.fn();
const mockActiveConnectorPublicationRequestsByItemId = jest.fn();

jest.mock("@/lib/api-middleware", () => {
  const actual = jest.requireActual("@/lib/api-middleware");
  return {
    ...actual,
    getAuthFromBearerOrSession: (...args: unknown[]) =>
      mockGetAuthFromBearerOrSession(...args),
  };
});

jest.mock("@/lib/rbac/resource-authz", () => ({
  requireResourcePermission: (...args: unknown[]) =>
    mockRequireResourcePermission(...args),
}));

jest.mock("@/lib/rbac/slack-channel-configured-directory", () => ({
  configuredSlackChannelsById: (...args: unknown[]) =>
    mockConfiguredSlackChannelsById(...args),
}));

jest.mock("@/lib/publication-approval.server", () => ({
  activeConnectorPublicationRequestsByItemId: (...args: unknown[]) =>
    mockActiveConnectorPublicationRequestsByItemId(...args),
  publicationActorFromSession: (session: { sub?: string }) => ({
    subject: session.sub ?? "",
  }),
  connectorPublicationRequestView: (
    request: Record<string, unknown>,
    actor: { subject: string },
  ) => ({
    id: request._id,
    status: request.status,
    requester: request.requester,
    requester_is_viewer:
      (request.requester as { subject: string }).subject === actor.subject,
    team_slug: "team-primary",
    agent_id: "agent-primary",
    approver_team_slugs: ["reviewers"],
    approver_user_subjects: [],
  }),
}));

interface SlackFetchCall {
  endpoint: string;
  cursor: string | null;
  url: string;
}

const slackCalls: SlackFetchCall[] = [];

function mockSlackFetch(handler: (call: SlackFetchCall) => unknown) {
  (global.fetch as jest.Mock).mockImplementation(async (input: string) => {
    const url = typeof input === "string" ? input : input.toString();
    const parsed = new URL(url);
    const endpointName = parsed.pathname.split("/").pop() ?? "";
    const cursor = parsed.searchParams.get("cursor");
    const call: SlackFetchCall = { endpoint: endpointName, cursor, url };
    slackCalls.push(call);
    const body = handler(call);
    return {
      ok: true,
      status: 200,
      headers: new Map<string, string>(),
      json: async () => body,
      text: async () => JSON.stringify(body),
    };
  });
}

async function makeRequest(query: string): Promise<unknown> {
  const { GET } = await import("../route");
  const response = await GET(
    new NextRequest(
      `http://localhost:3000/api/admin/slack/available-channels?${query}`,
      { headers: { Authorization: "Bearer test-token" } }
    )
  );
  return await response.json();
}

beforeEach(async () => {
  jest.clearAllMocks();
  slackCalls.length = 0;
  mockGetAuthFromBearerOrSession.mockResolvedValue({
    user: { email: "admin@example.com" },
    session: { sub: "admin-sub" },
  });
  mockRequireResourcePermission.mockResolvedValue(undefined);
  mockConfiguredSlackChannelsById.mockResolvedValue(new Map());
  mockActiveConnectorPublicationRequestsByItemId.mockResolvedValue(new Map());
  process.env.SLACK_BOT_TOKEN = "xoxb-test-token-abcdefghijkl";

  // Reset the route's in-process cache so each test starts clean.
  const route = await import("../route");
  route.__resetAvailableChannelsCacheForTests();
  // Also reset the discovery-cache TTL memo so a previous test's env
  // toggling can't bleed into the next test.
  const cfg = await import("@/lib/rbac/discovery-cache-config");
  cfg.__resetDiscoveryCacheConfigForTests();
  delete process.env.SLACK_DISCOVERY_CACHE_TTL_MINUTES;
});

describe("GET /api/admin/slack/available-channels", () => {
  it("uses baseline Slack-surface read access for self-service discovery", async () => {
    mockSlackFetch(() => ({ ok: true, channels: [] }));

    await makeRequest("");

    expect(mockRequireResourcePermission).toHaveBeenCalledWith(
      { sub: "admin-sub" },
      { type: "admin_surface", id: "slack", action: "read" },
      { bypassForOrgAdmin: true },
    );
  });

  describe("issue #1506 — endpoint selection", () => {
    it("uses users.conversations when member_only=1 (default)", async () => {
      mockSlackFetch(() => ({
        ok: true,
        channels: [
          { id: "C100", name: "incidents", is_private: false, num_members: 5 },
          { id: "C101", name: "alerts", is_private: true, num_members: 2 },
        ],
        response_metadata: { next_cursor: "" },
      }));

      const body = await makeRequest("member_only=1");

      expect(slackCalls).toHaveLength(1);
      expect(slackCalls[0].endpoint).toBe("users.conversations");
      // Both channels should come back with is_member=true even though
      // users.conversations omits the field.
      expect(body).toMatchObject({
        success: true,
        data: {
          scope: "member_only",
          endpoint: "users.conversations",
          channels: [
            expect.objectContaining({ id: "C101", name: "alerts", is_member: true }),
            expect.objectContaining({ id: "C100", name: "incidents", is_member: true }),
          ],
        },
      });
      expect(mockConfiguredSlackChannelsById).toHaveBeenCalledTimes(1);
      expect(mockConfiguredSlackChannelsById).toHaveBeenCalledWith([
        "C101",
        "C100",
      ]);
    });

    it("marks configured channels with the Owner team in one batched lookup", async () => {
      mockConfiguredSlackChannelsById.mockResolvedValue(
        new Map([
          [
            "C100",
            {
              channelId: "C100",
              teamSlug: "platform",
              teamName: "Platform",
              agentId: "primary-agent",
              agentName: "Primary Agent",
            },
          ],
        ]),
      );
      mockSlackFetch(() => ({
        ok: true,
        channels: [
          { id: "C100", name: "incidents" },
          { id: "C101", name: "alerts" },
        ],
      }));

      const body = (await makeRequest("member_only=1")) as {
        data: {
          channels: Array<{
            id: string;
            configured: boolean;
            configured_team_slug?: string;
            configured_team_name?: string;
            configured_agent_id?: string;
            configured_agent_name?: string;
          }>;
        };
      };

      expect(mockConfiguredSlackChannelsById).toHaveBeenCalledTimes(1);
      expect(mockConfiguredSlackChannelsById).toHaveBeenCalledWith([
        "C101",
        "C100",
      ]);
      expect(body.data.channels).toEqual([
        expect.objectContaining({ id: "C101", configured: false }),
        expect.objectContaining({
          id: "C100",
          configured: true,
          configured_team_slug: "platform",
          configured_team_name: "Platform",
          configured_agent_id: "primary-agent",
          configured_agent_name: "Primary Agent",
        }),
      ]);
    });

    it("returns a persisted pending onboarding request with the discovered channel", async () => {
      mockActiveConnectorPublicationRequestsByItemId.mockResolvedValue(new Map([
        [
          "C100",
          {
            _id: "request-primary",
            status: "pending",
            requester: { subject: "admin-sub", name: "Example User" },
          },
        ],
      ]));
      mockSlackFetch(() => ({
        ok: true,
        channels: [{ id: "C100", name: "incidents" }],
      }));

      const body = (await makeRequest("member_only=1")) as {
        data: { channels: Array<Record<string, unknown>> };
      };

      expect(mockActiveConnectorPublicationRequestsByItemId).toHaveBeenCalledWith(
        "slack_channel",
        ["C100"],
      );
      expect(body.data.channels[0]).toMatchObject({
        id: "C100",
        configured: false,
        pending_publication: {
          id: "request-primary",
          requester_is_viewer: true,
          team_slug: "team-primary",
          agent_id: "agent-primary",
        },
      });
    });

    it("uses users.conversations by default (no member_only param)", async () => {
      mockSlackFetch(() => ({ ok: true, channels: [] }));
      await makeRequest("");
      expect(slackCalls[0].endpoint).toBe("users.conversations");
    });

    it("ignores legacy member_only=0 and still uses users.conversations", async () => {
      mockSlackFetch(() => ({
        ok: true,
        channels: [
          { id: "C200", name: "general", is_private: false, num_members: 100 },
        ],
      }));

      const body = await makeRequest("member_only=0");

      expect(slackCalls).toHaveLength(1);
      expect(slackCalls[0].endpoint).toBe("users.conversations");
      expect(body).toMatchObject({
        success: true,
        data: { scope: "member_only", endpoint: "users.conversations" },
      });
    });
  });

  describe("issue #1506 — caching", () => {
    it("serves repeat requests from cache without hitting Slack again", async () => {
      mockSlackFetch(() => ({
        ok: true,
        channels: [
          { id: "C100", name: "incidents", num_members: 5 },
        ],
      }));

      const first = (await makeRequest("member_only=1")) as { data: { cached: boolean } };
      const second = (await makeRequest("member_only=1")) as { data: { cached: boolean } };

      expect(slackCalls).toHaveLength(1); // second call hit the cache
      expect(first.data.cached).toBe(false);
      expect(second.data.cached).toBe(true);
    });

    it("forces a re-fetch when refresh=1 is set", async () => {
      mockSlackFetch(() => ({ ok: true, channels: [{ id: "C100", name: "incidents" }] }));

      await makeRequest("member_only=1");
      await makeRequest("member_only=1&refresh=1");

      expect(slackCalls).toHaveLength(2);
      expect(slackCalls.every((c) => c.endpoint === "users.conversations")).toBe(true);
    });

    it("skips the cache entirely when the admin TTL is 0 minutes", async () => {
      // Admin set the discovery cache TTL to 0 (= caching disabled) via
      // Admin → Platform Settings. Every request should re-fetch from
      // Slack — this is the debug knob for the `#test-0525` scenario
      // where the bot was just added to a new channel.
      process.env.SLACK_DISCOVERY_CACHE_TTL_MINUTES = "0";
      const cfg = await import("@/lib/rbac/discovery-cache-config");
      cfg.__resetDiscoveryCacheConfigForTests();

      mockSlackFetch(() => ({ ok: true, channels: [{ id: "C100", name: "incidents" }] }));

      await makeRequest("member_only=1");
      await makeRequest("member_only=1");
      await makeRequest("member_only=1");

      expect(slackCalls).toHaveLength(3);
    });

    it("uses one bot-member cache even for legacy member_only=0 callers", async () => {
      mockSlackFetch(() => ({
        ok: true,
        channels: [{ id: "C100", name: "members-only-channel" }],
      }));

      const memberOnly = (await makeRequest("member_only=1")) as {
        data: { channels: Array<{ id: string }>; cached: boolean };
      };
      const legacyAll = (await makeRequest("member_only=0")) as {
        data: { channels: Array<{ id: string }>; cached: boolean };
      };

      expect(slackCalls).toHaveLength(1);
      expect(slackCalls[0].endpoint).toBe("users.conversations");
      expect(memberOnly.data.cached).toBe(false);
      expect(legacyAll.data.cached).toBe(true);
      expect(memberOnly.data.channels.map((c) => c.id)).toEqual(["C100"]);
      expect(legacyAll.data.channels.map((c) => c.id)).toEqual(["C100"]);
    });
  });

  describe("pagination + filtering", () => {
    it("walks Slack cursors and returns all pages", async () => {
      mockSlackFetch((call) => {
        if (!call.cursor) {
          return {
            ok: true,
            channels: [{ id: "C001", name: "a-channel" }],
            response_metadata: { next_cursor: "page2" },
          };
        }
        return {
          ok: true,
          channels: [{ id: "C002", name: "b-channel" }],
          response_metadata: { next_cursor: "" },
        };
      });

      const body = (await makeRequest("member_only=1")) as {
        data: { channels: Array<{ id: string }>; total_visible: number };
      };

      expect(slackCalls).toHaveLength(2);
      expect(body.data.total_visible).toBe(2);
      expect(body.data.channels.map((c) => c.id)).toEqual(["C001", "C002"]);
    });

    it("filters by q (case-insensitive substring) over the cached snapshot", async () => {
      mockSlackFetch(() => ({
        ok: true,
        channels: [
          { id: "C001", name: "incidents-prod" },
          { id: "C002", name: "incidents-dev" },
          { id: "C003", name: "random" },
        ],
      }));

      const body = (await makeRequest("member_only=1&q=INCIDENTS")) as {
        data: { channels: Array<{ id: string }>; total_matches: number };
      };

      expect(body.data.total_matches).toBe(2);
      expect(body.data.channels.map((c) => c.id).sort()).toEqual(["C001", "C002"]);
    });
  });

  describe("failure modes", () => {
    it("returns 503 when SLACK_BOT_TOKEN is unset", async () => {
      delete process.env.SLACK_BOT_TOKEN;
      const { GET } = await import("../route");
      const response = await GET(
        new NextRequest(
          "http://localhost:3000/api/admin/slack/available-channels?member_only=1",
          { headers: { Authorization: "Bearer test-token" } }
        )
      );
      expect(response.status).toBe(503);
    });

    // Regression: previously a network failure surfaced as the opaque
    // "fetch failed" string from Node's undici, which left admins with no
    // way to tell whether Slack was down, DNS was broken, or egress was
    // blocked. The route now unwraps `error.cause` so the underlying
    // reason makes it back to the UI and the server logs.
    it("returns 502 with the underlying cause when fetch() rejects (DNS/TLS/connect)", async () => {
      const causeError = Object.assign(new Error("getaddrinfo ENOTFOUND slack.com"), {
        name: "Error",
      });
      const fetchError = new TypeError("fetch failed");
      (fetchError as { cause?: unknown }).cause = causeError;
      (global.fetch as jest.Mock).mockRejectedValue(fetchError);

      const { GET } = await import("../route");
      const response = await GET(
        new NextRequest(
          "http://localhost:3000/api/admin/slack/available-channels?member_only=1",
          { headers: { Authorization: "Bearer test-token" } }
        )
      );
      expect(response.status).toBe(502);
      const body = (await response.json()) as { success: boolean; error: string };
      expect(body.success).toBe(false);
      expect(body.error).toContain("Slack discovery network failure");
      expect(body.error).toContain("users.conversations");
      expect(body.error).toContain("ENOTFOUND slack.com");
      // Must NOT contain the bearer token in the user-facing message.
      expect(body.error).not.toContain("Bearer");
      expect(body.error).not.toContain(process.env.SLACK_BOT_TOKEN ?? "xoxb-test");
    });

    it("returns 502 when Slack returns a non-JSON body (e.g. HTML during incident)", async () => {
      (global.fetch as jest.Mock).mockResolvedValue({
        ok: false,
        status: 503,
        headers: new Map<string, string>(),
        json: async () => {
          throw new SyntaxError("Unexpected token < in JSON at position 0");
        },
        text: async () => "<html>Service Unavailable</html>",
      });

      const { GET } = await import("../route");
      const response = await GET(
        new NextRequest(
          "http://localhost:3000/api/admin/slack/available-channels?member_only=1",
          { headers: { Authorization: "Bearer test-token" } }
        )
      );
      expect(response.status).toBe(502);
      const body = (await response.json()) as { success: boolean; error: string };
      expect(body.error).toContain("non-JSON response");
      expect(body.error).toContain("users.conversations");
    });
  });
});
