import {
  annotateConversationsWithViewerSharing,
  conversationOwnershipCandidateQuery,
  conversationVisibilityCandidateQuery,
  filterConversationsByImplicitOrExplicitPermission,
  getDirectSharingAccessConversationIds,
  isImplicitConversationOwner,
  requireConversationResourcePermission,
} from "../conversation-implicit-authz";

jest.mock("../resource-authz", () => ({
  filterResourcesByPermission: jest.fn(async (_session, resources) =>
    resources.filter((resource: { _id: string }) => resource._id === "shared"),
  ),
  requireResourcePermission: jest.fn(async () => undefined),
}));

const { filterResourcesByPermission, requireResourcePermission } = jest.requireMock("../resource-authz") as {
  filterResourcesByPermission: jest.Mock;
  requireResourcePermission: jest.Mock;
};

describe("conversation implicit authorization", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("bounds personal assistant discovery by subject or normalized legacy ownership without sharing", () => {
    expect(conversationOwnershipCandidateQuery({ sub: "test-user" }, "Test-User@Example.test")).toEqual({
      $or: [{ owner_subject: "test-user" }, { owner_id: { $in: ["Test-User@Example.test", "test-user@example.test"] } }],
    });
    expect(conversationOwnershipCandidateQuery({}, "test-user@example.test")).toEqual({
      $or: [{ owner_id: "test-user@example.test" }],
    });
  });

  it("builds a bounded candidate query for owned and explicitly shared conversations", () => {
    expect(conversationVisibilityCandidateQuery("alice@example.com")).toEqual({
      $or: [
        { owner_id: "alice@example.com" },
        { "sharing.shared_with": "alice@example.com" },
        { "sharing.shared_with_teams.0": { $exists: true } },
      ],
    });
  });

  it("includes direct SharingAccess conversation ids as Mongo fallback candidates", () => {
    expect(conversationVisibilityCandidateQuery("Alice@Example.com", ["legacy-share"])).toEqual({
      $or: [
        { owner_id: { $in: ["Alice@Example.com", "alice@example.com"] } },
        { "sharing.shared_with": { $in: ["Alice@Example.com", "alice@example.com"] } },
        { _id: { $in: ["legacy-share"] } },
        { "sharing.shared_with_teams.0": { $exists: true } },
      ],
    });
  });

  it("reads direct SharingAccess conversation ids with raw and normalized email candidates", async () => {
    const distinct = jest.fn().mockResolvedValue(["legacy-share", "legacy-share", ""]);
    const ids = await getDirectSharingAccessConversationIds("Alice@Example.com", async () => ({ distinct }));

    expect(ids).toEqual(["legacy-share"]);
    expect(distinct).toHaveBeenCalledWith("conversation_id", {
      granted_to: { $in: ["Alice@Example.com", "alice@example.com"] },
      revoked_at: null,
    });
  });

  it("treats owner_subject and legacy owner_id as implicit ownership", () => {
    expect(
      isImplicitConversationOwner(
        { sub: "alice-sub" },
        "other@example.com",
        { owner_id: "legacy@example.com", owner_subject: "alice-sub" },
      ),
    ).toBe(true);
    expect(
      isImplicitConversationOwner(
        {},
        "legacy@example.com",
        { owner_id: "legacy@example.com", owner_subject: undefined },
      ),
    ).toBe(true);
  });

  it("skips OpenFGA checks for implicit owners and checks shared candidates", async () => {
    const visible = await filterConversationsByImplicitOrExplicitPermission(
      { sub: "alice-sub" },
      "legacy@example.com",
      [
        { _id: "owned-sub", owner_id: "other@example.com", owner_subject: "alice-sub" } as unknown,
        { _id: "owned-email", owner_id: "legacy@example.com" } as unknown,
        { _id: "direct-embedded", owner_id: "carol@example.com", sharing: { shared_with: ["Legacy@Example.com"] } } as unknown,
        { _id: "direct-access", owner_id: "carol@example.com" } as unknown,
        { _id: "public", owner_id: "carol@example.com", sharing: { is_public: true } } as unknown,
        { _id: "shared", owner_id: "carol@example.com" } as unknown,
        { _id: "denied", owner_id: "dave@example.com" } as unknown,
      ],
      "discover",
      ["direct-access"],
    );

    expect(visible.map((conversation) => conversation._id)).toEqual([
      "owned-sub",
      "owned-email",
      "direct-embedded",
      "direct-access",
      "shared",
    ]);
    expect(filterResourcesByPermission).toHaveBeenCalledWith(
      { sub: "alice-sub" },
      [
        { _id: "public", owner_id: "carol@example.com", sharing: { is_public: true } },
        { _id: "shared", owner_id: "carol@example.com" },
        { _id: "denied", owner_id: "dave@example.com" },
      ],
      expect.objectContaining({
        type: "conversation",
        action: "discover",
      }),
      { bypassForOrgAdmin: true },
    );
  });

  it("annotates viewer sharing for non-owned visible rows", () => {
    type ViewerFlagRow = {
      _id: string;
      owner_id?: string;
      owner_subject?: string;
    };

    const rows = annotateConversationsWithViewerSharing<ViewerFlagRow>(
      { sub: "alice-sub" },
      "alice@example.com",
      [
        { _id: "owned-sub", owner_id: "other@example.com", owner_subject: "alice-sub" },
        { _id: "owned-email", owner_id: "alice@example.com", owner_subject: undefined },
        { _id: "shared-no-owner", owner_id: undefined, owner_subject: undefined },
        { _id: "shared-known-owner", owner_id: "bob@example.com", owner_subject: undefined },
      ],
    );

    expect(rows.map((row) => [row._id, row.viewer_has_shared_access])).toEqual([
      ["owned-sub", false],
      ["owned-email", false],
      ["shared-no-owner", true],
      ["shared-known-owner", true],
    ]);
  });

  it("requires OpenFGA only when caller is not the implicit owner", async () => {
    await requireConversationResourcePermission(
      { sub: "alice-sub" },
      "alice@example.com",
      { _id: "owned", owner_id: "alice@example.com" } as unknown,
      "write",
    );
    expect(requireResourcePermission).not.toHaveBeenCalled();

    await requireConversationResourcePermission(
      { sub: "bob-sub" },
      "bob@example.com",
      { _id: "shared", owner_id: "alice@example.com" } as unknown,
      "write",
    );
    expect(requireResourcePermission).toHaveBeenCalledWith(
      { sub: "bob-sub" },
      { type: "conversation", id: "shared", action: "write" },
      { bypassForOrgAdmin: true },
    );
  });
});
