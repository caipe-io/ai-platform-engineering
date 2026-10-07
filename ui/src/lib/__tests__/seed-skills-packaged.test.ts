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

it("keeps protected gateway instructions out of the ordinary packaged catalog", () => {
  const templates = getLegacySkillTemplates();
  expect(templates.length).toBeGreaterThan(2);
  expect(templates.some((skill) => ["live-skills", "update-skills"].includes(skill.id))).toBe(false);
  expect(templates.some((skill) => skill.id === "hello-world")).toBe(false);
});
