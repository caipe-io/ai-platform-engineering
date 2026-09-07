/**
 * @jest-environment node
 */
/**
 * DELETE /api/admin/slack/channels/[workspaceId]/[channelId].
 *
 * Hard-deletes a channel: sweeps every OpenFGA tuple referencing the channel
 * (both directions) and purges its Mongo metadata. The OpenFGA sweep is the
 * piece under test — `listChannelTuples` must:
 *   - read the channel-as-object direction with `{ object: <channelRef> }`,
 *   - read the channel-as-user direction once PER usable object type
 *     (`{ object: "<type>:", user: <channelRef> }`) — OpenFGA /read rejects a
 *     user-only filter, so a single combined read is impossible,
 *   - union + dedup the results before deleting,
 *   - abort (502) if the OpenFGA delete fails, leaving Mongo untouched.
 */

import { NextRequest } from "next/server";

const mockReadOpenFgaTuples = jest.fn();
const mockDeleteExactOpenFgaTuples = jest.fn();
const mockDeleteSlackChannelAgentRoutes = jest.fn();
const mockDeleteSlackChannelGrants = jest.fn();
const mockGetCollection = jest.fn();

jest.mock("@/lib/rbac/openfga", () => ({
  readOpenFgaTuples: (...args: unknown[]) => mockReadOpenFgaTuples(...args),
  deleteExactOpenFgaTuples: (...args: unknown[]) => mockDeleteExactOpenFgaTuples(...args),
}));

jest.mock("@/lib/rbac/slack-channel-grant-store", () => ({
  deleteSlackChannelGrants: (...args: unknown[]) => mockDeleteSlackChannelGrants(...args),
  slackChannelSubjectId: (ws: string, ch: string) => `${ws}--${ch}`,
  slackWorkspaceRef: (ws: string) => ws,
}));

jest.mock("@/lib/rbac/slack-channel-route-store", () => ({
  deleteSlackChannelAgentRoutes: (...args: unknown[]) => mockDeleteSlackChannelAgentRoutes(...args),
}));

jest.mock("@/lib/mongodb", () => ({
  getCollection: (...args: unknown[]) => mockGetCollection(...args),
}));

// Auth wrapper: pass through to the handler (authorization is exercised
// elsewhere; here we focus on the delete/sweep behavior).
jest.mock("../../../_lib", () => ({
  withSlackChannelRebacManageAuth: (
    _request: unknown,
    handler: () => Promise<unknown>,
  ) => handler(),
}));

import { DELETE } from "../route";

const WS = "T123";
const CH = "C456";
const CHANNEL_REF = `slack_channel:${WS}--${CH}`;
const CHANNEL_USABLE_OBJECT_TYPES = [
  "agent",
  "mcp_server",
  "tool",
  "knowledge_base",
  "rag_collection",
  "document",
  "skill",
];

function ctx() {
  return { params: Promise.resolve({ workspaceId: WS, channelId: CH }) };
}
function req() {
  return new NextRequest(new URL(`/api/admin/slack/channels/${WS}/${CH}`, "http://localhost:3000"), {
    method: "DELETE",
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  mockReadOpenFgaTuples.mockResolvedValue({ tuples: [], continuationToken: undefined });
  mockDeleteExactOpenFgaTuples.mockResolvedValue({ enabled: true, deletes: 0 });
  mockDeleteSlackChannelAgentRoutes.mockResolvedValue(0);
  mockDeleteSlackChannelGrants.mockResolvedValue(0);
  mockGetCollection.mockResolvedValue({
    deleteMany: jest.fn(async () => ({ deletedCount: 1 })),
  });
});

describe("DELETE channel", () => {
  it("reads channel-as-object once plus channel-as-user once per usable object type", async () => {
    const res = await DELETE(req(), ctx());
    expect(res.status).toBe(200);

    // 1 channel-as-object read + one per usable type = 1 + N.
    const tuples = mockReadOpenFgaTuples.mock.calls.map((c) => (c[0] as { tuple: unknown }).tuple);
    expect(mockReadOpenFgaTuples).toHaveBeenCalledTimes(1 + CHANNEL_USABLE_OBJECT_TYPES.length);
    // channel-as-object direction
    expect(tuples).toContainEqual({ object: CHANNEL_REF });
    // channel-as-user direction, one typed read each
    for (const type of CHANNEL_USABLE_OBJECT_TYPES) {
      expect(tuples).toContainEqual({ object: `${type}:`, user: CHANNEL_REF });
    }
  });

  it("unions + dedupes tuples across reads before deleting", async () => {
    const agentTuple = { user: CHANNEL_REF, relation: "user", object: "agent:incident" };
    const teamTuple = { user: "team:eng#member", relation: "user", object: CHANNEL_REF };
    // Same agentTuple returned by two different reads → must be deduped to one.
    mockReadOpenFgaTuples.mockImplementation(async (opts: { tuple?: Record<string, string> }) => {
      const t = opts.tuple ?? {};
      if (t.object === CHANNEL_REF) return { tuples: [{ key: teamTuple }], continuationToken: undefined };
      if (t.object === "agent:") return { tuples: [{ key: agentTuple }], continuationToken: undefined };
      if (t.object === "tool:") return { tuples: [{ key: agentTuple }], continuationToken: undefined }; // dup
      return { tuples: [], continuationToken: undefined };
    });

    await DELETE(req(), ctx());

    expect(mockDeleteExactOpenFgaTuples).toHaveBeenCalledTimes(1);
    const deleted = mockDeleteExactOpenFgaTuples.mock.calls[0][0] as unknown[];
    expect(deleted).toHaveLength(2); // teamTuple + one agentTuple (dup removed)
    expect(deleted).toContainEqual(agentTuple);
    expect(deleted).toContainEqual(teamTuple);
  });

  it("aborts with 502 if the OpenFGA delete fails, before touching Mongo", async () => {
    mockDeleteExactOpenFgaTuples.mockRejectedValue(new Error("openfga down"));
    const deleteMany = jest.fn(async () => ({ deletedCount: 1 }));
    mockGetCollection.mockResolvedValue({ deleteMany });

    const res = await DELETE(req(), ctx());

    expect(res.status).toBe(502);
    expect(deleteMany).not.toHaveBeenCalled();
    expect(mockDeleteSlackChannelAgentRoutes).not.toHaveBeenCalled();
    expect(mockDeleteSlackChannelGrants).not.toHaveBeenCalled();
  });

  it("purges Mongo metadata (mappings, routes, grants) after a successful OpenFGA delete", async () => {
    const deleteMany = jest.fn(async () => ({ deletedCount: 1 }));
    mockGetCollection.mockResolvedValue({ deleteMany });

    const res = await DELETE(req(), ctx());
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(deleteMany).toHaveBeenCalled(); // channel_team_mappings purge
    expect(mockDeleteSlackChannelAgentRoutes).toHaveBeenCalledWith(WS, CH);
    expect(mockDeleteSlackChannelGrants).toHaveBeenCalledWith(WS, CH);
    expect(body.data.deleted.channel_id).toBe(CH);
  });
});
