/** @jest-environment node */
import { createStreamEvent } from "../types";
import { createAGUIProtocolState, processAGUIEvent } from "../protocols/agui";

it("dispatches progressive tool output without completing the tool", () => {
  const onToolOutput = jest.fn();
  const onToolEnd = jest.fn();
  expect(processAGUIEvent("CUSTOM", {
    name: "TOOL_OUTPUT", value: { tool_call_id: "call-stream", result: "partial", namespace: ["child"] },
  }, createAGUIProtocolState(), { onToolOutput, onToolEnd })).toBe(false);
  expect(onToolOutput).toHaveBeenCalledWith("call-stream", "partial", ["child"]);
  expect(onToolEnd).not.toHaveBeenCalled();
  expect(createStreamEvent("tool_output", { tool_call_id: "call-stream", result: "partial", namespace: ["child"] })).toMatchObject({
    type: "tool_output", toolData: { tool_call_id: "call-stream", result: "partial" }, namespace: ["child"],
  });
});
