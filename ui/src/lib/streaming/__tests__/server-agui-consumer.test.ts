/** @jest-environment node */
import { consumeAgentStream } from "../clients/server-agui-consumer";
const mockAppend = jest.fn();
jest.mock("@/lib/server/event-store", () => ({ appendEvents: (...args: unknown[]) => mockAppend(...args) }));

it("retains single-tool permitted decisions and separate reasoning through workflow consumption", async () => {
  const events = [
    { type: "CUSTOM", name: "REASONING_DELTA", value: { text: "Planning the next step", namespace: [] } },
    { type: "RUN_FINISHED", outcome: "interrupt", interrupt: { id: "permission-current", reason: "tool_approval", payload: {
      tool_name: "read_file", tool_args: { path: "/example.txt" }, allowed_decisions: ["reject"], agent: "example-agent",
    } } },
  ];
  global.fetch = jest.fn().mockResolvedValue(new Response(events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join("")));
  const result = await consumeAgentStream({ url: "https://runtime.example.test/stream", body: {}, headers: {}, sourceType: "workflow_step", sourceId: "example-step" });
  expect(result).toMatchObject({ text: "", interrupted: true, interrupt: { interruptId: "permission-current", allowedDecisions: ["reject"] } });
  expect(mockAppend).toHaveBeenCalledWith("workflow_step", "example-step", expect.arrayContaining([expect.objectContaining({ type: "reasoning", content: "Planning the next step" })]));
});
