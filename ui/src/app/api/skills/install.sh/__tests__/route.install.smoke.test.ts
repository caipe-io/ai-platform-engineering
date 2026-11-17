/**
 * @jest-environment node
 *
 * Runtime smoke tests for the generated install script. These execute the
 * emitted bash in a sandbox with a fake curl binary so we catch destructive
 * dotfile mutations, not just string-shape regressions.
 *
 * assisted-by Codex Codex-sonnet-4-6
 */

import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

jest.mock("next/server", () => {
  class MockResponse {
    body: string;
    status: number;
    headers: Map<string, string>;
    constructor(
      body: string,
      init?: { status?: number; headers?: Record<string, string> },
    ) {
      this.body = body;
      this.status = init?.status ?? 200;
      this.headers = new Map(Object.entries(init?.headers ?? {}));
    }
    text() {
      return Promise.resolve(this.body);
    }
  }
  return { NextResponse: MockResponse };
});

import { GET } from "../route";

interface MockRes {
  body: string;
  status: number;
}

const callRaw = async (url: string): Promise<MockRes> =>
  (await GET(new Request(url))) as unknown as MockRes;

function writeFakeCurl(binDir: string): void {
  const curlPath = join(binDir, "curl");
  writeFileSync(
    curlPath,
    `#!/usr/bin/env bash
set -euo pipefail
out=""
url=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    -o) out="$2"; shift 2 ;;
    -w) shift 2 ;;
    -H) shift 2 ;;
    -sS|-f|-L|-fsSL) shift ;;
    *) url="$1"; shift ;;
  esac
done
case "$url" in
  *"/api/skills/live-skills"*) printf '%s' '{"template":"---\\nname: caipe-skills\\ndescription: Browse\\n---\\n\\n# Browse\\n"}' > "$out" ;;
  *"/api/skills/update-skills"*) printf '%s' '{"template":"---\\nname: update-caipe-skills\\ndescription: Refresh\\n---\\n\\n# Refresh\\n"}' > "$out" ;;
  *"/api/skills/helpers/caipe-skills.py"*) printf '# helper\\n' > "$out" ;;
  *"/api/skills/hooks/caipe-catalog.sh"*) printf '#!/usr/bin/env bash\\n' > "$out" ;;
  *"/api/skills?"*) if [ -n "\${FAKE_CATALOG_JSON:-}" ]; then printf '%s' "$FAKE_CATALOG_JSON" > "$out"; else printf '{}' > "$out"; fi ;;
  *) printf '{}' > "$out" ;;
esac
printf '200'
`,
    { mode: 0o755 },
  );
  chmodSync(curlPath, 0o755);
}

