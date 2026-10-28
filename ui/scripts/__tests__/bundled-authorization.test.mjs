import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { validateAgenticAppManifest } from "../../app-sdk/agentic-app-manifest.mjs";
import { readAuthorizationFiles, validateManifest, validatePackage } from "../../app-sdk/checker.mjs";
import { authorizationModelsEqual, validateAuthorizationComposition } from "../../app-sdk/authorization-model.mjs";
import { generateNativeExtensions } from "../generate-native-extensions.mjs";

const uiRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const example = join(uiRoot, "examples/agentic-apps/service-only");
const shared = JSON.parse(readFileSync(join(uiRoot, "examples/agentic-apps/shared/manifest.json"), "utf8"));
const app = JSON.parse(readFileSync(join(example, "manifest.json"), "utf8"));
const core = JSON.parse(readFileSync(join(uiRoot, "../charts/ai-platform-engineering/charts/openfga/authorization-model.json"), "utf8"));

test("declares bundled policy files without creating a fake native UI component", () => {
  assert.equal(validateAgenticAppManifest(app).authorization.module, "example-service");
  assert.equal(validateManifest("@example/service-policy", app), null);
  assert.equal(validateManifest("@example/service-policy", { ...shared, api: { mounts: [] }, ui: { ...shared.ui, profiles: [{ id: "hosted", mode: "iframe" }] }, authorization: app.authorization }), null);
  assert.deepEqual(Object.keys(validatePackage(example, null).exports), ["./manifest"]);
  assert.match(readAuthorizationFiles(example, app).model, /type example_agent_sandbox/);
  for (const model of ["https://example.test/model.fga", "../model.fga", "/model.fga"]) {
    assert.throws(() => validateAgenticAppManifest({ ...app, authorization: { ...app.authorization, model } }), /packaged/);
  }
  assert.throws(() => validateAgenticAppManifest({ ...app, authorization: { ...app.authorization, module: "core" } }), /module/);
});

test("does not follow authorization file symlinks outside the pinned package", () => {
  const root = mkdtempSync(join(tmpdir(), "cas-policy-path-"));
  try {
    mkdirSync(join(root, "package"));
    writeFileSync(join(root, "outside.fga"), "module other");
    symlinkSync(join(root, "outside.fga"), join(root, "package/model.fga"));
    assert.throws(() => readAuthorizationFiles(join(root, "package"), app), /packaged regular/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("protects core policy while retaining legitimate relations named module", () => {
  const baseline = { schema_version: "1.1", type_definitions: [{ type: "example", relations: { module: { this: {} } },
    metadata: { relations: { module: { directly_related_user_types: [{ type: "user" }] } } } }] };
  const changed = structuredClone(baseline);
  changed.type_definitions[0].relations.module = { computedUserset: { relation: "other" } };
  assert.throws(() => validateAuthorizationComposition(changed, baseline, []), /core type/);
  assert.equal(authorizationModelsEqual(core, { ...core, id: "published" }), true);
});

test("build assembles pinned policy-only packages and runs their real OpenFGA tests", { skip: !process.env.FGA_CLI }, () => {
  const root = mkdtempSync(join(tmpdir(), "cas-bundled-build-"));
  try {
    const host = join(root, "ui"); mkdirSync(host);
    mkdirSync(join(host, "native-extension-artifacts"));
    const [packed] = JSON.parse(execFileSync("npm", ["pack", "--json", "--ignore-scripts", "--pack-destination", join(host, "native-extension-artifacts")],
      { cwd: example, encoding: "utf8" }));
    writeFileSync(join(host, "package.json"), JSON.stringify({ private: true, dependencies: {
      "@example/service-policy": `file:native-extension-artifacts/${packed.filename}`,
    } }));
    execFileSync("npm", ["install", "--ignore-scripts", "--offline", "--no-audit", "--no-fund"], { cwd: host, encoding: "utf8" });
    generateNativeExtensions(host, ["@example/service-policy"]);
    const model = JSON.parse(readFileSync(join(host, "authorization/authorization-model.json"), "utf8"));
    validateAuthorizationComposition(model, core, ["example-service"]);
    assert.ok(model.type_definitions.some((type) => type.type === "example_agent_sandbox"));
    const registry = readFileSync(join(host, "src/native-extensions/authorization.generated.ts"), "utf8");
    assert.match(registry, /example-service/);
    assert.doesNotMatch(readFileSync(join(host, "src/native-extensions/installed.generated.tsx"), "utf8"), /import extension/);
    const tests = join(host, "node_modules/@example/service-policy/model.fga.yaml");
    writeFileSync(tests, readFileSync(tests, "utf8").replace("can_exec: false", "can_exec: true"));
    assert.throws(() => generateNativeExtensions(host, ["@example/service-policy"]));
    writeFileSync(tests, readFileSync(join(example, "model.fga.yaml"), "utf8"));
    const policy = join(host, "node_modules/@example/service-policy/model.fga");
    writeFileSync(policy, readFileSync(policy, "utf8") + "\n\nextend type user\n  relations\n    define injected: [user]\n");
    assert.throws(() => generateNativeExtensions(host, ["@example/service-policy"]));
  } finally { rmSync(root, { recursive: true, force: true }); }
});
