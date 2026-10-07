/**
 * Cross-cutting authorization decision matrix for `mcp_tool`
 * (spec 2026-06-03-unified-shareable-resource-rbac, US6).
 *
 * This is the mock-only "matrix lock": instead of injecting rows into
 * `tests/rbac/rbac-matrix.yaml` (whose validator only permits
 * `authorization_system: openfga` rows for `object_type: agent` /
 * `relation: can_use`, and whose `--rbac-online` lane has no `mcp_tool` tuple
 * fixtures), we encode the full subject × sharing → action decision table here
 * and evaluate it against:
 *
 *   1. the REAL tuple projection (`buildMcpToolRelationshipTupleDiff`), which
 *      decides which DIRECT relations each subject receives, and
 *   2. the model's permission graph, read from the deployed
 *      `authorization-model.json` and asserted to match the resolver below so
 *      the encoded `can_*` unions can't silently drift.
 *
 * It runs under both `make caipe-ui-tests` and `make test-rbac-jest` (the
 * latter globs `src/lib/rbac/__tests__/`). No live OpenFGA / Mongo / stack.
 * assisted-by Cursor claude-opus-4-8
 */

import { readFileSync } from "fs";
import { join } from "path";

import { buildMcpToolRelationshipTupleDiff } from "@/lib/rbac/openfga-owned-resources";

const TOOL_ID = "custom-search";
const OWNER_TEAM = "platform";
const SHARED_TEAM = "data-eng";

// ---------------------------------------------------------------------------
// 1. The permission graph the resolver encodes — asserted against the chart
//    JSON so a model change that doesn't update this test fails loudly.
// ---------------------------------------------------------------------------

const REPO_ROOT = join(__dirname, "..", "..", "..", "..", "..", "..");
const CHART_JSON = join(
  REPO_ROOT,
  "charts",
  "ai-platform-engineering",
  "charts",
  "openfga",
  "authorization-model.json",
);

interface ChildUserset {
  computedUserset?: { relation?: string };
}

/** computedUserset relations that make up `mcp_tool.<perm>` in the chart JSON. */
function chartUnionMembers(perm: string): string[] {
  const model = JSON.parse(readFileSync(CHART_JSON, "utf8")) as {
    type_definitions: Array<{
      type: string;
      relations?: Record<string, { union?: { child?: ChildUserset[] } }>;
    }>;
  };
  const mcpTool = model.type_definitions.find((t) => t.type === "mcp_tool");
  const def = mcpTool?.relations?.[perm];
  const children = def?.union?.child ?? [];
  return children
    .map((c) => c.computedUserset?.relation)
    .filter((r): r is string => Boolean(r));
}

// ---------------------------------------------------------------------------
// 2. Direct-relation projection from the REAL tuple builder.
// ---------------------------------------------------------------------------

interface Scenario {
  sharedWithOrg?: boolean;
  sharedTeamSlugs?: string[];
}

/** The set of DIRECT relations a subject receives for a sharing scenario. */
function directRelations(subject: string, scenario: Scenario = {}): Set<string> {
  const diff = buildMcpToolRelationshipTupleDiff({
    toolId: TOOL_ID,
    ownerSubject: "alice-sub",
    ownerTeamSlug: OWNER_TEAM,
    nextSharedTeamSlugs: scenario.sharedTeamSlugs ?? [],
    sharedWithOrg: scenario.sharedWithOrg ?? false,
  });
  // `team.member` is `[direct members] or admin` (deploy/openfga/model.fga),
  // so a team-admin subject also satisfies any `#member` tuple written for
  // that same team — mirror that union here instead of a literal string match.
  const relevantUsers = new Set([subject]);
  const adminMatch = /^team:(.+)#admin$/.exec(subject);
  if (adminMatch) {
    relevantUsers.add(`team:${adminMatch[1]}#member`);
  }
  return new Set(
    diff.writes.filter((t) => relevantUsers.has(t.user)).map((t) => t.relation),
  );
}

/** Resolve effective permissions from a subject's direct relations using the
 *  mcp_tool union graph (locked against the chart JSON below). */
function resolve(direct: Set<string>) {
  const owner = direct.has("owner");
  const canManage = direct.has("manager") || owner;
  const canCall = direct.has("caller") || canManage || owner;
  const canUse = direct.has("user") || canCall || canManage || owner;
  const canRead = direct.has("reader") || canUse || canManage || owner;
  return { read: canRead, use: canUse, call: canCall, manage: canManage };
}

// ---------------------------------------------------------------------------
// Lock the resolver's union graph against the deployed model.
// ---------------------------------------------------------------------------

