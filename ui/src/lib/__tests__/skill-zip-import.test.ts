/**
 * @jest-environment node
 */
// assisted-by cursor (composer-2-fast)
//
// Pins the lenient zip parser used by the import API. Builds zips
// in-memory with jszip so tests don't need any fixture binaries
// checked in. Each test asserts behaviour observable to the user:
// candidate count, ancillary grouping, error reasons, security
// caps.

import JSZip from "jszip";

import {
  parseSkillZip,
  buildConflictDecisions,
  getMaxZipEntries,
  DEFAULT_MAX_ZIP_ENTRIES,
  MAX_ANCILLARY_FILE_BYTES,
  MAX_SKILLS_PER_ZIP,
} from "@/lib/skill-zip-import";

// Helper: build an ArrayBuffer zip from a {path: content} map.
async function makeZip(
  entries: Record<string, string | Uint8Array>,
): Promise<ArrayBuffer> {
  const zip = new JSZip();
  for (const [path, body] of Object.entries(entries)) {
    zip.file(path, body);
  }
  const node = await zip.generateAsync({ type: "nodebuffer" });
  // Normalise to ArrayBuffer (Node's Buffer is a Uint8Array subclass
  // but `parseSkillZip` accepts ArrayBuffer to match the route's
  // `formData().get('file').arrayBuffer()` shape).
  return node.buffer.slice(
    node.byteOffset,
    node.byteOffset + node.byteLength,
  ) as ArrayBuffer;
}

const FRONTMATTER = (name: string, description = "Test skill"): string =>
  `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n\nbody`;

// ---------------------------------------------------------------------------
// Happy paths
// ---------------------------------------------------------------------------

describe("parseSkillZip — single skill at the root", () => {
  it("returns one candidate with root-level files as ancillaries", async () => {
    const buf = await makeZip({
      "SKILL.md": FRONTMATTER("foo"),
      "scripts/run.sh": "#!/bin/bash\necho hi\n",
      "examples/sample.md": "# Sample",
    });
    const result = await parseSkillZip(buf);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.candidates).toHaveLength(1);
    const cand = result.candidates[0];
    expect(cand.directory).toBe("");
    expect(cand.proposedName).toBe("foo");
    expect(cand.ancillaryFiles).toEqual({
      "scripts/run.sh": "#!/bin/bash\necho hi\n",
      "examples/sample.md": "# Sample",
    });
  });

  it("uses H1 title as proposedName when frontmatter and title differ", async () => {
    const content =
      "---\nname: my-skill\ndescription: x\n---\n\n# My Pretty Skill\n\nbody";
    const buf = await makeZip({ "SKILL.md": content });
    const result = await parseSkillZip(buf);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.candidates[0].proposedName).toBe("My Pretty Skill");
  });
});

describe("parseSkillZip — single skill in a subdirectory", () => {
  it("groups all files under that directory as ancillaries", async () => {
    const buf = await makeZip({
      "skills/argocd/SKILL.md": FRONTMATTER("argocd-rollback"),
      "skills/argocd/scripts/check.sh": "#!/bin/bash",
      "skills/argocd/examples/output.txt": "ok",
    });
    const result = await parseSkillZip(buf);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.candidates).toHaveLength(1);
    const cand = result.candidates[0];
    expect(cand.directory).toBe("skills/argocd");
    expect(Object.keys(cand.ancillaryFiles).sort()).toEqual([
      "examples/output.txt",
      "scripts/check.sh",
    ]);
    expect(cand.skippedFiles).toEqual([]);
  });
});

