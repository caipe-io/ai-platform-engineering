import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { validateBuiltArtifact, validateManifest, validateOwnership, validatePackage } from "../native-extension-contract.mjs";

const example = {
  id: "example-app",
  displayName: "Example App",
  description: "Example",
  contractVersion: "1.1",
  hostPaths: ["/example"],
  navigation: { label: "Example", href: "/example", placement: "after-chat" },
  api: { appId: "example-app", basePath: "/api/agentic-apps/runtime/example-app", mounts: ["/api/example"] },
  auth: { mode: "app-scoped-token" },
};

test("accepts a routeful advertised app", () => {
  assert.equal(validateManifest("example", example).id, "example-app");
});

test("accepts an internal route without navigation", () => {
  const internal = { ...example, navigation: undefined };
  assert.equal(validateManifest("internal", internal).id, "example-app");
});

test("validates an optional native assistant claim", () => {
  const assistant = { agentId: "agent-example", label: "Ask Example", name: "Example Assistant" };
  assert.equal(validateManifest("assistant", { ...example, assistant }).assistant.agentId, "agent-example");
  assert.throws(() => validateManifest("assistant", { ...example, assistant: { ...assistant, agentId: "../other" } }), /assistant/);
  assert.throws(() => validateManifest("assistant", { ...example, assistant: { ...assistant, route: "/chat" } }), /assistant/);
});

test("accepts a route-less app in a declared slot", () => {
  const internal = { ...example, navigation: undefined };
  assert.equal(validateManifest("slot", { ...internal, hostPaths: [], slots: ["home"] }).id, "example-app");
});

test("rejects missing surface, unsafe paths, and undeclared auth", () => {
  assert.throws(() => validateManifest("empty", { ...example, hostPaths: [], navigation: undefined }), /path or slot/);
  assert.throws(() => validateManifest("unsafe", { ...example, hostPaths: ["//evil"] }), /host path/);
  assert.throws(() => validateManifest("auth", { ...example, auth: undefined }), /auth.mode/);
  assert.throws(() => validateManifest("nav", { ...example, navigation: { ...example.navigation, href: "/chat" } }), /navigation/);
});

test("rejects overlapping host paths and slots", () => {
  assert.throws(() => validateOwnership([
    { moduleName: "a", manifest: example },
    { moduleName: "b", manifest: { ...example, id: "other", hostPaths: ["/example/detail"], api: { ...example.api, mounts: ["/api/other"] } } },
  ]), /overlap/);
  assert.throws(() => validateOwnership([
    { moduleName: "a", manifest: { ...example, slots: ["home"] } },
    { moduleName: "b", manifest: { ...example, id: "other", slots: ["home"], hostPaths: ["/other"], api: { ...example.api, mounts: ["/api/other"] } } },
  ]), /overlap/);
});

test("rejects server exports and lifecycle hooks", () => {
  const root = mkdtempSync(join(tmpdir(), "native-contract-"));
  try {
    const pkg = {
      name: "example-package", version: "1.0.0",
      exports: { ".": "./dist/index.mjs", "./manifest": "./manifest.json", "./styles.css": "./dist/index.css" },
      peerDependencies: { next: "*", "next-auth": "*", "next-themes": "*", react: "*", "react-dom": "*" },
    };
    writeFileSync(join(root, "package.json"), JSON.stringify({ ...pkg, exports: { ...pkg.exports, "./server": "./dist/server.mjs" } }));
    assert.throws(() => validatePackage(root, example), /server or undeclared entry/);
    writeFileSync(join(root, "package.json"), JSON.stringify({ ...pkg, scripts: { postinstall: "node setup.js" } }));
    assert.throws(() => validatePackage(root, example), /browser-only/);
    writeFileSync(join(root, "package.json"), JSON.stringify({ ...pkg, exports: { ...pkg.exports, ".": "./../server.mjs" } }));
    assert.throws(() => validatePackage(root, example), /unsafe export target/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("rejects colliding API mounts", () => {
  assert.throws(() => validateOwnership([
    { moduleName: "a", manifest: example },
    { moduleName: "b", manifest: { ...example, id: "other", hostPaths: ["/other"], api: { ...example.api, mounts: ["/api/example/subpath"] } } },
  ]), /overlap/);
});

test("rejects server imports, global CSS, and oversized entry bundles", () => {
  const root = mkdtempSync(join(tmpdir(), "native-artifact-"));
  try {
    mkdirSync(join(root, "dist"));
    const pkg = { name: "example-package", exports: { ".": "./dist/index.mjs", "./styles.css": "./dist/index.css" } };
    const entry = join(root, "dist", "index.mjs");
    const css = join(root, "dist", "index.css");
    writeFileSync(entry, '"use client";\nexport default {};\n');
    writeFileSync(css, '.example-app { color: red; }');
    assert.equal(validateBuiltArtifact(root, pkg).entryBytes > 0, true);
    writeFileSync(entry, '"use client";\nimport { cookies } from "next/headers";');
    assert.throws(() => validateBuiltArtifact(root, pkg), /server-only module/);
    writeFileSync(entry, '"use client";\nexport default {};\n');
    writeFileSync(css, 'body { margin: 0; }');
    assert.throws(() => validateBuiltArtifact(root, pkg), /unscoped document selector/);
    writeFileSync(css, '.example-app { color: red; }');
    writeFileSync(entry, `"use client";\n${" ".repeat(65 * 1024)}`);
    assert.throws(() => validateBuiltArtifact(root, pkg), /entry exceeds/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("accepts compiled files at the package root", () => {
  const root = mkdtempSync(join(tmpdir(), "native-root-artifact-"));
  try {
    writeFileSync(join(root, "index.mjs"), '"use client";\nimport "./client.mjs";');
    writeFileSync(join(root, "client.mjs"), "export const ready = true;");
    writeFileSync(join(root, "styles.css"), ".example-app { color: red; }");
    const pkg = { name: "example-package", exports: { ".": "./index.mjs", "./styles.css": "./styles.css" } };
    assert.equal(validateBuiltArtifact(root, pkg).javascriptBytes > 0, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
