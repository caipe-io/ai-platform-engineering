/**
 * Tests for the canonical team-membership reader helpers.
 *
 * Mocks `getRbacCollection` to return a `team_membership_sources`
 * collection driven by an in-memory array. This keeps tests fast and
 * isolates them from MongoDB topology decisions (the helpers only
 * issue `find` and `aggregate` calls; we mirror that minimally).
 */

import type { TeamMembershipSource } from "@/types/identity-group-sync";

const fixtureRows: TeamMembershipSource[] = [];

function findMatcher(filter: Record<string, unknown>) {
  return (row: TeamMembershipSource): boolean => {
    for (const [key, value] of Object.entries(filter)) {
      if (key === "$or") {
        const clauses = value as Record<string, unknown>[];
        const anyMatch = clauses.some((clause) => findMatcher(clause)(row));
        if (!anyMatch) return false;
        continue;
      }
      const rowValue = key.split(".").reduce<unknown>((value, part) =>
        (value as Record<string, unknown> | undefined)?.[part], row);
      if (value && typeof value === "object" && "$ne" in value) {
        if ((rowValue ?? null) === (value as { $ne: unknown }).$ne) return false;
        continue;
      }
      if (
        typeof value === "object" &&
        value !== null &&
        "$in" in (value as Record<string, unknown>)
      ) {
        const inValues = (value as { $in: unknown[] }).$in;
        if (!inValues.includes(rowValue)) return false;
        continue;
      }
      if (
        typeof value === "object" &&
        value !== null &&
        "$regex" in (value as Record<string, unknown>)
      ) {
        const { $regex, $options } = value as { $regex: string; $options?: string };
        const re = new RegExp($regex, $options);
        if (typeof rowValue !== "string" || !re.test(rowValue)) return false;
        continue;
      }
      if (rowValue !== value) return false;
    }
    return true;
  };
}

function findStub(filter: Record<string, unknown>) {
  const matcher = findMatcher(filter);
  const matched = fixtureRows.filter(matcher);
  return {
    toArray: async () => matched,
  };
}

type Document = Record<string, unknown>;

