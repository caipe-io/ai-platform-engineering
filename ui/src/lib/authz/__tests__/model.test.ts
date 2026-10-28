/** @jest-environment node */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import manifest from "../../../../examples/agentic-apps/service-only/manifest.json";
import exampleType from "../../../../examples/agentic-apps/service-only/model.json";
import { nativeGrantRelation, nativeResourceDefinition, selectedModel, validateNativeInstallations } from "../model";

const directory = mkdtempSync(join(tmpdir(), "cas-selected-model-"));
const configFile = join(directory, "apps.json");
const originalEnv = { ...process.env };
const originalFetch = global.fetch;
const modelId = "01K8E0AMP0E000000000000000";
let requestNumber = 0;
let fetchMock: jest.Mock;
function configure(enabled = true, module = "example-service") {
  writeFileSync(configFile, JSON.stringify({ agentic_apps: {
    packages: [{ package_id: manifest.id, manifest }], installations: [{ app_id: manifest.id, enabled,
      bindings: { serviceAccountClientId: "example-client", authorizationModule: module } }],
  } }));
}
beforeEach(() => {
  Object.assign(process.env, { OPENFGA_HTTP: `https://model-${++requestNumber}.example.test`, OPENFGA_STORE_ID: "example-store",
    OPENFGA_AUTHORIZATION_MODEL_ID: modelId, AGENTIC_APPS_INSTALL_ENABLED: "true", AGENTIC_APPS_CONFIG_PATH: configFile });
  configure();
  fetchMock = jest.fn().mockResolvedValue(new Response(JSON.stringify({ authorization_model: {
    id: modelId, schema_version: "1.1", type_definitions: [exampleType],
  } })));
  global.fetch = fetchMock;
});
afterAll(() => { process.env = originalEnv; global.fetch = originalFetch; rmSync(directory, { recursive: true, force: true }); });

it("binds the immutable native model to the canonical installation", async () => {
  expect(await nativeResourceDefinition(exampleType.type)).toMatchObject({ appId: manifest.id, modelId,
    definition: { type: exampleType.type }, app: { installation: { enabled: true } } });
  expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining(`/authorization-models/${modelId}`), expect.objectContaining({ method: "GET" }));
  await validateNativeInstallations();
  await expect(nativeResourceDefinition("unknown_type")).rejects.toMatchObject({ status: 400 });
});
it("requires explicit store and model pins before activating native installations", async () => {
  delete process.env.OPENFGA_AUTHORIZATION_MODEL_ID;
  await expect(validateNativeInstallations()).rejects.toThrow("explicit OpenFGA store and model");
  expect(fetchMock).not.toHaveBeenCalled();
  process.env.OPENFGA_AUTHORIZATION_MODEL_ID = modelId;
  delete process.env.OPENFGA_STORE_ID;
  await expect(validateNativeInstallations()).rejects.toThrow("explicit OpenFGA store and model");
});
it("rejects mismatched server model IDs and retries failed model reads", async () => {
  fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ authorization_model: { id: "other", type_definitions: [exampleType] } })));
  await expect(selectedModel()).rejects.toThrow("invalid");
  await expect(selectedModel()).resolves.toMatchObject({ id: modelId });
  expect(fetchMock).toHaveBeenCalledTimes(2);
});
it("keeps immutable schema caching separate from live installation enablement", async () => {
  await nativeResourceDefinition(exampleType.type);
  configure(false);
  expect((await nativeResourceDefinition(exampleType.type)).app).toBeNull();
  expect(fetchMock).toHaveBeenCalledTimes(1);
  configure(true, "missing-module");
  await expect(validateNativeInstallations()).rejects.toThrow("absent");
});
it("uses the native per-relationship authority and blocks ownership and computed-permission writes", async () => {
  expect(await nativeGrantRelation(exampleType.type, "executor", "service_account")).toBe("can_grant_executor");
  expect(await nativeGrantRelation(exampleType.type, "terminator", "user")).toBe("can_grant_terminator");
  for (const [relation, principal] of [["owner", "user"], ["can_exec", "user"], ["execution_grantor", "user"], ["executor", "everyone"]]) {
    await expect(nativeGrantRelation(exampleType.type, relation, principal)).rejects.toMatchObject({ status: 400 });
  }
});
