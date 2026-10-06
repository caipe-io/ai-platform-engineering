/** @jest-environment node */

import fs from "fs";

const mockCollection = { updateOne: jest.fn(), findOne: jest.fn() };
const mockGetCollection = jest.fn();
jest.mock("@/lib/mongodb", () => ({
  isMongoDBConfigured: true,
  getCollection: (...args: unknown[]) => mockGetCollection(...args),
}));

import { getSystemSkill, readPackagedSystemSkill, seedSystemSkills } from "../system-skills";

const originalEnv = process.env;
beforeEach(() => {
  jest.clearAllMocks();
  mockGetCollection.mockResolvedValue(mockCollection);
  jest.requireMock("@/lib/mongodb").isMongoDBConfigured = true;
  process.env = { ...originalEnv };
});
afterEach(() => {
  process.env = originalEnv;
  jest.restoreAllMocks();
});

it("loads the two gateway instructions from code-owned packaged assets", () => {
  expect(readPackagedSystemSkill("live-skills")).toContain("execute skills inline");
  expect(readPackagedSystemSkill("update-skills")).toContain("Refresh locally-installed");
});

it("ignores the ordinary skills directory and legacy gateway overrides", () => {
  process.env.SKILLS_DIR = "/example/operator-skills";
  process.env.SKILLS_LIVE_SKILLS_TEMPLATE = "Operator content";
  process.env.SKILLS_LIVE_SKILLS_FILE = "/example/operator-template.md";
  expect(readPackagedSystemSkill("live-skills")).not.toContain("Operator content");
});

it("upserts system instructions on every startup without touching the ordinary catalog", async () => {
  expect(await seedSystemSkills()).toBe(2);
  expect(mockGetCollection).toHaveBeenCalledWith("system_skills");
  expect(mockCollection.updateOne).toHaveBeenCalledWith(
    { _id: "live-skills" },
    { $set: { name: "Live Skills", content: expect.stringContaining("{{BASE_URL}}") },
      $setOnInsert: { created_at: expect.any(Date) } },
    { upsert: true },
  );
  await seedSystemSkills();
  expect(mockCollection.updateOne).toHaveBeenCalledTimes(4);
  expect(mockGetCollection.mock.calls.every(([name]) => name === "system_skills")).toBe(true);
});

it("reads only the protected record by its system id", async () => {
  const record = { _id: "live-skills", content: "Packaged instructions" };
  mockCollection.findOne.mockResolvedValue(record);
  expect(await getSystemSkill("live-skills")).toEqual(record);
  expect(mockGetCollection).toHaveBeenCalledWith("system_skills");
  expect(mockCollection.findOne).toHaveBeenCalledWith({ _id: "live-skills" });
});

it("validates all packaged templates before writing any records", async () => {
  jest.spyOn(fs, "existsSync").mockReturnValue(true);
  jest.spyOn(fs, "statSync").mockReturnValue({ isFile: () => true, size: 100 } as fs.Stats);
  jest.spyOn(fs, "readFileSync").mockImplementation((file) => String(file).endsWith("update-skills.md") ? "" : "Valid instructions");
  await expect(seedSystemSkills()).rejects.toThrow("Empty packaged system skill");
  expect(mockGetCollection).not.toHaveBeenCalled();
  expect(mockCollection.updateOne).not.toHaveBeenCalled();
});

it("does not write without MongoDB and leaves failures retryable", async () => {
  jest.requireMock("@/lib/mongodb").isMongoDBConfigured = false;
  expect(await seedSystemSkills()).toBe(0);
  expect(mockGetCollection).not.toHaveBeenCalled();
  jest.requireMock("@/lib/mongodb").isMongoDBConfigured = true;
  mockCollection.updateOne.mockRejectedValueOnce(new Error("Database unavailable"));
  await expect(seedSystemSkills()).rejects.toThrow("Database unavailable");
  await expect(seedSystemSkills()).resolves.toBe(2);
});
