/**
 * @jest-environment node
 */
// assisted-by cursor (composer-2-fast)
//
// Tests for the zip-import driver `runZipImport`. Same strategy as
// `app/api/skills/import/__tests__/route.test.ts`: stub
// `@/lib/api-middleware` so the route file imports cleanly without
// pulling NextAuth + Mongo at module load, then drive the pure
// helper through both phases (analyze + import) with synthesised
// zips.

import JSZip from "jszip";

jest.mock("@/lib/api-middleware", () => {
  class FakeApiError extends Error {
    statusCode: number;
    constructor(message: string, statusCode: number) {
      super(message);
      this.statusCode = statusCode;
      this.name = "ApiError";
    }
  }
  return {
    withErrorHandler: (handler: unknown) => handler,
    withAuth: jest.fn(),
    successResponse: (data: unknown) => ({ data }),
    ApiError: FakeApiError,
  };
});

jest.mock("@/lib/mongodb", () => ({
  isMongoDBConfigured: false,
  getCollection: jest.fn(),
}));

const scanMock = jest.fn();
jest.mock("@/lib/skill-scan", () => ({
  scanSkillContent: (...args: unknown[]) => scanMock(...args),
}));

const recordScanEventMock = jest.fn();
jest.mock("@/lib/skill-scan-history", () => ({
  recordScanEvent: (...args: unknown[]) => recordScanEventMock(...args),
}));

const recordRevisionMock = jest.fn();
jest.mock("@/lib/skill-revisions", () => ({
  recordRevision: (...args: unknown[]) => recordRevisionMock(...args),
}));

import { runZipImport } from "../route";
import type { AgentSkill } from "@/types/agent-skill";
import type { ImportConflictDecision } from "@/lib/skill-import-helpers";

const FRONTMATTER = (name: string, description = "Test skill") =>
  `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n\nbody`;

async function makeZipBuffer(
  entries: Record<string, string>,
): Promise<ArrayBuffer> {
  const zip = new JSZip();
  for (const [path, body] of Object.entries(entries)) {
    zip.file(path, body);
  }
  const node = await zip.generateAsync({ type: "nodebuffer" });
  return node.buffer.slice(
    node.byteOffset,
    node.byteOffset + node.byteLength,
  ) as ArrayBuffer;
}

const baseUser = { email: "alice@example.com", role: "user" as const };

beforeEach(() => {
  scanMock.mockReset();
  recordScanEventMock.mockReset();
  recordRevisionMock.mockReset();
  recordScanEventMock.mockResolvedValue(undefined);
  recordRevisionMock.mockResolvedValue(null);
});

// ---------------------------------------------------------------------------
// Analyze phase
// ---------------------------------------------------------------------------

