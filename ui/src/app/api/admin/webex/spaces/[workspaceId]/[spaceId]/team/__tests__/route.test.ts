/**
 * @jest-environment node
 */

import { NextRequest, NextResponse } from "next/server";

const mockGetAuthFromBearerOrSession = jest.fn();
const mockGetCollection = jest.fn();
const mockGetRbacCollection = jest.fn();
const mockWriteOpenFgaTuples = jest.fn();
const mockRequireBot = jest.fn();

jest.mock("@/lib/api-middleware", () => {
  class MockApiError extends Error {
    statusCode: number;
    constructor(message: string, statusCode = 400) {
      super(message);
      this.statusCode = statusCode;
    }
  }
  return {
    ApiError: MockApiError,
    getAuthFromBearerOrSession: (...args: unknown[]) => mockGetAuthFromBearerOrSession(...args),
    successResponse: (data: unknown, status = 200) => NextResponse.json({ success: true, data }, { status }),
    withErrorHandler: <T>(handler: T) => handler,
  };
});

jest.mock("@/lib/mongodb", () => ({
  getCollection: (...args: unknown[]) => mockGetCollection(...args),
}));

jest.mock("@/lib/rbac/mongo-collections", () => ({
  getRbacCollection: (...args: unknown[]) => mockGetRbacCollection(...args),
}));

jest.mock("@/lib/rbac/openfga", () => ({
  writeOpenFgaTuples: (...args: unknown[]) => mockWriteOpenFgaTuples(...args),
}));

jest.mock("@/lib/webex-bot-policy", () => ({
  requireAvailableWebexBotPolicy: (...args: unknown[]) => mockRequireBot(...args),
}));

// Auth is exercised separately by _lib's own tests; here it's a passthrough
// so route tests focus on the bot_id/team-resolution logic.
jest.mock("../../../../_lib", () => ({
  withWebexSpaceRebacManageAuth: (
    _request: NextRequest,
    handler: () => Promise<unknown>,
  ) => handler(),
}));

const mockTeamsFindOne = jest.fn();
const mockMappingsFindOne = jest.fn();
const mockMappingsUpdateOne = jest.fn();

function request(body?: Record<string, unknown>, botId?: string): NextRequest {
  const params = new URLSearchParams();
  if (botId !== undefined) params.set("bot_id", botId);
  const qs = params.toString();
  return new NextRequest(
    `http://localhost/api/admin/webex/spaces/WEBEX-WORKSPACE/space-abc/team${qs ? `?${qs}` : ""}`,
    {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body ?? {}),
    },
  );
}

function context() {
  return { params: Promise.resolve({ workspaceId: "WEBEX-WORKSPACE", spaceId: "space-abc" }) };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockGetAuthFromBearerOrSession.mockResolvedValue({
    user: { email: "admin@example.com" },
    session: { user: { email: "admin@example.com" } },
  });
  mockRequireBot.mockImplementation(async (botId: string | null) => {
    if (botId !== "primary") throw new Error(`Unknown Webex bot: ${botId ?? ""}`);
    return { id: "primary", name: "Primary bot", available: true };
  });
  mockGetCollection.mockResolvedValue({ findOne: mockTeamsFindOne });
  mockGetRbacCollection.mockResolvedValue({
    findOne: mockMappingsFindOne,
    updateOne: mockMappingsUpdateOne,
  });
  mockTeamsFindOne.mockResolvedValue({ _id: "team-1", slug: "platform-engineering", name: "Platform Engineering" });
  mockMappingsFindOne.mockResolvedValue(null);
  mockMappingsUpdateOne.mockResolvedValue(undefined);
  mockWriteOpenFgaTuples.mockResolvedValue({ enabled: true, writes: 2, deletes: 0 });
});

