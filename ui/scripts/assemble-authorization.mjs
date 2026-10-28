import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { dump as dumpYaml, load as loadYaml } from "js-yaml";
import { readAuthorizationFiles } from "../app-sdk/checker.mjs";
import { validateAuthorizationComposition } from "../app-sdk/authorization-model.mjs";

const hostRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

/** Build one tested model from pinned host extensions. No runtime catalog is input. */
export function assembleAuthorization(uiRoot, packages) {
  const core = JSON.parse(readFileSync(join(hostRoot, "charts/ai-platform-engineering/charts/openfga/authorization-model.json"), "utf8"));
  const policies = packages.filter(({ appManifest }) => appManifest.authorization);
  const modules = policies.map(({ appManifest, moduleName }) => ({
    appId: appManifest.id, module: appManifest.authorization.module, packageName: moduleName, version: appManifest.version,
  }));
  if (new Set(modules.map((entry) => entry.module)).size !== modules.length) throw new Error("Duplicate bundled authorization module");
  let model = core;
  const work = mkdtempSync(join(uiRoot, ".authorization-build-"));
  try {
    if (policies.length) {
      const cli = process.env.FGA_CLI || "fga";
      const run = (args) => execFileSync(cli, ["--config", "cli.yaml", "--api-url", "http://127.0.0.1:8080", ...args], { cwd: work, encoding: "utf8", timeout: 120_000,
        maxBuffer: 8 * 1024 * 1024, env: { ...process.env, FGA_API_URL: "", FGA_STORE_ID: "", FGA_MODEL_ID: "" } });
      writeFileSync(join(work, "cli.yaml"), "{}\n");
      const source = readFileSync(join(hostRoot, "deploy/openfga/model.fga"), "utf8");
      if (!/\bmodel\s*\n\s*schema 1\.1\b/.test(source)) throw new Error("Core OpenFGA source header is unsupported");
      writeFileSync(join(work, "core.fga"), source.replace(/\bmodel\s*\n\s*schema 1\.1\b/, "module core"));
      const fixtures = [];
      for (const { packageRoot, appManifest } of policies) {
        const files = readAuthorizationFiles(packageRoot, appManifest);
        writeFileSync(join(work, `${appManifest.id}.fga`), files.model);
        const fixture = loadYaml(files.tests);
        if (!fixture || typeof fixture !== "object" || Array.isArray(fixture) ||
            Object.keys(fixture).some((key) => !["name", "tuples", "tests"].includes(key)) ||
            !Array.isArray(fixture.tests) || !fixture.tests.length || fixture.tests.some((test) =>
              !test || test.tuple_file || test.tuple_files || !["check", "list_objects", "list_users"].some((key) => test[key]?.length))) {
          throw new Error(`${appManifest.id}: policy tests must contain assertions and inline tuples; the host supplies the model`);
        }
        fixtures.push([appManifest.id, fixture]);
      }
      writeFileSync(join(work, "fga.mod"), dumpYaml({ schema: "1.2", contents: ["core.fga", ...modules.map((entry) => `${entry.appId}.fga`)] }));
      model = JSON.parse(run(["model", "transform", "--file", "fga.mod", "--output-format", "json"]));
      validateAuthorizationComposition(model, core, modules.map((entry) => entry.module));
      writeFileSync(join(work, "authorization-model.json"), JSON.stringify(model));
      for (const [appId, fixture] of fixtures) {
        const path = `${appId}.fga.yaml`;
        writeFileSync(join(work, path), dumpYaml({ ...fixture, name: appId, model_file: "authorization-model.json" }));
        run(["model", "test", "--tests", path]);
      }
    }
    const output = join(uiRoot, "authorization");
    mkdirSync(output, { recursive: true });
    writeFileSync(join(output, "authorization-model.json"), JSON.stringify(model, null, 2) + "\n");
    writeFileSync(join(output, "core-authorization-model.json"), JSON.stringify(core, null, 2) + "\n");
    writeFileSync(join(output, "bundle.json"), JSON.stringify({ modules }, null, 2) + "\n");
    return { model, modules };
  } finally { rmSync(work, { recursive: true, force: true }); }
}
