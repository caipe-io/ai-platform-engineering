import { safeConnectionAction, validateConnectionGuidance } from "../connection-guidance";
const guide = { id: "webex", enabled: true, label: "Connect to Webex", title: "Webex instructions", markdown: "Search for example-bot@example.test and start a direct conversation.", action_label: "Link identity", action_url: "/api/auth/webex-link/start" };
test("accepts admin text and safe connection actions", () => { expect(validateConnectionGuidance([guide])).toEqual([guide]); });
test("accepts the optional Webex logo and rejects unsupported logos", () => {
  expect(validateConnectionGuidance([{ ...guide, logo: "webex" }])).toEqual([{ ...guide, logo: "webex" }]);
  expect(() => validateConnectionGuidance([{ ...guide, logo: "slack" }])).toThrow(/logo/);
});
test.each(["javascript:alert(1)", "//example.test", "/\\example.test", "https://user:pass@example.test", "/\n/example.test"])("rejects unsafe action %s", (url) => { expect(safeConnectionAction(url)).toBe(false); });
test("requires readable enabled instructions and unique channel IDs", () => {
  expect(() => validateConnectionGuidance([{ ...guide, markdown: "" }])).toThrow(/instructions/);
  expect(() => validateConnectionGuidance([guide, guide])).toThrow(/unique/);
  expect(() => validateConnectionGuidance([{ ...guide, markdown: "x".repeat(8193) }])).toThrow(/markdown/);
});
