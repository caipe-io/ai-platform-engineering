import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { test } from "node:test";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  validateAgenticAppManifest,
  validateAgenticAppOwnership,
  normalizeNativeExtensionManifest,
  normalizeLegacyAgenticAppManifest,
  nativeUiDescriptor,
  resolveAgenticAppIcon,
} from "../../app-sdk/agentic-app-manifest.mjs";
import { validateManifest } from "../../app-sdk/checker.mjs";
import { generateNativeExtensions, installAppIcon } from "../generate-native-extensions.mjs";

export function exampleManifest() {
  return {
    id: "example-app",
    displayName: "Example App",
    description: "Example",
    apiVersion: "2.0",
    version: "1.0.0",
    ui: {
      profiles: [
        {
          id: "native",
          mode: "native-package",
          package: "@example/native-app",
          contractVersion: "2.0",
        },
      ],
      routes: [{ id: "home", path: "/example" }],
      navigation: {
        label: "Example",
        routeRef: "home",
        placement: "after-chat",
      },
    },
    api: { mounts: ["/api/example"] },
    auth: { mode: "app-scoped-token" },
    surfaces: { showInHub: true },
    access: { requiredRoles: ["user"], tokenScopes: [], policyActions: [] },
    provides: { mcp: ["example-mcp"], agents: [], workflows: [] },
    consumes: { platformApis: [] },
    requestedPermissions: [
      { resourceType: "agent", resourceRef: "assistant", actions: ["use"] },
    ],
  };
}

test("app icons are owned same-origin assets; legacy symbolic names remain compatible", () => {
  const app = exampleManifest();
  const icon = "/app-icons/example-app/logo.svg";
  assert.equal(validateAgenticAppManifest({ ...app, catalog: { icon } }).catalog.icon, icon);
  assert.equal(resolveAgenticAppIcon(app.id, icon), icon);
  assert.equal(resolveAgenticAppIcon(app.id, "book-open"), undefined);
  assert.doesNotThrow(() => validateAgenticAppManifest({ ...app, catalog: { icon: "book-open" } }));
  for (const unsafe of ["//example.test/logo.svg", "https://example.test/logo.svg", "data:image/svg+xml,evil", "/app-icons/other/logo.svg", "/app-icons/example-app/../logo.svg", "/app-icons/example-app/%2e.svg", "/app-icons/example-app/logo.svg?x=1", "/api/example/logo.svg"]) {
    assert.equal(resolveAgenticAppIcon(app.id, unsafe), undefined);
    assert.throws(() => validateAgenticAppManifest({ ...app, catalog: { icon: unsafe } }), /catalog.icon/);
  }
});

