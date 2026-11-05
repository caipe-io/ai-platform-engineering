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


it("does not report a remotely cancelled run as completed", () => {
  const onDone = jest.fn(), onError = jest.fn();
  expect(processAGUIEvent("RUN_FINISHED", { outcome: "cancelled" }, createAGUIProtocolState(), { onDone, onError })).toBe(true);
  expect(onDone).not.toHaveBeenCalled();
  expect(onError).toHaveBeenCalledWith(expect.stringContaining("stopped"));
});
