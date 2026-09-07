/** @jest-environment node */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadConfiguredAgenticApps } from "../config";

describe("External Apps deployment config", () => {
  const previousEnabled = process.env.AGENTIC_APPS_INSTALL_ENABLED;

  beforeEach(() => {
    process.env.AGENTIC_APPS_INSTALL_ENABLED = "true";
  });

  afterAll(() => {
    if (previousEnabled === undefined) delete process.env.AGENTIC_APPS_INSTALL_ENABLED;
    else process.env.AGENTIC_APPS_INSTALL_ENABLED = previousEnabled;
  });

  it("loads and joins generic packages and installations", () => {
    withConfig(validConfig(), (path) => {
      expect(loadConfiguredAgenticApps(path)).toEqual([
        expect.objectContaining({
          manifest: expect.objectContaining({
            id: "example-app",
            access: expect.objectContaining({ tokenScopes: ["example-app:read"] }),
          }),
          installation: expect.objectContaining({
            appId: "example-app",
            runtimeOriginOverride: "http://example-app.example.svc",
          }),
        }),
      ]);
    });
  });

  it("keeps the bundled Weather example compatible with the catalog parser", () => {
    const [configured] = loadConfiguredAgenticApps(
      join(process.cwd(), "examples/external-apps/weather/agentic-apps.yaml"),
    );

    expect(configured).toEqual(
      expect.objectContaining({
        manifest: expect.objectContaining({
          id: "weather",
          runtime: expect.objectContaining({ mountPath: "/apps/weather" }),
          access: expect.objectContaining({
            tokenScopes: ["weather:read", "weather:write"],
          }),
        }),
        installation: expect.objectContaining({
          appId: "weather",
          enabled: true,
          visible: true,
        }),
      }),
    );
  });

  it("accepts the full deployment catalog shape while selecting the runtime contract", () => {
    const deploymentShape = validConfig()
      .replace(
        "          navOrder: 50",
        "          navOrder: 50\n          showInTopNav: false\n          homeEligible: true\n          overlays: []",
      )
      .replace(
        "          policyActions:",
        "          canUseCustomAgents: false\n          policyActions:",
      )
      .replace(
        "        health:\n          endpoint: /health",
        "        assistant:\n          enabled: false\n        health:\n          endpoint: /health\n          timeoutMs: 2000\n          blockLaunchWhen: [degraded, unreachable]",
      )
      .replace(
        "      runtime_origin_override: http://example-app.example.svc",
        "      runtime_origin_override: http://example-app.example.svc\n      health_policy:\n        block_launch_when: [degraded, unreachable]",
      );
    withConfig(deploymentShape, (path) => {
      const [configured] = loadConfiguredAgenticApps(path);
      expect(configured).toEqual(
        expect.objectContaining({
          manifest: expect.objectContaining({
            id: "example-app",
            surfaces: expect.objectContaining({ showInHub: true, navOrder: 50 }),
            health: { endpoint: "/health", timeoutMs: 2000 },
          }),
          installation: expect.objectContaining({ enabled: true, visible: true }),
        }),
      );
    });
  });

  it("rejects unresolved packages and route collisions", () => {
    withConfig(validConfig().replace("package_id: example-app\n      installed", "package_id: missing\n      installed"), (path) => {
      expect(() => loadConfiguredAgenticApps(path)).toThrow(/not configured/);
    });

    const duplicate = `${validConfig()}\n    - app_id: second-app\n      package_id: example-app`;
    withConfig(duplicate, (path) => {
      expect(() => loadConfiguredAgenticApps(path)).toThrow(/must match manifest id/);
    });
  });

  it("rejects unsafe origins and mount paths", () => {
    withConfig(validConfig().replace("http://example-app.example.svc", "file:///tmp/app"), (path) => {
      expect(() => loadConfiguredAgenticApps(path)).toThrow(/HTTP\(S\)/);
    });
    withConfig(validConfig().replaceAll("/apps/example-app", "/api/example-app"), (path) => {
      expect(() => loadConfiguredAgenticApps(path)).toThrow(/below \/apps\//);
    });
    withConfig(
      validConfig()
        .replace("          origin: http://example-app.example.svc\n", "")
        .replace("      runtime_origin_override: http://example-app.example.svc\n", ""),
      (path) => {
        expect(() => loadConfiguredAgenticApps(path)).toThrow(/requires a runtime origin/);
      },
    );
  });

  it("rejects incomplete exact routes and scopes outside the manifest contract", () => {
    withConfig(
      validConfig().replace(
        "            - action: proxy:GET",
        "            - action: read-item\n              method: GET",
      ),
      (path) => {
        expect(() => loadConfiguredAgenticApps(path)).toThrow(/method and .*path/);
      },
    );
    withConfig(
      validConfig().replace(
        "              defaultEffect: allow",
        "              defaultEffect: allow\n              requiredScopes: [example-app:admin]",
      ),
      (path) => {
        expect(() => loadConfiguredAgenticApps(path)).toThrow(/undeclared scope/);
      },
    );
  });

  it("rejects misspelled access and policy keys instead of widening access", () => {
    withConfig(
      validConfig().replace("requiredRoles", "requiredRole"),
      (path) => {
        expect(() => loadConfiguredAgenticApps(path)).toThrow(
          /access has unknown key "requiredRole"/,
        );
      },
    );
    withConfig(
      validConfig().replace("requiredRoles", "requiredGroups"),
      (path) => {
        expect(() => loadConfiguredAgenticApps(path)).toThrow(
          /access has unknown key "requiredGroups"/,
        );
      },
    );
    withConfig(
      validConfig().replace("defaultEffect", "defaultEffects"),
      (path) => {
        expect(() => loadConfiguredAgenticApps(path)).toThrow(
          /unknown key "defaultEffects"/,
        );
      },
    );
  });
});

function withConfig(config: string, assertion: (path: string) => void): void {
  const directory = mkdtempSync(join(tmpdir(), "external-apps-"));
  const path = join(directory, "apps.yaml");
  try {
    writeFileSync(path, config);
    assertion(path);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function validConfig(): string {
  return `agentic_apps:
  packages:
    - package_id: example-app
      source: helm
      manifest:
        id: example-app
        displayName: Example App
        description: Example application.
        apiVersion: "1.0"
        runtime:
          kind: proxied-next-zone
          origin: http://example-app.example.svc
          mountPath: /apps/example-app
          chrome: iframe
        surfaces:
          showInHub: true
          navOrder: 50
        access:
          requiredRoles: [user]
          tokenScopes: [example-app:read]
          policyActions:
            - action: proxy:GET
              defaultEffect: allow
        health:
          endpoint: /health
  installations:
    - app_id: example-app
      package_id: example-app
      installed: true
      enabled: true
      visible: true
      runtime_mount_path: /apps/example-app
      runtime_origin_override: http://example-app.example.svc
`;
}