test("native logo installation requires a bounded asset inside the pinned package", () => {
  const root = mkdtempSync(join(tmpdir(), "app-icon-"));
  try {
    const pkg = join(root, "package");
    const host = join(root, "host");
    const icon = "/app-icons/example-app/logo.png";
    const app = { ...exampleManifest(), catalog: { icon } };
    const asset = join(pkg, "public", icon);
    mkdirSync(join(pkg, "public", "app-icons", "example-app"), { recursive: true });
    assert.throws(() => installAppIcon(host, pkg, app), /ENOENT/);
    writeFileSync(asset, "example-image");
    installAppIcon(host, pkg, app);
    assert.equal(readFileSync(join(host, "public", icon), "utf8"), "example-image");
    writeFileSync(asset, Buffer.alloc(256 * 1024 + 1));
    assert.throws(() => installAppIcon(host, pkg, app), /256 KiB/);
    rmSync(asset);
    writeFileSync(join(root, "outside.png"), "outside");
    symlinkSync(join(root, "outside.png"), asset);
    assert.throws(() => installAppIcon(host, pkg, app), /packaged image/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("publisher and host use the exported nested manifest, not a root decoy", () => {
  const root = mkdtempSync(join(tmpdir(), "nested-native-manifest-"));
  try {
    const packageName = "@example/native-app";
    const packageRoot = join(root, "node_modules", "@example", "native-app");
    mkdirSync(join(packageRoot, "dist", "client"), { recursive: true });
    const app = exampleManifest();
    const pkg = {
      name: packageName, version: app.version,
      exports: { ".": "./dist/client/index.mjs", "./manifest": "./dist/manifest.json", "./styles.css": "./dist/styles.css" },
      peerDependencies: { next: "*", "next-auth": "*", "next-themes": "*", react: "*", "react-dom": "*" },
    };
    writeFileSync(join(packageRoot, "package.json"), JSON.stringify(pkg));
    writeFileSync(join(packageRoot, "dist", "manifest.json"), JSON.stringify(app));
    writeFileSync(join(packageRoot, "manifest.json"), JSON.stringify({ id: "ignored-root-decoy" }));
    writeFileSync(join(packageRoot, "dist", "client", "index.mjs"), '"use client";\nexport default {};');
    writeFileSync(join(packageRoot, "dist", "styles.css"), ".example-app { color: red; }");
    writeFileSync(join(root, "package.json"), JSON.stringify({ dependencies: { [packageName]: app.version } }));
    writeFileSync(join(root, "package-lock.json"), JSON.stringify({ packages: {
      "": { dependencies: { [packageName]: app.version } },
      [`node_modules/${packageName}`]: { version: app.version, integrity: "sha512-example" },
    } }));
    const cli = fileURLToPath(new URL("../../app-sdk/bin/check.mjs", import.meta.url));
    assert.match(execFileSync(process.execPath, [cli, packageRoot], { encoding: "utf8" }), /conforms/);
    generateNativeExtensions(root, [packageName]);
    assert.match(readFileSync(join(root, "src", "native-extensions", "manifests.generated.ts"), "utf8"), /example-app/);
    assert.doesNotMatch(readFileSync(join(root, "src", "native-extensions", "manifests.generated.ts"), "utf8"), /ignored-root-decoy/);
    writeFileSync(join(packageRoot, "dist", "manifest.json"), JSON.stringify({ ...app, version: "2.0.0" }));
    assert.throws(() => execFileSync(process.execPath, [cli, packageRoot], { stdio: "pipe" }), /application version\/package/);
    assert.throws(() => generateNativeExtensions(root, [packageName]), /application version\/package/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("one manifest projects onto the aligned 2.0 native component contract", () => {
  const common = validateAgenticAppManifest(exampleManifest());
  const ui = validateManifest("@example/native-app", common);
  assert.equal(ui.navigation.href, "/example");
  assert.equal(ui.contractVersion, "2.0");
  assert.equal(common.access.requiredRoles[0], "user");
  assert.deepEqual(
    common.requestedPermissions,
    exampleManifest().requestedPermissions,
  );
  assert.equal(common.grants, undefined);
});

test("preserves legacy CAIPE App Contract declarations instead of silently relabeling modules", () => {
  const legacy = exampleManifest();
  legacy.ui.profiles[0].contractVersion = "1.1";
  assert.equal(nativeUiDescriptor(validateAgenticAppManifest(legacy)).contractVersion, "1.1");
  legacy.ui.profiles[0].contractVersion = "3.0";
  assert.throws(() => validateAgenticAppManifest(legacy), /contractVersion/);
});

test("native and iframe profiles share service and capability identity", () => {
  const app = exampleManifest();
  app.ui.profiles.push({ id: "hosted", mode: "iframe" });
  app.runtime = { kind: "proxied-next-zone", mountPath: "/apps/example-app" };
  app.access.policyActions = [{ action: "proxy:GET", defaultEffect: "allow" }];
  assert.equal(validateAgenticAppManifest(app).id, "example-app");
  assert.equal(nativeUiDescriptor(app).api.appId, app.id);
});

test("service-only and route-less native apps are supported without inventing agent capabilities", () => {
  const app = exampleManifest();
  app.ui = { profiles: [], routes: [] };
  app.api.mounts = [];
  app.surfaces.showInHub = false;
  assert.equal(nativeUiDescriptor(validateAgenticAppManifest(app)), null);
  const slot = exampleManifest();
  slot.ui.routes = [];
  delete slot.ui.navigation;
  slot.ui.slots = ["home"];
  assert.deepEqual(validateManifest("@example/native-app", slot).slots, [
    "home",
  ]);
});

test("legacy native navigation preserves subroutes while normalizing identity", () => {
  const legacy = {
    id: "example-app",
    displayName: "Example",
    description: "Example",
    contractVersion: "1.1",
    hostPaths: ["/example"],
    navigation: {
      label: "Example",
      href: "/example/details",
      placement: "after-chat",
    },
    api: { mounts: [] },
    auth: { mode: "app-scoped-token" },
  };
  const common = normalizeNativeExtensionManifest(
    legacy,
    "@example/native-app",
    "1.0.0",
  );
  validateAgenticAppManifest(common);
  assert.equal(common.ui.profiles[0].contractVersion, "1.1");
  assert.equal(nativeUiDescriptor(common).navigation.href, "/example/details");
});

test("legacy hosted input normalizes without manufacturing a package version", () => {
  const common = normalizeLegacyAgenticAppManifest({
    id: "example-app",
    apiVersion: "1.0",
    runtime: { mountPath: "/apps/example-app" },
  });
  assert.equal(common.apiVersion, "2.0");
  assert.equal(common.version, undefined);
  assert.equal(common.ui.profiles[0].mode, "iframe");
});

test("required future capabilities fail closed; optional references remain declarations", () => {
  const app = exampleManifest();
  app.consumes.platformApis = [
    { id: "agents.invocation", version: "1.0", required: true },
  ];
  assert.throws(() => validateAgenticAppManifest(app), /unsupported required/);
  app.consumes.platformApis[0].required = false;
  assert.equal(validateAgenticAppManifest(app).consumes.platformApis.length, 1);
});

test("permission declarations cannot smuggle grants or broaden existing policy", () => {
  const app = exampleManifest();
  assert.throws(
    () => validateAgenticAppManifest({ ...app, grants: ["admin"] }),
    /unknown field/,
  );
  app.requestedPermissions[0].subject = "other-user";
  assert.throws(() => validateAgenticAppManifest(app), /unknown field/);
});

test("rejects ambiguous profiles, references, reserved paths and unbound origins", () => {
  const mutations = [
    (app) => {
      app.version = "01.0.0";
    },
    (app) => {
      app.version = "1.0.0-01";
    },
    (app) => {
      app.access.policyActions = [
        { action: "proxy:GET", defaultEffect: "allow", requiredScopes: null },
      ];
    },
    (app) => {
      app.access.requiredRoles = null;
    },
    (app) => app.ui.profiles.push({ ...app.ui.profiles[0], id: "other" }),
    (app) => {
      app.ui.navigation.routeRef = "missing";
    },
    (app) => {
      app.ui.routes[0].path = "/admin";
    },
    (app) => {
      app.api.mounts = ["/api/auth"];
    },
    (app) => {
      app.runtime = {
        kind: "proxied-next-zone",
        mountPath: "/apps/example-app",
        origin: "https://example.test",
      };
    },
    (app) => {
      app.version = "latest";
    },
  ];
  for (const mutate of mutations) {
    const app = exampleManifest();
    mutate(app);
    assert.throws(() => validateAgenticAppManifest(app));
  }
});

test("ownership validation covers overlapping routes, API mounts and slots", () => {
  const primary = exampleManifest(),
    secondary = exampleManifest();
  secondary.id = "secondary-app";
  secondary.ui.routes[0].path = "/example/details";
  assert.throws(
    () => validateAgenticAppOwnership([primary, secondary]),
    /overlap/,
  );
  secondary.ui.routes[0].path = "/secondary";
  assert.throws(
    () => validateAgenticAppOwnership([primary, secondary]),
    /overlap/,
  );
  secondary.api.mounts = ["/api/secondary"];
  primary.ui.slots = secondary.ui.slots = ["home"];
  assert.throws(
    () => validateAgenticAppOwnership([primary, secondary]),
    /overlap/,
  );
});

test("the build registry is generated from one pinned application declaration", () => {
  const root = mkdtempSync(join(tmpdir(), "app-registry-"));
  try {
    const packageName = "@example/native-app";
    const pkgRoot = join(root, "node_modules", packageName);
    mkdirSync(pkgRoot, { recursive: true });
    writeFileSync(
      join(root, "package.json"),
      JSON.stringify({ dependencies: { [packageName]: "1.0.0" } }),
    );
    writeFileSync(
      join(root, "package-lock.json"),
      JSON.stringify({
        packages: {
          "": { dependencies: { [packageName]: "1.0.0" } },
          [`node_modules/${packageName}`]: {
            version: "1.0.0",
            integrity: "sha512-example",
          },
        },
      }),
    );
    writeFileSync(
      join(pkgRoot, "package.json"),
      JSON.stringify({
        name: packageName,
        version: "1.0.0",
        exports: {
          ".": "./index.mjs",
          "./manifest": "./manifest.json",
          "./styles.css": "./styles.css",
        },
        peerDependencies: {
          react: "*",
          "react-dom": "*",
          next: "*",
          "next-auth": "*",
          "next-themes": "*",
        },
      }),
    );
    writeFileSync(
      join(pkgRoot, "manifest.json"),
      JSON.stringify(exampleManifest()),
    );
    writeFileSync(
      join(pkgRoot, "index.mjs"),
      '"use client"; export default { contractVersion: "2.0", Component: () => null };',
    );
    writeFileSync(join(pkgRoot, "styles.css"), ".example-app {color: inherit}");
    generateNativeExtensions(root, [packageName]);
    const registry = readFileSync(
      join(root, "src/native-extensions/manifests.generated.ts"),
      "utf8",
    );
    assert.match(registry, /installedAgenticAppManifests/);
    assert.match(registry, /"apiVersion": "2.0"/);
    assert.match(
      registry,
      /installedLegacyNativeExtensionIds: string\[\] = \[\]/,
    );
    assert.match(registry, /"contractVersion": "2.0"/);
    const declaration = exampleManifest();
    declaration.version = "2.0.0";
    writeFileSync(join(pkgRoot, "manifest.json"), JSON.stringify(declaration));
    assert.throws(
      () => generateNativeExtensions(root, [packageName]),
      /version\/package/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
