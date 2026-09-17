/**
 * Tests for the generalized shareable-resource reconciler core
 * (`buildShareableResourceTupleDiff` / `buildTeamGrantTuples`) introduced by
 * spec 2026-06-03-unified-shareable-resource-rbac, User Story 1.
 *
 * The core is the single home for the owner-team + share-with-teams effective
 * set diff (writes for owner ∪ shared, deletes for previousEffective \
 * nextEffective) plus the audit-only `creator` tuple and the data_source
 * `parent_kb` inheritance edge. The agent / knowledge_base / data_source /
 * mcp_tool builders all compose it — see SC-006 (their existing suites must
 * pass unchanged after the refactor).
 */

import {
  buildShareableResourceTupleDiff,
  buildTeamGrantTuples,
} from "@/lib/rbac/openfga-owned-resources";

describe("buildShareableResourceTupleDiff", () => {
  it("writes the creator tuple exactly once and never deletes it", () => {
    const diff = buildShareableResourceTupleDiff({
      objectType: "data_source",
      objectId: "ds-1",
      creatorSubject: "alice-sub",
      ownerTeamSlug: "platform",
      previousOwnerTeamSlug: "legacy",
    });
    const creatorWrites = diff.writes.filter((t) => t.relation === "creator");
    expect(creatorWrites).toEqual([
      { user: "user:alice-sub", relation: "creator", object: "data_source:ds-1" },
    ]);
    // creator is audit-only: it is NEVER in a delete set, even on transfer.
    expect(diff.deletes.some((t) => t.relation === "creator")).toBe(false);
  });

  it("emits the creator tuple first, before owner-subject and team grants", () => {
    const diff = buildShareableResourceTupleDiff({
      objectType: "knowledge_base",
      objectId: "kb-1",
      creatorSubject: "alice-sub",
      ownerSubject: "alice-sub",
      ownerTeamSlug: "platform",
      extraMemberRelations: ["ingestor"],
    });
    expect(diff.writes).toEqual([
      { user: "user:alice-sub", relation: "creator", object: "knowledge_base:kb-1" },
      { user: "user:alice-sub", relation: "owner", object: "knowledge_base:kb-1" },
      { user: "team:platform#member", relation: "reader", object: "knowledge_base:kb-1" },
      { user: "team:platform#member", relation: "ingestor", object: "knowledge_base:kb-1" },
      { user: "team:platform#admin", relation: "manager", object: "knowledge_base:kb-1" },
    ]);
  });

  it("writes the parent_kb inheritance edge for a data_source", () => {
    const diff = buildShareableResourceTupleDiff({
      objectType: "data_source",
      objectId: "ds-1",
      parentKnowledgeBaseId: "ds-1",
    });
    expect(diff.writes).toEqual([
      { user: "knowledge_base:ds-1", relation: "parent_kb", object: "data_source:ds-1" },
    ]);
  });

  it("does not delete the parent_kb edge on a share change", () => {
    const diff = buildShareableResourceTupleDiff({
      objectType: "data_source",
      objectId: "ds-1",
      parentKnowledgeBaseId: "ds-1",
      ownerTeamSlug: "platform",
      previousSharedTeamSlugs: ["legacy"],
    });
    expect(diff.deletes.some((t) => t.relation === "parent_kb")).toBe(false);
  });

  it("computes transfer deletes from previousOwnerTeamSlug", () => {
    const diff = buildShareableResourceTupleDiff({
      objectType: "data_source",
      objectId: "ds-1",
      ownerTeamSlug: "new-team",
      previousOwnerTeamSlug: "old-team",
    });
    expect(diff.writes).toEqual(
      expect.arrayContaining([
        { user: "team:new-team#member", relation: "reader", object: "data_source:ds-1" },
        { user: "team:new-team#admin", relation: "manager", object: "data_source:ds-1" },
      ]),
    );
    expect(diff.deletes).toEqual(
      expect.arrayContaining([
        { user: "team:old-team#member", relation: "reader", object: "data_source:ds-1" },
        { user: "team:old-team#admin", relation: "manager", object: "data_source:ds-1" },
      ]),
    );
  });

  it("ownerTeamManagerViaMember: writes #member (not #admin) manager for the owner, with no stale delete", () => {
    const diff = buildShareableResourceTupleDiff({
      objectType: "data_source",
      objectId: "ds-1",
      ownerTeamSlug: "platform",
      ownerTeamManagerViaMember: true,
    });
    // Exact match (not arrayContaining): asserts there is no leftover
    // `#admin manager` write alongside the `#member` one.
    expect(diff.writes).toEqual([
      { user: "team:platform#member", relation: "reader", object: "data_source:ds-1" },
      { user: "team:platform#member", relation: "manager", object: "data_source:ds-1" },
    ]);
    expect(diff.deletes).toEqual([]);
  });

  it("ownerTeamManagerViaMember: transfer deletes the previous owner's #member manager, not a stale #admin one", () => {
    const diff = buildShareableResourceTupleDiff({
      objectType: "data_source",
      objectId: "ds-1",
      ownerTeamSlug: "new-team",
      previousOwnerTeamSlug: "old-team",
      ownerTeamManagerViaMember: true,
    });
    // Exact match: the base `buildTeamGrantTuples` delete for
    // `team:old-team#admin manager` must be suppressed here, since that
    // tuple was never written under this override — only `#member` was.
    expect(diff.deletes).toEqual([
      { user: "team:old-team#member", relation: "reader", object: "data_source:ds-1" },
      { user: "team:old-team#member", relation: "manager", object: "data_source:ds-1" },
    ]);
  });

  it("honors extraMemberRelations (mcp_tool gets reader + user + caller)", () => {
    const diff = buildShareableResourceTupleDiff({
      objectType: "mcp_tool",
      objectId: "t-1",
      ownerTeamSlug: "platform",
      extraMemberRelations: ["user", "caller"],
    });
    expect(diff.writes).toEqual([
      { user: "team:platform#member", relation: "reader", object: "mcp_tool:t-1" },
      { user: "team:platform#member", relation: "user", object: "mcp_tool:t-1" },
      { user: "team:platform#member", relation: "caller", object: "mcp_tool:t-1" },
      { user: "team:platform#admin", relation: "manager", object: "mcp_tool:t-1" },
    ]);
  });

  it("grants org members the member relations when sharedWithOrg is true", () => {
    const diff = buildShareableResourceTupleDiff({
      objectType: "mcp_tool",
      objectId: "t-1",
      ownerTeamSlug: "platform",
      extraMemberRelations: ["user", "caller"],
      sharedWithOrg: true,
    });
    expect(diff.writes).toEqual(
      expect.arrayContaining([
        { user: "organization:caipe#member", relation: "reader", object: "mcp_tool:t-1" },
        { user: "organization:caipe#member", relation: "user", object: "mcp_tool:t-1" },
        { user: "organization:caipe#member", relation: "caller", object: "mcp_tool:t-1" },
      ]),
    );
    expect(diff.deletes).toEqual([]);
  });

  it("leaves org tuples untouched when sharedWithOrg is undefined", () => {
    const diff = buildShareableResourceTupleDiff({
      objectType: "data_source",
      objectId: "ds-1",
      ownerTeamSlug: "platform",
    });
    const orgTuples = [...diff.writes, ...diff.deletes].filter((t) =>
      t.user.startsWith("organization:"),
    );
    expect(orgTuples).toEqual([]);
  });

  it("is idempotent and dedupes when owner is also in the shared list", () => {
    const input = {
      objectType: "data_source",
      objectId: "ds-1",
      ownerTeamSlug: "platform",
      nextSharedTeamSlugs: ["platform", "data-eng"],
      previousSharedTeamSlugs: ["platform", "data-eng"],
    } as const;
    const a = buildShareableResourceTupleDiff(input);
    const b = buildShareableResourceTupleDiff(input);
    expect(a).toEqual(b);
    const platformReaders = a.writes.filter(
      (t) => t.user === "team:platform#member" && t.relation === "reader",
    );
    expect(platformReaders).toHaveLength(1);
    expect(a.deletes).toEqual([]);
  });

  it("throws on an invalid object id", () => {
    expect(() =>
      buildShareableResourceTupleDiff({ objectType: "data_source", objectId: "bad id" }),
    ).toThrow(/Invalid OpenFGA/);
  });

  it("silently drops invalid team slugs", () => {
    const diff = buildShareableResourceTupleDiff({
      objectType: "data_source",
      objectId: "ds-1",
      nextSharedTeamSlugs: ["good-team", "bad slug"],
    });
    const users = diff.writes.map((t) => t.user);
    expect(users).toContain("team:good-team#member");
    expect(users).not.toContain("team:bad slug#member");
  });
});

