/** @jest-environment node */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bundledAuthorizationModel } from "@/native-extensions/authorization.generated";
import { resetOpenFgaStoreIdCacheForTests } from "../engines/openfga-client";
import { nativeGrantRelation, nativeResourceDefinition, selectedModel, validateNativeInstallations } from "../model";

jest.mock("@/native-extensions/manifests.generated", () => ({ installedAgenticAppManifests: [
  jest.requireActual("../../../../examples/agentic-apps/service-only/manifest.json")], installedLegacyNativeExtensionIds: [] }));
jest.mock("@/native-extensions/authorization.generated", () => {
  const core = jest.requireActual("../../../../../charts/ai-platform-engineering/charts/openfga/authorization-model.json");
  const type = jest.requireActual("../../../../examples/agentic-apps/service-only/model.json");
  return { bundledAuthorizationModel: { ...core, type_definitions: [...core.type_definitions, type] },
    installedAuthorizationModules: [{ appId: "example-service", module: "example-service", packageName: "@example/service-policy", version: "1.0.0" }] };
});
const directory = mkdtempSync(join(tmpdir(), "cas-selected-model-"));
const configFile = join(directory, "apps.json");
const originalEnv = { ...process.env };
const originalFetch = global.fetch;
const modelId = "01K8E0AMP0E000000000000000";
const nativeType = "example_agent_sandbox";
let requestNumber = 0;
let fetchMock: jest.Mock;
const model = () => ({ ...bundledAuthorizationModel, id: modelId });
function configure(enabled = true) {
  writeFileSync(configFile, JSON.stringify({ agentic_apps: { installations: [{ app_id: "example-service", enabled,
    bindings: { serviceAccountClientId: "example-client" } }] } }));
}
beforeEach(() => {
  Object.assign(process.env, { OPENFGA_HTTP: `https://model-${++requestNumber}.example.test`, OPENFGA_STORE_ID: "example-store",
    OPENFGA_AUTHORIZATION_MODEL_ID: modelId, AGENTIC_APPS_INSTALL_ENABLED: "true", AGENTIC_APPS_CONFIG_PATH: configFile });
  resetOpenFgaStoreIdCacheForTests(); configure();
  fetchMock = jest.fn().mockImplementation(() => new Response(JSON.stringify({ authorization_model: model() })));
  global.fetch = fetchMock;
});
afterAll(() => { process.env = originalEnv; global.fetch = originalFetch; rmSync(directory, { recursive: true, force: true }); });

it("derives schema custody from the compiled registry and binds the installed service", async () => {
  expect(await nativeResourceDefinition(nativeType)).toMatchObject({ appId: "example-service", modelId,
    definition: { type: nativeType }, app: { installation: { enabled: true } } });
  await expect(nativeResourceDefinition("unknown_type")).rejects.toMatchObject({ status: 400 });
});
it("validates local installation claims before deployment publishes the artifact", async () => {
  delete process.env.OPENFGA_AUTHORIZATION_MODEL_ID;
  await validateNativeInstallations();
  expect(fetchMock).not.toHaveBeenCalled();
});
it("selects only the exact bundled model, never an unrelated latest model", async () => {
  delete process.env.OPENFGA_AUTHORIZATION_MODEL_ID;
  fetchMock.mockImplementation((url: string) => new Response(JSON.stringify(url.includes("?page_size")
    ? { authorization_models: [{ id: "unrelated", schema_version: "1.1", type_definitions: [] }, model()] }
    : { authorization_model: model() })));
  await expect(selectedModel()).resolves.toMatchObject({ id: modelId });
  expect(fetchMock.mock.calls[0][0]).toContain("/authorization-models?page_size");
});
it("rejects an explicit model pin with policy that differs from the compiled build", async () => {
  fetchMock.mockImplementationOnce(() => new Response(JSON.stringify({ authorization_model: { ...model(), type_definitions: [] } })));
  await expect(selectedModel()).rejects.toThrow("does not match");
  await expect(selectedModel()).resolves.toMatchObject({ id: modelId });
});
it("does not follow latest if the build's artifact has not been published, and can retry", async () => {
  delete process.env.OPENFGA_AUTHORIZATION_MODEL_ID;
  fetchMock.mockImplementationOnce(() => new Response(JSON.stringify({ authorization_models: [] })));
  await expect(selectedModel()).rejects.toThrow("has not been published");
  fetchMock.mockImplementation((url: string) => new Response(JSON.stringify(url.includes("?page_size")
    ? { authorization_models: [model()] } : { authorization_model: model() })));
  await expect(selectedModel()).resolves.toMatchObject({ id: modelId });
});
it("rejects a matching artifact without a valid immutable model ID", async () => {
  delete process.env.OPENFGA_AUTHORIZATION_MODEL_ID;
  fetchMock.mockImplementationOnce(() => new Response(JSON.stringify({ authorization_models: [{ ...model(), id: "" }] })));
  await expect(selectedModel()).rejects.toThrow("invalid model ID");
});
it("keeps compiled schema caching separate from live installation enablement", async () => {
  await nativeResourceDefinition(nativeType); configure(false);
  expect((await nativeResourceDefinition(nativeType)).app).toBeNull();
  expect(fetchMock).toHaveBeenCalledTimes(2);
});
it("uses separate grant authority and protects ownership and computed permissions", async () => {
  expect(await nativeGrantRelation(nativeType, "executor", "service_account")).toBe("can_grant_executor");
  expect(await nativeGrantRelation(nativeType, "terminator", "user")).toBe("can_grant_terminator");
  for (const [relation, principal] of [["owner", "user"], ["can_exec", "user"], ["execution_grantor", "user"], ["executor", "everyone"]]) {
    await expect(nativeGrantRelation(nativeType, relation, principal)).rejects.toMatchObject({ status: 400 });
  }
});
