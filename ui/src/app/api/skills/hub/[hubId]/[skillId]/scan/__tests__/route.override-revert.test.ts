/**
 * @jest-environment node
 */
/**
 * Hub-source counterpart to
 * ``app/api/skills/configs/[id]/scan/__tests__/route.override-revert.test.ts``.
 *
 * Same post-pivot policy: ``scan_status`` and ``scan_override`` are
 * single-writer-per-field. The scan route writes ``scan_status``
 * only and MUST never touch ``scan_override`` — under any verdict,
 * for hub-cached skills the same as for ``agent_skills``.
 *
 * The drift surface this protects is the hub branch of bulk
 * ``scan-all`` plus this per-skill route — both must apply the same
 * "don't touch the override" policy or the override sub-doc would
 * race the override route under concurrent admin actions.
 *
 * assisted-by Cursor Composer-Sonnet-4.7
 */

import { NextRequest } from "next/server";

// ----------------------------------------------------------------------------
// Mocks (mirror the agent_skills route.override-revert.test.ts so the
// two suites can be diffed for drift)
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

const mockScan = jest.fn();
jest.mock("@/lib/skill-scan", () => ({
  scanSkillContent: (...args: unknown[]) => mockScan(...args),
  isSkillScannerConfigured: () => true,
}));

const mockRecordScanEvent = jest.fn().mockResolvedValue(undefined);
jest.mock("@/lib/skill-scan-history", () => ({
  recordScanEvent: (event: unknown) => mockRecordScanEvent(event),
}));

const mockRecordOverrideEvent = jest.fn().mockResolvedValue(undefined);
jest.mock("@/lib/skill-scan-override-history", () => ({
  recordScanOverrideEvent: (event: unknown) =>
    mockRecordOverrideEvent(event),
}));

// 098-enterprise-rbac introduced an OpenFGA PDP gate on the scan route
// via `requireResourcePermission`. Mock it permissively so the suite
// focuses on the override-vs-rescan invariant under test.
jest.mock("@/lib/rbac/openfga", () => ({
  checkOpenFgaTuple: jest.fn().mockResolvedValue({ allowed: true }),
}));