describe("buildTeamGrantTuples (shared primitive)", () => {
  it("supports a full member-relation override (agent uses 'user', not 'reader')", () => {
    const { writes } = buildTeamGrantTuples({
      object: "agent:a-1",
      memberRelations: ["user"],
      ownerTeamSlug: "platform",
      nextSharedTeamSlugs: ["sre"],
    });
    expect(writes).toEqual([
      { user: "team:platform#member", relation: "user", object: "agent:a-1" },
      { user: "team:platform#admin", relation: "manager", object: "agent:a-1" },
      { user: "team:sre#member", relation: "user", object: "agent:a-1" },
      { user: "team:sre#admin", relation: "manager", object: "agent:a-1" },
    ]);
  });

  it("does not delete a previous owner team that is promoted to the new owner", () => {
    const { deletes } = buildTeamGrantTuples({
      object: "agent:a-1",
      memberRelations: ["user"],
      ownerTeamSlug: "sre",
      previousOwnerTeamSlug: "platform",
      nextSharedTeamSlugs: [],
      previousSharedTeamSlugs: ["sre"],
    });
    // platform (old owner) deleted; sre (new owner, was shared) NOT deleted.
    expect(deletes).toEqual(
      expect.arrayContaining([
        { user: "team:platform#member", relation: "user", object: "agent:a-1" },
        { user: "team:platform#admin", relation: "manager", object: "agent:a-1" },
      ]),
    );
    expect(deletes.some((t) => t.user === "team:sre#member")).toBe(false);
  });
});
