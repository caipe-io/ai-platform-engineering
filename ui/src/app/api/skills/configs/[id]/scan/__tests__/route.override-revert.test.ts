/**
 * @jest-environment node
 */
/**
 * Tests the rescan-vs-override interaction for the per-skill scan
 * route (``POST /api/skills/configs/[id]/scan``).
 *
 * Design pivot (2026-05): the old "auto-revert-on-clean" policy was
 * removed. ``scan_status`` and ``scan_override`` are now independent
 * fields:
 *
 *   - ``scan_status`` is the scanner's verdict (``passed`` /
 *     ``flagged`` / ``unscanned``). Only scan code paths write it.
 *   - ``scan_override`` is the admin's "trust me, run it anyway"
 *     assertion. Only the ``/admin/scan-override`` routes write it.
 *
 * The runnable gate is now ``scan_status === "flagged" && !scan_override``.
 *
 * This suite pins the post-pivot invariant: the scan route MUST
 * NEVER touch ``scan_override`` (neither in ``$set`` nor in
 * ``$unset``) and MUST NEVER write an override audit row, regardless
 * of the verdict and regardless of whether the skill currently has
 * an override. If a future refactor reintroduces auto-revert it
 * would race the override route under concurrent admin actions, so
 * we keep the policy single-writer-per-field.
 *
 * assisted-by Cursor Composer-Sonnet-4.7
 */

import { NextRequest } from "next/server";

// ----------------------------------------------------------------------------
// Mocks
// ----------------------------------------------------------------------------

const mockGetServerSession = jest.fn();
jest.mock("next-auth", () => ({
  getServerSession: (...args: unknown[]) => mockGetServerSession(...args),
}));

jest.mock("@/lib/auth-config", () => ({ authOptions: {} }));
jest.mock("@/lib/config", () => ({
  getConfig: (key: string) => key === "ssoEnabled",
}));

let mockIsMongoDBConfigured = true;
const mockCollections: Record<string, ReturnType<typeof createMockCollection>> =
  {};
const mockGetCollection = jest.fn((name: string) => {
  if (!mockCollections[name]) {
    mockCollections[name] = createMockCollection();
  }
  return Promise.resolve(mockCollections[name]);
});
jest.mock("@/lib/mongodb", () => ({
  get isMongoDBConfigured() {
    return mockIsMongoDBConfigured;
  },
  getCollection: (...args: unknown[]) => mockGetCollection(...(args as [string])),
}));

const mockGetSkillVisible = jest.fn();
jest.mock("@/lib/agent-skill-visibility", () => ({
  getAgentSkillVisibleToUser: (...args: unknown[]) =>
    mockGetSkillVisible(...args),
}));

const mockScan = jest.fn();
jest.mock("@/lib/skill-scan", () => ({
  scanSkillContent: (...args: unknown[]) => mockScan(...args),
  isSkillScannerConfigured: () => true,
}));

const mockRecordScanEvent = jest.fn().mockResolvedValue(undefined);
jest.mock("@/lib/skill-scan-history", () => ({
  recordScanEvent: (event: unknown) => mockRecordScanEvent(event),
}));

// The regression assertion the rest of the suite hangs off of: the
// override audit MUST NOT be written by this route under any verdict.
const mockRecordOverrideEvent = jest.fn().mockResolvedValue(undefined);
jest.mock("@/lib/skill-scan-override-history", () => ({
  recordScanOverrideEvent: (event: unknown) =>
    mockRecordOverrideEvent(event),
}));

const mockRequireSkillPermission = jest.fn();
jest.mock("@/lib/rbac/resource-authz", () => ({
  requireSkillPermission: (...args: unknown[]) => mockRequireSkillPermission(...args),
}));

jest.mock("@/lib/rbac/skill-team-grants", () => ({
  readSkillSharedTeamSlugsFromOpenFga: jest.fn().mockResolvedValue([]),
  reconcileSkillTeamShares: jest.fn().mockResolvedValue(undefined),
}));

jest.spyOn(console, "warn").mockImplementation(() => {});
jest.spyOn(console, "error").mockImplementation(() => {});

function createMockCollection() {
  return {
    findOne: jest.fn().mockResolvedValue(null),
    updateOne: jest
      .fn()
      .mockResolvedValue({ matchedCount: 1, modifiedCount: 1 }),
  };
}

function adminSession() {
  return {
    user: { email: "admin@example.com", name: "Admin" },
    role: "admin",
    // OpenFGA gates need a stable subject id.
    sub: "admin-sub",
  };
}

function makeRequest(): NextRequest {
  return new NextRequest(
    new URL("/api/skills/configs/skill-123/scan", "http://localhost:3000"),
    { method: "POST" },
  );
}

// A flagged skill with an active admin override. The post-pivot
// shape: scan_status stays at the scanner's verdict (``flagged``),
// the override sub-doc lives next to it.
const OVERRIDDEN_SKILL = {
  id: "skill-123",
  name: "Risky Skill",
  description: "Test",
  is_system: false,
  owner_id: "owner@example.com",
  scan_status: "flagged" as const,
  scan_summary: "Flagged before override",
  scan_override: {
    set_by: "alice@example.com",
    set_at: "2026-05-01T00:00:00Z",
    reason: "Reviewed",
    prior_scan_status: "flagged" as const,
    prior_scan_summary: "Flagged before override",
  },
  // Provide skill_content so resolveSkillMarkdownForScan returns
  // non-empty. Otherwise the route 400s before we get to the
  // post-scan code.
  skill_content: "# Test\nHello",
};

