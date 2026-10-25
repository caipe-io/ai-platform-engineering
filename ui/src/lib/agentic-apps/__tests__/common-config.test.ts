/** @jest-environment node */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import example from "../../../../examples/agentic-apps/shared/manifest.json";
import {
  validateAgenticAppManifest,
  normalizeNativeExtensionManifest,
} from "../../../../app-sdk/agentic-app-manifest.mjs";
import {
  installedAgenticAppManifests,
  installedLegacyNativeExtensionIds,
} from "@/native-extensions/manifests.generated";
import { canLaunchAgenticApp } from "../access";
import { loadConfiguredAgenticApps } from "../config";
import {
  agenticAppEntryHref,
  buildPublicAgenticApp,
  nativeAgenticAppDestination,
} from "../public-app";

jest.mock("@/native-extensions/manifests.generated", () => ({
  installedAgenticAppManifests: [],
  installedLegacyNativeExtensionIds: [],
}));

describe("shared application installation", () => {
  const previousEnabled = process.env.AGENTIC_APPS_INSTALL_ENABLED;
  beforeEach(() => {
    process.env.AGENTIC_APPS_INSTALL_ENABLED = "true";
    installedAgenticAppManifests.splice(0);
    installedLegacyNativeExtensionIds.splice(0);
  });
  afterAll(() => {
    if (previousEnabled === undefined)
      delete process.env.AGENTIC_APPS_INSTALL_ENABLED;
    else process.env.AGENTIC_APPS_INSTALL_ENABLED = previousEnabled;
  });

  function configured(
    manifest: unknown | undefined,
    installation: Record<string, unknown>,
  ) {
    const dir = mkdtempSync(join(tmpdir(), "app-installation-"));
    const file = join(dir, "apps.yaml");
    try {
      writeFileSync(
        file,
        JSON.stringify({
          agentic_apps: {
            packages: manifest ? [{ package_id: "example-app", manifest }] : [],
            installations: [{ app_id: "example-app", ...installation }],
          },
        }),
      );
      return loadConfiguredAgenticApps(file);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it("one compiled manifest supports selecting either UI with the same services and capabilities", () => {
    installedAgenticAppManifests.push(validateAgenticAppManifest({ ...example, ui: { ...example.ui,
      assistant: { agentId: "example-agent", label: "Ask example", name: "Example assistant" } } }));
    for (const profile of ["native", "hosted"]) {
      const [app] = configured(undefined, {
        selected_ui_profile: profile,
        app_version: "1.0.0",
        bindings: {
          runtimeOrigin: "https://runtime.example.test",
          resources: { assistant: "example-agent" },
        },
      });
      expect(app.manifest.provides.mcp).toEqual(["example-mcp"]);
      expect(app.installation.bindings.resources.assistant).toBe(
        "example-agent",
      );
      expect(agenticAppEntryHref(app)).toBe(
        profile === "native" ? "/example" : "/apps/example-app",
      );
      expect(buildPublicAgenticApp(app, true)).not.toHaveProperty("bindings");
    }
  });

  it.each(["../invalid", "agent with spaces"])("rejects an invalid bound assistant identity %s", id => {
    const manifest = { ...example, ui: { ...example.ui, assistant: { agentId: "example-agent", label: "Ask", name: "Example" } } };
    expect(() => configured(manifest, { selected_ui_profile: "hosted", bindings: { resources: { assistant: id } } })).toThrow(/invalid assistant agent ID/);
  });

  it("rejects a runtime request to enable native code missing from the image", () => {
    expect(() =>
      configured(example, {
        selected_ui_profile: "native",
        bindings: { runtimeOrigin: "https://runtime.example.test" },
      }),
    ).toThrow(/not compiled/);
  });

  it("reads the service-account client id an installed app calls the host with", () => {
    const [app] = configured(example, {
      selected_ui_profile: "hosted",
      bindings: {
        runtimeOrigin: "https://runtime.example.test",
        serviceAccountClientId: "example-client",
      },
    });
    expect(app.installation.bindings?.serviceAccountClientId).toBe("example-client");
  });

  it("rejects a service-account client id that is not a string", () => {
    expect(() =>
      configured(example, {
        selected_ui_profile: "hosted",
        bindings: { runtimeOrigin: "https://runtime.example.test", serviceAccountClientId: 7 },
      }),
    ).toThrow(/serviceAccountClientId/);
  });

  it("rejects a client id shared by two application installations", () => {
    const manifests = ["primary", "secondary"].map((id) =>
      validateAgenticAppManifest({
        ...example,
        id,
        ui: { profiles: [], routes: [] },
        api: { mounts: [] },
        runtime: undefined,
        surfaces: { showInHub: false },
      }),
    );
    installedAgenticAppManifests.push(...manifests);
    const dir = mkdtempSync(join(tmpdir(), "app-installation-"));
    const file = join(dir, "apps.json");
    try {
      writeFileSync(file, JSON.stringify({ agentic_apps: {
        installations: manifests.map(({ id }) => ({
          app_id: id,
          bindings: { serviceAccountClientId: "example-client" },
        })),
      } }));
      expect(() => loadConfiguredAgenticApps(file)).toThrow(
        /serviceAccountClientId "example-client" is bound to both "primary" and "secondary"/,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it.each(["hosted", "service-only"])("supports required notifications for a %s app", (profile) => {
    const manifest = {
      ...example,
      ...(profile === "service-only" ? {
        ui: { profiles: [], routes: [] },
        api: { mounts: [] },
        surfaces: { showInHub: false },
      } : {}),
      consumes: { platformApis: [{ id: "host.notifications", version: "1.0", required: true }] },
    };
    const [app] = configured(manifest, {
      ...(profile === "hosted" ? { selected_ui_profile: "hosted" } : {}),
      bindings: { runtimeOrigin: "https://runtime.example.test", serviceAccountClientId: "example-client" },
    });
    expect(app.manifest.consumes.platformApis).toEqual(manifest.consumes.platformApis);
    expect(() => configured({
      ...manifest,
      consumes: { platformApis: [{ id: "host.notifications", version: "2.0", required: true }] },
    }, {})).toThrow(/unsupported required platform capability/);
  });

  it("preserves owned canonical and relative aliases without escaping into host pages", () => {
    const publicApp = {
      appId: "example-app",
      displayName: "Example",
      description: "Example",
      href: "/example",
      canLaunch: true,
      blockedReasons: [],
      categories: [],
      capabilities: [],
      uiMode: "native-package" as const,
      hostPaths: ["/example"],
    };
    expect(
      nativeAgenticAppDestination(
        publicApp,
        ["example", "items", "one"],
        "view=full",
      ),
    ).toBe("/example/items/one?view=full");
    expect(nativeAgenticAppDestination(publicApp, ["items", "one"], "")).toBe(
      "/example/items/one",
    );
    expect(nativeAgenticAppDestination(publicApp, ["..", "admin"], "")).toBe(
      "/example",
    );
    expect(nativeAgenticAppDestination(publicApp, ["admin"], "")).toBe(
      "/example/admin",
    );
  });

  it("permits the same publisher manifest in a hosted installation without native code", () => {
    const [app] = configured(example, {
      selected_ui_profile: "hosted",
      bindings: { runtimeOrigin: "https://runtime.example.test" },
    });
    expect(app.installation.selectedUiProfile).toBe("hosted");
  });

  it("rejects a second mutable declaration of a compiled manifest", () => {
    installedAgenticAppManifests.push(validateAgenticAppManifest(example));
    expect(() =>
      configured(example, { selected_ui_profile: "hosted" }),
    ).toThrow(/pinned package/);
  });

  it("preserves role and service policy when migrating a native v1.1 deployment", () => {
    const native = normalizeNativeExtensionManifest(
      {
        id: "example-app",
        displayName: "Example",
        description: "Example",
        contractVersion: "1.1",
        hostPaths: ["/example"],
        api: { mounts: ["/api/example"] },
        auth: { mode: "app-scoped-token" },
      },
      "@example/native-app",
      "1.0.0",
    );
    installedAgenticAppManifests.push(native);
    installedLegacyNativeExtensionIds.push(native.id);
    const legacy = {
      id: "example-app",
      displayName: "Example",
      description: "Example",
      apiVersion: "1.0",
      runtime: { kind: "proxied-next-zone", mountPath: "/apps/example-app" },
      surfaces: { showInHub: true },
      access: {
        requiredRoles: ["admin"],
        tokenScopes: ["example:read"],
        policyActions: [{ action: "proxy:GET", defaultEffect: "allow" }],
      },
    };
    const [app] = configured(legacy, {
      runtime_origin_override: "https://runtime.example.test",
    });
    expect(app.installation.selectedUiProfile).toBe("native");
    expect(app.manifest.ui.routes[0].path).toBe("/example");
    expect(app.manifest.access.requiredRoles).toEqual(["admin"]);
    expect(canLaunchAgenticApp(app, { role: "user" })).toBe(false);
    expect(() =>
      configured(
        { ...legacy, auth: { mode: "forward-user-access-token" } },
        { runtime_origin_override: "https://runtime.example.test" },
      ),
    ).toThrow(/auth mode/);
  });

  it("does not let a legacy deployment overwrite a new pinned manifest's policy", () => {
    installedAgenticAppManifests.push(validateAgenticAppManifest(example));
    const legacy = {
      id: "example-app",
      displayName: "Example",
      description: "Example",
      apiVersion: "1.0",
      runtime: { kind: "proxied-next-zone", mountPath: "/apps/example-app" },
      surfaces: { showInHub: true },
      access: {
        tokenScopes: ["example:admin"],
        policyActions: [{ action: "proxy:GET", defaultEffect: "allow" }],
      },
    };
    expect(() =>
      configured(legacy, {
        runtime_origin_override: "https://runtime.example.test",
      }),
    ).toThrow(/pinned package/);
  });

  it("checks selected profile, artifact version and private runtime bindings", () => {
    installedAgenticAppManifests.push(validateAgenticAppManifest(example));
    expect(() =>
      configured(undefined, { selected_ui_profile: "missing" }),
    ).toThrow(/not declared/);
    expect(() =>
      configured(undefined, {
        bindings: { runtimeOrigin: "https://runtime.example.test" },
      }),
    ).toThrow(/explicit UI profile/);
    expect(() => configured(undefined, { app_version: "2.0.0" })).toThrow(
      /artifact/,
    );
    expect(() =>
      configured(undefined, {
        bindings: { runtimeOrigin: "file:///tmp/example" },
      }),
    ).toThrow(/HTTP/);
    expect(() =>
      configured(undefined, {
        bindings: {
          runtimeOrigin: "https://runtime.example.test",
          token: "secret",
        },
      }),
    ).toThrow(/unknown key/);
  });

  it("supports a UI-only compiled app without a fake backend binding", () => {
    const app = {
      ...example,
      ui: {
        ...example.ui,
        profiles: example.ui.profiles.filter(
          (profile) => profile.mode === "native-package",
        ),
      },
      runtime: undefined,
      api: { mounts: [] },
      access: { requiredRoles: ["user"], tokenScopes: [], policyActions: [] },
    };
    installedAgenticAppManifests.push(validateAgenticAppManifest(app));
    const [configuredApp] = configured(undefined, {});
    expect(configuredApp.manifest.runtime).toBeUndefined();
    expect(agenticAppEntryHref(configuredApp)).toBe("/example");
  });

  it("requires a service origin for enabled native API mounts even without runtime metadata", () => {
    const app = {
      ...example,
      ui: { ...example.ui, profiles: example.ui.profiles.filter((profile) => profile.mode === "native-package") },
      runtime: undefined,
    };
    installedAgenticAppManifests.push(validateAgenticAppManifest(app));
    expect(() => configured(undefined, {})).toThrow(/requires a runtime origin/);
    const [bound] = configured(undefined, { bindings: { runtimeOrigin: "https://runtime.example.test" } });
    expect(bound.installation.bindings.runtimeOrigin).toBe("https://runtime.example.test");
    expect(configured(undefined, { enabled: false })[0].installation.enabled).toBe(false);
    expect(configured(undefined, { installed: false })[0].installation.installed).toBe(false);
  });

  it("keeps permission requests declarative and hidden apps protected", () => {
    installedAgenticAppManifests.push(validateAgenticAppManifest(example));
    const [app] = configured(undefined, {
      selected_ui_profile: "native",
      visible: false,
      bindings: { runtimeOrigin: "https://runtime.example.test" },
    });
    expect(app.manifest.requestedPermissions).toHaveLength(1);
    expect(canLaunchAgenticApp(app, { role: "user" })).toBe(true);
    expect(canLaunchAgenticApp(app, { role: "viewer" })).toBe(false);
    expect(app.installation).not.toHaveProperty("grants");
  });

  it("registers service-only apps without advertising UI or requiring native modules", () => {
    const manifest = {
      ...example,
      ui: { profiles: [], routes: [] },
      api: { mounts: [] },
      surfaces: { showInHub: false },
    };
    const [app] = configured(manifest, {
      bindings: { runtimeOrigin: "https://runtime.example.test" },
    });
    expect(app.manifest.ui.profiles).toEqual([]);
    expect(app.installation.selectedUiProfile).toBeUndefined();
  });
});
