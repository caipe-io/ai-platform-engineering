import type { Conversation } from "@/types/mongodb";
import {
  annotateConversationsWithViewerSharing,
  conversationVisibilityCandidateQuery,
  filterConversationsByImplicitOrExplicitPermission,
  getDirectSharingAccessConversationIds,
  isImplicitConversationOwner,
  requireConversationResourcePermission,
} from "../conversation-implicit-authz";

jest.mock("@/lib/mongodb", () => ({ getCollection: jest.fn() }));

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


describe("private personal evidence authorization", () => {
  const privateChat = {
    _id: "private-chat", owner_id: "owner@example.com", owner_subject: "owner-sub", owner_identity_version: 2,
    personal_context: "private",
    sharing: { shared_with: ["owner@example.com"], shared_with_teams: [] },
  } as Conversation;

  beforeEach(() => { jest.clearAllMocks(); });

  it("requires the authoritative human subject even when email matches", async () => {
    expect(isImplicitConversationOwner({ sub: "other-sub" }, "owner@example.com", privateChat)).toBe(false);
    await expect(requireConversationResourcePermission({ sub: "other-sub" }, "owner@example.com", privateChat, "read"))
      .rejects.toMatchObject({ statusCode: 403, code: "PRIVATE_CONVERSATION_OWNER_REQUIRED" });
    expect(requireResourcePermission).not.toHaveBeenCalled();
  });

  it.each(["read", "write"] as const)("denies service-account %s even with matching subject and email", async (action) => {
    await expect(requireConversationResourcePermission(
      { sub: "owner-sub", isServiceAccount: true, role: "admin" }, "owner@example.com", privateChat, action,
    )).rejects.toMatchObject({ statusCode: 403 });
    expect(requireResourcePermission).not.toHaveBeenCalled();
  });

  it("allows exact owners and preserves only unnormalized legacy email fallback", async () => {
    await expect(requireConversationResourcePermission({ sub: "owner-sub" }, "old@example.com", privateChat, "write")).resolves.toBeUndefined();
    expect(isImplicitConversationOwner({ sub: "new-sub" }, "Owner@Example.com", {
      ...privateChat, owner_subject: undefined, owner_identity_version: undefined,
    })).toBe(true);
    expect(isImplicitConversationOwner({ sub: "new-sub" }, "owner@example.com", {
      ...privateChat, owner_subject: undefined,
    })).toBe(false);
    expect(requireResourcePermission).not.toHaveBeenCalled();
  });

  it("keeps normal conversations on their existing ownership rules", async () => {
    const ordinary = { ...privateChat, personal_context: undefined } as Conversation;
    await expect(requireConversationResourcePermission({ sub: "other-sub" }, "owner@example.com", ordinary, "write")).resolves.toBeUndefined();
    expect(requireResourcePermission).not.toHaveBeenCalled();
  });

  it("removes private rows from lists before stale shares or CAS grants are considered", async () => {
    const owned = { ...privateChat, _id: "owned", owner_subject: "caller-sub" };
    const visible = await filterConversationsByImplicitOrExplicitPermission(
      { sub: "caller-sub" }, "owner@example.com", [privateChat, owned], "discover", [privateChat._id],
    );
    expect(visible.map((row) => row._id)).toEqual(["owned"]);
    expect(filterResourcesByPermission).toHaveBeenCalledWith(
      { sub: "caller-sub" }, [], expect.any(Object), { bypassForOrgAdmin: true },
    );
  });

  it("retains explicit admin audit reads while blocking admin writes", async () => {
    await expect(requireConversationResourcePermission({ sub: "auditor-sub", role: "admin" }, "audit@example.com", privateChat, "read")).resolves.toBeUndefined();
    expect(requireResourcePermission).toHaveBeenCalledWith(
      { sub: "auditor-sub", role: "admin" }, { type: "conversation", id: privateChat._id, action: "read" }, { bypassForOrgAdmin: true },
    );
    await expect(requireConversationResourcePermission({ sub: "auditor-sub", canViewAdmin: true }, "audit@example.com", privateChat, "write"))
      .rejects.toMatchObject({ statusCode: 403 });
  });

  it("blocks owner reads and writes once purge starts, while permitting an authorized deletion retry", async () => {
    const purging = { ...privateChat, purge: { token: 'attempt', started_at: new Date(),
      lease_until: new Date(), retry_after: new Date(), last_attempted_at: new Date(), reason: 'manual' as const } };
    for (const action of ['read', 'write'] as const) {
      await expect(requireConversationResourcePermission({ sub: 'owner-sub' }, 'owner@example.com', purging, action))
        .rejects.toMatchObject({ statusCode: 409, code: 'CONVERSATION_PURGING' });
    }
    await expect(requireConversationResourcePermission({ sub: 'owner-sub' }, 'owner@example.com', purging, 'delete'))
      .resolves.toBeUndefined();
    expect(requireResourcePermission).not.toHaveBeenCalled();
  });
});
