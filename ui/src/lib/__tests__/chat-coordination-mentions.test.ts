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


describe("canonical participant replies", () => {
  it("shares identities between submit and recovery, preserving server-owned handoffs", () => {
    const { participantAssistantMessageId, handoffAssistantMessageId } = jest.requireActual("../chat-coordination");
    expect(participantAssistantMessageId("example-turn")).toBe("reply-example-turn-assistant");
    expect(participantAssistantMessageId("example-turn", "primary")).not.toBe(participantAssistantMessageId("example-turn", "helper"));
    const turn = `handoff-${"a".repeat(64)}`;
    expect(participantAssistantMessageId(turn)).toBe(handoffAssistantMessageId(turn));
  });
  it("hides legacy subscriber duplicates without losing a finished answer or another agent", () => {
    const { deduplicateParticipantReplies } = jest.requireActual("../chat-coordination");
    const messages = [
      { id: "first", role: "assistant", agentId: "primary", turnId: "example", content: "partial", isFinal: false },
      { id: "second", role: "assistant", agentId: "primary", turnId: "example", content: "Completed result", isFinal: true, turnStatus: "done" },
      { id: "peer", role: "assistant", agentId: "helper", turnId: "example", content: "Peer result", isFinal: true },
    ];
    expect(deduplicateParticipantReplies(messages).map((message: { id: string }) => message.id)).toEqual(["second", "peer"]);
  });
});
