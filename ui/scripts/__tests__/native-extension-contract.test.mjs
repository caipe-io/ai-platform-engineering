import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { tailwindSourceForEntry } from "../native-extension-source.mjs";
import { RESERVED_API_PATHS, validateBuiltArtifact, validateInstalledPin, validateManifest, validateOwnership, validatePackage } from "../native-extension-contract.mjs";

const example = {
  id: "example-app",
  displayName: "Example App",
  description: "Example",
  contractVersion: "2.0",
  hostPaths: ["/example"],
  navigation: { label: "Example", href: "/example", placement: "after-chat" },
  api: { appId: "example-app", basePath: "/api/agentic-apps/runtime/example-app", mounts: ["/api/example"] },
  auth: { mode: "app-scoped-token" },
};

test("accepts a routeful advertised app", () => {
  assert.equal(validateManifest("example", example).id, "example-app");
});

test("accepts the current and explicit legacy CAIPE App Contract versions, but rejects unknown versions", () => {
  for (const contractVersion of ["2.0", "1.1"]) {
    assert.equal(validateManifest("example", { ...example, contractVersion }).contractVersion, contractVersion);
  }
  for (const contractVersion of ["1.0", "2.1", "3.0", undefined]) {
    assert.throws(() => validateManifest("example", { ...example, contractVersion }), /contractVersion/);
  }
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

test("rejects runtime assistant paths in legacy descriptors", () => {
  const assistant = { agentId: "agent-example", label: "Ask Example", name: "Example Assistant", streamPath: "/api/example/chat" };
  for (const contractVersion of ["1.1", "2.0"]) assert.throws(() => validateManifest("example", { ...example, contractVersion, assistant }), /apiVersion 2.0/);
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

test("rejects API mounts that overlap CAIPE routes and keeps reservations in sync", () => {
  for (const mount of [...RESERVED_API_PATHS, ...RESERVED_API_PATHS.map((path) => `${path}/example`)]) {
    assert.throws(
      () => validateManifest("reserved-api", { ...example, api: { ...example.api, mounts: [mount] } }),
      /API mounts/,
    );
  }
  assert.equal(validateManifest("owned-api", { ...example, api: { ...example.api, mounts: ["/api/example-owned"] } }).id, "example-app");

  const apiRoot = join(dirname(fileURLToPath(import.meta.url)), "../../src/app/api");
  const routeRoots = new Set();
  const visit = (directory) => {
    for (const item of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, item.name);
      if (item.isDirectory()) visit(path);
      else if (item.isFile() && item.name === "route.ts") {
        const firstSegment = relative(apiRoot, path).split(/[\\/]/)[0];
        routeRoots.add(`/api/${firstSegment}`);
      }
    }
  };
  visit(apiRoot);
  assert.deepEqual([...RESERVED_API_PATHS].sort(), [...routeRoots].sort());
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
    for (const selector of [
      'body { margin: 0; }',
      '* { display: none; }',
      '.example, body { display: none; }',
      '@layer base { body { display: none; } }',
      '@media (min-width: 1px) { @supports (display: grid) { .example, html { display: none; } } }',
      '.example, :root { --foreground: red; }',
    ]) {
      writeFileSync(css, selector);
      assert.throws(() => validateBuiltArtifact(root, pkg), /unscoped document selector/, selector);
    }
    writeFileSync(css, '@layer components { .example-app, .example-app[data-value=","] { color: red; content: "body {"; } .example-app { & > * { color: blue; } } } @keyframes example-spin { from { opacity: 0; } 50%, to { opacity: 1; } }');
    assert.equal(validateBuiltArtifact(root, pkg).entryBytes > 0, true);
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

test("only accepts pinned tarballs inside the native artifact directory", () => {
  const root = mkdtempSync(join(tmpdir(), "native-pin-"));
  try {
    const packageName = "@example/native-app";
    const spec = "file:native-extension-artifacts/native-app-1.0.0.tgz";
    writeFileSync(join(root, "package.json"), JSON.stringify({ dependencies: { [packageName]: spec } }));
    writeFileSync(join(root, "package-lock.json"), JSON.stringify({
      packages: {
        "": { dependencies: { [packageName]: spec } },
        [`node_modules/${packageName}`]: { version: "1.0.0", integrity: "sha512-test" },
      },
    }));
    validateInstalledPin(root, packageName, "1.0.0");

    const unsafeSpec = "file:../../tmp/native-app-1.0.0.tgz";
    writeFileSync(join(root, "package.json"), JSON.stringify({ dependencies: { [packageName]: unsafeSpec } }));
    writeFileSync(join(root, "package-lock.json"), JSON.stringify({
      packages: {
        "": { dependencies: { [packageName]: unsafeSpec } },
        [`node_modules/${packageName}`]: { version: "1.0.0", integrity: "sha512-test" },
      },
    }));
    assert.throws(() => validateInstalledPin(root, packageName, "1.0.0"), /local tarball/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("derives Tailwind source paths from the resolved package entry", () => {
  const styles = "/workspace/ui/src/native-extensions/styles.generated.css";
  assert.equal(
    tailwindSourceForEntry(styles, "/workspace/ui/node_modules/example-app/index.js"),
    "../../node_modules/example-app",
  );
  assert.equal(
    tailwindSourceForEntry(styles, "/workspace/ui/node_modules/example-app/dist/index.js"),
    "../../node_modules/example-app/dist",
  );
});
