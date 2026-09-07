/**
 * Tests for `buildKnowledgeBaseRelationshipTupleDiff` shared-team handling.
 *
 * Search-only teams receive reader but never ingestor or manager. Removing a
 * team emits matching deletes,
 * the owner team is always treated as "wanted" so duplicating it in the
 * shared list is a no-op, and invalid slugs are silently dropped.
 */

import {
  buildKnowledgeBaseRelationshipTupleDiff,
  buildDataSourceRelationshipTupleDiff,
} from "@/lib/rbac/openfga-owned-resources";

describe("buildKnowledgeBaseRelationshipTupleDiff — shared teams", () => {
  const KB = "knowledge_base:kb-1";

  it("backwards-compatible: only owner is granted when no shared teams supplied", () => {
    const diff = buildKnowledgeBaseRelationshipTupleDiff({
      knowledgeBaseId: "kb-1",
      ownerSubject: "alice-sub",
      ownerTeamSlug: "platform",
    });
    expect(diff.writes).toEqual([
      { user: "user:alice-sub", relation: "owner", object: KB },
      { user: "team:platform#member", relation: "reader", object: KB },
      { user: "team:platform#admin", relation: "manager", object: KB },
    ]);
    expect(diff.deletes).toEqual([
      { user: "team:platform#member", relation: "ingestor", object: KB },
    ]);
  });

  it("adds reader but never ingestor or manager tuples for search-only teams", () => {
    const diff = buildKnowledgeBaseRelationshipTupleDiff({
      knowledgeBaseId: "kb-1",
      ownerTeamSlug: "platform",
      nextSharedTeamSlugs: ["data-eng", "ml-ops"],
    });
    expect(diff.writes).toEqual(
      expect.arrayContaining([
        { user: "team:platform#member", relation: "reader", object: KB },
        { user: "team:platform#admin", relation: "manager", object: KB },
        { user: "team:data-eng#member", relation: "reader", object: KB },
        { user: "team:ml-ops#member", relation: "reader", object: KB },
      ]),
    );
    expect(
      diff.writes.some(
        (tuple) => tuple.relation === "manager" && tuple.user !== "team:platform#admin",
      ),
    ).toBe(false);
    expect(diff.writes.some((tuple) => tuple.relation === "ingestor")).toBe(false);
    expect(diff.deletes).toEqual(expect.arrayContaining([
      { user: "team:platform#member", relation: "ingestor", object: KB },
      { user: "team:data-eng#member", relation: "ingestor", object: KB },
      { user: "team:ml-ops#member", relation: "ingestor", object: KB },
    ]));
  });

  it("deletes reader and any stale ingestor tuple when a search team is removed", () => {
    const diff = buildKnowledgeBaseRelationshipTupleDiff({
      knowledgeBaseId: "kb-1",
      ownerTeamSlug: "platform",
      previousSharedTeamSlugs: ["data-eng", "ml-ops"],
      nextSharedTeamSlugs: ["data-eng"],
    });
    expect(diff.writes).toEqual(
      expect.arrayContaining([
        { user: "team:data-eng#member", relation: "reader", object: KB },
      ]),
    );
    expect(diff.deletes).toEqual(
      expect.arrayContaining([
        { user: "team:ml-ops#member", relation: "reader", object: KB },
        { user: "team:ml-ops#member", relation: "ingestor", object: KB },
      ]),
    );
    // Cleanup also removes stale development-era ingestor tuples from every
    // represented Search audience, including the still-selected team.
    expect(diff.deletes).toContainEqual({
      user: "team:data-eng#member",
      relation: "ingestor",
      object: KB,
    });
  });

  it("adds and revokes direct-user search grants without granting management", () => {
    const diff = buildKnowledgeBaseRelationshipTupleDiff({
      knowledgeBaseId: "kb-1",
      ownerSubject: "owner-sub",
      nextSharedUserSubjects: ["reader-sub", "owner-sub"],
      previousSharedUserSubjects: ["former-reader-sub"],
    });

    expect(diff.writes).toEqual(expect.arrayContaining([
      { user: "user:owner-sub", relation: "owner", object: KB },
      { user: "user:reader-sub", relation: "reader", object: KB },
    ]));
    expect(diff.writes).not.toContainEqual({
      user: "user:reader-sub",
      relation: "manager",
      object: KB,
    });
    expect(diff.writes.filter((tuple) => tuple.user === "user:owner-sub")).toHaveLength(1);
    expect(diff.deletes).toEqual(expect.arrayContaining([
      { user: "user:former-reader-sub", relation: "reader", object: KB },
      { user: "user:former-reader-sub", relation: "ingestor", object: KB },
    ]));
    expect(diff.deletes).toContainEqual({
      user: "user:reader-sub",
      relation: "ingestor",
      object: KB,
    });
  });

  it("can explicitly remove manager tuples left by the legacy search-sharing policy", () => {
    const diff = buildKnowledgeBaseRelationshipTupleDiff({
      knowledgeBaseId: "kb-1",
      previousSharedTeamSlugs: ["data-eng"],
      nextSharedTeamSlugs: ["data-eng"],
      previousSharedTeamAdminsManage: true,
    });
    expect(diff.deletes).toContainEqual({
      user: "team:data-eng#admin",
      relation: "manager",
      object: KB,
    });
  });

  it("dedupes when the owner team is also listed in the shared array", () => {
    const diff = buildKnowledgeBaseRelationshipTupleDiff({
      knowledgeBaseId: "kb-1",
      ownerTeamSlug: "platform",
      nextSharedTeamSlugs: ["platform", "data-eng"],
    });
    const ownerWrites = diff.writes.filter(
      (tuple) =>
        tuple.object === KB &&
        (tuple.user === "team:platform#member" || tuple.user === "team:platform#admin"),
    );
    expect(ownerWrites).toHaveLength(2);
    expect(diff.deletes).toContainEqual({
      user: "team:platform#member",
      relation: "ingestor",
      object: KB,
    });
  });

  it("treats removed owner team as a delete when previousOwnerTeamSlug supplied", () => {
    const diff = buildKnowledgeBaseRelationshipTupleDiff({
      knowledgeBaseId: "kb-1",
      ownerTeamSlug: "data-eng",
      previousOwnerTeamSlug: "platform",
    });
    expect(diff.writes).toEqual(
      expect.arrayContaining([
        { user: "team:data-eng#member", relation: "reader", object: KB },
        { user: "team:data-eng#admin", relation: "manager", object: KB },
      ]),
    );
    expect(diff.deletes).toEqual(
      expect.arrayContaining([
        { user: "team:platform#member", relation: "reader", object: KB },
        { user: "team:platform#admin", relation: "manager", object: KB },
      ]),
    );
    expect(diff.deletes).toEqual(expect.arrayContaining([
      { user: "team:data-eng#member", relation: "ingestor", object: KB },
      { user: "team:platform#member", relation: "ingestor", object: KB },
    ]));
  });

  it("silently drops invalid slugs in next/previous shared lists", () => {
    const diff = buildKnowledgeBaseRelationshipTupleDiff({
      knowledgeBaseId: "kb-1",
      ownerTeamSlug: "platform",
      nextSharedTeamSlugs: ["good-team", "", "x".repeat(300), "   "],
      previousSharedTeamSlugs: ["bad team"],
    });
    expect(diff.writes).toEqual(
      expect.arrayContaining([
        { user: "team:good-team#member", relation: "reader", object: KB },
      ]),
    );
    expect(diff.deletes).toEqual(expect.arrayContaining([
      { user: "team:platform#member", relation: "ingestor", object: KB },
      { user: "team:good-team#member", relation: "ingestor", object: KB },
    ]));
  });

  it("idempotent across repeated reconcile calls with the same input", () => {
    const input = {
      knowledgeBaseId: "kb-1",
      ownerTeamSlug: "platform",
      nextSharedTeamSlugs: ["data-eng"],
      previousSharedTeamSlugs: ["data-eng"],
    };
    const a = buildKnowledgeBaseRelationshipTupleDiff(input);
    const b = buildKnowledgeBaseRelationshipTupleDiff(input);
    expect(a).toEqual(b);
    expect(a.deletes).toEqual(expect.arrayContaining([
      { user: "team:platform#member", relation: "ingestor", object: KB },
      { user: "team:data-eng#member", relation: "ingestor", object: KB },
    ]));
  });
});

