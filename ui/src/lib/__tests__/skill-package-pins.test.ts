jest.mock("../api-middleware", () => ({ ApiError: class extends Error { constructor(message: string, public status: number) { super(message); } } }));
import { normalizeSkillPackagePins } from "../skill-package-pins";
const digest = "a".repeat(64);
it("retains exact content and ancillary hashes for an attached stable ID", () => {
  const pins = { skill: { content_sha256: digest, ancillary_sha256: { "references/check.md": digest } } };
  expect(normalizeSkillPackagePins(pins, ["skill"])).toEqual(pins);
});
it.each([null, [], { skill: { content_sha256: "bad", ancillary_sha256: {} } },
  { skill: { content_sha256: digest, ancillary_sha256: { "../escape": digest } } },
  { skill: { content_sha256: digest, ancillary_sha256: { "SKILL.md": digest } } }])("rejects malformed pin package %p", pins => {
  expect(() => normalizeSkillPackagePins(pins, ["skill"])).toThrow();
});
it("does not allow pinning an unattached ID", () => {
  expect(() => normalizeSkillPackagePins({ other: { content_sha256: digest, ancillary_sha256: {} } }, ["skill"])).toThrow();
});
