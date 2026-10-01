/**
 * @jest-environment node
 */
// assisted-by cursor (composer-2-fast)
//
// Pins the UI-side enforcement that flagged skills must be marked
// non-runnable before the catalog leaves the server. The gallery,
// runner, and downstream consumers all depend on the `runnable`
// field; we don't want a drift-by-refactor to silently turn a
// flagged skill back into a launchable one.

// Stub api-middleware before the route imports it so the test
// doesn't pull in NextAuth / Mongo at module load.
jest.mock("@/lib/api-middleware", () => ({
  getAuthFromBearerOrSession: jest.fn(),
  withErrorHandler: (handler: unknown) => handler,
}));

import { applyRunnableGate, filterSkillsByOpenFga, type CatalogSkill } from "../route";

const baseSkill: CatalogSkill = {
  id: "x",
  name: "x",
  description: "",
  source: "agent_skills",
  source_id: null,
  content: null,
  metadata: {},
};

describe("applyRunnableGate", () => {
  it("forces runnable=false + blocked_reason on a flagged skill", () => {
    const out = applyRunnableGate({ ...baseSkill, scan_status: "flagged" });
    expect(out.runnable).toBe(false);
    expect(out.blocked_reason).toBe("scan_flagged");
  });

  it("ignores any caller-supplied runnable=true on a flagged skill", () => {
    // Defense-in-depth: even if a stale backend marked the skill
    // runnable, the UI gate must still drop it.
    const out = applyRunnableGate({
      ...baseSkill,
      scan_status: "flagged",
      runnable: true,
    });
    expect(out.runnable).toBe(false);
  });

  it("leaves passed skills runnable", () => {
    const out = applyRunnableGate({ ...baseSkill, scan_status: "passed" });
    expect(out.runnable).toBe(true);
    expect(out.blocked_reason).toBeUndefined();
  });

  it("defaults missing scan_status to runnable=true", () => {
    const out = applyRunnableGate(baseSkill);
    expect(out.runnable).toBe(true);
    expect(out.blocked_reason).toBeUndefined();
  });

  it("preserves an explicit runnable=false from a caller", () => {
    // Callers can still set their own runnable=false for reasons
    // the gate doesn't know about (e.g. a future "tenant disabled"
    // signal). The gate only forces flagged skills to false.
    const out = applyRunnableGate({
      ...baseSkill,
      scan_status: "passed",
      runnable: false,
    });
    expect(out.runnable).toBe(false);
  });
});