beforeEach(() => {
  jest.clearAllMocks();
  mockIsMongoDBConfigured = true;
  Object.keys(mockCollections).forEach((k) => delete mockCollections[k]);
  mockRecordOverrideEvent.mockClear();
});

// ----------------------------------------------------------------------------
// Test cases
// ----------------------------------------------------------------------------

describe("POST /api/skills/configs/[id]/scan — does not touch scan_override", () => {
  let POST: (
    req: NextRequest,
    ctx: { params: Promise<{ id: string }> },
  ) => Promise<Response>;

  beforeEach(async () => {
    jest.resetModules();
    mockRequireSkillPermission.mockResolvedValue(undefined);
    const mod = await import("@/app/api/skills/configs/[id]/scan/route");
    POST = mod.POST as typeof POST;
  });

  const ctx = { params: Promise.resolve({ id: "skill-123" }) };

  it("does NOT clear override on a passing rescan", async () => {
    // Pre-pivot this auto-cleared the override. Now the override
    // is the admin's standing assertion and stays put: the runnable
    // gate flips to ``true`` anyway because scan_status == passed.
    // Keeping the override avoids audit churn (no spurious clear
    // on every passing rescan) and keeps the rescan path
    // single-purpose.
    mockGetServerSession.mockResolvedValue(adminSession());
    mockGetSkillVisible.mockResolvedValue(OVERRIDDEN_SKILL);
    const skillsCol = createMockCollection();
    mockCollections.agent_skills = skillsCol;
    mockScan.mockResolvedValue({
      scan_status: "passed",
      scan_summary: "All checks passed",
    });

    const res = await POST(makeRequest(), ctx);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.data.scan_status).toBe("passed");
    // override_auto_cleared was a pre-pivot field. The route no
    // longer emits it under any branch; pin it absent so a
    // refactor that reintroduces auto-revert fails this test.
    expect(body.data.override_auto_cleared).toBeUndefined();

    expect(skillsCol.updateOne).toHaveBeenCalledTimes(1);
    const [, update] = skillsCol.updateOne.mock.calls[0];
    expect(update.$set).toEqual(
      expect.objectContaining({ scan_status: "passed" }),
    );
    // The two single-writer invariants — the scan route must not
    // $set or $unset scan_override under any verdict.
    expect(update.$set.scan_override).toBeUndefined();
    expect(update.$unset).toBeUndefined();

    // And it must not write to the override audit log.
    expect(mockRecordOverrideEvent).not.toHaveBeenCalled();
  });

  it("does not touch override on a still-flagged rescan", async () => {
    mockGetServerSession.mockResolvedValue(adminSession());
    mockGetSkillVisible.mockResolvedValue(OVERRIDDEN_SKILL);
    const skillsCol = createMockCollection();
    mockCollections.agent_skills = skillsCol;
    mockScan.mockResolvedValue({
      scan_status: "flagged",
      scan_summary: "Still detected shell exec",
    });

    const res = await POST(makeRequest(), ctx);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.scan_status).toBe("flagged");
    expect(body.data.override_auto_cleared).toBeUndefined();

    expect(skillsCol.updateOne).toHaveBeenCalledTimes(1);
    const [, update] = skillsCol.updateOne.mock.calls[0];
    expect(update.$set.scan_override).toBeUndefined();
    expect(update.$unset).toBeUndefined();
    expect(mockRecordOverrideEvent).not.toHaveBeenCalled();
  });

  it("does not touch override when rescan returns unscanned", async () => {
    // A scanner that 503s should be treated the same as the other
    // verdicts: leave the override alone.
    mockGetServerSession.mockResolvedValue(adminSession());
    mockGetSkillVisible.mockResolvedValue(OVERRIDDEN_SKILL);
    const skillsCol = createMockCollection();
    mockCollections.agent_skills = skillsCol;
    mockScan.mockResolvedValue({
      scan_status: "unscanned",
      unscanned_reason: "Scanner unreachable",
    });

    const res = await POST(makeRequest(), ctx);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.scan_status).toBe("unscanned");
    expect(body.data.override_auto_cleared).toBeUndefined();

    expect(skillsCol.updateOne).toHaveBeenCalledTimes(1);
    const [, update] = skillsCol.updateOne.mock.calls[0];
    expect(update.$set.scan_override).toBeUndefined();
    expect(update.$unset).toBeUndefined();
    expect(mockRecordOverrideEvent).not.toHaveBeenCalled();
  });

  it("never writes an override audit row on a rescan of a non-overridden skill", async () => {
    // The "no override in the first place" baseline. Pinning this
    // guarantees the scan route never accidentally audits a clear
    // when there was nothing to clear.
    mockGetServerSession.mockResolvedValue(adminSession());
    mockGetSkillVisible.mockResolvedValue({
      ...OVERRIDDEN_SKILL,
      scan_status: "flagged",
      scan_override: undefined,
    });
    const skillsCol = createMockCollection();
    mockCollections.agent_skills = skillsCol;
    mockScan.mockResolvedValue({
      scan_status: "passed",
      scan_summary: "All checks passed",
    });

    const res = await POST(makeRequest(), ctx);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.scan_status).toBe("passed");
    expect(body.data.override_auto_cleared).toBeUndefined();

    expect(skillsCol.updateOne).toHaveBeenCalledTimes(1);
    const [, update] = skillsCol.updateOne.mock.calls[0];
    expect(update.$unset).toBeUndefined();
    expect(mockRecordOverrideEvent).not.toHaveBeenCalled();
  });
});
