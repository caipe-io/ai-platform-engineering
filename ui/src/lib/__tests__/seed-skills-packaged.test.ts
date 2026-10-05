/** @jest-environment node */

import { getDefaultSkillTemplates, getLegacySkillTemplates } from "../seed-skills";

const originalEnv = process.env;
beforeEach(() => {
  process.env = { ...originalEnv };
  delete process.env.SKILLS_DIR;
});
afterEach(() => { process.env = originalEnv; });

it("packages a tool-free example as the only initial default", () => {
  const templates = getDefaultSkillTemplates();
  expect(templates.map((skill) => skill.id)).toEqual(["hello-world"]);
  expect(templates[0].content).toContain("Do not call tools");
});

it("includes the legacy catalog and gateway instructions for existing installs", () => {
  const templates = getLegacySkillTemplates();
  expect(templates.length).toBeGreaterThan(2);
  expect(templates.map((skill) => skill.id)).toEqual(expect.arrayContaining(["live-skills", "update-skills"]));
  expect(templates.find((skill) => skill.id === "live-skills")?.content).toContain("{{BASE_URL}}");
  expect(templates.some((skill) => skill.id === "hello-world")).toBe(false);
});
