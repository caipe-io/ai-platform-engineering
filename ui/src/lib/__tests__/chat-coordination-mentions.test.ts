import { agentMentionQuery, agentMentionTokens, leadingAgentMentions } from "../chat-coordination";

it("routes only a leading recipient block, deduplicated in input order", () => {
  const input = "  @first @second @first Verify @reference notes";
  const result = leadingAgentMentions(input);
  expect(result.handles).toEqual(["first", "second"]);
  expect(input.slice(result.end)).toBe("Verify @reference notes");
  expect(leadingAgentMentions("Email user@example.test or ask @helper").handles).toEqual([]);
  expect(leadingAgentMentions("@invalid_handle @helper Check").handles).toEqual([]);
});

it("locates a second token at the caret without treating email as a query", () => {
  expect(agentMentionQuery("@first @sec message", 11)).toEqual({ start: 7, filter: "sec" });
  expect(agentMentionQuery("user@example", 12)).toBeNull();
  expect(agentMentionTokens("@first @second suffix")).toEqual([
    { handle: "first", start: 0, end: 6 }, { handle: "second", start: 7, end: 14 },
  ]);
});