describe("PUT /api/admin/webex/spaces/[workspaceId]/[spaceId]/team", () => {
  it("requires team_slug", async () => {
    const { PUT } = await import("../route");
    await expect(PUT(request({}, "primary"), context())).rejects.toMatchObject({ statusCode: 400 });
  });

  it("404s when the team doesn't exist", async () => {
    mockTeamsFindOne.mockResolvedValueOnce(null);
    const { PUT } = await import("../route");
    await expect(
      PUT(request({ team_slug: "no-such-team" }, "primary"), context()),
    ).rejects.toMatchObject({ statusCode: 404 });
  });

  it("rejects a brand-new assignment with no bot_id and no existing mapping", async () => {
    const { PUT } = await import("../route");
    await expect(
      PUT(request({ team_slug: "platform-engineering" }), context()),
    ).rejects.toThrow(/Unknown Webex bot/);
  });

  it("falls back to the existing mapping's bot_id when none is supplied", async () => {
    mockMappingsFindOne.mockResolvedValueOnce({
      bot_id: "primary",
      webex_workspace_id: "WEBEX-WORKSPACE",
      webex_space_id: "space-abc",
      team_slug: "security",
    });
    const { PUT } = await import("../route");
    const res = await PUT(request({ team_slug: "platform-engineering" }), context());
    expect(res.status).toBe(200);
    expect(mockRequireBot).toHaveBeenCalledWith("primary");
  });

  it("upserts the mapping and writes OpenFGA tuples for the new team, deleting the old team's tuples", async () => {
    mockMappingsFindOne.mockResolvedValueOnce({
      bot_id: "primary",
      webex_workspace_id: "WEBEX-WORKSPACE",
      webex_space_id: "space-abc",
      team_slug: "security",
    });
    const { PUT } = await import("../route");
    const res = await PUT(
      request({ team_slug: "platform-engineering", space_name: "Platform Alerts" }, "primary"),
      context(),
    );
    const payload = await res.json();

    expect(payload.data).toMatchObject({
      workspace_id: "WEBEX-WORKSPACE",
      space_id: "space-abc",
      bot_id: "primary",
      team_id: "team-1",
      team_slug: "platform-engineering",
    });

    const diff = mockWriteOpenFgaTuples.mock.calls[0][0];
    expect(diff.writes.some((t: { user: string }) => t.user.startsWith("team:platform-engineering#"))).toBe(true);
    expect(diff.deletes.some((t: { user: string }) => t.user.startsWith("team:security#"))).toBe(true);

    expect(mockMappingsUpdateOne).toHaveBeenCalledWith(
      { bot_id: "primary", webex_workspace_id: "WEBEX-WORKSPACE", webex_space_id: "space-abc" },
      expect.objectContaining({
        $set: expect.objectContaining({
          team_id: "team-1",
          team_slug: "platform-engineering",
          space_name: "Platform Alerts",
          active: true,
        }),
      }),
      { upsert: true },
    );
  });

  it("does not send a delete diff when the team is unchanged", async () => {
    mockMappingsFindOne.mockResolvedValueOnce({
      bot_id: "primary",
      webex_workspace_id: "WEBEX-WORKSPACE",
      webex_space_id: "space-abc",
      team_slug: "platform-engineering",
    });
    const { PUT } = await import("../route");
    await PUT(request({ team_slug: "platform-engineering" }, "primary"), context());

    const diff = mockWriteOpenFgaTuples.mock.calls[0][0];
    expect(diff.deletes).toEqual([]);
  });

  it("surfaces a 502 when OpenFGA is disabled", async () => {
    mockWriteOpenFgaTuples.mockResolvedValueOnce({ enabled: false, writes: 0, deletes: 0 });
    const { PUT } = await import("../route");
    await expect(
      PUT(request({ team_slug: "platform-engineering" }, "primary"), context()),
    ).rejects.toMatchObject({ statusCode: 502 });
  });

  it("revokes the old team's OpenFGA tuples even when the mapping only has team_id (written by the bulk team route)", async () => {
    mockMappingsFindOne.mockResolvedValueOnce({
      bot_id: "primary",
      webex_workspace_id: "WEBEX-WORKSPACE",
      webex_space_id: "space-abc",
      team_id: "team-security",
      // no team_slug: this is what the bulk route used to write before it
      // was fixed to also persist team_slug.
    });
    mockTeamsFindOne
      .mockResolvedValueOnce({ _id: "team-1", slug: "platform-engineering", name: "Platform Engineering" })
      .mockResolvedValueOnce({ _id: "team-security", slug: "security", name: "Security" });

    const { PUT } = await import("../route");
    const res = await PUT(
      request({ team_slug: "platform-engineering" }, "primary"),
      context(),
    );
    expect(res.status).toBe(200);

    const diff = mockWriteOpenFgaTuples.mock.calls[0][0];
    expect(diff.writes.some((t: { user: string }) => t.user.startsWith("team:platform-engineering#"))).toBe(true);
    expect(diff.deletes.some((t: { user: string }) => t.user.startsWith("team:security#"))).toBe(true);
  });

  it("does not look up the old team or emit a delete when team_id is already the new team's id", async () => {
    mockMappingsFindOne.mockResolvedValueOnce({
      bot_id: "primary",
      webex_workspace_id: "WEBEX-WORKSPACE",
      webex_space_id: "space-abc",
      team_id: "team-1",
    });

    const { PUT } = await import("../route");
    await PUT(request({ team_slug: "platform-engineering" }, "primary"), context());

    expect(mockTeamsFindOne).toHaveBeenCalledTimes(1);
    const diff = mockWriteOpenFgaTuples.mock.calls[0][0];
    expect(diff.deletes).toEqual([]);
  });

  it("deactivates the mapping under the old bot_id instead of leaving two active mappings when the bot changes", async () => {
    mockMappingsFindOne.mockResolvedValueOnce({
      bot_id: "secondary",
      webex_workspace_id: "WEBEX-WORKSPACE",
      webex_space_id: "space-abc",
      team_slug: "platform-engineering",
    });
    mockRequireBot.mockImplementation(async (botId: string | null) => {
      if (botId !== "primary" && botId !== "secondary") throw new Error(`Unknown Webex bot: ${botId ?? ""}`);
      return { id: botId, name: `${botId} bot`, available: true };
    });

    const { PUT } = await import("../route");
    const res = await PUT(request({ team_slug: "platform-engineering" }, "primary"), context());
    expect(res.status).toBe(200);

    expect(mockMappingsUpdateOne).toHaveBeenCalledWith(
      { bot_id: "secondary", webex_workspace_id: "WEBEX-WORKSPACE", webex_space_id: "space-abc" },
      { $set: { active: false, updated_at: expect.any(Date) } },
    );
    expect(mockMappingsUpdateOne).toHaveBeenCalledWith(
      { bot_id: "primary", webex_workspace_id: "WEBEX-WORKSPACE", webex_space_id: "space-abc" },
      expect.objectContaining({ $set: expect.objectContaining({ bot_id: "primary", active: true }) }),
      { upsert: true },
    );
    expect(mockMappingsUpdateOne).toHaveBeenCalledTimes(2);
  });

  it("does not deactivate any prior mapping when the bot_id is unchanged", async () => {
    mockMappingsFindOne.mockResolvedValueOnce({
      bot_id: "primary",
      webex_workspace_id: "WEBEX-WORKSPACE",
      webex_space_id: "space-abc",
      team_slug: "security",
    });

    const { PUT } = await import("../route");
    await PUT(request({ team_slug: "platform-engineering" }, "primary"), context());

    expect(mockMappingsUpdateOne).toHaveBeenCalledTimes(1);
  });
});
