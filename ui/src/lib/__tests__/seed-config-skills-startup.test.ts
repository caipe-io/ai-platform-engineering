/** @jest-environment node */

import fs from "fs";
import os from "os";
import path from "path";

const mockBootstrapSkills = jest.fn();
const mockCollection = {
  find: jest.fn(() => ({ toArray: async () => [] })),
  findOne: jest.fn(async () => null),
  countDocuments: jest.fn(async () => 1),
};
jest.mock("@/lib/mongodb", () => ({
  isMongoDBConfigured: true,
  getCollection: async () => mockCollection,
}));
jest.mock("@/lib/seed-skills", () => ({
  bootstrapSkills: (...args: unknown[]) => mockBootstrapSkills(...args),
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
  expect(mockBootstrapSkills).not.toHaveBeenCalled();
  expect(mockCollection.find).not.toHaveBeenCalled();

  fs.writeFileSync(process.env.APP_CONFIG_PATH!, "skills:\n  - id: example-skill\n    name: Example Skill\n    content: Summarize a document.");
  await applySeedConfig();
  expect(mockBootstrapSkills).toHaveBeenCalledWith([
    { id: "example-skill", name: "Example Skill", content: "Summarize a document." },
  ]);
});

it("initializes an empty catalog for an explicitly loaded skills list", async () => {
  fs.writeFileSync(process.env.APP_CONFIG_PATH!, "skills: []");
  await applySeedConfig();
  expect(mockBootstrapSkills).toHaveBeenCalledWith([]);
});

it("selects packaged defaults when no application config path is set", async () => {
  delete process.env.APP_CONFIG_PATH;
  await applySeedConfig();
  expect(mockBootstrapSkills).toHaveBeenCalledWith(undefined);
});
