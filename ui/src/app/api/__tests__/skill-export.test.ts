/**
 * @jest-environment node
 *
 * Tests for the skill export endpoint.
 *
 *   GET /api/skills/configs/[id]/export
 *
 * Verifies:
 *   - 503 when Mongo is unconfigured
 *   - 401-style behaviour when unauthenticated (handled by withAuth)
 *   - 404 when the skill is not visible to the caller
 *   - 200 + valid ZIP body for an editable user-owned skill
 *   - SKILL.md and metadata.json are always present
 *   - Ancillary files (incl. nested paths) are preserved verbatim
 *   - Read-only built-in (`is_system`) skills can also be exported
 *   - Content-Disposition advertises a sanitised filename
 */

import JSZip from "jszip";
import { NextRequest } from "next/server";

const mockGetServerSession = jest.fn();
jest.mock("next-auth", () => ({
  getServerSession: (...args: unknown[]) => mockGetServerSession(...args),
}));
jest.mock("@/lib/auth-config", () => ({
  authOptions: {},
  isBootstrapAdmin: jest.fn().mockReturnValue(false),
}));

let mongoConfigured = true;
jest.mock("@/lib/mongodb", () => ({
  // Export route doesn't read collections directly, but the route's module
  // initialisation captures `isMongoDBConfigured` at import time. We expose
  // a getter so tests can flip the value before re-importing.
  get isMongoDBConfigured() {
    return mongoConfigured;
  },
  getCollection: jest.fn(),
}));

const mockGetVisible = jest.fn();
jest.mock("@/lib/agent-skill-visibility", () => ({
  getAgentSkillVisibleToUser: (...args: unknown[]) => mockGetVisible(...args),
  // Not used by the export route, but the visibility module also exports
  // this and downstream code may import it indirectly.
}));

// 098-enterprise-rbac introduced an OpenFGA PDP gate on the export route via
// `requireResourcePermission`. Mock it so tests don't need a live OpenFGA;
// the underlying visibility helper is what actually controls 404 vs 200 here.
jest.mock("@/lib/rbac/openfga", () => ({
  checkOpenFgaTuple: jest.fn().mockResolvedValue({ allowed: true }),
}));

jest.mock("@/lib/rbac/resource-authz", () => ({
  requireSkillPermission: jest.fn().mockResolvedValue(undefined),
}));

function makeRequest(): NextRequest {
  return new NextRequest(
    new URL("/api/skills/configs/skill-1/export", "http://localhost:3000"),
  );
}

function userSession(email = "user@example.com") {
  return {
    user: { email, name: "Test User" },
    role: "user",
    // OpenFGA gates require a stable subject id; populate it so the
    // 098-enterprise-rbac PDP gates don't 401 with NO_SUBJECT.
    sub: "user-sub",
  };
}

async function importExportRoute() {
  // Reset module cache so `isMongoDBConfigured` is re-read.
  jest.resetModules();
  return await import("@/app/api/skills/configs/[id]/export/route");
}

beforeEach(() => {
  mongoConfigured = true;
  mockGetServerSession.mockReset();
  mockGetVisible.mockReset();
});

