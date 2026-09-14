// assisted-by Claude Claude-opus-4-7
//
// Unit tests for the pure planning function in
// scripts/migrate-canonical-team-membership.ts. We don't spin up a
// real Mongo for this — the migration's main I/O glue
// (`applyMigration`/`fetchExistingSources`) is exercised manually
// See docs/docs/security/rbac/canonical-team-membership-migration.md.
// because it's three lines of straight collection calls. The
// non-trivial logic (dedupe against existing canonical rows, role
// normalization, slug handling) lives in
// `planCanonicalTeamMembershipMigration` and is fully covered here.
//
// Run: npx ts-node --compiler-options '{"module":"CommonJS"}' \
//   scripts/__tests__/migrate-canonical-team-membership.test.ts

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  planCanonicalTeamMembershipMigration,
  normalizeRelationship,
  MIGRATION_ACTOR,
} = require("../migrate-canonical-team-membership.ts");

const NOW = "2026-05-26T12:00:00.000Z";

test("normalizeRelationship: owner collapses to admin", () => {
  assert.equal(normalizeRelationship("owner"), "admin");
  assert.equal(normalizeRelationship("admin"), "admin");
  assert.equal(normalizeRelationship("OWNER"), "admin");
  assert.equal(normalizeRelationship("member"), "member");
  assert.equal(normalizeRelationship("MEMBER"), "member");
  assert.equal(normalizeRelationship("guest"), null);
  assert.equal(normalizeRelationship(undefined), null);
  assert.equal(normalizeRelationship(42), null);
});

test("plan backfills every legacy member missing from canonical store", () => {
  const plan = planCanonicalTeamMembershipMigration({
    teams: [
      {
        _id: "team-1",
        slug: "platform",
        members: [
          { user_id: "alice@example.com", role: "owner" },
          { user_id: "bob@example.com", role: "member" },
        ],
      },
    ],
    existingSources: new Set(),
    now: NOW,
  });

  assert.equal(plan.teamsScanned, 1);
  assert.equal(plan.teamsWithLegacyMembers, 1);
  assert.equal(plan.rowsToBackfill.length, 2);
  assert.deepEqual(plan.teamsToUnset, ["team-1"]);
  assert.equal(plan.skipped.length, 0);
  assert.equal(plan.warnings.length, 0);

  const byEmail = Object.fromEntries(
    plan.rowsToBackfill.map(
      (r: { user_email: string; relationship: string }) => [r.user_email, r.relationship],
    ),
  );
  // owner → admin, member → member
  assert.equal(byEmail["alice@example.com"], "admin");
  assert.equal(byEmail["bob@example.com"], "member");

  const aliceRow = plan.rowsToBackfill.find(
    (r: { user_email: string }) => r.user_email === "alice@example.com",
  );
  assert.equal(aliceRow.team_slug, "platform");
  assert.equal(aliceRow.source_type, "manual");
  assert.equal(aliceRow.status, "active");
  assert.equal(aliceRow.created_by, MIGRATION_ACTOR);
  assert.equal(aliceRow.created_at, NOW);
});

test("plan skips members already present in canonical store (idempotency)", () => {
  const plan = planCanonicalTeamMembershipMigration({
    teams: [
      {
        _id: "team-1",
        slug: "platform",
        members: [
          { user_id: "alice@example.com", role: "owner" },
          { user_id: "bob@example.com", role: "member" },
        ],
      },
    ],
    // Alice is already canonical; Bob is not.
    existingSources: new Set(["platform:alice@example.com"]),
    now: NOW,
  });

  assert.equal(plan.rowsToBackfill.length, 1);
  assert.equal(plan.rowsToBackfill[0].user_email, "bob@example.com");
  // The team is still scheduled for $unset — once we strip the
  // embedded array the canonical store is authoritative regardless of
  // whether this run had to backfill any rows for it.
  assert.deepEqual(plan.teamsToUnset, ["team-1"]);
});

test("plan deduplicates emails case-insensitively against existing sources", () => {
  const plan = planCanonicalTeamMembershipMigration({
    teams: [
      {
        _id: "team-1",
        slug: "platform",
        // legacy embedded array uses mixed case
        members: [{ user_id: "Alice@Example.com", role: "owner" }],
      },
    ],
    // canonical key is always lowercase
    existingSources: new Set(["platform:alice@example.com"]),
    now: NOW,
  });

  assert.equal(plan.rowsToBackfill.length, 0);
  assert.deepEqual(plan.teamsToUnset, ["team-1"]);
});

test("plan unsets defunct members: [] but doesn't count them as legacy", () => {
  const plan = planCanonicalTeamMembershipMigration({
    teams: [
      // A team with no members field at all — must not appear in the
      // unset list (we only $unset what's actually there).
      { _id: "team-empty", slug: "empty" },
      // A team with an empty members[] — still needs $unset to clean
      // up the field, but doesn't count as "had legacy members".
      { _id: "team-stub", slug: "stub", members: [] },
      // A team with actual legacy data.
      {
        _id: "team-real",
        slug: "real",
        members: [{ user_id: "alice@example.com", role: "member" }],
      },
    ],
    existingSources: new Set(),
    now: NOW,
  });

  assert.equal(plan.teamsScanned, 3);
  assert.equal(plan.teamsWithLegacyMembers, 1);
  assert.deepEqual(plan.teamsToUnset.sort(), ["team-real", "team-stub"]);
});

test("plan skips teams without slug (warns, does not crash)", () => {
  const plan = planCanonicalTeamMembershipMigration({
    teams: [
      {
        _id: "team-bad",
        // no slug field
        members: [{ user_id: "alice@example.com", role: "member" }],
      },
    ],
    existingSources: new Set(),
    now: NOW,
  });

  assert.equal(plan.rowsToBackfill.length, 0);
  assert.equal(plan.skipped.length, 1);
  assert.equal(plan.skipped[0].team_id, "team-bad");
  assert.match(plan.warnings[0], /no slug/);
  // We still want to $unset members on a slugless team so the
  // post-migration state is clean — the field is the field.
  assert.deepEqual(plan.teamsToUnset, ["team-bad"]);
});

test("plan skips members with non-string user_id or unknown role", () => {
  const plan = planCanonicalTeamMembershipMigration({
    teams: [
      {
        _id: "team-1",
        slug: "platform",
        members: [
          { user_id: "alice@example.com", role: "owner" },
          { user_id: null, role: "member" },
          { user_id: "bob@example.com", role: "guest" },
        ],
      },
    ],
    existingSources: new Set(),
    now: NOW,
  });

  assert.equal(plan.rowsToBackfill.length, 1);
  assert.equal(plan.rowsToBackfill[0].user_email, "alice@example.com");
  assert.equal(plan.warnings.length, 2);
  assert.match(plan.warnings.join("\n"), /non-string user_id/);
  assert.match(plan.warnings.join("\n"), /unknown role "guest"/);
});

test("plan is empty for a zero-team database", () => {
  const plan = planCanonicalTeamMembershipMigration({
    teams: [],
    existingSources: new Set(),
    now: NOW,
  });
  assert.equal(plan.teamsScanned, 0);
  assert.equal(plan.rowsToBackfill.length, 0);
  assert.equal(plan.teamsToUnset.length, 0);
  assert.equal(plan.warnings.length, 0);
});
