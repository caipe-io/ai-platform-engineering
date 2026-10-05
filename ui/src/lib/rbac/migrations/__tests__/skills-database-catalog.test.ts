/** @jest-environment node */

const mockGetCollection = jest.fn();
const mockComplete = jest.fn();
const mockLegacy = jest.fn();
const mockBootstrap = jest.fn();
const mockLoad = jest.fn();
jest.mock("@/lib/mongodb", () => ({
  getCollection: (...args: unknown[]) => mockGetCollection(...args),
}));
jest.mock("@/lib/seed-config", () => ({ loadSeedConfig: (...args: unknown[]) => mockLoad(...args) }));
jest.mock("@/lib/seed-skills", () => ({
  isSkillBootstrapComplete: () => mockComplete(),
  getLegacySkillTemplates: () => mockLegacy(),
  bootstrapSkills: (...args: unknown[]) => mockBootstrap(...args),
  templateToAgentSkill: jest.fn(),
}));
import { applyMigration, planMigration, getMigrationDefinition } from "../registry";
import { SKILLS_DATABASE_CATALOG_MIGRATION_ID as id, SKILLS_DATABASE_CATALOG_CONFIRMATION } from "../skills-database-catalog";

const example = { id: "example-skill", name: "Example Skill", content: "Summarize a document." };
const skills = { findOne: jest.fn() };
const records = { updateOne: jest.fn() };
const originalEnv = process.env;
beforeEach(() => {
  jest.resetAllMocks();
  process.env = { ...originalEnv };
  delete process.env.APP_CONFIG_PATH;
  mockComplete.mockResolvedValue(false);
  mockLegacy.mockReturnValue([example]);
  mockBootstrap.mockResolvedValue({ seeded: 1, skipped: 0 });
  skills.findOne.mockResolvedValue(null);
  mockGetCollection.mockImplementation((name) => name === "agent_skills" ? skills : records);
});
afterEach(() => { process.env = originalEnv; });

it("registers a nonblocking migration after the existing skill migrations", () => {
  expect(getMigrationDefinition(id)).toMatchObject({
    release: "1.3.0", schema_area: "agent_skills", from_version: 3, to_version: 4,
    blocking: false, implemented: true,
  });
});

it("previews missing records and preserves existing or imported copies", async () => {
  expect((await planMigration(id)).counts).toMatchObject({ missing_skills: 1 });
  expect(skills.findOne).toHaveBeenCalledWith({ $or: [
    { id: example.id }, { is_system: true, "metadata.template_source_id": example.id },
  ] });
  skills.findOne.mockResolvedValue({ id: "imported-skill" });
  const plan = await planMigration(id);
  expect(plan.counts).toMatchObject({ missing_skills: 0, existing_skills: 1 });
  expect(plan.sample_diffs).toEqual([]);
});

it("uses configured seed lists, including an explicitly empty catalog", async () => {
  process.env.APP_CONFIG_PATH = "/example/app-config.yaml";
  mockLoad.mockReturnValue({ skills: [] });
  expect((await planMigration(id)).counts.selected_skills).toBe(0);
  expect(mockLegacy).not.toHaveBeenCalled();
  mockLoad.mockReturnValue({ skills: [example] });
  expect((await planMigration(id)).counts.missing_skills).toBe(1);
});

it("leaves initialized new databases and deleted skills unchanged", async () => {
  mockComplete.mockResolvedValue(true);
  expect((await planMigration(id)).counts.selected_skills).toBe(0);
  expect(mockLegacy).not.toHaveBeenCalled();
  expect(mockLoad).not.toHaveBeenCalled();
});

it("applies through the registry and records schema completion", async () => {
  await applyMigration({ migrationId: id, actor: "admin@example.com", confirmation: SKILLS_DATABASE_CATALOG_CONFIRMATION });
  expect(mockBootstrap).toHaveBeenCalledWith([example], { migration: true });
  expect(records.updateOne).toHaveBeenCalledWith({ _id: "agent_skills" }, expect.objectContaining({
    $set: expect.objectContaining({ version: 4, last_migration_id: id }),
  }), { upsert: true });
});

it("does not record completion for missing config files or failed imports", async () => {
  process.env.APP_CONFIG_PATH = "/example/app-config.yaml";
  mockLoad.mockImplementation(() => { throw new Error("ENOENT"); });
  await expect(planMigration(id)).rejects.toThrow("ENOENT");
  delete process.env.APP_CONFIG_PATH;
  mockBootstrap.mockRejectedValue(new Error("grant unavailable"));
  await expect(applyMigration({ migrationId: id, actor: "admin@example.com", confirmation: SKILLS_DATABASE_CATALOG_CONFIRMATION })).rejects.toThrow("grant unavailable");
  expect(records.updateOne).not.toHaveBeenCalled();
});
