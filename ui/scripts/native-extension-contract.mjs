import { readFileSync } from "node:fs";
import { join } from "node:path";

export const CONTRACT_VERSION = "1.1";
const ID = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const RESERVED_HOST_PATHS = [
  "/", "/api", "/_next", "/native-extensions", "/admin", "/agent-builder",
  "/apps", "/autonomous", "/chat", "/credentials", "/dynamic-agents",
  "/insights", "/knowledge-bases", "/login", "/logout", "/schedules",
  "/settings", "/skills", "/unauthorized", "/workflows",
];
const PEERS = ["next", "next-auth", "next-themes", "react", "react-dom"];

export function ownsPath(root, candidate) {
  return candidate === root || candidate.startsWith(`${root}/`);
}

function validPath(path) {
  return typeof path === "string"
    && path.startsWith("/")
    && !path.includes("..")
    && !path.includes("?")
    && !path.includes("#")
    && !path.includes("//")
    && !path.includes("\\")
    && !/%2f|%5c|%2e/i.test(path)
    && !/[\u0000-\u001f\u007f]/.test(path)
    && !path.endsWith("/");
}

export function validateManifest(moduleName, manifest) {
  const fail = (reason) => { throw new Error(`${moduleName}: ${reason}`); };
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) fail("manifest must be an object");
  if (!ID.test(manifest.id ?? "")) fail("invalid extension id");
  if (manifest.contractVersion !== CONTRACT_VERSION) fail(`contractVersion must be ${CONTRACT_VERSION}`);
  if (typeof manifest.displayName !== "string" || !manifest.displayName.trim()) fail("displayName is required");
  if (typeof manifest.description !== "string") fail("description is required");

  const paths = manifest.hostPaths;
  const slots = manifest.slots ?? [];
  if (!Array.isArray(paths) || !Array.isArray(slots) || paths.length + slots.length === 0) {
    fail("at least one host path or slot is required");
  }
  if (slots.some((slot) => slot !== "home")) fail("unsupported slot (supported: home)");
  if (new Set(slots).size !== slots.length) fail("duplicate slot");
  if (paths.some((path) => !validPath(path) || RESERVED_HOST_PATHS.some((reserved) => ownsPath(reserved, path)))) {
    fail("invalid or reserved host path");
  }
  if (new Set(paths).size !== paths.length) fail("duplicate host path");

  if (manifest.navigation !== undefined) {
    const nav = manifest.navigation;
    if (!nav || typeof nav.label !== "string" || !nav.label.trim() || nav.placement !== "after-chat"
      || !validPath(nav.href) || !paths.some((path) => ownsPath(path, nav.href))
      || (nav.icon !== undefined && !["book-open", "layout-grid"].includes(nav.icon))) {
      fail("navigation must reference an owned route and use a supported placement/icon");
    }
  }
  const api = manifest.api;
  if (!api || api.appId !== manifest.id || api.basePath !== `/api/agentic-apps/runtime/${manifest.id}`
    || !Array.isArray(api.mounts) || api.mounts.some((path) => !validPath(path) || !path.startsWith("/api/")
      || ownsPath("/api/agentic-apps", path) || ownsPath("/api/auth", path))) {
    fail("api must declare an authenticated gateway and valid API mounts");
  }
  if (new Set(api.mounts).size !== api.mounts.length) fail("duplicate API mount");
  if (!["app-scoped-token", "forward-user-access-token"].includes(manifest.auth?.mode)) {
    fail("auth.mode must explicitly declare app-scoped-token or forward-user-access-token");
  }
  if (Object.keys(manifest).some((key) => !["id", "displayName", "description", "contractVersion", "hostPaths", "slots", "navigation", "api", "auth"].includes(key))) {
    fail("unknown manifest field");
  }
  return manifest;
}

export function validateOwnership(entries) {
  const ids = new Set();
  const claims = [];
  for (const { moduleName, manifest } of entries) {
    if (ids.has(manifest.id)) throw new Error(`Duplicate native extension id: ${manifest.id}`);
    ids.add(manifest.id);
    for (const path of manifest.hostPaths) claims.push({ moduleName, kind: "host", path });
    for (const path of manifest.api.mounts) claims.push({ moduleName, kind: "api", path });
    for (const slot of manifest.slots ?? []) claims.push({ moduleName, kind: "slot", path: slot });
  }
  for (let left = 0; left < claims.length; left += 1) {
    for (let right = left + 1; right < claims.length; right += 1) {
      const a = claims[left];
      const b = claims[right];
      if (a.kind === b.kind && (a.kind === "slot" ? a.path === b.path : ownsPath(a.path, b.path) || ownsPath(b.path, a.path))) {
        throw new Error(`${a.moduleName} and ${b.moduleName} overlap at ${a.path} / ${b.path}`);
      }
    }
  }
}

export function validatePackage(packageRoot, manifest) {
  const pkg = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8"));
  if (typeof pkg.name !== "string" || typeof pkg.version !== "string") throw new Error("package name and version are required");
  for (const field of [".", "./manifest", "./styles.css"]) {
    if (typeof pkg.exports?.[field] !== "string") throw new Error(`${pkg.name}: missing export ${field}`);
  }
  for (const peer of PEERS) {
    if (!pkg.peerDependencies?.[peer] || pkg.dependencies?.[peer]) {
      throw new Error(`${pkg.name}: ${peer} must be a peer, not a dependency`);
    }
  }
  if (manifest.contractVersion !== CONTRACT_VERSION) throw new Error(`${pkg.name}: incompatible contract version`);
  return pkg;
}

export function validateInstalledPin(uiRoot, packageName, installedVersion) {
  const pkg = JSON.parse(readFileSync(join(uiRoot, "package.json"), "utf8"));
  const lock = JSON.parse(readFileSync(join(uiRoot, "package-lock.json"), "utf8"));
  const spec = pkg.dependencies?.[packageName];
  const entry = lock.packages?.[`node_modules/${packageName}`];
  if (!spec || lock.packages?.[""]?.dependencies?.[packageName] !== spec
    || !entry || entry.version !== installedVersion || !entry.integrity) {
    throw new Error(`${packageName}: install must be recorded with version and integrity in package-lock.json`);
  }
  if (spec !== installedVersion && !/^file:[^\s]+\.tgz$/.test(spec)) {
    throw new Error(`${packageName}: dependency must pin an exact version or a local tarball`);
  }
}
