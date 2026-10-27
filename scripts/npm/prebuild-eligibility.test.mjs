import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

const root = resolve(import.meta.dirname, "../..");
const workflow = name => readFileSync(resolve(root, ".github/workflows", name), "utf8");
const automatic = workflow("prebuild-caipe-ui.yml");
const manual = workflow("prebuild-manual.yml");
const block = manual.match(/^ {10}script: \|\n((?: {12}[^\n]*\n|\n)+)/m);
assert.ok(block, "manual prebuild metadata script must exist");
const script = block[1].split("\n").map(line => line.slice(12)).join("\n");
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const resolvePr = new AsyncFunction("process", "context", "github", "core", script);

async function manualEligibility(file, target) {
  const outputs = {};
  await resolvePr(
    { env: { PR_NUMBER: "1", TARGET: target } },
    { repo: { owner: "example", repo: "example" }, actor: "test-user" },
    {
      rest: {
        repos: { getCollaboratorPermissionLevel: async () => ({ data: { permission: "write" } }) },
        pulls: {
          get: async () => ({ data: {
            number: 1, state: "open",
            head: { repo: { full_name: "example/example" }, ref: "prebuild/example", sha: "head" },
            base: { ref: "main", sha: "base" },
          } }),
          listFiles: () => {},
        },
      },
      paginate: async () => [{ filename: file }],
    },
    { setOutput: (key, value) => { outputs[key] = value; }, info: () => {}, setFailed: assert.fail },
  );
  return outputs.caipe_ui_changed;
}

test("automatic prebuild trigger and inner eligibility include shared npm scripts", () => {
  assert.match(automatic, /- 'scripts\/npm\/\*\*'/);
  const comparison = automatic.match(/if git diff --name-only[^]*?\| grep -q \.; then/);
  assert.ok(comparison, "prebuild changed-file comparison must exist");
  assert.match(comparison[0], /^\s+scripts\/npm\s+\\$/m);
});

for (const target of ["all", "docker", "caipe-ui"]) {
  test(`manual ${target} prebuild selects UI for a scripts-only change`, async () => {
    assert.equal(await manualEligibility("scripts/npm/example.mjs", target), "true");
    assert.equal(await manualEligibility("scripts/npm/nested/example.mjs", target), "true");
  });
}

for (const file of ["docs/example.md", "scripts/example.mjs", "scripts/npm-example/example.mjs"]) {
  test(`manual prebuild excludes unrelated ${file} changes from UI selection`, async () => {
    assert.equal(await manualEligibility(file, "all"), "false");
  });
}

test("UI retains the RBAC regression command alongside the security postinstall hook", () => {
  const { scripts } = JSON.parse(readFileSync(resolve(root, "ui/package.json"), "utf8"));
  assert.match(scripts["test:e2e:rbac-regression"], /^WORKFLOWS_ENABLED=true playwright test /);
  assert.match(scripts["test:e2e:rbac-regression"], /--config=playwright\.rbac\.config\.ts$/);
  assert.match(scripts.postinstall, /patch-security-dependencies\.mjs/);
});