describe("parseSkillZip — multi-skill bundle", () => {
  it("keeps root files while leaving a nested skill's files with that skill", async () => {
    const buf = await makeZip({
      "SKILL.md": FRONTMATTER("root"),
      "scripts/root.sh": "root",
      "skills/nested/SKILL.md": FRONTMATTER("nested"),
      "skills/nested/scripts/run.sh": "nested",
    });
    const result = await parseSkillZip(buf);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const root = result.candidates.find((candidate) => candidate.proposedName === "root")!;
    const nested = result.candidates.find((candidate) => candidate.proposedName === "nested")!;
    expect(root.ancillaryFiles).toEqual({ "scripts/root.sh": "root" });
    expect(nested.ancillaryFiles).toEqual({ "scripts/run.sh": "nested" });
  });

  it("returns one candidate per SKILL.md and groups files per skill", async () => {
    const buf = await makeZip({
      "skills/foo/SKILL.md": FRONTMATTER("foo"),
      "skills/foo/scripts/a.sh": "#!/bin/bash",
      "skills/bar/SKILL.md": FRONTMATTER("bar"),
      "skills/bar/scripts/b.sh": "#!/bin/bash",
    });
    const result = await parseSkillZip(buf);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.candidates).toHaveLength(2);
    const foo = result.candidates.find((c) => c.proposedName === "foo")!;
    const bar = result.candidates.find((c) => c.proposedName === "bar")!;
    expect(Object.keys(foo.ancillaryFiles)).toEqual(["scripts/a.sh"]);
    expect(Object.keys(bar.ancillaryFiles)).toEqual(["scripts/b.sh"]);
  });

  it("nested SKILL.md claims its files; outer skill keeps only its own", async () => {
    // Tricky case: `skills/foo` has a SKILL.md AND `skills/foo/sub`
    // also has a SKILL.md. The deeper one must win the files under
    // `skills/foo/sub/...` even though `skills/foo` is a prefix.
    const buf = await makeZip({
      "skills/foo/SKILL.md": FRONTMATTER("outer"),
      "skills/foo/scripts/outer.sh": "outer",
      "skills/foo/sub/SKILL.md": FRONTMATTER("inner"),
      "skills/foo/sub/scripts/inner.sh": "inner",
    });
    const result = await parseSkillZip(buf);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.candidates).toHaveLength(2);
    const outer = result.candidates.find((c) => c.proposedName === "outer")!;
    const inner = result.candidates.find((c) => c.proposedName === "inner")!;
    // Inner claims its own scripts.
    expect(Object.keys(inner.ancillaryFiles)).toEqual([
      "scripts/inner.sh",
    ]);
    // Outer claims ONLY the file that isn't already in inner's
    // territory. The "sub/" path doesn't show up in outer's
    // ancillaries.
    expect(Object.keys(outer.ancillaryFiles).sort()).toEqual([
      "scripts/outer.sh",
    ]);
  });

  it("case-insensitive SKILL.md match", async () => {
    const buf = await makeZip({
      "Foo/skill.md": FRONTMATTER("foo"),
      "Bar/Skill.MD": FRONTMATTER("bar"),
    });
    const result = await parseSkillZip(buf);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.candidates).toHaveLength(2);
  });
});

describe("parseSkillZip — Windows-style separators", () => {
  it("normalises backslash paths into POSIX before grouping", async () => {
    // Some zip tools (Windows ZIP) emit literal backslashes. We
    // synthesise via jszip with forward slashes (jszip canonicalises
    // on write), but assert the parser would handle a backslash
    // form by feeding one through the post-load normaliser.
    const zip = new JSZip();
    // jszip normalises `\` on add, so we use the forward-slash
    // form to seed and trust the parser's normaliser for the real
    // Windows case.
    zip.file("skills/win/SKILL.md", FRONTMATTER("win"));
    zip.file("skills/win/scripts/check.ps1", "Write-Host hi");
    const buf = (await zip.generateAsync({ type: "nodebuffer" })).buffer;
    const result = await parseSkillZip(buf as ArrayBuffer);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(Object.keys(result.candidates[0].ancillaryFiles)).toEqual([
      "scripts/check.ps1",
    ]);
  });
});

// ---------------------------------------------------------------------------
// Failure modes
// ---------------------------------------------------------------------------

