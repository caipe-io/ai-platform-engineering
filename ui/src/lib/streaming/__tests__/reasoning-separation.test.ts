/** @jest-environment node */
import { createStreamAdapter } from "../adapter";

it.each(["custom", "agui"] as const)("keeps %s published reasoning separate from final content", async (protocol) => {
  const events = protocol === "custom" ? [
    ["reasoning", { text: "Checking evidence", namespace: ["child"] }],
    ["content", { text: "The answer", namespace: [] }],
    ["done", {}],
  ] : [
    ["CUSTOM", { name: "REASONING_DELTA", value: { text: "Checking evidence", namespace: ["child"] } }],
    ["TEXT_MESSAGE_CONTENT", { delta: "The answer" }],
    ["RUN_FINISHED", {}],
  ];
  global.fetch = jest.fn().mockResolvedValue(new Response(events.map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join("")));
  const callbacks = { onReasoning: jest.fn(), onContent: jest.fn(), onDone: jest.fn() };
  await createStreamAdapter({ protocol }).streamMessage({ conversationId: "conversation-primary", agentId: "agent-primary", message: "Question" }, callbacks);
  expect(callbacks.onReasoning).toHaveBeenCalledWith("Checking evidence", ["child"]);
  expect(callbacks.onContent).toHaveBeenCalledTimes(1);
  expect(callbacks.onContent.mock.calls[0][0]).toBe("The answer");
  expect(callbacks.onDone).toHaveBeenCalledTimes(1);
});
