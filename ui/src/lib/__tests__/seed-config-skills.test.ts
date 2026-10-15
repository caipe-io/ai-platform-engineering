/** @jest-environment node */

const mockSkills = { findOne: jest.fn(), replaceOne: jest.fn(), find: jest.fn(), deleteOne: jest.fn() };
const mockReconcile = jest.fn();
const mockDeleteTuples = jest.fn();
const mockState = { updateOne: jest.fn() };
jest.mock("@/lib/mongodb", () => ({
  isMongoDBConfigured: true,
  getCollection: async (name: string) => name === "agent_skills" ? mockSkills : name === "startup_seeds" ? mockState : {
    find: () => ({ toArray: async () => [] }),
  },
}));
jest.mock("@/lib/rbac/openfga", () => ({ isOpenFgaReconciliationEnabled: () => true }));
jest.mock("@/lib/rbac/openfga-owned-resources-reconcile", () => ({
  reconcileShareableResource: (...args: unknown[]) => mockReconcile(...args),
  deleteAllSkillRelationshipTuples: (...args: unknown[]) => mockDeleteTuples(...args),
}));
import { seedConfiguredSkills } from "../seed-config";

const skill = { id: "example-skill", name: "Example Skill", content: "Summarize a document." };
beforeEach(() => {
  jest.resetAllMocks();
  mockSkills.findOne.mockResolvedValue(null);
  mockSkills.find.mockReturnValue({ toArray: async () => [] });
  mockState.updateOne.mockResolvedValue({ matchedCount: 1 });
});

it("reapplies configured skills with stable creation time and managed ownership", async () => {
  const created = new Date("2026-01-01T00:00:00Z");
  mockSkills.findOne.mockResolvedValue({ created_at: created, skill_content: "Previous prompt" });
  expect(await seedConfiguredSkills([skill])).toBe(1);
  expect(mockSkills.replaceOne).toHaveBeenCalledWith({ id: skill.id }, expect.objectContaining({
    config_driven: true, owner_id: "system", skill_content: skill.content, created_at: created,
  }), { upsert: true });
  await seedConfiguredSkills([{ ...skill, content: "Updated prompt" }]);
  expect(mockSkills.replaceOne).toHaveBeenLastCalledWith({ id: skill.id }, expect.objectContaining({
    skill_content: "Updated prompt",
  }), { upsert: true });
});

it("preserves scan verdicts for unchanged content and invalidates them for changed content", async () => {
  mockSkills.findOne.mockResolvedValue({ skill_content: skill.content, scan_status: "flagged", scan_override: { reason: "Reviewed" } });
  await seedConfiguredSkills([skill]);
  expect(mockSkills.replaceOne.mock.calls[0][1].scan_status).toBe("flagged");
  await seedConfiguredSkills([{ ...skill, content: "Updated prompt" }]);
  expect(mockSkills.replaceOne.mock.calls[1][1].scan_status).toBeUndefined();
  expect(mockSkills.replaceOne.mock.calls[1][1].scan_override).toBeUndefined();
});

it("rejects duplicate or malformed configuration before writing", async () => {
  await expect(seedConfiguredSkills([skill, skill])).rejects.toThrow("unique");
  await expect(seedConfiguredSkills([{ ...skill, content: "" }])).rejects.toThrow("require");
  expect(mockSkills.replaceOne).not.toHaveBeenCalled();
});

it("removes only config-managed skills absent from YAML and revokes their grants", async () => {
  mockSkills.find.mockReturnValue({ toArray: async () => [
    { id: "keep-skill", config_driven: true }, { id: "remove-skill", config_driven: true },
  ] });
  await seedConfiguredSkills([{ ...skill, id: "keep-skill" }]);
  expect(mockSkills.find).toHaveBeenCalledWith({ config_driven: true });
  expect(mockSkills.deleteOne).toHaveBeenCalledTimes(1);
  expect(mockSkills.deleteOne).toHaveBeenCalledWith({ id: "remove-skill", config_driven: true });
  expect(mockDeleteTuples).toHaveBeenCalledWith("remove-skill");
});

it("serializes different configurations through writes, grant changes, and stale cleanup", async () => {
  let leaseOwner: string | undefined;
  mockState.updateOne.mockImplementation(async (filter, update, options) => {
    if (options?.upsert) {
      if (leaseOwner) throw { code: 11000 };
      leaseOwner = update.$set.lease_owner;
    } else if (filter.lease_owner !== leaseOwner) return { matchedCount: 0 };
    if (update.$unset) leaseOwner = undefined;
    return { matchedCount: 1 };
  });
  const stored = new Map<string, { id: string; skill_content: string }>();
  mockSkills.findOne.mockImplementation(async ({ id }) => stored.get(id) ?? null);
  mockSkills.replaceOne.mockImplementation(async ({ id }, document) => { stored.set(id, document); });
  mockSkills.find.mockReturnValue({ toArray: async () => [...stored.values()] });
  mockSkills.deleteOne.mockImplementation(async ({ id }) => { stored.delete(id); });
  let releaseFirst!: () => void;
  let enteredFirst!: () => void;
  const entered = new Promise<void>((resolve) => { enteredFirst = resolve; });
  mockReconcile.mockImplementationOnce(async () => {
    enteredFirst();
    await new Promise<void>((resolve) => { releaseFirst = resolve; });
  });
  const first = seedConfiguredSkills([{ ...skill, id: "primary" }]);
  await entered;
  const second = seedConfiguredSkills([{ ...skill, id: "secondary" }]);
  await new Promise((resolve) => setTimeout(resolve, 10));
  expect(stored.has("secondary")).toBe(false);
  expect(mockDeleteTuples).not.toHaveBeenCalled();
  releaseFirst();
  await Promise.all([first, second]);
  expect([...stored.keys()]).toEqual(["secondary"]);
  expect(mockDeleteTuples).toHaveBeenCalledWith("primary");
  expect(leaseOwner).toBeUndefined();
});
