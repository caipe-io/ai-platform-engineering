/** @jest-environment node */

import fs from "fs";
import os from "os";
import path from "path";

const mockBootstrapSkills = jest.fn();
const mockSeedSystemSkills = jest.fn();
jest.mock("@/lib/system-skills", () => ({
  seedSystemSkills: () => mockSeedSystemSkills(),
}));
const mockCollection = {
  find: jest.fn(() => ({ toArray: async () => [] })),
  findOne: jest.fn(async () => null),
  countDocuments: jest.fn(async () => 1),
  replaceOne: jest.fn(async () => ({ upsertedCount: 1 })),
  updateOne: jest.fn(async () => ({ matchedCount: 1 })),
};
jest.mock("@/lib/mongodb", () => ({
  isMongoDBConfigured: true,
  getCollection: async () => mockCollection,
}));
jest.mock("@/lib/seed-skills", () => ({
  ...jest.requireActual("@/lib/seed-skills"),
  bootstrapSkills: (...args: unknown[]) => mockBootstrapSkills(...args),
}));
jest.mock("@/lib/rbac/openfga-owned-resources-reconcile", () => ({
  reconcileShareableResource: async () => ({}),
}));
jest.mock("@/lib/rbac/openfga", () => ({
  isOpenFgaReconciliationEnabled: () => false,
}));
jest.mock("@/lib/rbac/workflow-config-rebac", () => ({
  repairWorkflowConfigTeamSlugRefs: async () => 0,
}));
jest.mock("@/lib/rbac/unlinked-knowledge-access", () => ({
  reconcileExistingUnlinkedKnowledgeAccess: async () => ({ datasourceCount: 0, collectionCount: 0 }),
}));
jest.mock("@/lib/credentials/oauth-bootstrap", () => ({ bootstrapOAuthConnectorsFromEnv: async () => {} }));
jest.mock("@/lib/credentials/secret-bootstrap", () => ({ bootstrapSecretsFromEnv: async () => {} }));
jest.mock("@/lib/rbac/team-scope-sync", () => ({ syncTeamScopesOnStartup: async () => {} }));

import { applySeedConfig } from "../seed-config";

const originalEnv = process.env;
let directory: string;
beforeEach(() => {
  jest.clearAllMocks();
  directory = fs.mkdtempSync(path.join(os.tmpdir(), "seed-skills-startup-"));
  process.env = { ...originalEnv, APP_CONFIG_PATH: path.join(directory, "example.yaml") };
  delete process.env.IDENTITY_SYNC_LOGIN_AUTO_CREATE_TEAMS;
});
afterEach(() => {
  process.env = originalEnv;
  fs.rmSync(directory, { recursive: true, force: true });
});

it("does not consume skill bootstrap when a configured file is missing", async () => {
  await applySeedConfig();
  expect(mockSeedSystemSkills).toHaveBeenCalled();
  expect(mockBootstrapSkills).not.toHaveBeenCalled();
  expect(mockCollection.find).not.toHaveBeenCalled();

  fs.writeFileSync(process.env.APP_CONFIG_PATH!, "skills:\n  - id: example-skill\n    name: Example Skill\n    content: Summarize a document.");
  await applySeedConfig();
  expect(mockCollection.replaceOne).toHaveBeenCalledWith(
    { id: "example-skill" },
    expect.objectContaining({ skill_content: "Summarize a document.", config_driven: true }),
    { upsert: true },
  );
  expect(mockBootstrapSkills).toHaveBeenCalledWith([]);
});

it("initializes an empty catalog for an explicitly loaded skills list", async () => {
  fs.writeFileSync(process.env.APP_CONFIG_PATH!, "skills: []");
  await applySeedConfig();
  expect(mockBootstrapSkills).toHaveBeenCalledWith([]);
  expect(mockCollection.replaceOne).not.toHaveBeenCalled();
});

it("initializes system instructions independently of same-named configured skills", async () => {
  fs.writeFileSync(process.env.APP_CONFIG_PATH!, JSON.stringify({ skills: [
    { id: "live-skills", name: "Example Skill", content: "Operator catalog content" },
  ] }));
  await applySeedConfig();
  expect(mockSeedSystemSkills).toHaveBeenCalledTimes(1);
  expect(mockCollection.replaceOne).toHaveBeenCalledWith(
    { id: "live-skills" },
    expect.objectContaining({ skill_content: "Operator catalog content", config_driven: true }),
    { upsert: true },
  );
});

it("keeps ordinary initialization available after a system skill initialization failure", async () => {
  mockSeedSystemSkills.mockRejectedValueOnce(new Error("System assets unavailable"));
  delete process.env.APP_CONFIG_PATH;
  await applySeedConfig();
  expect(mockBootstrapSkills).toHaveBeenCalledWith(undefined);
  await applySeedConfig();
  expect(mockSeedSystemSkills).toHaveBeenCalledTimes(2);
});

it.each([
  [{ id: "example-skill", name: "Example Skill", content: "" }],
  [null],
  [
    { id: "example-skill", name: "Example Skill", content: "First prompt" },
    { id: "example-skill", name: "Example Skill", content: "Second prompt" },
  ],
])("validates configured skills before consuming bootstrap: %j", async (...skills) => {
  fs.writeFileSync(process.env.APP_CONFIG_PATH!, JSON.stringify({ skills }));
  await applySeedConfig();
  expect(mockBootstrapSkills).not.toHaveBeenCalled();
  expect(mockCollection.replaceOne).not.toHaveBeenCalled();
  expect(mockCollection.find).not.toHaveBeenCalled();

  fs.writeFileSync(process.env.APP_CONFIG_PATH!, JSON.stringify({ skills: [
    { id: "example-skill", name: "Example Skill", content: "Corrected prompt" },
  ] }));
  await applySeedConfig();
  expect(mockBootstrapSkills).toHaveBeenCalledWith([]);
  expect(mockCollection.replaceOne).toHaveBeenCalledWith(
    { id: "example-skill" }, expect.objectContaining({ skill_content: "Corrected prompt", config_driven: true }),
    { upsert: true },
  );
});

it("selects packaged defaults when no application config path is set", async () => {
  delete process.env.APP_CONFIG_PATH;
  await applySeedConfig();
  expect(mockBootstrapSkills).toHaveBeenCalledWith(undefined);
});
