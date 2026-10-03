import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

export const CONTRACT_VERSION = "1.1";
export const CHECKER_VERSION = "1.1.2";
export const MAX_ENTRY_BYTES = 64 * 1024;
export const MAX_JAVASCRIPT_BYTES = 2 * 1024 * 1024;
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
  if (manifest.assistant !== undefined) {
    const assistant = manifest.assistant;
    if (!assistant || typeof assistant !== "object" || Array.isArray(assistant)
      || typeof assistant.agentId !== "string" || !ID.test(assistant.agentId)
      || typeof assistant.label !== "string" || !assistant.label.trim() || assistant.label.length > 48
      || typeof assistant.name !== "string" || !assistant.name.trim() || assistant.name.length > 80
      || Object.keys(assistant).some((key) => !["agentId", "label", "name"].includes(key))) {
      fail("assistant must declare a valid agentId, label, and name");
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
  if (Object.keys(manifest).some((key) => !["id", "displayName", "description", "contractVersion", "hostPaths", "slots", "navigation", "assistant", "api", "auth"].includes(key))) {
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
    const target = pkg.exports?.[field];
    if (typeof target !== "string") throw new Error(`${pkg.name}: missing export ${field}`);
    if (!target.startsWith("./") || target.includes("..") || target.includes("\\") || /[?#]/.test(target)) {
      throw new Error(`${pkg.name}: unsafe export target ${field}`);
    }
  }
  if (Object.keys(pkg.exports).some((field) => ![".", "./manifest", "./styles.css"].includes(field))) {
    throw new Error(`${pkg.name}: native packages may not export a server or undeclared entry point`);
  }
  if (pkg.main || pkg.bin || pkg.scripts?.start || pkg.scripts?.postinstall) {
    throw new Error(`${pkg.name}: native packages must be browser-only build artifacts`);
  }
  for (const peer of PEERS) {
    if (!pkg.peerDependencies?.[peer] || pkg.dependencies?.[peer]) {
      throw new Error(`${pkg.name}: ${peer} must be a peer, not a dependency`);
    }
  }
  if (manifest.contractVersion !== CONTRACT_VERSION) throw new Error(`${pkg.name}: incompatible contract version`);
  return pkg;
}

/** Check the published artifact, not only its source manifest. */
export function validateBuiltArtifact(packageRoot, pkg) {
  const entry = join(packageRoot, pkg.exports["."]);
  const entrySource = readFileSync(entry, "utf8");
  if (!/^\s*["']use client["'];/.test(entrySource)) {
    throw new Error(`${pkg.name}: browser entry must start with use client`);
  }
  if (statSync(entry).size > MAX_ENTRY_BYTES) {
    throw new Error(`${pkg.name}: entry exceeds ${MAX_ENTRY_BYTES} bytes`);
  }
  const javascript = compiledJavaScriptFiles(packageRoot);
  if (javascript.length === 0) throw new Error(`${pkg.name}: no compiled JavaScript found`);
  let totalBytes = 0;
  for (const file of javascript) {
    const path = join(packageRoot, file);
    totalBytes += statSync(path).size;
    const source = readFileSync(path, "utf8");
    if (/(?:from\s*|import\s*\()\s*["'](?:node:|server-only|next\/(?:server|headers|cache)|next-auth\/next)/.test(source)) {
      throw new Error(`${pkg.name}: ${file} imports a server-only module`);
    }
  }
  if (totalBytes > MAX_JAVASCRIPT_BYTES) {
    throw new Error(`${pkg.name}: compiled JavaScript exceeds ${MAX_JAVASCRIPT_BYTES} bytes`);
  }
  const css = readFileSync(join(packageRoot, pkg.exports["./styles.css"]), "utf8");
  if (/(?:^|})\s*(?:html|body|:root|\*)\b[^{}]*\{/m.test(css)) {
    throw new Error(`${pkg.name}: stylesheet contains an unscoped document selector`);
  }
  return { entryBytes: statSync(entry).size, javascriptBytes: totalBytes };
}

function compiledJavaScriptFiles(packageRoot) {
  const files = [];
  const visit = (directory) => {
    for (const item of readdirSync(directory, { withFileTypes: true })) {
      if (item.name === "node_modules" || item.name.startsWith(".")) continue;
      const path = join(directory, item.name);
      if (item.isDirectory()) visit(path);
      else if (item.isFile() && /\.(?:mjs|js)$/.test(item.name)) {
        files.push(relative(packageRoot, path));
      }
    }
  };
  visit(packageRoot);
  return files;
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
