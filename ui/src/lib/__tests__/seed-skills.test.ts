/** @jest-environment node */

const mockState = { findOne: jest.fn(), updateOne: jest.fn() };
const mockSkills = { findOne: jest.fn(), updateOne: jest.fn() };
const mockScans = { findOne: jest.fn() };
const mockExisting = { findOne: jest.fn() };
const mockTemplates = jest.fn();
const mockReconcile = jest.fn();
jest.mock("@/lib/mongodb", () => ({
  isMongoDBConfigured: true,
  getCollection: async (name: string) =>
    name === "startup_seeds" ? mockState : name === "agent_skills" ? mockSkills : name === "builtin_skill_scans" ? mockScans : mockExisting,
}));
jest.mock("@/app/api/skills/skill-templates-loader", () => ({
  loadSkillTemplatesInternal: () => mockTemplates(),
  resolveTemplateDir: () => null,
  loadTemplateAncillaryFiles: () => ({}),
}));
jest.mock("@/lib/rbac/openfga-owned-resources-reconcile", () => ({
  reconcileShareableResource: (...args: unknown[]) => mockReconcile(...args),
}));

import { bootstrapSkills, getDefaultSkillTemplates, getLegacySkillTemplates } from "../seed-skills";

const example = { id: "example-skill", name: "Example Skill", content: "Summarize a document." };
const hello = { ...example, id: "hello-world", name: "Hello World", content: "Say Hello, world! without tools." };
const originalEnv = process.env;
beforeEach(() => {
  jest.resetAllMocks();
  process.env = { ...originalEnv };
  mockTemplates.mockReturnValue([example, hello]);
  mockExisting.findOne.mockResolvedValue(null);
  mockState.findOne.mockResolvedValue(null);
  mockState.updateOne.mockResolvedValue({ matchedCount: 1 });
  mockSkills.findOne.mockImplementation(async (query) => query.id
    ? { ...example, is_system: true, visibility: "global" } : null);
  mockSkills.updateOne.mockResolvedValue({ upsertedCount: 1 });
  mockScans.findOne.mockResolvedValue(null);
  mockReconcile.mockResolvedValue({});
});
afterAll(() => { process.env = originalEnv; });

it("seeds configured skills and grants org access without using packaged defaults", async () => {
  expect(await bootstrapSkills([example])).toEqual({ seeded: 1, skipped: 0 });
  expect(mockTemplates).not.toHaveBeenCalled();
  expect(mockSkills.updateOne).toHaveBeenCalledWith(
    { id: example.id },
    { $setOnInsert: expect.objectContaining({ skill_content: example.content, visibility: "global" }) },
    { upsert: true },
  );
  expect(mockReconcile).toHaveBeenCalledWith({
    objectType: "skill", objectId: example.id, sharedWithOrg: true, memberRelations: ["user"],
  });
  expect(mockState.updateOne).toHaveBeenLastCalledWith(
    expect.objectContaining({ _id: "skills" }),
    expect.objectContaining({ $set: { completed_at: expect.any(Date) } }),
  );
});

it("does not restore deleted skills or apply changed config after completed bootstrap", async () => {
  mockState.findOne.mockResolvedValue({ completed_at: new Date() });
  await bootstrapSkills([{ ...example, content: "New content" }]);
  expect(mockSkills.updateOne).not.toHaveBeenCalled();
  expect(mockTemplates).not.toHaveBeenCalled();
});

it("preserves existing content and restricted visibility", async () => {
  mockSkills.updateOne.mockResolvedValue({ upsertedCount: 0 });
  mockSkills.findOne.mockImplementation(async (query) => query.id
    ? { ...example, is_system: true, visibility: "private", skill_content: "Edited" } : null);
  expect(await bootstrapSkills([example])).toEqual({ seeded: 0, skipped: 1 });
  expect(mockSkills.updateOne.mock.calls[0][1]).toHaveProperty("$setOnInsert");
  expect(mockReconcile).not.toHaveBeenCalled();
});