describe("filterSkillsByOpenFga", () => {
  it("fails closed for non-admin callers without a stable subject", async () => {
    const filtered = await filterSkillsByOpenFga([{ ...baseSkill, id: "private" }], {
      subject: null,
      mode: "read",
    });

    expect(filtered).toEqual([]);
  });

  it("a catalog credential owner uses the same OpenFGA reads as its real user", async () => {
    const check = jest.fn(async (tuple) => ({
      allowed: tuple.object === "skill:hub-skill-1" || tuple.object === "skill:agent-global",
    }));
    const skills: CatalogSkill[] = [
      { ...baseSkill, id: "builtin-1", source: "default" },
      { ...baseSkill, id: "hub-skill-1", source: "hub" },
      { ...baseSkill, id: "agent-global", source: "agent_skills", visibility: "global" } as CatalogSkill,
      { ...baseSkill, id: "agent-private", source: "agent_skills" },
      { ...baseSkill, id: "agent-team", source: "agent_skills", visibility: "team" } as CatalogSkill,
    ];

    const filtered = await filterSkillsByOpenFga(skills, {
      subject: "user:owner-sub",
      mode: "read",
      check,
    });

    expect(filtered.map((s) => s.id)).toEqual(["builtin-1", "hub-skill-1", "agent-global"]);
    expect(check).toHaveBeenCalled();
  });

  it("catalog credential owners cannot use skills without an OpenFGA can_use tuple", async () => {
    const filtered = await filterSkillsByOpenFga(
      [{ ...baseSkill, id: "builtin-1", source: "default" }],
      {
        subject: "user:owner-sub",
        mode: "use",
        check: async () => ({ allowed: false }),
      },
    );

    expect(filtered).toEqual([]);
  });

  // Regression: local skills JWT (HS256 from /api/skills/token) previously
  // returned session: { role: 'user' } with no `sub`, hitting the null guard.
  // The fix preserves the signed identity-provider subject.
  it("local skills JWT subject resolves OpenFGA tuples for agent_skills", async () => {
    const filtered = await filterSkillsByOpenFga(
      [
        { ...baseSkill, id: "builtin-1", source: "default" },
        { ...baseSkill, id: "my-custom-skill", source: "agent_skills" },
      ],
      {
        subject: "user:owner-sub",
        mode: "read",
        check: async (tuple) => ({ allowed: tuple.object === "skill:my-custom-skill" }),
      },
    );

    expect(filtered.map((s) => s.id)).toEqual(["builtin-1", "my-custom-skill"]);
  });

  it("does not call OpenFGA and returns all skills for admins", async () => {
    const check = jest.fn(async () => ({ allowed: false }));
    const skills: CatalogSkill[] = [
      { ...baseSkill, id: "admin-visible-a" },
      { ...baseSkill, id: "admin-visible-b" },
    ];

    const filtered = await filterSkillsByOpenFga(skills, {
      subject: null,
      mode: "read",
      isAdmin: true,
      check,
    });

    expect(filtered.map((skill) => skill.id)).toEqual(["admin-visible-a", "admin-visible-b"]);
    expect(check).not.toHaveBeenCalled();
  });

  it("keeps only skills the subject can read", async () => {
    const skills: CatalogSkill[] = [
      { ...baseSkill, id: "hub-h1-safe", name: "safe" },
      { ...baseSkill, id: "hub-h1-hidden", name: "hidden" },
    ];
    const checks: string[] = [];

    const filtered = await filterSkillsByOpenFga(skills, {
      subject: "user:alice-sub",
      mode: "read",
      check: async (tuple) => {
        checks.push(`${tuple.user} ${tuple.relation} ${tuple.object}`);
        return { allowed: tuple.object === "skill:hub-h1-safe" };
      },
    });

    expect(filtered.map((skill) => skill.id)).toEqual(["hub-h1-safe"]);
    expect(checks).toEqual([
      "user:alice-sub can_read skill:hub-h1-safe",
      "user:alice-sub can_read skill:hub-h1-hidden",
    ]);
  });

  it("keeps built-in catalog skills visible for signed-in readers without per-skill tuples", async () => {
    const check = jest.fn(async () => ({ allowed: false }));
    const filtered = await filterSkillsByOpenFga(
      [
        { ...baseSkill, id: "builtin-safe", source: "default", name: "Built in" },
        { ...baseSkill, id: "team-private", source: "agent_skills", name: "Team private" },
      ],
      {
        subject: "user:alice-sub",
        mode: "read",
        check,
      }
    );

    expect(filtered.map((skill) => skill.id)).toEqual(["builtin-safe"]);
    expect(check).toHaveBeenCalledWith({
      user: "user:alice-sub",
      relation: "can_read",
      object: "skill:team-private",
    });
    expect(check).not.toHaveBeenCalledWith(
      expect.objectContaining({ object: "skill:builtin-safe" }),
    );
  });

  it("requires can_use when content is being loaded for runtime consumers", async () => {
    const filtered = await filterSkillsByOpenFga(
      [{ ...baseSkill, id: "hub-h1-runnable" }],
      {
        subject: "user:alice-sub",
        mode: "use",
        check: async (tuple) => ({ allowed: tuple.relation === "can_use" }),
      }
    );

    expect(filtered.map((skill) => skill.id)).toEqual(["hub-h1-runnable"]);
  });

  it("keeps built-in catalog skills visible in use mode for users with baseline org access", async () => {
    const checks: string[] = [];
    const filtered = await filterSkillsByOpenFga(
      [
        { ...baseSkill, id: "builtin-safe", source: "default", name: "Built in" },
        { ...baseSkill, id: "team-private", source: "agent_skills", name: "Team private" },
      ],
      {
        subject: "user:alice-sub",
        mode: "use",
        check: async (tuple) => {
          checks.push(`${tuple.user} ${tuple.relation} ${tuple.object}`);
          return { allowed: tuple.object === "organization:caipe" };
        },
      }
    );

    expect(filtered.map((skill) => skill.id)).toEqual(["builtin-safe"]);
    expect(checks).toEqual([
      "user:alice-sub can_use organization:caipe",
      "user:alice-sub can_use skill:team-private",
    ]);
  });

  it("drops skills whose OpenFGA check throws instead of failing open", async () => {
    const filtered = await filterSkillsByOpenFga(
      [
        { ...baseSkill, id: "safe" },
        { ...baseSkill, id: "pdp-error" },
      ],
      {
        subject: "user:alice-sub",
        mode: "read",
        check: async (tuple) => {
          if (tuple.object === "skill:pdp-error") {
            throw new Error("OpenFGA unavailable for object");
          }
          return { allowed: true };
        },
      },
    );

    expect(filtered.map((skill) => skill.id)).toEqual(["safe"]);
  });

  it("checks every candidate skill using its stable catalog id", async () => {
    const checkedObjects: string[] = [];

    await filterSkillsByOpenFga(
      [
        { ...baseSkill, id: "local-skill" },
        { ...baseSkill, id: "hub-hub1-skill2", source: "hub" },
      ],
      {
        subject: "user:alice-sub",
        mode: "use",
        check: async (tuple) => {
          checkedObjects.push(`${tuple.relation} ${tuple.object}`);
          return { allowed: false };
        },
      },
    );

    expect(checkedObjects).toEqual([
      "can_use skill:local-skill",
      "can_use skill:hub-hub1-skill2",
    ]);
  });
});

