import { createRequire } from "node:module";
import { copyFileSync, mkdirSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { tailwindSourceForEntry } from "./native-extension-source.mjs";
import {
  normalizeNativeExtensionManifest,
  resolveAgenticAppIcon,
  validateAgenticAppManifest,
} from "../app-sdk/agentic-app-manifest.mjs";
import {
  validateBuiltArtifact,
  validateInstalledPin,
  validateManifest,
  validateOwnership,
  validatePackage,
  readPackageManifest,
  resolveNativePackageRoot,
} from "./native-extension-contract.mjs";

/** Native app logo assets travel with the pinned package, under an owned namespace. */
export function installAppIcon(uiRoot, packageRoot, manifest) {
  const icon = resolveAgenticAppIcon(manifest.id, manifest.catalog?.icon);
  if (!icon) return;
  const source = realpathSync(join(packageRoot, "public", icon.slice(1)));
  const location = relative(realpathSync(packageRoot), source);
  if (isAbsolute(location) || location.startsWith("..") || !statSync(source).isFile() || statSync(source).size > 256 * 1024)
    throw new Error(`${manifest.id}: catalog icon must be a packaged image of at most 256 KiB`);
  const target = join(uiRoot, "public", icon.slice(1));
  mkdirSync(dirname(target), { recursive: true });
  copyFileSync(source, target);
}

export function generateNativeExtensions(
  uiRoot = join(dirname(fileURLToPath(import.meta.url)), ".."),
  modules = (process.env.CAIPE_NATIVE_EXTENSION_MODULES ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean),
) {
  const require = createRequire(join(uiRoot, "package.json"));
  const outputRoot = join(uiRoot, "src", "native-extensions");

  const manifests = modules.map((moduleName) => {
    if (!/^(?:@[a-z0-9-]+\/)?[a-z0-9-]+$/.test(moduleName)) {
      throw new Error(`Invalid native extension module name: ${moduleName}`);
    }
    const entryPath = require.resolve(moduleName);
    const packageRoot = resolveNativePackageRoot(entryPath, moduleName);
    const declaration = readPackageManifest(packageRoot);
    const manifest = validateManifest(moduleName, declaration);
    const pkg = validatePackage(packageRoot, manifest);
    validateBuiltArtifact(packageRoot, pkg);
    if (pkg.name !== moduleName)
      throw new Error(`${moduleName}: installed package name mismatch`);
    validateInstalledPin(uiRoot, moduleName, pkg.version);
    const appManifest =
      declaration.apiVersion === "2.0"
        ? validateAgenticAppManifest(declaration)
        : normalizeNativeExtensionManifest(manifest, moduleName, pkg.version);
    if (
      appManifest.version !== pkg.version ||
      appManifest.ui.profiles.find(
        (profile) => profile.mode === "native-package",
      )?.package !== moduleName
    ) {
      throw new Error(
        `${moduleName}: application version/package must match the artifact`,
      );
    }
    installAppIcon(uiRoot, packageRoot, appManifest);
    return {
      moduleName,
      manifest,
      appManifest,
      legacy: declaration.apiVersion !== "2.0",
      entryPath,
    };
  });

  validateOwnership(manifests);
  mkdirSync(outputRoot, { recursive: true });

  const imports = manifests
    .map(
      ({ moduleName }, index) =>
        `import extension${index} from ${JSON.stringify(moduleName)};`,
    )
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
    `import type { NativeExtensionManifest } from "./types";\nimport type { AgenticAppManifest } from "@/types/agentic-app";\n\nexport const installedAgenticAppManifests: AgenticAppManifest[] = ${JSON.stringify(
      manifests.map(({ appManifest }) => appManifest),
      null,
      2,
    )};\n\nexport const installedLegacyNativeExtensionIds: string[] = ${JSON.stringify(manifests.filter(({ legacy }) => legacy).map(({ manifest }) => manifest.id))};\n\nexport const installedNativeExtensionManifests: NativeExtensionManifest[] = ${JSON.stringify(
      manifests.map(({ manifest }) => manifest),
      null,
      2,
    )};\n`,
  );

  writeFileSync(
    join(outputRoot, "styles.generated.css"),
    `${manifests.map(({ moduleName, entryPath }) => `@import ${JSON.stringify(`${moduleName}/styles.css`)};\n@source ${JSON.stringify(tailwindSourceForEntry(join(outputRoot, "styles.generated.css"), entryPath))};`).join("\n")}\n`,
  );
}

if (import.meta.main) generateNativeExtensions();
