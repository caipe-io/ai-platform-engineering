/** @jest-environment node */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import manifest from "../../../../examples/agentic-apps/service-only/manifest.json";
import { loadConfiguredAgenticApps } from "../config";
import { appResourceDefinition, listAppResourceTypeDefinition } from "@/lib/authz/resource-types";
import { resourceApp, resolveAppService } from "../service-binding";

const consumerManifest = manifest;
const originalEnv = { ...process.env };
const directory = mkdtempSync(join(tmpdir(), "cas-app-binding-"));
const file = join(directory, "apps.json");
const service = { issuer: "https://identity.example.test", subject: { type: "service_account" as const, id: "service-subject" },
  clientId: "example-client", expiresAt: 10 ** 10 };
beforeEach(() => {
  process.env.OIDC_ISSUER = service.issuer;
  process.env.AGENTIC_APPS_INSTALL_ENABLED = "true";
  process.env.AGENTIC_APPS_CONFIG_PATH = file;
});
afterAll(() => {
  process.env = originalEnv;
  rmSync(directory, { recursive: true, force: true });
});
function configuration(enabled = true) {
  return { agentic_apps: {
    packages: [{ package_id: manifest.id, manifest: consumerManifest }],
    installations: [{ app_id: manifest.id, installed: true, enabled, visible: false,
      bindings: { serviceAccountClientId: service.clientId } }],
  } };
}
it("loads a service-only installation using the shared schema without a UI or runtime origin", () => {
  writeFileSync(file, JSON.stringify(configuration()));
  const apps = loadConfiguredAgenticApps();
  expect(resourceApp(manifest.id, apps)?.installation.visible).toBe(false);
  expect(resolveAppService(service, apps)?.installation.appId).toBe(manifest.id);
  expect(resolveAppService({ ...service, clientId: service.subject.id }, apps)).toBeNull();
  expect(apps[0].manifest.requestedPermissions).toEqual([]);
});
it("requires an active installation, the service identity profile and the exact client binding", () => {
  writeFileSync(file, JSON.stringify(configuration()));
  for (const identity of [{ ...service, clientId: "other-client" }, { ...service, issuer: "https://other.example.test" },
    { ...service, expiresAt: 1 }, { ...service, subject: { type: "user" as const, id: service.subject.id } }]) {
    expect(resolveAppService(identity)).toBeNull();
  }
  writeFileSync(file, JSON.stringify(configuration(false)));
  expect(resolveAppService(service)).toBeNull();
});
it("rejects ambiguous client bindings across installations", () => {
  const config = configuration();
  config.agentic_apps.packages.push({ package_id: "secondary-service", manifest: { ...consumerManifest, id: "secondary-service" } });
  config.agentic_apps.installations.push({ ...config.agentic_apps.installations[0], app_id: "secondary-service" });
  writeFileSync(file, JSON.stringify(config));
  expect(() => loadConfiguredAgenticApps()).toThrow(/serviceAccountClientId.*bound to both/);
});

it("loads declared types and actions from a runtime catalog without a compiled package", () => {
  writeFileSync(file, JSON.stringify(configuration()));
  expect(loadConfiguredAgenticApps()[0].manifest.resourceTypes).toEqual([{ name: "agent-sandbox", actions: ["execute", "terminate"] }]);
});
it("rejects unsupported policy/module fields instead of keeping old contracts alive", () => {
  const config = configuration();
  writeFileSync(file, JSON.stringify({ agentic_apps: { ...config.agentic_apps, packages: [{ package_id: manifest.id,
    manifest: { ...manifest, authorization: { module: "example-service", model: "policy.fga", tests: "policy.fga.yaml" } } }] } }));
  expect(() => loadConfiguredAgenticApps()).toThrow(/unknown field/);
  writeFileSync(file, JSON.stringify({ agentic_apps: { ...config.agentic_apps, installations: [{
    ...config.agentic_apps.installations[0], bindings: { serviceAccountClientId: service.clientId, authorizationModule: "example-service" },
  }] } }));
  expect(() => loadConfiguredAgenticApps()).toThrow(/unknown/);
});

it("keeps admin inventory available on malformed config while permission enforcement stays closed", () => {
  writeFileSync(file, "not: an app configuration");
  const log = jest.spyOn(console, "warn").mockImplementation(() => {});
  try {
    expect(listAppResourceTypeDefinition()).toMatchObject({ type: "app_resource", actions: ["owner"] });
    expect(() => appResourceDefinition(manifest.id, "agent-sandbox")).toThrow();
    expect(log).toHaveBeenCalledWith("[cas/resources] App declarations unavailable for admin inventory", { name: "Error" });
    expect(JSON.stringify(log.mock.calls)).not.toContain("not: an app configuration");
  } finally { log.mockRestore(); }
});