// -- Admin scan-override gate -------------------------------------------------
//
// Mirrors the policy table in
// ai_platform_engineering/skills_middleware/scan_gate.py — the Node
// gate stamps `runnable` for the UI; the Python gate enforces it on
// the actual loader path. They have to agree on every cell of the
// table or the gallery and the runtime will disagree about whether
// a skill is launchable.
//
// IMPORTANT: the override is stored in a SEPARATE field
// (`scan_override` sub-doc), NOT a magic `scan_status =
// "admin_overridden"` value. The earlier design overloaded
// `scan_status` and was removed because every scanner write path
// (rescan, scan-all, hub auto-scan) would blindly overwrite the
// synthetic value with the scanner's raw verdict ("flagged") and
// silently nuke the override. These tests pin the new two-field
// contract so the bug can't regress.
describe("applyRunnableGate — admin scan_override", () => {
  // The persisted shape after an admin sets an override: scan_status
  // stays whatever the scanner last wrote ("flagged"), and the
  // separate scan_override sub-doc carries the audit metadata.
  const flaggedWithOverride: CatalogSkill = {
    ...baseSkill,
    scan_status: "flagged",
    scan_override: {
      set_by: "alice@example.com",
      set_at: "2026-05-05T12:00:00Z",
      reason: "Reviewed shell-out warning, all paths use allow-list.",
      prior_scan_status: "flagged",
      prior_scan_summary: "Detected shell exec with user input",
    },
  };

  // Reset the env var between cases so a prior test can't leak the
  // feature into the off state. afterEach is paired with an explicit
  // delete instead of restoreAllMocks because the gate reads
  // process.env directly (not through a mockable function).
  afterEach(() => {
    delete process.env.ADMIN_SCAN_OVERRIDE_ENABLED;
  });

  it("treats flagged+override as runnable when feature is on (default)", () => {
    // ADMIN_SCAN_OVERRIDE_ENABLED unset ⇒ default-on. This is the
    // happy path: an admin has explicitly green-lit a flagged skill
    // and the runtime serves it.
    const out = applyRunnableGate(flaggedWithOverride);
    expect(out.runnable).toBe(true);
    expect(out.blocked_reason).toBeUndefined();
    // The override metadata must round-trip so the report dialog can
    // render set_by / reason / prior_scan_status.
    expect(out.scan_override).toEqual(flaggedWithOverride.scan_override);
    // scan_status stays "flagged" — the gate doesn't mutate the
    // scanner verdict, only the runnable bit.
    expect(out.scan_status).toBe("flagged");
  });

  it("treats flagged+override as runnable when feature is explicitly true", () => {
    process.env.ADMIN_SCAN_OVERRIDE_ENABLED = "true";
    const out = applyRunnableGate(flaggedWithOverride);
    expect(out.runnable).toBe(true);
  });

  it.each(["false", "0", "no", "off"])(
    "collapses flagged+override back to blocked when feature is off (%s)",
    (value) => {
      // Flipping the env disables the escape hatch on both tiers.
      // The UI must mark runnable=false even though the override
      // sub-doc is present, so the runner refuses to launch and
      // the gallery shows the disabled badge again. The override
      // sub-doc is preserved on the row so the dialog can still
      // explain "an override exists but the feature is off."
      process.env.ADMIN_SCAN_OVERRIDE_ENABLED = value;
      const out = applyRunnableGate(flaggedWithOverride);
      expect(out.runnable).toBe(false);
      expect(out.blocked_reason).toBe("scan_flagged");
      expect(out.scan_status).toBe("flagged");
      expect(out.scan_override).toEqual(flaggedWithOverride.scan_override);
    },
  );

  it("flagged-without-override stays blocked regardless of override env", () => {
    // Toggling the override flag has nothing to do with a plain
    // flagged skill that has no override sub-doc. Both states of
    // the env must keep an unprotected flagged skill non-runnable.
    for (const value of ["true", "false"]) {
      process.env.ADMIN_SCAN_OVERRIDE_ENABLED = value;
      const out = applyRunnableGate({
        ...baseSkill,
        scan_status: "flagged",
      });
      expect(out.runnable).toBe(false);
      expect(out.blocked_reason).toBe("scan_flagged");
    }
  });

  it("override on a non-flagged skill is a no-op", () => {
    // The override field only rescues "flagged". An override sitting
    // on a passed/unscanned row (shouldn't happen in normal flow but
    // could appear during edge transitions) doesn't grant any extra
    // privilege beyond what scan_status already does.
    const out = applyRunnableGate({
      ...baseSkill,
      scan_status: "passed",
      scan_override: flaggedWithOverride.scan_override,
    });
    expect(out.runnable).toBe(true);
    expect(out.blocked_reason).toBeUndefined();
  });
});