describe("runZipImport — analyze phase", () => {
  it("returns candidates and an empty conflicts list when no name collides", async () => {
    const buffer = await makeZipBuffer({
      "skills/foo/SKILL.md": FRONTMATTER("foo"),
      "skills/foo/scripts/run.sh": "#!/bin/bash",
    });
    const result = await runZipImport({
      buffer,
      user: baseUser,
      loadVisibleSkills: async () => [],
      persistSkill: jest.fn(),
    });
    expect(result.phase).toBe("analyze");
    if (result.phase !== "analyze") return;
    expect(result.candidates).toHaveLength(1);
    expect(result.conflicts).toEqual([]);
    expect(result.candidates[0].proposedName).toBe("foo");
    expect(result.candidates[0].ancillaryCount).toBe(1);
  });

  it("populates conflicts for every candidate name that matches an existing skill", async () => {
    const buffer = await makeZipBuffer({
      "a/SKILL.md": FRONTMATTER("foo"),
      "b/SKILL.md": FRONTMATTER("bar"),
    });
    const existing: AgentSkill[] = [
      { id: "skill-foo-1", name: "foo" } as AgentSkill,
      { id: "skill-baz-1", name: "baz" } as AgentSkill,
    ];
    const result = await runZipImport({
      buffer,
      user: baseUser,
      loadVisibleSkills: async () => existing,
      persistSkill: jest.fn(),
    });
    if (result.phase !== "analyze") throw new Error("expected analyze");
    expect(result.conflicts).toHaveLength(1);
    expect(result.conflicts[0].existingId).toBe("skill-foo-1");
    expect(result.conflicts[0].action).toBe("skip");
  });

  it("does not invoke the scanner during the analyze phase", async () => {
    const buffer = await makeZipBuffer({
      "SKILL.md": FRONTMATTER("foo"),
    });
    await runZipImport({
      buffer,
      user: baseUser,
      loadVisibleSkills: async () => [],
      persistSkill: jest.fn(),
    });
    expect(scanMock).not.toHaveBeenCalled();
    expect(recordRevisionMock).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Import phase
// ---------------------------------------------------------------------------

describe("runZipImport — import phase", () => {
  beforeEach(() => {
    scanMock.mockResolvedValue({
      scan_status: "passed",
      scan_summary: undefined,
    });
  });

  it("creates a brand-new skill when no decision and no name collision", async () => {
    const buffer = await makeZipBuffer({
      "SKILL.md": FRONTMATTER("brand-new"),
    });
    const persistSpy = jest.fn().mockResolvedValue(undefined);
    const reconcileAccess = jest.fn().mockResolvedValue(undefined);
    const result = await runZipImport({
      buffer,
      resolutions: [],
      user: baseUser,
      loadVisibleSkills: async () => [],
      persistSkill: persistSpy,
      reconcileAccess,
    });
    if (result.phase !== "import") throw new Error("expected import");
    expect(result.imported).toHaveLength(1);
    expect(result.imported[0].outcome).toBe("created");
    expect(result.imported[0].name).toBe("brand-new");
    expect(persistSpy).toHaveBeenCalledTimes(1);
    expect(persistSpy.mock.calls[0][1]).toBe("create");
    expect(reconcileAccess).toHaveBeenCalledWith(
      persistSpy.mock.calls[0][0],
      "create",
    );
    // Scan ran inline ("scan before save").
    expect(scanMock).toHaveBeenCalledTimes(1);
    // Revision #1 was recorded with trigger "import".
    expect(recordRevisionMock).toHaveBeenCalledTimes(1);
    expect(recordRevisionMock.mock.calls[0][0].trigger).toBe("import");
  });

  it("applies selected team permissions to imported skills", async () => {
    const buffer = await makeZipBuffer({
      "SKILL.md": FRONTMATTER("team-imported"),
    });
    const persistSpy = jest.fn().mockResolvedValue(undefined);
    const reconcileAccess = jest.fn().mockResolvedValue(undefined);
    const result = await runZipImport({
      buffer,
      resolutions: [],
      user: baseUser,
      teamRefs: ["platform"],
      loadVisibleSkills: async () => [],
      persistSkill: persistSpy,
      reconcileAccess,
    });
    if (result.phase !== "import") throw new Error("expected import");
    const [savedSkill] = persistSpy.mock.calls[0];
    expect(savedSkill.visibility).toBe("team");
    expect(savedSkill.shared_with_teams).toBeUndefined();
    expect(reconcileAccess).toHaveBeenCalledWith(savedSkill, "create");
  });

  it("rolls back a private import when owner reconciliation fails", async () => {
    const buffer = await makeZipBuffer({
      "SKILL.md": FRONTMATTER("ownerless"),
    });
    const rollback = jest.fn().mockResolvedValue(undefined);
    const result = await runZipImport({
      buffer,
      resolutions: [],
      user: baseUser,
      loadVisibleSkills: async () => [],
      persistSkill: jest.fn().mockResolvedValue({ rollback }),
      reconcileAccess: jest.fn().mockRejectedValue(new Error("OpenFGA unavailable")),
    });
    if (result.phase !== "import") throw new Error("expected import");
    expect(result.imported[0]).toEqual(
      expect.objectContaining({
        outcome: "failed",
        error: "OpenFGA unavailable",
      }),
    );
    expect(rollback).toHaveBeenCalledTimes(1);
    expect(recordRevisionMock).not.toHaveBeenCalled();
  });

  it("respects a 'skip' decision and does not call the scanner or persist", async () => {
    const buffer = await makeZipBuffer({
      "SKILL.md": FRONTMATTER("foo"),
    });
    const existing: AgentSkill[] = [
      { id: "skill-foo-existing", name: "foo", owner_id: baseUser.email } as AgentSkill,
    ];
    const persistSpy = jest.fn();
    const decision: ImportConflictDecision = {
      candidateId: "(root)",
      candidateName: "foo",
      existingName: "foo",
      existingId: "skill-foo-existing",
      action: "skip",
    };
    const result = await runZipImport({
      buffer,
      resolutions: [decision],
      user: baseUser,
      loadVisibleSkills: async () => existing,
      persistSkill: persistSpy,
    });
    if (result.phase !== "import") throw new Error("expected import");
    expect(result.imported[0].outcome).toBe("skipped");
    expect(scanMock).not.toHaveBeenCalled();
    expect(persistSpy).not.toHaveBeenCalled();
    expect(recordRevisionMock).not.toHaveBeenCalled();
  });

  it("renames to the user-supplied name on a 'rename' decision", async () => {
    const buffer = await makeZipBuffer({
      "SKILL.md": FRONTMATTER("foo"),
    });
    const existing: AgentSkill[] = [
      { id: "skill-foo-existing", name: "foo", owner_id: baseUser.email } as AgentSkill,
    ];
    const persistSpy = jest.fn().mockResolvedValue(undefined);
    const decision: ImportConflictDecision = {
      candidateId: "(root)",
      candidateName: "foo",
      existingName: "foo",
      existingId: "skill-foo-existing",
      action: "rename",
      renameTo: "foo (imported)",
    };
    const result = await runZipImport({
      buffer,
      resolutions: [decision],
      user: baseUser,
      loadVisibleSkills: async () => existing,
      persistSkill: persistSpy,
    });
    if (result.phase !== "import") throw new Error("expected import");
    expect(result.imported[0].outcome).toBe("created");
    expect(result.imported[0].name).toBe("foo (imported)");
    expect(persistSpy.mock.calls[0][0].name).toBe("foo (imported)");
    expect(persistSpy.mock.calls[0][1]).toBe("create");
  });

  it("overwrites an existing skill on an 'overwrite' decision and writes pre+post revisions", async () => {
    const buffer = await makeZipBuffer({
      "SKILL.md": FRONTMATTER("foo", "newer description"),
    });
    const existing: AgentSkill[] = [
      {
        id: "skill-foo-existing",
        name: "foo",
        description: "older",
        owner_id: baseUser.email,
        is_system: false,
        skill_content: "old body",
        tasks: [{ display_text: "Old", llm_prompt: "old", subagent: "skills" }],
      } as AgentSkill,
    ];
    const persistSpy = jest.fn().mockResolvedValue(undefined);
    const reconcileAccess = jest.fn().mockResolvedValue(undefined);
    const decision: ImportConflictDecision = {
      candidateId: "(root)",
      candidateName: "foo",
      existingName: "foo",
      existingId: "skill-foo-existing",
      action: "overwrite",
    };
    const result = await runZipImport({
      buffer,
      resolutions: [decision],
      user: baseUser,
      loadVisibleSkills: async () => existing,
      persistSkill: persistSpy,
      reconcileAccess,
    });
    if (result.phase !== "import") throw new Error("expected import");
    expect(result.imported[0].outcome).toBe("overwritten");
    expect(persistSpy).toHaveBeenCalledTimes(1);
    const [savedSkill, mode] = persistSpy.mock.calls[0];
    expect(mode).toBe("overwrite");
    expect(savedSkill.id).toBe("skill-foo-existing");
    expect(savedSkill.skill_content).toContain("# foo");
    expect(savedSkill.tasks[0].llm_prompt).toContain("# foo");
    expect(reconcileAccess).toHaveBeenCalledWith(savedSkill, "overwrite", existing[0]);
    // Two revisions: pre-overwrite update + post-overwrite import.
    expect(recordRevisionMock).toHaveBeenCalledTimes(2);
    expect(recordRevisionMock.mock.calls[0][0].trigger).toBe("update");
    expect(recordRevisionMock.mock.calls[1][0].trigger).toBe("import");
  });

  it("rolls back an overwrite and records no revisions when access reconciliation fails", async () => {
    const buffer = await makeZipBuffer({
      "SKILL.md": FRONTMATTER("foo", "newer description"),
    });
    const existing = {
      id: "skill-foo-existing",
      name: "foo",
      description: "older",
      owner_id: baseUser.email,
      is_system: false,
      skill_content: "old body",
      tasks: [{ display_text: "Old", llm_prompt: "old", subagent: "skills" }],
    } as AgentSkill;
    const rollback = jest.fn().mockResolvedValue(undefined);
    const decision: ImportConflictDecision = {
      candidateId: "(root)",
      candidateName: "foo",
      existingName: "foo",
      existingId: existing.id,
      action: "overwrite",
    };
    const result = await runZipImport({
      buffer,
      resolutions: [decision],
      user: baseUser,
      loadVisibleSkills: async () => [existing],
      persistSkill: jest.fn().mockResolvedValue({ rollback }),
      reconcileAccess: jest.fn().mockRejectedValue(new Error("OpenFGA unavailable")),
    });
    if (result.phase !== "import") throw new Error("expected import");
    expect(result.imported[0].outcome).toBe("failed");
    expect(rollback).toHaveBeenCalledTimes(1);
    expect(recordRevisionMock).not.toHaveBeenCalled();
  });

  it("rejects overwrite of a built-in skill with a 403", async () => {
    const buffer = await makeZipBuffer({
      "SKILL.md": FRONTMATTER("system-skill"),
    });
    const existing: AgentSkill[] = [
      {
        id: "skill-system-1",
        name: "system-skill",
        is_system: true,
        owner_id: "system",
      } as AgentSkill,
    ];
    const decision: ImportConflictDecision = {
      candidateId: "(root)",
      candidateName: "system-skill",
      existingName: "system-skill",
      existingId: "skill-system-1",
      action: "overwrite",
    };
    await expect(
      runZipImport({
        buffer,
        resolutions: [decision],
        user: baseUser,
        loadVisibleSkills: async () => existing,
        persistSkill: jest.fn(),
      }),
    ).rejects.toMatchObject({ statusCode: 403 });
  });

  it("rejects overwrite when the OpenFGA write hook denies it", async () => {
    const buffer = await makeZipBuffer({
      "SKILL.md": FRONTMATTER("foo"),
    });
    const existing: AgentSkill[] = [
      {
        id: "skill-foo-1",
        name: "foo",
        is_system: false,
        owner_id: "bob@example.com",
      } as AgentSkill,
    ];
    const decision: ImportConflictDecision = {
      candidateId: "(root)",
      candidateName: "foo",
      existingName: "foo",
      existingId: "skill-foo-1",
      action: "overwrite",
    };
    await expect(
      runZipImport({
        buffer,
        resolutions: [decision],
        user: baseUser,
        loadVisibleSkills: async () => existing,
        canOverwriteSkill: async () => {
          throw Object.assign(new Error("denied"), { statusCode: 403 });
        },
        persistSkill: jest.fn(),
      }),
    ).rejects.toMatchObject({ statusCode: 403 });
  });

  it("persists a 'flagged' scan_status on the new skill (gate enforced downstream)", async () => {
    scanMock.mockResolvedValue({
      scan_status: "flagged",
      scan_summary: "1 finding — max severity: high",
    });
    const buffer = await makeZipBuffer({
      "SKILL.md": FRONTMATTER("risky"),
    });
    const persistSpy = jest.fn().mockResolvedValue(undefined);
    const result = await runZipImport({
      buffer,
      resolutions: [],
      user: baseUser,
      loadVisibleSkills: async () => [],
      persistSkill: persistSpy,
    });
    if (result.phase !== "import") throw new Error("expected import");
    expect(result.imported[0].scan_status).toBe("flagged");
    expect(persistSpy.mock.calls[0][0].scan_status).toBe("flagged");
  });

  it("imports multiple candidates from a multi-skill zip in one call", async () => {
    const buffer = await makeZipBuffer({
      "skills/foo/SKILL.md": FRONTMATTER("foo"),
      "skills/bar/SKILL.md": FRONTMATTER("bar"),
    });
    const persistSpy = jest.fn().mockResolvedValue(undefined);
    const result = await runZipImport({
      buffer,
      resolutions: [],
      user: baseUser,
      loadVisibleSkills: async () => [],
      persistSkill: persistSpy,
    });
    if (result.phase !== "import") throw new Error("expected import");
    expect(result.imported).toHaveLength(2);
    expect(persistSpy).toHaveBeenCalledTimes(2);
    expect(scanMock).toHaveBeenCalledTimes(2);
  });

  it("isolates per-candidate failures so other candidates still import", async () => {
    scanMock
      .mockResolvedValueOnce({ scan_status: "passed" })
      .mockRejectedValueOnce(new Error("scanner blew up"));
    const buffer = await makeZipBuffer({
      "skills/ok/SKILL.md": FRONTMATTER("ok"),
      "skills/oops/SKILL.md": FRONTMATTER("oops"),
    });
    const persistSpy = jest.fn().mockResolvedValue(undefined);
    const result = await runZipImport({
      buffer,
      resolutions: [],
      user: baseUser,
      loadVisibleSkills: async () => [],
      persistSkill: persistSpy,
    });
    if (result.phase !== "import") throw new Error("expected import");
    expect(result.imported).toHaveLength(2);
    const ok = result.imported.find((r) => r.name === "ok")!;
    const oops = result.imported.find((r) => r.name === "oops")!;
    expect(ok.outcome).toBe("created");
    expect(oops.outcome).toBe("failed");
    expect(oops.error).toContain("scanner blew up");
    // Only the successful one persisted.
    expect(persistSpy).toHaveBeenCalledTimes(1);
  });

  it("falls back to '(imported)' suffix when a race created a same-named skill between analyze and import", async () => {
    const buffer = await makeZipBuffer({
      "SKILL.md": FRONTMATTER("foo"),
    });
    const persistSpy = jest.fn().mockResolvedValue(undefined);
    // No resolutions (caller didn't see a conflict) but the catalog
    // now contains a colliding name — simulating a concurrent
    // import or another user creating the same name.
    const result = await runZipImport({
      buffer,
      resolutions: [],
      user: baseUser,
      loadVisibleSkills: async () => [
        { id: "skill-foo-1", name: "foo", owner_id: "bob@x" } as AgentSkill,
      ],
      persistSkill: persistSpy,
    });
    if (result.phase !== "import") throw new Error("expected import");
    expect(result.imported[0].outcome).toBe("created");
    expect(result.imported[0].name).toBe("foo (imported)");
    expect(persistSpy.mock.calls[0][0].name).toBe("foo (imported)");
  });
});

// ---------------------------------------------------------------------------
// Parse failures bubble up as ApiError with mapped HTTP status
// ---------------------------------------------------------------------------

describe("runZipImport — parse failures map to HTTP statuses", () => {
  it("returns 400 (invalid_zip) for garbage bytes", async () => {
    const buffer = new Uint8Array([1, 2, 3, 4, 5]).buffer;
    await expect(
      runZipImport({
        buffer,
        user: baseUser,
        loadVisibleSkills: async () => [],
        persistSkill: jest.fn(),
      }),
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  it("returns 400 (no_skills_found) when the zip lacks any SKILL.md", async () => {
    const buffer = await makeZipBuffer({ "README.md": "no skills here" });
    await expect(
      runZipImport({
        buffer,
        user: baseUser,
        loadVisibleSkills: async () => [],
        persistSkill: jest.fn(),
      }),
    ).rejects.toMatchObject({ statusCode: 400 });
  });
});
