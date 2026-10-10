/**
 * Tests for `buildIngestionSourceRelationshipTupleDiff` (spec
 * 2026-07-21-rag-source-config-db, US5's `visibility: "global"` grant).
 *
 * `Check(user:*, can_read, ingestion_source:X)` is satisfied by the
 * `user:* reader` tuple this builder writes when `globalUserAccess` is
 * true — OpenFGA itself isn't exercised here (no server in unit tests),
 * so this asserts the tuple diff the reconcile layer feeds it.
 */

import { buildIngestionSourceRelationshipTupleDiff } from "@/lib/rbac/openfga-owned-resources";

describe("buildIngestionSourceRelationshipTupleDiff", () => {
  const SOURCE = "ingestion_source:slack-channel-C1";

  it("writes a user:* reader tuple when globalUserAccess is true", () => {
    const diff = buildIngestionSourceRelationshipTupleDiff({
      sourceId: "slack-channel-C1",
      ownerTeamSlug: "platform",
      globalUserAccess: true,
    });

    expect(diff.writes).toEqual(
      expect.arrayContaining([{ user: "user:*", relation: "reader", object: SOURCE }]),
    );
  });

  it("does not write a user:* reader tuple for team-scoped visibility", () => {
    const diff = buildIngestionSourceRelationshipTupleDiff({
      sourceId: "slack-channel-C1",
      ownerTeamSlug: "platform",
      globalUserAccess: false,
    });

    expect(diff.writes).not.toEqual(
      expect.arrayContaining([{ user: "user:*", relation: "reader", object: SOURCE }]),
    );
  });

  it("revokes the user:* reader tuple when visibility flips from global to team", () => {
    const diff = buildIngestionSourceRelationshipTupleDiff({
      sourceId: "slack-channel-C1",
      ownerTeamSlug: "platform",
      globalUserAccess: false,
      previousGlobalUserAccess: true,
    });

    expect(diff.deletes).toEqual(
      expect.arrayContaining([{ user: "user:*", relation: "reader", object: SOURCE }]),
    );
  });

  it("still grants the owner team its reader/ingestor/manager set alongside a global grant", () => {
    const diff = buildIngestionSourceRelationshipTupleDiff({
      sourceId: "slack-channel-C1",
      ownerTeamSlug: "platform",
      globalUserAccess: true,
    });

    expect(diff.writes).toEqual(
      expect.arrayContaining([
        { user: "team:platform#member", relation: "reader", object: SOURCE },
        { user: "team:platform#member", relation: "manager", object: SOURCE },
        { user: "user:*", relation: "reader", object: SOURCE },
      ]),
    );
  });
});