it("deduplicates templates already imported under another id", async () => {
  mockSkills.findOne.mockResolvedValue({ id: "imported-skill", is_system: true, visibility: "global" });
  expect(await bootstrapSkills([example], { migration: true })).toEqual({ seeded: 0, skipped: 1 });
  expect(mockSkills.updateOne).not.toHaveBeenCalled();
  expect(mockReconcile).toHaveBeenCalledWith(expect.objectContaining({ objectId: "imported-skill" }));
});

it("leaves bootstrap incomplete after grant failure so a restart retries", async () => {
  mockReconcile.mockRejectedValueOnce(new Error("grant unavailable"));
  await expect(bootstrapSkills([example])).rejects.toThrow("grant unavailable");
  expect(mockState.updateOne.mock.calls.some(([, update]) => update.$set?.completed_at)).toBe(false);
  expect(mockState.updateOne).toHaveBeenLastCalledWith(
    expect.anything(), { $unset: { lease_owner: "", lease_until: "" } },
  );
  mockSkills.updateOne.mockResolvedValue({ upsertedCount: 0 });
  await expect(bootstrapSkills([example])).resolves.toEqual({ seeded: 0, skipped: 1 });
});

it("lets a concurrent replica finish without inserting duplicate skills", async () => {
  mockState.updateOne.mockRejectedValueOnce({ code: 11000 });
  await expect(bootstrapSkills([example])).resolves.toEqual({ seeded: 0, skipped: 0 });
  expect(mockSkills.updateOne).not.toHaveBeenCalled();
});

it("treats explicit empty skills as a completed bootstrap", async () => {
  await bootstrapSkills([]);
  expect(mockTemplates).not.toHaveBeenCalled();
  expect(mockSkills.updateOne).not.toHaveBeenCalled();
  expect(mockState.updateOne).toHaveBeenLastCalledWith(
    expect.anything(), expect.objectContaining({ $set: { completed_at: expect.any(Date) } }),
  );
});

it("preserves packaged scan verdicts when inserting MongoDB skills", async () => {
  mockScans.findOne.mockResolvedValue({ scan_status: "flagged", scan_summary: "Review required" });
  await bootstrapSkills();
  expect(mockSkills.updateOne).toHaveBeenCalledWith(
    expect.anything(),
    { $setOnInsert: expect.objectContaining({ scan_status: "flagged", scan_summary: "Review required" }) },
    { upsert: true },
  );
});

it("rejects invalid seed input before claiming the lease", async () => {
  await expect(bootstrapSkills([{ ...example, content: "" }])).rejects.toThrow("require");
  expect(mockState.updateOne).not.toHaveBeenCalled();
});

it("seeds only Hello World by default", async () => {
  expect(getDefaultSkillTemplates()).toEqual([hello]);
  await bootstrapSkills();
  expect(mockSkills.updateOne.mock.calls[0][0]).toEqual({ id: "hello-world" });
});

it("leaves existing installations for the explicit UI migration", async () => {
  mockExisting.findOne.mockResolvedValueOnce({ id: "test-user" });
  await bootstrapSkills();
  expect(mockSkills.updateOne).not.toHaveBeenCalled();
  expect(mockState.updateOne).not.toHaveBeenCalled();
});

it("retries an unfinished startup bootstrap even after skill records exist", async () => {
  mockState.findOne.mockResolvedValue({ _id: "skills" });
  mockExisting.findOne.mockResolvedValue({ id: "test-user" });
  await bootstrapSkills();
  expect(mockSkills.updateOne).toHaveBeenCalled();
});

it("does not complete a migration while another replica holds its lease", async () => {
  mockState.updateOne.mockRejectedValueOnce({ code: 11000 });
  await expect(bootstrapSkills([example], { migration: true })).rejects.toThrow("another replica");
});

it("does not consume migration seeds when packaged assets are unavailable", () => {
  mockTemplates.mockReturnValue([]);
  expect(() => getLegacySkillTemplates()).toThrow("catalog unavailable");
});