describe("mcp_tool permission graph matches the resolver", () => {
  it("can_call = caller ∪ can_manage ∪ owner", () => {
    expect(chartUnionMembers("can_call").sort()).toEqual(
      ["caller", "can_manage", "owner"].sort(),
    );
  });
  it("can_use = user ∪ can_call ∪ can_manage ∪ owner", () => {
    expect(chartUnionMembers("can_use").sort()).toEqual(
      ["user", "can_call", "can_manage", "owner"].sort(),
    );
  });
  it("can_read = reader ∪ can_use ∪ can_manage ∪ owner", () => {
    expect(chartUnionMembers("can_read").sort()).toEqual(
      ["reader", "can_use", "can_manage", "owner"].sort(),
    );
  });
  it("can_manage = manager ∪ owner", () => {
    expect(chartUnionMembers("can_manage").sort()).toEqual(
      ["manager", "owner"].sort(),
    );
  });
});

// ---------------------------------------------------------------------------
// 3. The decision matrix.
// ---------------------------------------------------------------------------

type Action = "use" | "call" | "manage";

interface MatrixCase {
  name: string;
  subject: string;
  scenario?: Scenario;
  allow: Action[];
  deny: Action[];
}

const MATRIX: MatrixCase[] = [
  {
    name: "owner-team member can manage (and therefore use+call)",
    subject: `team:${OWNER_TEAM}#member`,
    allow: ["use", "call", "manage"],
    deny: [],
  },
  {
    name: "owner-team admin can manage (and therefore use+call)",
    subject: `team:${OWNER_TEAM}#admin`,
    allow: ["use", "call", "manage"],
    deny: [],
  },
  {
    name: "shared-team member can use+call via the caller grant, not manage",
    subject: `team:${SHARED_TEAM}#member`,
    scenario: { sharedTeamSlugs: [SHARED_TEAM] },
    allow: ["use", "call"],
    deny: ["manage"],
  },
  {
    name: "org member can use+call when shared_with_org",
    subject: "organization:caipe#member",
    scenario: { sharedWithOrg: true },
    allow: ["use", "call"],
    deny: ["manage"],
  },
  {
    name: "org member is denied everything when NOT shared_with_org",
    subject: "organization:caipe#member",
    scenario: { sharedWithOrg: false },
    allow: [],
    deny: ["use", "call", "manage"],
  },
  {
    name: "personal owner subject can do everything",
    subject: "user:alice-sub",
    allow: ["use", "call", "manage"],
    deny: [],
  },
  {
    name: "an unrelated user is denied everything",
    subject: "user:mallory-sub",
    allow: [],
    deny: ["use", "call", "manage"],
  },
];

describe("mcp_tool authorization decision matrix", () => {
  for (const c of MATRIX) {
    it(c.name, () => {
      const perms = resolve(directRelations(c.subject, c.scenario));
      for (const action of c.allow) {
        expect(perms[action]).toBe(true);
      }
      for (const action of c.deny) {
        expect(perms[action]).toBe(false);
      }
    });
  }
});

// ---------------------------------------------------------------------------
// 4. super-admins → org-admin → can_manage any mcp_tool.
//
// The `team:super-admins#admin → organization:caipe#admin` link is covered by
// super-admins-org-admin-link.test.ts. Here we lock the second half: the model
// lets `organization#admin` be an mcp_tool `manager`, so an org admin (and thus
// a super-admins member) resolves `can_manage` on EVERY mcp_tool.
// ---------------------------------------------------------------------------

describe("super-admins / org-admin can manage any mcp_tool", () => {
  it("model lists organization#admin as an mcp_tool manager subject", () => {
    const model = JSON.parse(readFileSync(CHART_JSON, "utf8")) as {
      type_definitions: Array<{
        type: string;
        metadata?: {
          relations?: Record<
            string,
            { directly_related_user_types?: Array<{ type: string; relation?: string }> }
          >;
        };
      }>;
    };
    const mcpTool = model.type_definitions.find((t) => t.type === "mcp_tool");
    const managerTypes =
      mcpTool?.metadata?.relations?.manager?.directly_related_user_types ?? [];
    expect(
      managerTypes.some((t) => t.type === "organization" && t.relation === "admin"),
    ).toBe(true);
  });

  it("an organization#admin subject resolves can_manage (and use+call)", () => {
    // org admins are granted via the `manager` relation, so simulate that
    // direct grant and confirm the resolver elevates it correctly.
    const perms = resolve(new Set(["manager"]));
    expect(perms.manage).toBe(true);
    expect(perms.use).toBe(true);
    expect(perms.call).toBe(true);
  });
});
