/** @jest-environment node */

import { NextRequest } from "next/server";

const mockCallWebexBotAdmin = jest.fn();
const mockRequireResourcePermission = jest.fn();
const mockActiveConnectorPublicationRequestsByItemId = jest.fn();

jest.mock("@/lib/api-middleware", () => ({
  getAuthFromBearerOrSession: jest.fn(async () => ({
    user: { email: "admin@example.com" },
    session: { sub: "admin-sub", user: { email: "admin@example.com" } },
  })),
  successResponse: (data: unknown) => Response.json({ success: true, data }),
  withErrorHandler: (handler: (request: NextRequest) => Promise<Response>) => handler,
  ApiError: class ApiError extends Error {
    statusCode: number;

    constructor(message: string, statusCode: number) {
      super(message);
      this.statusCode = statusCode;
    }
  },
}));

jest.mock("@/lib/rbac/resource-authz", () => ({
  requireResourcePermission: (...args: unknown[]) =>
    mockRequireResourcePermission(...args),
}));

jest.mock("@/lib/webex-bot-admin", () => ({
  callWebexBotAdmin: (...args: unknown[]) => mockCallWebexBotAdmin(...args),
}));

jest.mock("@/lib/rbac/discovery-cache-config", () => ({
  getDiscoveryCacheTtlMs: jest.fn(async () => 3_600_000),
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
    bot_id: "primary",
    approver_team_slugs: ["reviewers"],
    approver_user_subjects: [],
  }),
}));

const bots = [
  { id: "primary", name: "Primary", available: true },
  { id: "secondary", name: "Secondary", available: true },
];

function runtimeSnapshot(botId: string, spaces: Array<Record<string, unknown>>) {
  return {
    spaces,
    total_matches: spaces.length,
    total_visible: spaces.length,
    next_cursor: null,
    has_more: false,
    cached: false,
    fetched_at: 123,
    bot: bots.find((bot) => bot.id === botId),
  };
}

describe("GET /api/admin/webex/available-spaces", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockRequireResourcePermission.mockResolvedValue(undefined);
    mockActiveConnectorPublicationRequestsByItemId.mockResolvedValue(new Map());
    mockCallWebexBotAdmin.mockImplementation(async (path: string) => {
      if (path === "/admin/webex/bots") return { bots };
      if (path === "/admin/webex/bots/primary/spaces") {
        return runtimeSnapshot("primary", [
          { id: "shared", name: "Shared", type: "group", is_locked: false },
          { id: "primary", name: "Primary only", type: "group", is_locked: false },
        ]);
      }
      if (path === "/admin/webex/bots/secondary/spaces") {
        return runtimeSnapshot("secondary", [
          { id: "shared", name: "Shared", type: "group", is_locked: false },
        ]);
      }
      throw new Error(`Unexpected path: ${path}`);
    });
  });

  it("uses baseline Webex-surface read access for self-service discovery", async () => {
    const { GET } = await import("../available-spaces/route");

    await GET(new NextRequest("http://localhost/api/admin/webex/available-spaces"));

    expect(mockRequireResourcePermission).toHaveBeenCalledWith(
      { sub: "admin-sub", user: { email: "admin@example.com" } },
      { type: "admin_surface", id: "webex", action: "read" },
      { bypassForOrgAdmin: true },
    );
  });

  it("asks the runtime to discover spaces for the selected bot", async () => {
    const { GET } = await import("../available-spaces/route");
    const response = await GET(new NextRequest(
      "http://localhost/api/admin/webex/available-spaces?bot_id=secondary&refresh=1&q=ops&limit=50",
    ));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      data: {
        bot: { id: "secondary" },
        spaces: [{ id: "shared", available_bot_ids: ["secondary"] }],
      },
    });
    expect(mockCallWebexBotAdmin).toHaveBeenCalledWith(
      "/admin/webex/bots/secondary/spaces",
      {
        query: {
          refresh: 1,
          cache_ttl_seconds: 3600,
          q: "ops",
          cursor: undefined,
          limit: 50,
        },
      },
    );
  });

  it("merges physical spaces across available bots", async () => {
    const { GET } = await import("../available-spaces/route");
    const response = await GET(new NextRequest(
      "http://localhost/api/admin/webex/available-spaces",
    ));
    const body = await response.json();

    expect(body.data.spaces).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: "shared",
        available_bot_ids: ["primary", "secondary"],
      }),
      expect.objectContaining({ id: "primary", available_bot_ids: ["primary"] }),
    ]));
  });

  it("rejects an unavailable bot before asking the runtime for spaces", async () => {
    mockCallWebexBotAdmin.mockResolvedValueOnce({
      bots: [{ id: "offline", name: "Offline", available: false }],
    });
    const { GET } = await import("../available-spaces/route");

    await expect(GET(new NextRequest(
      "http://localhost/api/admin/webex/available-spaces?bot_id=offline",
    ))).rejects.toMatchObject({ statusCode: 400 });
    expect(mockCallWebexBotAdmin).toHaveBeenCalledTimes(1);
  });
});
