import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const uiRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const sdkRoot = join(uiRoot, "app-sdk");

test("packed app SDK installs without frameworks and exposes its types, validators, and CLIs", () => {
  const temporaryRoot = mkdtempSync(join(tmpdir(), "app-sdk-package-"));
  try {
    const [packed] = JSON.parse(execFileSync("npm", [
      "pack", "--json", "--ignore-scripts", "--pack-destination", temporaryRoot,
    ], { cwd: sdkRoot, encoding: "utf8" }));
    const source = JSON.parse(readFileSync(join(sdkRoot, "package.json"), "utf8"));
    assert.equal(packed.name, "@caipe-io/app-sdk");
    assert.equal(packed.version, source.version);
    const files = new Set(packed.files.map((item) => item.path));
    for (const file of ["README.md", "LICENSE", "index.d.ts", "index.mjs", "checker.mjs",
      "contract-version.mjs", "contract-version.d.mts", "agentic-app-manifest.mjs",
      "agentic-app-manifest.d.mts", "native-manifest.d.mts", "bin/check.mjs", "bin/check-manifest.mjs"]) {
      assert.ok(files.has(file), `Missing packed file: ${file}`);
    }
    const consumer = join(temporaryRoot, "consumer");
    mkdirSync(consumer);
    writeFileSync(join(consumer, "package.json"), JSON.stringify({ private: true, type: "module" }));
    execFileSync("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund", "--offline",
      join(temporaryRoot, packed.filename)], { cwd: consumer, encoding: "utf8" });
    const lock = JSON.parse(readFileSync(join(consumer, "package-lock.json"), "utf8"));
    assert.deepEqual(Object.keys(lock.packages).sort(), ["", "node_modules/@caipe-io/app-sdk"]);
    execFileSync(process.execPath, ["--input-type=module", "-e", `
      import assert from "node:assert/strict";
      import { CHECKER_VERSION, CONTRACT_VERSION } from "@caipe-io/app-sdk";
      import { validateAgenticAppManifest } from "@caipe-io/app-sdk/manifest-contract";
      import { isSupportedNativeContractVersion } from "@caipe-io/app-sdk/contract-version";
      import { validateManifest } from "@caipe-io/app-sdk/checker";
      assert.equal(CHECKER_VERSION, ${JSON.stringify(source.version)});
      assert.equal(CONTRACT_VERSION, "2.0");
      assert.equal(isSupportedNativeContractVersion("1.1"), true);
      assert.equal(typeof validateAgenticAppManifest, "function");
      assert.equal(typeof validateManifest, "function");
    `], { cwd: consumer, encoding: "utf8" });
    const manifest = join(uiRoot, "examples/agentic-apps/shared/manifest.json");
    const checked = execFileSync(join(consumer, "node_modules/.bin/caipe-app-check"), [manifest],
      { cwd: consumer, encoding: "utf8" });
    assert.match(checked, /AgenticAppManifest 2\.0/);
    const artifact = join(temporaryRoot, "example-app");
    mkdirSync(join(artifact, "dist"), { recursive: true });
    const declaration = JSON.parse(readFileSync(manifest, "utf8"));
    const profile = declaration.ui.profiles.find((item) => item.mode === "native-package");
    writeFileSync(join(artifact, "manifest.json"), JSON.stringify(declaration));
    writeFileSync(join(artifact, "package.json"), JSON.stringify({
      name: profile.package, version: declaration.version,
      exports: { ".": "./dist/index.mjs", "./manifest": "./manifest.json", "./styles.css": "./dist/index.css" },
      peerDependencies: { next: "16.3.8", "next-auth": "4.24.15", "next-themes": "0.4.6", react: "19.2.8", "react-dom": "19.2.8" },
    }));
    writeFileSync(join(artifact, "dist/index.mjs"), '"use client";\nexport const contractVersion = "2.0";\nexport function Component() { return null; }\n');
    writeFileSync(join(artifact, "dist/index.css"), ".example-app { display: block; }\n");
    const native = execFileSync(join(consumer, "node_modules/.bin/caipe-native-check"), [artifact],
      { cwd: consumer, encoding: "utf8" });
    assert.ok(native.includes(`SDK ${source.version}`));
    writeFileSync(join(consumer, "types.mts"), `
      import { validateAgenticAppManifest, nativeUiDescriptor } from "@caipe-io/app-sdk/manifest-contract";
      import type { AgenticAppManifest } from "@caipe-io/app-sdk/manifest-contract";
      const app: AgenticAppManifest = validateAgenticAppManifest({});
      const contractVersion: "2.0" | "1.1" | undefined = nativeUiDescriptor(app)?.contractVersion;
      void contractVersion;
    `);
    writeFileSync(join(consumer, "tsconfig.json"), JSON.stringify({
      compilerOptions: { noEmit: true, strict: true, module: "NodeNext", moduleResolution: "NodeNext", target: "ES2022", types: [] },
      files: ["types.mts"],
    }));
    execFileSync(process.execPath, [join(uiRoot, "node_modules/typescript/bin/tsc"),
      "--project", "tsconfig.json"], { cwd: consumer, encoding: "utf8" });
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
});