describe("GET /api/skills/configs/[id]/export", () => {
  it("returns 503 when MongoDB is not configured", async () => {
    mongoConfigured = false;
    mockGetServerSession.mockResolvedValue(userSession());
    const { GET } = await importExportRoute();
    const res = await GET(makeRequest(), {
      params: Promise.resolve({ id: "skill-1" }),
    });
    expect(res.status).toBe(503);
  });

  it("rejects unauthenticated requests with a non-2xx status", async () => {
    mockGetServerSession.mockResolvedValue(null);
    const { GET } = await importExportRoute();
    const res = await GET(makeRequest(), {
      params: Promise.resolve({ id: "skill-1" }),
    });
    // The exact code (401 vs 404) is decided by `withAuth`'s internals, but
    // an unauthenticated caller must never get the ZIP body.
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
    expect(res.headers.get("Content-Type") || "").not.toContain("application/zip");
  });

  it("returns 404 when the skill isn't visible to the caller", async () => {
    mockGetServerSession.mockResolvedValue(userSession());
    mockGetVisible.mockResolvedValue(null);
    const { GET } = await importExportRoute();
    const res = await GET(makeRequest(), {
      params: Promise.resolve({ id: "skill-1" }),
    });
    expect(res.status).toBe(404);
  });

  it("streams a ZIP with SKILL.md + metadata.json + ancillary files", async () => {
    mockGetServerSession.mockResolvedValue(userSession());
    mockGetVisible.mockResolvedValue({
      id: "skill-1",
      name: "Sample Skill",
      description: "A demo skill",
      category: "Development",
      thumbnail: "Zap",
      visibility: "private",
      is_system: false,
      owner_id: "user@example.com",
      skill_content: "---\nname: sample\n---\n# Sample\n",
      ancillary_files: {
        "data/example.csv": "a,b,c\n1,2,3",
        "scripts/run.sh": "#!/usr/bin/env bash\necho hi",
      },
      metadata: { tags: ["demo", "test"] },
    });

    const { GET } = await importExportRoute();
    const res = await GET(makeRequest(), {
      params: Promise.resolve({ id: "skill-1" }),
    });

    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("application/zip");
    expect(res.headers.get("Content-Disposition")).toMatch(
      /attachment; filename="skill-1\.zip"/,
    );
    expect(res.headers.get("X-Skill-Export-Id")).toBe("skill-1");

    // Decode + inspect the ZIP body.
    const buf = Buffer.from(await res.arrayBuffer());
    const zip = await JSZip.loadAsync(buf);
    const names = Object.keys(zip.files).sort();

    expect(names).toEqual(
      expect.arrayContaining([
        "skill-1/",
        "skill-1/SKILL.md",
        "skill-1/metadata.json",
        "skill-1/data/example.csv",
        "skill-1/scripts/run.sh",
      ]),
    );

    const skillMd = await zip.file("skill-1/SKILL.md")!.async("string");
    expect(skillMd).toContain("name: sample");

    const metaRaw = await zip.file("skill-1/metadata.json")!.async("string");
    const meta = JSON.parse(metaRaw);
    expect(meta.title).toBe("Sample Skill");
    expect(meta.category).toBe("Development");
    expect(meta.tags).toEqual(["demo", "test"]);
    expect(meta.exported_from_id).toBe("skill-1");
    expect(meta.is_system).toBe(false);

    const csv = await zip.file("skill-1/data/example.csv")!.async("string");
    expect(csv).toBe("a,b,c\n1,2,3");
  });

  it("works for read-only built-in (is_system) skills", async () => {
    mockGetServerSession.mockResolvedValue(userSession());
    mockGetVisible.mockResolvedValue({
      id: "incident-postmortem-report",
      name: "Incident Post-Mortem Report",
      description: "Built-in template",
      category: "Custom",
      thumbnail: "AlertTriangle",
      visibility: "global",
      is_system: true,
      owner_id: "system",
      skill_content: "---\nname: incident-postmortem-report\n---\n# Body",
      ancillary_files: {},
      metadata: { tags: ["postmortem"] },
    });

    const { GET } = await importExportRoute();
    const res = await GET(makeRequest(), {
      params: Promise.resolve({ id: "incident-postmortem-report" }),
    });

    expect(res.status).toBe(200);
    const buf = Buffer.from(await res.arrayBuffer());
    const zip = await JSZip.loadAsync(buf);
    const meta = JSON.parse(
      await zip
        .file("incident-postmortem-report/metadata.json")!
        .async("string"),
    );
    expect(meta.is_system).toBe(true);
  });

  it("falls back to a safe folder name when id has unsafe chars", async () => {
    mockGetServerSession.mockResolvedValue(userSession());
    mockGetVisible.mockResolvedValue({
      id: "Bad ID/with..weird:chars",
      name: "Weird Skill",
      description: "",
      category: "Custom",
      thumbnail: "Zap",
      visibility: "private",
      is_system: false,
      owner_id: "user@example.com",
      skill_content: "# hi",
      ancillary_files: {},
      metadata: {},
    });

    const { GET } = await importExportRoute();
    const res = await GET(makeRequest(), {
      params: Promise.resolve({ id: "Bad ID/with..weird:chars" }),
    });
    expect(res.status).toBe(200);
    const dispo = res.headers.get("Content-Disposition") || "";
    // Sanitised: lowercased, unsafe chars collapsed to `-`, `..` collapsed
    // to `.` so traversal markers don't leak into archive entry names.
    expect(dispo).toMatch(/filename="bad-id-with\.weird-chars\.zip"/);
  });
});