describe("GET /api/skills/install.sh — install runtime smoke", () => {
  it.each(["--force", "--upgrade"])("keeps the first eligible install path with %s", async (flag) => {
    const res = await callRaw("https://app.example.test/api/skills/install.sh?agent=claude&scope=user");
    const dir = mkdtempSync(join(tmpdir(), "catalog-identity-"));
    try {
      const home = join(dir, "home"), bin = join(dir, "bin");
      mkdirSync(bin, { recursive: true });
      writeFakeCurl(bin);
      const script = join(dir, "install.sh");
      writeFileSync(script, res.body, { mode: 0o755 });
      const env = { ...process.env, HOME: home, PATH: `${bin}:${process.env.PATH ?? ""}`, CAIPE_CATALOG_KEY: "fake-test-key",
        FAKE_CATALOG_JSON: JSON.stringify({ skills: [
          { id: "builtin", name: "Review", content: "preferred", scan_status: "passed" },
          { id: "hub", name: "Review", content: "lower priority", scan_status: "passed" },
          { id: "flagged", name: "Fallback", content: "unsafe", scan_status: "flagged" },
          { id: "allowed", name: "Fallback", content: "safe fallback", scan_status: "passed" },
          { id: "slash", name: "Review/Code", content: "first path", scan_status: "passed" },
          { id: "question", name: "Review?Code", content: "same sanitized path", scan_status: "passed" },
        ] }),
      };
      execFileSync("bash", [script, "--no-hook"], { env, stdio: "pipe" });
      execFileSync("bash", [script, "--no-hook", flag], { env, stdio: "pipe" });
      for (const root of [".claude/skills", ".agents/skills"]) {
        expect(readFileSync(join(home, root, "Review/SKILL.md"), "utf8")).toBe("preferred");
        expect(readFileSync(join(home, root, "Fallback/SKILL.md"), "utf8")).toBe("safe fallback");
        expect(readFileSync(join(home, root, "Review_Code/SKILL.md"), "utf8")).toBe("first path");
      }
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("installs helper skills into Claude native and vendor-neutral skill trees", async () => {
    const res = await callRaw(
      "https://app.example.com/api/skills/install.sh?agent=claude&scope=user",
    );
    expect(res.status).toBe(200);

    const dir = mkdtempSync(join(tmpdir(), "caipe-install-"));
    try {
      const home = join(dir, "home");
      const bin = join(dir, "bin");
      mkdirSync(bin, { recursive: true });
      writeFakeCurl(bin);

      const scriptPath = join(dir, "install.sh");
      writeFileSync(scriptPath, res.body, { mode: 0o755 });
      execFileSync("bash", [scriptPath, "--no-bulk", "--no-hook"], {
        env: {
          ...process.env,
          HOME: home,
          PATH: `${bin}:${process.env.PATH ?? ""}`,
          CAIPE_CATALOG_KEY: "fake-test-key",
        },
        stdio: "pipe",
      });

      for (const root of [".claude/skills", ".agents/skills"]) {
        expect(
          existsSync(join(home, root, "caipe-skills", "SKILL.md")),
        ).toBe(true);
        expect(
          existsSync(join(home, root, "update-caipe-skills", "SKILL.md")),
        ).toBe(true);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("preserves existing Claude settings while registering the CAIPE hook", async () => {
    const res = await callRaw(
      "https://app.example.com/api/skills/install.sh?agent=claude&scope=user",
    );
    expect(res.status).toBe(200);

    const dir = mkdtempSync(join(tmpdir(), "caipe-install-"));
    try {
      const home = join(dir, "home");
      const bin = join(dir, "bin");
      mkdirSync(join(home, ".claude"), { recursive: true });
      mkdirSync(bin, { recursive: true });
      writeFakeCurl(bin);

      const settingsPath = join(home, ".claude", "settings.json");
      writeFileSync(
        settingsPath,
        JSON.stringify(
          {
            env: {
              ANTHROPIC_BASE_URL: "https://llm-proxy.example.invalid",
              ANTHROPIC_API_KEY: "REDACTED",
              ANTHROPIC_MODEL: "bedrock/global.anthropic.claude-sonnet-4-6",
              CLAUDE_MODEL: "bedrock/global.anthropic.claude-sonnet-4-6",
              CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS: "1",
              CAIPE_BASE_URL: "http://localhost:3000",
            },
            effortLevel: "medium",
            skipDangerousModePermissionPrompt: true,
            theme: "dark",
            hooks: {
              SessionStart: [
                {
                  hooks: [
                    {
                      type: "command",
                      command: "$HOME/.claude/hooks/caipe-catalog.sh",
                      timeout: 5,
                    },
                  ],
                },
              ],
            },
          },
          null,
          2,
        ) + "\n",
      );

      const scriptPath = join(dir, "install.sh");
      writeFileSync(scriptPath, res.body, { mode: 0o755 });
      execFileSync("bash", [scriptPath, "--no-bulk", "--no-helpers"], {
        env: {
          ...process.env,
          HOME: home,
          PATH: `${bin}:${process.env.PATH ?? ""}`,
          CAIPE_CATALOG_KEY: "fake-test-key",
        },
        stdio: "pipe",
      });

      const settings = JSON.parse(readFileSync(settingsPath, "utf8"));
      expect(settings.env).toEqual({
        ANTHROPIC_BASE_URL: "https://llm-proxy.example.invalid",
        ANTHROPIC_API_KEY: "REDACTED",
        ANTHROPIC_MODEL: "bedrock/global.anthropic.claude-sonnet-4-6",
        CLAUDE_MODEL: "bedrock/global.anthropic.claude-sonnet-4-6",
        CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS: "1",
        CAIPE_BASE_URL: "http://localhost:3000",
      });
      expect(settings.effortLevel).toBe("medium");
      expect(settings.skipDangerousModePermissionPrompt).toBe(true);
      expect(settings.theme).toBe("dark");
      expect(settings.hooks.SessionStart).toHaveLength(1);
      expect(settings.hooks.SessionStart[0].hooks).toEqual([
        {
          type: "command",
          command: "$HOME/.claude/hooks/caipe-catalog.sh",
          timeout: 5,
        },
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("backs up existing Claude settings before adding the CAIPE hook", async () => {
    const res = await callRaw(
      "https://app.example.com/api/skills/install.sh?agent=claude&scope=user",
    );
    expect(res.status).toBe(200);

    const dir = mkdtempSync(join(tmpdir(), "caipe-install-"));
    try {
      const home = join(dir, "home");
      const bin = join(dir, "bin");
      mkdirSync(join(home, ".claude"), { recursive: true });
      mkdirSync(bin, { recursive: true });
      writeFakeCurl(bin);

      const settingsPath = join(home, ".claude", "settings.json");
      const originalSettings = JSON.stringify(
        {
          env: {
            ANTHROPIC_BASE_URL: "https://llm-proxy.example.invalid",
            ANTHROPIC_API_KEY: "REDACTED",
          },
          theme: "dark",
        },
        null,
        2,
      ) + "\n";
      writeFileSync(settingsPath, originalSettings);

      const scriptPath = join(dir, "install.sh");
      writeFileSync(scriptPath, res.body, { mode: 0o755 });
      execFileSync("bash", [scriptPath, "--no-bulk", "--no-helpers"], {
        env: {
          ...process.env,
          HOME: home,
          PATH: `${bin}:${process.env.PATH ?? ""}`,
          CAIPE_CATALOG_KEY: "fake-test-key",
        },
        stdio: "pipe",
      });

      const backupNames = readdirSync(join(home, ".claude")).filter((name) =>
        /^settings\.json\.caipe-backup-\d{8}T\d{6}Z$/.test(name),
      );
      expect(backupNames).toHaveLength(1);
      expect(readFileSync(join(home, ".claude", backupNames[0]), "utf8")).toBe(
        originalSettings,
      );

      const settings = JSON.parse(readFileSync(settingsPath, "utf8"));
      expect(settings.env.ANTHROPIC_BASE_URL).toBe(
        "https://llm-proxy.example.invalid",
      );
      expect(settings.theme).toBe("dark");
      expect(settings.hooks.SessionStart).toHaveLength(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("upgrade preserves manifest-owned Claude skill copies", async () => {
    const res = await callRaw(
      "https://app.example.com/api/skills/install.sh?agent=claude&scope=user",
    );
    expect(res.status).toBe(200);

    const dir = mkdtempSync(join(tmpdir(), "caipe-install-"));
    try {
      const home = join(dir, "home");
      const bin = join(dir, "bin");
      const oldSkillPath = join(home, ".claude", "skills", "demo", "SKILL.md");
      const keptSkillPath = join(home, ".agents", "skills", "demo", "SKILL.md");
      const manifestPath = join(home, ".config", "caipe", "installed.json");
      mkdirSync(join(home, ".claude"), { recursive: true });
      mkdirSync(join(home, ".claude", "skills", "demo"), { recursive: true });
      mkdirSync(join(home, ".agents", "skills", "demo"), { recursive: true });
      mkdirSync(join(home, ".config", "caipe"), { recursive: true });
      mkdirSync(bin, { recursive: true });
      writeFakeCurl(bin);
      writeFileSync(oldSkillPath, "# old claude copy\n");
      writeFileSync(keptSkillPath, "# agents copy\n");
      writeFileSync(
        manifestPath,
        JSON.stringify(
          {
            version: 2,
            installed: [
              {
                agent: "claude",
                scope: "user",
                name: "demo",
                kind: "skill",
                paths: [oldSkillPath, keptSkillPath],
                installed_at: "2026-05-01T00:00:00+00:00",
              },
            ],
          },
          null,
          2,
        ) + "\n",
      );

      const scriptPath = join(dir, "install.sh");
      writeFileSync(scriptPath, res.body, { mode: 0o755 });
      execFileSync("bash", [scriptPath, "--upgrade", "--no-bulk", "--no-helpers"], {
        env: {
          ...process.env,
          HOME: home,
          PATH: `${bin}:${process.env.PATH ?? ""}`,
          CAIPE_CATALOG_KEY: "fake-test-key",
        },
        stdio: "pipe",
      });

      expect(existsSync(oldSkillPath)).toBe(true);
      expect(existsSync(keptSkillPath)).toBe(true);
      const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
      expect(manifest.installed[0].paths).toEqual([oldSkillPath, keptSkillPath]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
