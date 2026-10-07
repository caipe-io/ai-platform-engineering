/** @jest-environment node */
import type { Collection } from "mongodb";
import type { AgentSkill } from "@/types/agent-skill";

jest.mock("@/lib/api-middleware", () => ({
  ApiError: class extends Error { constructor(message: string, public statusCode: number) { super(message); } },
}));
import { persistImportedSkill } from "../persist-skill";

const mockCollection = {
  findOne: jest.fn(), insertOne: jest.fn(), updateOne: jest.fn(), deleteOne: jest.fn(), replaceOne: jest.fn(),
};
const collection = mockCollection as unknown as Collection<AgentSkill>;
const skill = { id: "example-skill", name: "Example Skill", skill_content: "Imported content" } as AgentSkill;
const filter = { id: skill.id, config_driven: { $ne: true } };
beforeEach(() => {
  jest.resetAllMocks();
  mockCollection.findOne.mockResolvedValue({ ...skill, skill_content: "Original content" });
  mockCollection.updateOne.mockResolvedValue({ matchedCount: 1 });
});

it("rejects overwrite when the ordinary skill becomes configured after conflict checking", async () => {
  mockCollection.updateOne.mockResolvedValue({ matchedCount: 0 });
  await expect(persistImportedSkill(collection, skill, "overwrite")).rejects.toMatchObject({ statusCode: 409 });
  expect(mockCollection.updateOne).toHaveBeenCalledWith(filter, expect.anything());
  expect(mockCollection.replaceOne).not.toHaveBeenCalled();
});

it("keeps overwrite rollback from restoring an ordinary snapshot over a configured record", async () => {
  const result = await persistImportedSkill(collection, skill, "overwrite");
  const configured = { ...skill, config_driven: true, skill_content: "Configured content" };
  mockCollection.replaceOne.mockImplementation(async (query, previous) => {
    if (!(query.config_driven?.$ne === true && configured.config_driven)) Object.assign(configured, previous);
  });
  await result.rollback();
  expect(mockCollection.replaceOne).toHaveBeenCalledWith(filter, expect.objectContaining({ skill_content: "Original content" }));
  expect(configured.skill_content).toBe("Configured content");
});

it("keeps create rollback from deleting a record adopted by app-config", async () => {
  const result = await persistImportedSkill(collection, skill, "create");
  await result.rollback();
  expect(mockCollection.insertOne).toHaveBeenCalledWith(skill);
  expect(mockCollection.deleteOne).toHaveBeenCalledWith(filter);
});
