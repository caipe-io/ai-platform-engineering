/** @jest-environment node */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { getAgenticAppRoutingSnapshot, loadConfiguredAgenticApps } from "../config";

describe("External Apps deployment config", () => {
  const previousEnabled = process.env.AGENTIC_APPS_INSTALL_ENABLED;

  beforeEach(() => {
    process.env.AGENTIC_APPS_INSTALL_ENABLED = "true";
  });

  afterAll(() => {
    if (previousEnabled === undefined) delete process.env.AGENTIC_APPS_INSTALL_ENABLED;
    else process.env.AGENTIC_APPS_INSTALL_ENABLED = previousEnabled;
  });

  it("keeps the validated routing snapshot after a failed refresh", () => {
    const previous = process.env.AGENTIC_APPS_CONFIG_PATH;
    try { withConfig(validConfig(), path => {
      process.env.AGENTIC_APPS_CONFIG_PATH = path;
      const apps = loadConfiguredAgenticApps();
      writeFileSync(path, "invalid: catalog");
      expect(() => loadConfiguredAgenticApps()).toThrow();
      expect(getAgenticAppRoutingSnapshot()).toEqual(apps);
    }); } finally { if (previous === undefined) delete process.env.AGENTIC_APPS_CONFIG_PATH; else process.env.AGENTIC_APPS_CONFIG_PATH = previous; }
  });

  it("requires an origin for a feedback-only app without runtime or API mounts", () => {
    withConfig(validConfig(), path => {
      const manifest = { ...loadConfiguredAgenticApps(path)[0].manifest, version: "1.0.0",
        ui: { profiles: [], routes: [] }, api: { mounts: [] }, surfaces: { showInHub: false, navOrder: 50 } };
      delete manifest.runtime;
      const config = { agentic_apps: {
        packages: [{ package_id: "example-app", manifest }],
        installations: [{ app_id: "example-app", package_id: "example-app", feedback_path: "/api/example/feedback" }],
      } };
      withConfig(JSON.stringify(config), feedbackPath => {
        expect(() => loadConfiguredAgenticApps(feedbackPath)).toThrow(/requires a runtime origin/);
      });
    });
  });

  it("loads an optional app-owned feedback path", () => {
    withConfig(validConfig().replace("      installed: true", "      feedback_path: /api/example/feedback\n      installed: true"), path => {
      expect(loadConfiguredAgenticApps(path)[0].installation.feedbackPath).toBe("/api/example/feedback");
    });
  });
  it.each(["https://other.example.test/report", "/api/../admin", "/api/feedback?repo=other", "/api//feedback"])("rejects unsafe feedback paths %s", feedbackPath => {
    withConfig(validConfig().replace("      installed: true", `      feedback_path: ${feedbackPath}\n      installed: true`), path => {
      expect(() => loadConfiguredAgenticApps(path)).toThrow(/feedback_path/);
    });
  });

  it("loads and joins generic packages and installations", () => {
    withConfig(validConfig(), (path) => {
      expect(loadConfiguredAgenticApps(path)).toEqual([
        expect.objectContaining({
          manifest: expect.objectContaining({
            id: "example-app",
            auth: { mode: "app-scoped-token" },
            runtime: expect.objectContaining({ maxRequestBodyBytes: 67108864 }),
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

  it("rejects request-body limits outside the supported byte range", () => {
    for (const invalid of [0, 1.5, 67108865]) {
      withConfig(
        validConfig().replace("maxRequestBodyBytes: 67108864", `maxRequestBodyBytes: ${invalid}`),
        (path) => {
          expect(() => loadConfiguredAgenticApps(path)).toThrow(
            /maxRequestBodyBytes must/,
          );
        },
      );
    }
  });

  it("accepts explicit user access-token forwarding for trusted apps", () => {
    withConfig(
      validConfig().replace(
        '        apiVersion: "1.0"',
        '        apiVersion: "1.0"\n        auth:\n          mode: forward-user-access-token',
      ),
      (path) => {
        const [configured] = loadConfiguredAgenticApps(path);
        expect(configured.manifest.auth).toEqual({
          mode: "forward-user-access-token",
        });
      },
    );
  });

  it("rejects invalid or unknown authentication settings", () => {
    withConfig(
      validConfig().replace(
        '        apiVersion: "1.0"',
        '        apiVersion: "1.0"\n        auth:\n          mode: passthrough-cookie',
      ),
      (path) => {
        expect(() => loadConfiguredAgenticApps(path)).toThrow(/auth.mode must be/);
      },
    );
    withConfig(
      validConfig().replace(
        '        apiVersion: "1.0"',
        '        apiVersion: "1.0"\n        auth:\n          mode: app-scoped-token\n          forwardCookie: true',
      ),
      (path) => {
        expect(() => loadConfiguredAgenticApps(path)).toThrow(
          /auth has unknown key "forwardCookie"/,
        );
      },
    );
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
          maxRequestBodyBytes: 67108864
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

it("loads deployment-owned feedback features", () => {
  const previous = process.env.AGENTIC_APPS_INSTALL_ENABLED;
  process.env.AGENTIC_APPS_INSTALL_ENABLED = "true";
  try { withConfig(validConfig().replace("      installed: true", "      feedback_features: [Routing, Other]\n      installed: true"), path => {
    expect(loadConfiguredAgenticApps(path)[0].installation.feedbackFeatures).toEqual(["Routing", "Other"]);
  }); } finally { if (previous === undefined) delete process.env.AGENTIC_APPS_INSTALL_ENABLED; else process.env.AGENTIC_APPS_INSTALL_ENABLED = previous; }
});


it("registers host-managed feedback from deployment settings and replaces the app endpoint", () => {
  const original = process.env.FEEDBACK_COMPONENTS_JSON;
  const enabled = process.env.AGENTIC_APPS_INSTALL_ENABLED;
  process.env.AGENTIC_APPS_INSTALL_ENABLED = "true";
  try {
    process.env.FEEDBACK_COMPONENTS_JSON = JSON.stringify({ "example-app": { handler: "github", repository: "example/product", tokenEnv: "FEEDBACK_EXAMPLE_TOKEN", features: ["Publishing", "Other"], style: { labels: ["user-feedback"], titlePrefix: true } } });
    withConfig(validConfig().replace("      installed: true", "      feedback_path: /api/example/feedback\n      installed: true"), path => {
      const app = loadConfiguredAgenticApps(path)[0];
      expect(app.installation.feedbackGitHub).toEqual(expect.objectContaining({ repository: "example/product", tokenEnv: "FEEDBACK_EXAMPLE_TOKEN" }));
      expect(app.installation.feedbackPath).toBeUndefined();
      expect(app.installation.feedbackFeatures).toEqual(["Publishing", "Other"]);
      expect(app.installation.feedbackGitHub?.style).toEqual({ labels: ["user-feedback"], titlePrefix: true });
    });
  } finally {
    if (original === undefined) delete process.env.FEEDBACK_COMPONENTS_JSON; else process.env.FEEDBACK_COMPONENTS_JSON = original;
    if (enabled === undefined) delete process.env.AGENTIC_APPS_INSTALL_ENABLED; else process.env.AGENTIC_APPS_INSTALL_ENABLED = enabled;
  }
});
