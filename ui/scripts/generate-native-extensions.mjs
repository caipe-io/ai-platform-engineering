import { createRequire } from "node:module";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  validateBuiltArtifact,
  validateInstalledPin,
  validateManifest,
  validateOwnership,
  validatePackage,
} from "./native-extension-contract.mjs";

const require = createRequire(import.meta.url);
const uiRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const outputRoot = join(uiRoot, "src", "native-extensions");
const modules = (process.env.CAIPE_NATIVE_EXTENSION_MODULES ?? "")
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean);

const manifests = modules.map((moduleName) => {
  if (!/^(?:@[a-z0-9-]+\/)?[a-z0-9-]+$/.test(moduleName)) {
    throw new Error(`Invalid native extension module name: ${moduleName}`);
  }
  const manifestPath = require.resolve(`${moduleName}/manifest`);
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  validateManifest(moduleName, manifest);
  const packageRoot = dirname(manifestPath);
  const pkg = validatePackage(packageRoot, manifest);
  validateBuiltArtifact(packageRoot, pkg);
  if (pkg.name !== moduleName) throw new Error(`${moduleName}: installed package name mismatch`);
  validateInstalledPin(uiRoot, moduleName, pkg.version);
  return { moduleName, manifest };
});

validateOwnership(manifests);
mkdirSync(outputRoot, { recursive: true });

const imports = manifests
  .map(({ moduleName }, index) => `import extension${index} from ${JSON.stringify(moduleName)};`)
  .join("\n");
const entries = manifests
  .map(
    ({ manifest }, index) =>
      `  { manifest: ${JSON.stringify(manifest)}, module: extension${index} },`,
  )
  .join("\n");
writeFileSync(
  join(outputRoot, "installed.generated.tsx"),
  `"use client";\n\n${imports}\n\nimport type { InstalledNativeExtension } from "./types";\n\nexport const installedNativeExtensions: InstalledNativeExtension[] = [\n${entries}\n];\n`,
);

writeFileSync(
  join(outputRoot, "manifests.generated.ts"),
  `import type { NativeExtensionManifest } from "./types";\n\nexport const installedNativeExtensionManifests: NativeExtensionManifest[] = ${JSON.stringify(manifests.map(({ manifest }) => manifest), null, 2)};\n`,
);

writeFileSync(
  join(outputRoot, "styles.generated.css"),
  `${manifests.map(({ moduleName }) => `@import ${JSON.stringify(`${moduleName}/styles.css`)};\n@source ${JSON.stringify(`../../node_modules/${moduleName}/dist`)};`).join("\n")}\n`,
);
