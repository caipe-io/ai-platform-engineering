import { createRequire } from "node:module";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const uiRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const outputRoot = join(uiRoot, "src", "native-extensions");
const modules = (process.env.CAIPE_NATIVE_EXTENSION_MODULES ?? "")
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean);

const manifests = modules.map((moduleName) => {
  const manifestPath = require.resolve(`${moduleName}/manifest`);
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  validateManifest(moduleName, manifest);
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

function validateManifest(moduleName, manifest) {
  if (!manifest || typeof manifest !== "object") {
    throw new Error(`${moduleName} must export a JSON manifest`);
  }
  if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(manifest.id ?? "")) {
    throw new Error(`${moduleName} has an invalid extension id`);
  }
  if (manifest.contractVersion !== "1.0") {
    throw new Error(`${moduleName} must use native extension contractVersion 1.0`);
  }
  if (!Array.isArray(manifest.hostPaths) || manifest.hostPaths.length === 0) {
    throw new Error(`${moduleName} must claim at least one host path`);
  }
  for (const path of [...manifest.hostPaths, ...(manifest.api?.mounts ?? [])]) {
    if (
      typeof path !== "string"
      || !path.startsWith("/")
      || path.includes("..")
      || path.includes("?")
      || path.includes("#")
      || path.includes("//")
    ) {
      throw new Error(`${moduleName} declares an invalid owned path`);
    }
  }
  for (const path of manifest.hostPaths) {
    if (
      path === "/"
      || path.startsWith("/api")
      || path.startsWith("/_next")
      || path.startsWith("/native-extensions")
    ) {
      throw new Error(`${moduleName} claims a reserved host path`);
    }
  }
  for (const path of manifest.api?.mounts ?? []) {
    if (!path.startsWith("/api/")) {
      throw new Error(`${moduleName} API mounts must be below /api/`);
    }
  }
  if (!manifest.navigation || manifest.navigation.placement !== "after-chat") {
    throw new Error(`${moduleName} must declare an after-chat navigation item`);
  }
  if (
    !manifest.hostPaths.some((path) => owns(path, manifest.navigation.href))
  ) {
    throw new Error(`${moduleName} navigation href must be an owned host path`);
  }
  if (
    manifest.api?.appId !== manifest.id
    || manifest.api?.basePath !== `/api/agentic-apps/runtime/${manifest.id}`
  ) {
    throw new Error(`${moduleName} must declare an authenticated API gateway`);
  }
}

function validateOwnership(entries) {
  const claims = [];
  const extensionIds = new Set();
  for (const { moduleName, manifest } of entries) {
    if (extensionIds.has(manifest.id)) {
      throw new Error(`Duplicate native extension id: ${manifest.id}`);
    }
    extensionIds.add(manifest.id);
    for (const path of manifest.hostPaths) claims.push({ moduleName, kind: "host", path });
    for (const path of manifest.api.mounts) claims.push({ moduleName, kind: "api", path });
  }
  for (let left = 0; left < claims.length; left += 1) {
    for (let right = left + 1; right < claims.length; right += 1) {
      const a = claims[left];
      const b = claims[right];
      if (a.kind !== b.kind) continue;
      if (owns(a.path, b.path) || owns(b.path, a.path)) {
        throw new Error(`${a.moduleName} and ${b.moduleName} overlap at ${a.path} / ${b.path}`);
      }
    }
  }
}

function owns(root, candidate) {
  return candidate === root || candidate.startsWith(`${root}/`);
}