// Evaluate the emitted expressions so tests exercise the database grouping key.
function expression(value: unknown, row: Document): unknown {
  if (typeof value === "string" && value.startsWith("$")) {
    return value.slice(1).split(".").reduce<unknown>((entry, key) =>
      (entry as Document | undefined)?.[key], row);
  }
  if (!value || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((entry) => expression(entry, row));
  const object = value as Document;
  const args = (operator: string) => (object[operator] as unknown[]).map((entry) => expression(entry, row));
  if ("$ifNull" in object) { const values = args("$ifNull"); return values[0] ?? values[1]; }
  if ("$toLower" in object) return String(expression(object.$toLower, row) ?? "").toLowerCase();
  if ("$trim" in object) return String(expression((object.$trim as Document).input, row) ?? "").trim();
  if ("$concat" in object) return args("$concat").join("");
  if ("$cond" in object) { const [test, yes, no] = object.$cond as unknown[]; return expression(expression(test, row) ? yes : no, row); }
  if ("$eq" in object) { const [a, b] = args("$eq"); return a === b; }
  if ("$ne" in object) { const [a, b] = args("$ne"); return a !== b; }
  return Object.fromEntries(Object.entries(object).map(([key, entry]) => [key, expression(entry, row)]));
}

function aggregateStub(pipeline: Record<string, unknown>[]) {
  let rows: Document[] = fixtureRows.map((row) => ({ ...row }));
  for (const stage of pipeline) {
    if (stage.$match) rows = rows.filter((row) => findMatcher(stage.$match as Document)(row as unknown as TeamMembershipSource));
    else if (stage.$group) {
      const group = stage.$group as Document;
      const buckets = new Map<string, Document[]>();
      for (const row of rows) {
        const key = JSON.stringify(expression(group._id, row));
        buckets.set(key, [...(buckets.get(key) ?? []), row]);
      }
      rows = [...buckets.values()].map((bucket) => Object.fromEntries(Object.entries(group).map(([key, accumulator]) => {
        if (key === "_id") return [key, expression(accumulator, bucket[0])];
        const [operator, operand] = Object.entries(accumulator as Document)[0];
        const values = bucket.map((row) => expression(operand, row));
        if (operator === "$first") return [key, values[0]];
        if (operator === "$addToSet") return [key, [...new Map(values.map((v) => [JSON.stringify(v), v])).values()]];
        if (operator === "$sum") return [key, values.reduce<number>((sum, v) => sum + Number(v), 0)];
        if (operator === "$max") return [key, Math.max(...values.map(Number))];
        if (operator === "$min") return [key, values.filter((v) => v != null).sort()[0]];
        throw new Error(`Unsupported accumulator ${operator}`);
      })));
    } else if (stage.$addFields) rows = rows.map((row) => ({ ...row, ...expression(stage.$addFields, row) as Document }));
    else if (stage.$sort) rows.sort((a, b) => {
      for (const [key, direction] of Object.entries(stage.$sort as Document)) {
        const comparison = String(a[key] ?? "").localeCompare(String(b[key] ?? ""));
        if (comparison) return comparison * Number(direction);
      }
      return 0;
    });
    else if (stage.$skip !== undefined) rows = rows.slice(Number(stage.$skip));
    else if (stage.$limit !== undefined) rows = rows.slice(0, Number(stage.$limit));
    else if (stage.$count) rows = rows.length ? [{ [String(stage.$count)]: rows.length }] : [];
    else throw new Error(`Unsupported stage ${Object.keys(stage)[0]}`);
  }
  return { toArray: async () => rows };
}

const collectionStub = {
  find: jest.fn((filter: Record<string, unknown>) => findStub(filter)),
  aggregate: jest.fn((pipeline: Record<string, unknown>[]) => aggregateStub(pipeline)),
};

jest.mock("../mongo-collections", () => ({
  getRbacCollection: jest.fn(async () => collectionStub),
}));

import {
  countActiveTeamMembers,
  findUserRoleInTeam,
  isUserInTeam,
  loadActiveTeamMembers,
  loadActiveTeamMembersPage,
  loadTeamMemberCounts,
  loadTeamMembersForSlugs,
} from "../team-membership-store";

function row(overrides: Partial<TeamMembershipSource> = {}): TeamMembershipSource {
  return {
    team_id: "tid-1",
    team_slug: "platform",
    user_subject: "kc-sub-001",
    user_email: "alice@example.com",
    relationship: "member",
    source_type: "manual",
    managed: false,
    status: "active",
    created_at: "2026-05-22T00:00:00.000Z",
    ...overrides,
  };
}

beforeEach(() => {
  fixtureRows.length = 0;
  collectionStub.find.mockClear();
  collectionStub.aggregate.mockClear();
});

describe("loadActiveTeamMembers", () => {
  it("returns an empty array for a team with no rows", async () => {
    const members = await loadActiveTeamMembers("empty-team");
    expect(members).toEqual([]);
  });

  it("returns one entry per distinct identity", async () => {
    fixtureRows.push(
      row({ user_subject: "kc-A", user_email: "a@example.com" }),
      row({ user_subject: "kc-B", user_email: "b@example.com" }),
    );
    const members = await loadActiveTeamMembers("platform");
    expect(members).toHaveLength(2);
    expect(members.map((m) => m.identity_key).sort()).toEqual(["kc-A", "kc-B"]);
  });

  it("dedupes two source rows for the same identity (different providers)", async () => {
    fixtureRows.push(
      row({ source_type: "okta", provider_id: "okta-prod" }),
      row({ source_type: "manual", provider_id: undefined }),
    );
    const members = await loadActiveTeamMembers("platform");
    expect(members).toHaveLength(1);
    expect(members[0].identity_key).toBe("kc-sub-001");
    expect(members[0].source_types.sort()).toEqual(["manual", "okta"]);
    expect(members[0].provider_ids).toEqual(["okta-prod"]);
  });

  it("escalates role to admin when any active row is admin", async () => {
    fixtureRows.push(
      row({ source_type: "manual", relationship: "member" }),
      row({ source_type: "okta", relationship: "admin", provider_id: "okta-prod" }),
    );
    const members = await loadActiveTeamMembers("platform");
    expect(members).toHaveLength(1);
    expect(members[0].role).toBe("admin");
  });

  it("excludes rows with status != active by default", async () => {
    fixtureRows.push(
      row({ user_subject: "kc-A", status: "active" }),
      row({ user_subject: "kc-B", status: "removed" }),
      row({ user_subject: "kc-C", status: "stale" }),
    );
    const members = await loadActiveTeamMembers("platform");
    expect(members).toHaveLength(1);
    expect(members[0].identity_key).toBe("kc-A");
  });

  it("includes non-active rows when includeRemoved=true (audit view)", async () => {
    fixtureRows.push(
      row({ user_subject: "kc-A", status: "active" }),
      row({ user_subject: "kc-B", status: "removed" }),
    );
    const members = await loadActiveTeamMembers("platform", { includeRemoved: true });
    expect(members).toHaveLength(2);
  });

  it("includes a row with user_subject but no user_email", async () => {
    fixtureRows.push(row({ user_subject: "kc-no-email", user_email: undefined }));
    const members = await loadActiveTeamMembers("platform");
    expect(members).toHaveLength(1);
    expect(members[0].identity_key).toBe("kc-no-email");
    expect(members[0].user_email).toBeUndefined();
  });

  it("skips rows that have neither user_subject nor user_email", async () => {
    fixtureRows.push(
      row({ user_subject: undefined, user_email: undefined }),
      row({ user_subject: "kc-A", user_email: "a@example.com" }),
    );
    const members = await loadActiveTeamMembers("platform");
    expect(members).toHaveLength(1);
    expect(members[0].identity_key).toBe("kc-A");
  });

  it("returns empty for invalid teamSlug input", async () => {
    expect(await loadActiveTeamMembers("")).toEqual([]);
    expect(await loadActiveTeamMembers(null as unknown as string)).toEqual([]);
  });

  it("sorts members deterministically by identity_key", async () => {
    fixtureRows.push(
      row({ user_subject: "kc-zebra", user_email: "z@example.com" }),
      row({ user_subject: "kc-alpha", user_email: "a@example.com" }),
      row({ user_subject: "kc-mango", user_email: "m@example.com" }),
    );
    const members = await loadActiveTeamMembers("platform");
    expect(members.map((m) => m.identity_key)).toEqual(["kc-alpha", "kc-mango", "kc-zebra"]);
  });
});

describe("loadTeamMemberCounts", () => {
  it("returns zero entries for an empty input", async () => {
    const counts = await loadTeamMemberCounts([]);
    expect(counts.size).toBe(0);
  });

  it("returns one entry per requested slug, including zero-count slugs", async () => {
    fixtureRows.push(row({ team_slug: "alpha", user_subject: "kc-A" }));
    const counts = await loadTeamMemberCounts(["alpha", "beta"]);
    expect(counts.get("alpha")).toBe(1);
    expect(counts.get("beta")).toBe(0);
  });

  it("dedupes by identity_key within a single team", async () => {
    fixtureRows.push(
      row({ team_slug: "alpha", user_subject: "kc-A", source_type: "manual" }),
      row({ team_slug: "alpha", user_subject: "kc-A", source_type: "okta", provider_id: "okta-prod" }),
      row({ team_slug: "alpha", user_subject: "kc-B", user_email: "secondary@example.com" }),
    );
    const counts = await loadTeamMemberCounts(["alpha"]);
    expect(counts.get("alpha")).toBe(2);
  });

  it("falls back to lowercased email when user_subject is absent", async () => {
    fixtureRows.push(
      row({ team_slug: "alpha", user_subject: undefined, user_email: "Foo@Example.com" }),
      row({ team_slug: "alpha", user_subject: undefined, user_email: "foo@example.com" }),
    );
    const counts = await loadTeamMemberCounts(["alpha"]);
    expect(counts.get("alpha")).toBe(1);
  });

  it("excludes non-active rows by default", async () => {
    fixtureRows.push(
      row({ team_slug: "alpha", user_subject: "kc-A", status: "active" }),
      row({ team_slug: "alpha", user_subject: "kc-B", status: "removed" }),
    );
    const counts = await loadTeamMemberCounts(["alpha"]);
    expect(counts.get("alpha")).toBe(1);
  });
});

describe("loadTeamMembersForSlugs", () => {
  it("returns empty arrays for an empty input", async () => {
    const map = await loadTeamMembersForSlugs([]);
    expect(map.size).toBe(0);
  });

  it("returns one entry per requested slug, including zero-member slugs", async () => {
    fixtureRows.push(row({ team_slug: "alpha", user_subject: "kc-A" }));
    const map = await loadTeamMembersForSlugs(["alpha", "beta"]);
    expect(map.get("alpha")).toHaveLength(1);
    expect(map.get("beta")).toEqual([]);
  });

  it("dedupes within each team independently", async () => {
    fixtureRows.push(
      row({ team_slug: "alpha", user_subject: "kc-A", source_type: "manual" }),
      row({ team_slug: "alpha", user_subject: "kc-A", source_type: "okta", provider_id: "okta-prod" }),
      row({ team_slug: "beta", user_subject: "kc-A" }),
    );
    const map = await loadTeamMembersForSlugs(["alpha", "beta"]);
    expect(map.get("alpha")).toHaveLength(1);
    expect(map.get("alpha")![0].source_types.sort()).toEqual(["manual", "okta"]);
    expect(map.get("beta")).toHaveLength(1);
  });

  it("excludes non-active rows by default", async () => {
    fixtureRows.push(
      row({ team_slug: "alpha", user_subject: "kc-A", status: "active" }),
      row({ team_slug: "alpha", user_subject: "kc-B", status: "removed" }),
    );
    const map = await loadTeamMembersForSlugs(["alpha"]);
    expect(map.get("alpha")).toHaveLength(1);
  });
});

describe("countActiveTeamMembers", () => {
  it("returns 0 for empty/invalid input", async () => {
    expect(await countActiveTeamMembers("")).toBe(0);
  });

  it("returns the same count as loadTeamMemberCounts", async () => {
    fixtureRows.push(
      row({ team_slug: "alpha", user_subject: "kc-A" }),
      row({ team_slug: "alpha", user_subject: "kc-B", user_email: "secondary@example.com" }),
      row({ team_slug: "beta", user_subject: "kc-A" }),
    );
    expect(await countActiveTeamMembers("alpha")).toBe(2);
    expect(await countActiveTeamMembers("beta")).toBe(1);
  });
});

describe("member display across identity providers", () => {
  beforeEach(() => {
    fixtureRows.push(
      row({ user_subject: "oidc-subject", user_email: " Test-User@Example.com ", source_type: "oidc_claim", provider_id: "primary", first_seen_at: "2026-06-05T00:00:00Z" }),
      row({ user_subject: "directory-subject", user_email: "test-user@example.com", source_type: "okta", provider_id: "secondary", relationship: "admin", first_seen_at: "2026-06-17T00:00:00Z" }),
      row({ user_subject: "removed-subject", user_email: "test-user@example.com", source_type: "manual", status: "removed" }),
      row({ user_subject: "other-subject", user_email: "other@example.com" }),
    );
  });

  it("shows one person with both active sources, original subjects, and earliest date", async () => {
    const { members, total } = await loadActiveTeamMembersPage("platform");
    expect(total).toBe(2);
    const member = members.find((entry) => entry.user_email === "test-user@example.com")!;
    expect(member).toMatchObject({ role: "admin", idp_managed: true, added_at: "2026-06-05T00:00:00Z" });
    expect(member.user_subject).toBeUndefined();
    expect(member.source_types).toEqual(expect.arrayContaining(["oidc_claim", "okta"]));
    expect(member.source_memberships).toHaveLength(2);
    expect(member.source_memberships).toEqual(expect.arrayContaining([
      { user_subject: "oidc-subject", relationship: "member", source_type: "oidc_claim", provider_id: "primary" },
      { user_subject: "directory-subject", relationship: "admin", source_type: "okta", provider_id: "secondary" },
    ]));
    expect((await loadTeamMemberCounts(["platform"])).get("platform")).toBe(total);
    expect(fixtureRows).toHaveLength(4);
  });

  it("paginates people rather than splitting membership sources across pages", async () => {
    const first = await loadActiveTeamMembersPage("platform", { pageSize: 1, ownerEmail: "test-user@example.com" });
    const second = await loadActiveTeamMembersPage("platform", { pageSize: 1, page: 2, ownerEmail: "test-user@example.com" });
    expect(first.members[0]).toMatchObject({ user_email: "test-user@example.com", role: "owner" });
    expect(first.members[0].source_memberships).toHaveLength(2);
    expect(second.members[0].user_email).toBe("other@example.com");
    expect(first.total).toBe(2);
  });

  it("keeps authorization roles scoped to their original subject", async () => {
    expect(await findUserRoleInTeam("platform", { user_subject: "oidc-subject" })).toBe("member");
    expect(await findUserRoleInTeam("platform", { user_subject: "directory-subject" })).toBe("admin");
    expect(await findUserRoleInTeam("platform", { user_subject: "removed-subject" })).toBeNull();
  });

  it("drops revoked source roles and provenance from the display without removing other sources", async () => {
    fixtureRows[1].status = "removed";
    const page = await loadActiveTeamMembersPage("platform");
    const member = page.members.find((entry) => entry.user_email === "test-user@example.com")!;
    expect(member).toMatchObject({ role: "member", user_subject: "oidc-subject", source_types: ["oidc_claim"] });
    expect(member.source_memberships).toHaveLength(1);
    expect(await findUserRoleInTeam("platform", { user_subject: "directory-subject" })).toBeNull();
  });

  it("keeps subjects without an email separate and drops unattributed rows", async () => {
    fixtureRows.splice(0, fixtureRows.length,
      row({ user_subject: "primary-subject", user_email: undefined }),
      row({ user_subject: "secondary-subject", user_email: " " }),
      row({ user_subject: undefined, user_email: undefined }),
    );
    const page = await loadActiveTeamMembersPage("platform");
    expect(page.total).toBe(2);
    expect(page.members.map((entry) => entry.user_subject)).toEqual(["primary-subject", "secondary-subject"]);
  });
});

describe("findUserRoleInTeam", () => {
  it("returns null for non-members", async () => {
    fixtureRows.push(row({ team_slug: "platform", user_subject: "kc-A" }));
    const role = await findUserRoleInTeam("platform", { user_subject: "kc-Z" });
    expect(role).toBeNull();
  });

  it("matches by user_subject", async () => {
    fixtureRows.push(row({ team_slug: "platform", user_subject: "kc-A", relationship: "member" }));
    expect(await findUserRoleInTeam("platform", { user_subject: "kc-A" })).toBe("member");
  });

  it("matches by user_email (case-insensitive — stored as lowercase)", async () => {
    fixtureRows.push(
      row({ team_slug: "platform", user_subject: undefined, user_email: "alice@example.com" }),
    );
    expect(await findUserRoleInTeam("platform", { user_email: "Alice@Example.com" })).toBe("member");
  });

  it("escalates to admin when one of multiple rows is admin", async () => {
    fixtureRows.push(
      row({ team_slug: "platform", user_subject: "kc-A", relationship: "member", source_type: "manual" }),
      row({ team_slug: "platform", user_subject: "kc-A", relationship: "admin", source_type: "okta", provider_id: "okta-prod" }),
    );
    expect(await findUserRoleInTeam("platform", { user_subject: "kc-A" })).toBe("admin");
  });

  it("returns null when no identity is supplied", async () => {
    fixtureRows.push(row({ team_slug: "platform", user_subject: "kc-A" }));
    expect(await findUserRoleInTeam("platform", {})).toBeNull();
  });

  it("returns null for invalid teamSlug", async () => {
    fixtureRows.push(row({ team_slug: "platform", user_subject: "kc-A" }));
    expect(await findUserRoleInTeam("", { user_subject: "kc-A" })).toBeNull();
  });

  it("excludes removed rows by default", async () => {
    fixtureRows.push(
      row({ team_slug: "platform", user_subject: "kc-A", status: "removed" }),
    );
    expect(await findUserRoleInTeam("platform", { user_subject: "kc-A" })).toBeNull();
  });
});

describe("isUserInTeam", () => {
  it("returns true when role is found", async () => {
    fixtureRows.push(row({ team_slug: "platform", user_subject: "kc-A" }));
    expect(await isUserInTeam("platform", { user_subject: "kc-A" })).toBe(true);
  });

  it("returns false otherwise", async () => {
    expect(await isUserInTeam("platform", { user_subject: "kc-Z" })).toBe(false);
  });
});

describe("loadActiveTeamMembersPage — DocumentDB compatibility", () => {
  // Amazon DocumentDB (our deploy target) does NOT support the $facet
  // aggregation stage; using it fails at runtime with
  // "Aggregation stage not supported: '$facet'". The page+count must be
  // computed as two pipelines sharing a prefix instead. These tests pin that.
  it("issues two aggregations (count + page) and never uses $facet", async () => {
    await loadActiveTeamMembersPage("platform", { page: 2, pageSize: 10 });

    // Two separate aggregate calls — one to count, one to fetch the page.
    expect(collectionStub.aggregate).toHaveBeenCalledTimes(2);

    const pipelines = collectionStub.aggregate.mock.calls.map((call) => call[0]);
    for (const pipeline of pipelines) {
      expect(pipeline.find((s: Record<string, unknown>) => "$facet" in s)).toBeUndefined();
    }

    // Exactly one pipeline counts; exactly one pages with $skip/$limit.
    const countPipeline = pipelines.find((p) =>
      p.some((s: Record<string, unknown>) => "$count" in s),
    );
    const pagePipeline = pipelines.find((p) =>
      p.some((s: Record<string, unknown>) => "$limit" in s),
    );
    expect(countPipeline).toBeDefined();
    expect(pagePipeline).toBeDefined();

    const skipStage = pagePipeline!.find((s: Record<string, unknown>) => "$skip" in s);
    const limitStage = pagePipeline!.find((s: Record<string, unknown>) => "$limit" in s);
    expect(skipStage.$skip).toBe(10); // (page 2 - 1) * pageSize 10
    expect(limitStage.$limit).toBe(10);
  });

  it("clamps page_size to [1,100] before building the $limit stage", async () => {
    await loadActiveTeamMembersPage("platform", { page: 1, pageSize: 9999 });
    const pipelines = collectionStub.aggregate.mock.calls.map((call) => call[0]);
    const pagePipeline = pipelines.find((p) =>
      p.some((s: Record<string, unknown>) => "$limit" in s),
    );
    const limitStage = pagePipeline!.find((s: Record<string, unknown>) => "$limit" in s);
    expect(limitStage.$limit).toBe(100);
  });
});

describe("loadActiveTeamMembersPage — search $match construction", () => {
  // Search clauses are checked directly to cover regex escaping and directory matches.
  function matchStageOf(pipelines: Record<string, unknown>[][]) {
    return (pipelines[0][0] as { $match: Record<string, unknown> }).$match;
  }

  it("matches by an email substring via a case-insensitive $regex", async () => {
    await loadActiveTeamMembersPage("platform", { search: "alice" });
    const pipelines = collectionStub.aggregate.mock.calls.map((call) => call[0]);
    expect(matchStageOf(pipelines).user_email).toEqual({ $regex: "alice", $options: "i" });
  });

  // Members are stored with only an email, no name — a search by name has
  // to be resolved by the caller (a directory lookup) into
  // `searchMatchedEmails`, which this OR's in alongside the plain email
  // substring match.
  it("OR's the email substring match with searchMatchedEmails from a resolved name search", async () => {
    await loadActiveTeamMembersPage("platform", {
      search: "ali",
      searchMatchedEmails: ["bob@example.com", "carol@example.com"],
    });
    const pipelines = collectionStub.aggregate.mock.calls.map((call) => call[0]);
    expect(matchStageOf(pipelines).$or).toEqual([
      { user_email: { $regex: "ali", $options: "i" } },
      { user_email: { $regex: "^bob@example\\.com$", $options: "i" } },
      { user_email: { $regex: "^carol@example\\.com$", $options: "i" } },
    ]);
  });

  it("skips empty/falsy entries in searchMatchedEmails", async () => {
    await loadActiveTeamMembersPage("platform", {
      search: "",
      searchMatchedEmails: ["", "dan@example.com"],
    });
    const pipelines = collectionStub.aggregate.mock.calls.map((call) => call[0]);
    // Only one real clause survives, so it's assigned directly (no $or).
    expect(matchStageOf(pipelines).user_email).toEqual({
      $regex: "^dan@example\\.com$",
      $options: "i",
    });
    expect(matchStageOf(pipelines).$or).toBeUndefined();
  });

  it("adds no search filter at all when both search and searchMatchedEmails are empty", async () => {
    await loadActiveTeamMembersPage("platform", {});
    const pipelines = collectionStub.aggregate.mock.calls.map((call) => call[0]);
    expect(matchStageOf(pipelines).user_email).toBeUndefined();
    expect(matchStageOf(pipelines).$or).toBeUndefined();
  });
});

describe("regression: legacy teams.members[] is never consulted", () => {
  // The whole point of this module is to be the canonical reader.
  // The mock collection only ever returns rows from `team_membership_sources`.
  // If the implementation tried to read `team.members[]`, these tests would
  // simply not see those values and would fail.
  it("returns 0 for a team that exists in `teams` collection but has no source rows", async () => {
    expect(await countActiveTeamMembers("ghost-team")).toBe(0);
    expect(await loadActiveTeamMembers("ghost-team")).toEqual([]);
    expect(await findUserRoleInTeam("ghost-team", { user_subject: "kc-A" })).toBeNull();
  });
});