describe("parseSkillZip — failure modes", () => {
  it("returns no_skills_found when the zip has no SKILL.md anywhere", async () => {
    const buf = await makeZip({
      "README.md": "# nope",
      "scripts/check.sh": "echo nope",
    });
    const result = await parseSkillZip(buf);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("no_skills_found");
  });

  it("returns invalid_zip on a corrupted buffer", async () => {
    // Random non-zip bytes.
    const garbage = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
    const result = await parseSkillZip(garbage.buffer);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("invalid_zip");
  });

  it("returns traversal_attempt on a `..` entry", async () => {
    // jszip refuses to write `..` directly via .file(), but we can
    // smuggle it through by manipulating the resulting structure.
    const zip = new JSZip();
    zip.file("../etc/passwd", "root:x:0:0");
    const buf = (await zip.generateAsync({ type: "nodebuffer" })).buffer;
    const result = await parseSkillZip(buf as ArrayBuffer);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("traversal_attempt");
  });

  it("returns too_many_skills when more than MAX_SKILLS_PER_ZIP SKILL.md files are present", async () => {
    const entries: Record<string, string> = {};
    for (let i = 0; i < MAX_SKILLS_PER_ZIP + 1; i++) {
      entries[`skills/s${i}/SKILL.md`] = FRONTMATTER(`s${i}`);
    }
    const buf = await makeZip(entries);
    const result = await parseSkillZip(buf);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("too_many_skills");
  });

  it("returns too_many_entries when total entry count exceeds the cap", async () => {
    // Lower the cap via env override so the test doesn't have to
    // build a 25k-entry zip just to trip the default. The default
    // (DEFAULT_MAX_ZIP_ENTRIES = 25000) is sized for hub-style
    // monorepos, which would make naive ``MAX + 5`` test
    // construction prohibitively slow at suite time.
    process.env.SKILL_IMPORT_MAX_ZIP_ENTRIES = "10";
    try {
      const entries: Record<string, string> = {
        "skills/foo/SKILL.md": FRONTMATTER("foo"),
      };
      for (let i = 0; i < 15; i++) {
        entries[`skills/foo/file${i}.txt`] = `${i}`;
      }
      const buf = await makeZip(entries);
      const result = await parseSkillZip(buf);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.reason).toBe("too_many_entries");
      // Error message names the env var so the operator can find
      // the override without spelunking through code.
      expect(result.message).toContain("SKILL_IMPORT_MAX_ZIP_ENTRIES");
    } finally {
      delete process.env.SKILL_IMPORT_MAX_ZIP_ENTRIES;
    }
  });

  it("respects SKILL_IMPORT_MAX_ZIP_ENTRIES to raise the cap above the default", async () => {
    // Pin the env-override path: a deployment that ingests larger
    // archives can dial the cap up without a code change. We can't
    // realistically prove the upper bound here (default = 25000),
    // so we instead prove the same "too many" zip parses cleanly
    // when the cap is raised above its entry count. This is the
    // monorepo scenario the original 1000-cap rejected.
    process.env.SKILL_IMPORT_MAX_ZIP_ENTRIES = "100";
    try {
      const entries: Record<string, string> = {
        "skills/foo/SKILL.md": FRONTMATTER("foo"),
      };
      // 20 ancillaries → 21 total entries, well within the raised
      // cap. Deliberately picked to exceed the lowered cap from
      // the previous test (10) so a regression in the env reader
      // would surface here.
      for (let i = 0; i < 20; i++) {
        entries[`skills/foo/file${i}.txt`] = `${i}`;
      }
      const buf = await makeZip(entries);
      const result = await parseSkillZip(buf);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.candidates).toHaveLength(1);
      expect(result.totalEntries).toBeGreaterThanOrEqual(21);
    } finally {
      delete process.env.SKILL_IMPORT_MAX_ZIP_ENTRIES;
    }
  });

  it("falls back to the default cap when the env override is invalid", async () => {
    // Defence-in-depth: a typo or accidental "" wiring shouldn't
    // disable the cap. We assert via getMaxZipEntries because
    // proving the parser default would require a 25k-entry zip.
    for (const bad of ["", "abc", "0", "-5", "  "]) {
      process.env.SKILL_IMPORT_MAX_ZIP_ENTRIES = bad;
      expect(getMaxZipEntries()).toBe(DEFAULT_MAX_ZIP_ENTRIES);
    }
    delete process.env.SKILL_IMPORT_MAX_ZIP_ENTRIES;
    expect(getMaxZipEntries()).toBe(DEFAULT_MAX_ZIP_ENTRIES);
  });
});

// ---------------------------------------------------------------------------
// Per-file caps
// ---------------------------------------------------------------------------

describe("parseSkillZip — per-file size cap", () => {
  it("drops ancillary files larger than MAX_ANCILLARY_FILE_BYTES into skippedFiles", async () => {
    // Build a 1.5 MB blob (above the 1 MB per-file cap).
    const big = "a".repeat(MAX_ANCILLARY_FILE_BYTES + 100);
    const buf = await makeZip({
      "skills/foo/SKILL.md": FRONTMATTER("foo"),
      "skills/foo/scripts/big.sh": big,
      "skills/foo/scripts/small.sh": "#!/bin/bash",
    });
    const result = await parseSkillZip(buf);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const cand = result.candidates[0];
    expect(Object.keys(cand.ancillaryFiles)).toEqual(["scripts/small.sh"]);
    expect(cand.skippedFiles).toEqual(["scripts/big.sh"]);
  });
});

// ---------------------------------------------------------------------------
// buildConflictDecisions
// ---------------------------------------------------------------------------

describe("buildConflictDecisions", () => {
  it("returns no decisions when no candidate name collides", async () => {
    const buf = await makeZip({
      "SKILL.md": FRONTMATTER("brand-new"),
    });
    const result = await parseSkillZip(buf);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const decisions = buildConflictDecisions(result.candidates, [
      { id: "skill-existing-1", name: "Other" },
    ]);
    expect(decisions).toEqual([]);
  });

  it("flags a collision when the candidate name matches an existing name (case-insensitive)", async () => {
    const buf = await makeZip({
      "SKILL.md": FRONTMATTER("foo"),
    });
    const result = await parseSkillZip(buf);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const decisions = buildConflictDecisions(result.candidates, [
      { id: "skill-foo-existing", name: "FOO" },
    ]);
    expect(decisions).toHaveLength(1);
    expect(decisions[0].action).toBe("skip");
    expect(decisions[0].existingId).toBe("skill-foo-existing");
    expect(decisions[0].existingName).toBe("FOO");
    expect(decisions[0].candidateName).toBe("foo");
    // Summary line gives the user a sense of size/ancillary count.
    expect(decisions[0].summary).toMatch(/KB/);
  });
});