describe("data_source inheritance (parent_kb) replaces the PR #1703 mirror", () => {
  const DS = "data_source:kb-1";

  it("writes ONLY the parent_kb edge for a datasource — no per-team data_source grants", () => {
    // Post-spec-2026-06-03 (US4): team grants live on knowledge_base:<id>
    // and the data_source inherits them via `parent_kb`. The datasource
    // reconcile therefore writes a single inheritance edge and NO mirrored
    // per-team reader/ingestor/manager tuples.
    const diff = buildDataSourceRelationshipTupleDiff({
      dataSourceId: "kb-1",
      parentKnowledgeBaseId: "kb-1",
    });
    expect(diff.writes).toEqual([
      { user: "knowledge_base:kb-1", relation: "parent_kb", object: DS },
    ]);
    // No team:*#member reader / team:*#admin manager tuples are mirrored.
    expect(
      diff.writes.some((t) => t.user.startsWith("team:") && t.object === DS),
    ).toBe(false);
    expect(diff.deletes).toEqual([]);
  });

  it("does not delete the parent_kb edge when a share set changes", () => {
    const diff = buildDataSourceRelationshipTupleDiff({
      dataSourceId: "kb-1",
      parentKnowledgeBaseId: "kb-1",
      previousSharedTeamSlugs: ["legacy"],
      nextSharedTeamSlugs: [],
    });
    expect(diff.deletes.some((t) => t.relation === "parent_kb")).toBe(false);
  });
});