jest.mock("@/lib/rbac/resource-authz", () => ({
  requireResourcePermission: jest.fn().mockResolvedValue(undefined),
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
    new URL(
      "/api/skills/hub/hub-1/gitlab-pipeline-watch/scan",
      "http://localhost:3000",
    ),
    { method: "POST" },
  );
}

const HUB_DOC = {
  id: "hub-1",
  type: "gitlab",
  location: "gitlab-org/ai/skills",
  enabled: true,
};

// Post-pivot: scan_status reflects the scanner's verdict ("flagged"),
// the override sub-doc lives next to it.
const OVERRIDDEN_HUB_SKILL = {
  hub_id: "hub-1",
  skill_id: "gitlab-pipeline-watch",
  name: "GitLab Pipeline Watch",
  description: "Watch a GitLab pipeline",
  content: "# pipeline watch...",
  metadata: {},
  path: "skills/gitlab-pipeline-watch/SKILL.md",
  cached_at: new Date("2026-05-01T00:00:00Z"),
  scan_status: "flagged" as const,
  scan_summary: "Flagged before override",
  scan_override: {
    set_by: "alice@example.com",
    set_at: "2026-05-01T00:00:00Z",
    reason: "Reviewed",
    prior_scan_status: "flagged" as const,
    prior_scan_summary: "Flagged before override",
  },
};

beforeEach(() => {
  jest.clearAllMocks();
  mockIsMongoDBConfigured = true;
  Object.keys(mockCollections).forEach((k) => delete mockCollections[k]);
  mockRecordOverrideEvent.mockClear();
});

// Seed both required collections (skill_hubs for the hub lookup,
// hub_skills for the cached skill doc) with overridden state.
function seedOverriddenHubSkill(): {
  hubsCol: ReturnType<typeof createMockCollection>;
  hubSkillsCol: ReturnType<typeof createMockCollection>;
} {
  const hubsCol = createMockCollection();
  hubsCol.findOne.mockResolvedValue(HUB_DOC);
  mockCollections.skill_hubs = hubsCol;

  const hubSkillsCol = createMockCollection();
  hubSkillsCol.findOne.mockResolvedValue(OVERRIDDEN_HUB_SKILL);
  mockCollections.hub_skills = hubSkillsCol;

  return { hubsCol, hubSkillsCol };
}

// ----------------------------------------------------------------------------
// Test cases
// ----------------------------------------------------------------------------

describe("POST /api/skills/hub/[hubId]/[skillId]/scan — does not touch scan_override", () => {
  let POST: (
    req: NextRequest,
    ctx: { params: Promise<{ hubId: string; skillId: string }> },
  ) => Promise<Response>;

  beforeEach(async () => {
    jest.resetModules();
    const mod = await import(
      "@/app/api/skills/hub/[hubId]/[skillId]/scan/route"
    );
    POST = mod.POST as typeof POST;
  });

  const ctx = {
    params: Promise.resolve({
      hubId: "hub-1",
      skillId: "gitlab-pipeline-watch",
    }),
  };

  it("does NOT clear override on a passing rescan", async () => {
    mockGetServerSession.mockResolvedValue(adminSession());
    const { hubSkillsCol } = seedOverriddenHubSkill();
    mockScan.mockResolvedValue({
      scan_status: "passed",
      scan_summary: "All checks passed",
    });

    const res = await POST(makeRequest(), ctx);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.data.scan_status).toBe("passed");
    // Pre-pivot field; route no longer emits it.
    expect(body.data.override_auto_cleared).toBeUndefined();

    expect(hubSkillsCol.updateOne).toHaveBeenCalledTimes(1);
    const [filter, update] = hubSkillsCol.updateOne.mock.calls[0];
    expect(filter).toEqual({
      hub_id: "hub-1",
      skill_id: "gitlab-pipeline-watch",
      content: OVERRIDDEN_HUB_SKILL.content,
      ancillary_files: null,
    });
    expect(update.$set).toEqual(
      expect.objectContaining({ scan_status: "passed" }),
    );
    // Single-writer invariant: the scan route must not touch
    // scan_override under any verdict, hub edition.
    expect(update.$set.scan_override).toBeUndefined();
    expect(update.$unset).toBeUndefined();

    expect(mockRecordOverrideEvent).not.toHaveBeenCalled();
  });

  it("does not touch override on a still-flagged rescan", async () => {
    mockGetServerSession.mockResolvedValue(adminSession());
    const { hubSkillsCol } = seedOverriddenHubSkill();
    mockScan.mockResolvedValue({
      scan_status: "flagged",
      scan_summary: "Still detected loop",
    });

    const res = await POST(makeRequest(), ctx);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.scan_status).toBe("flagged");
    expect(body.data.override_auto_cleared).toBeUndefined();

    expect(hubSkillsCol.updateOne).toHaveBeenCalledTimes(1);
    const [, update] = hubSkillsCol.updateOne.mock.calls[0];
    expect(update.$set.scan_override).toBeUndefined();
    expect(update.$unset).toBeUndefined();
    expect(mockRecordOverrideEvent).not.toHaveBeenCalled();
  });

  it("does not touch override when rescan returns unscanned", async () => {
    mockGetServerSession.mockResolvedValue(adminSession());
    const { hubSkillsCol } = seedOverriddenHubSkill();
    mockScan.mockResolvedValue({
      scan_status: "unscanned",
      unscanned_reason: "Scanner unreachable",
    });

    const res = await POST(makeRequest(), ctx);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.scan_status).toBe("unscanned");
    expect(body.data.override_auto_cleared).toBeUndefined();

    expect(hubSkillsCol.updateOne).toHaveBeenCalledTimes(1);
    const [, update] = hubSkillsCol.updateOne.mock.calls[0];
    expect(update.$set.scan_override).toBeUndefined();
    expect(update.$unset).toBeUndefined();
    expect(mockRecordOverrideEvent).not.toHaveBeenCalled();
  });

  it("never writes an override audit row on a rescan of a non-overridden hub skill", async () => {
    mockGetServerSession.mockResolvedValue(adminSession());
    const hubsCol = createMockCollection();
    hubsCol.findOne.mockResolvedValue(HUB_DOC);
    mockCollections.skill_hubs = hubsCol;
    const hubSkillsCol = createMockCollection();
    hubSkillsCol.findOne.mockResolvedValue({
      ...OVERRIDDEN_HUB_SKILL,
      scan_status: "flagged",
      scan_override: undefined,
    });
    mockCollections.hub_skills = hubSkillsCol;

    mockScan.mockResolvedValue({
      scan_status: "passed",
      scan_summary: "All checks passed",
    });

    const res = await POST(makeRequest(), ctx);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.scan_status).toBe("passed");
    expect(body.data.override_auto_cleared).toBeUndefined();

    expect(hubSkillsCol.updateOne).toHaveBeenCalledTimes(1);
    const [, update] = hubSkillsCol.updateOne.mock.calls[0];
    expect(update.$unset).toBeUndefined();
    expect(mockRecordOverrideEvent).not.toHaveBeenCalled();
  });
});
