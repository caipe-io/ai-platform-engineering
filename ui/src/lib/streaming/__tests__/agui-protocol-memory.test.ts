/**
 * @jest-environment node
 */

import type { StreamCallbacks } from "../callbacks";
import {
  createAGUIProtocolState,
  processAGUIEvent,
} from "../protocols/agui";

describe("AG-UI protocol memory events", () => {
  it("dispatches memory custom events to semantic callbacks", () => {
    const state = createAGUIProtocolState();
    const callbacks: StreamCallbacks = {
      onMemoryInjected: jest.fn(),
      onMemoryUpdate: jest.fn(),
    };

    expect(
      processAGUIEvent(
        "CUSTOM",
        {
          type: "CUSTOM",
          name: "MEMORY_INJECTED",
          value: { memory_ids: ["mem-1", "mem-2"], namespace: [] },
        },
        state,
        callbacks,
      ),
    ).toBe(false);
    expect(callbacks.onMemoryInjected).toHaveBeenCalledWith(["mem-1", "mem-2"], []);

    expect(
      processAGUIEvent(
        "CUSTOM",
        {
          type: "CUSTOM",
          name: "MEMORY_CONTEXT_USED",
          value: { memory_ids: ["ctx-1"], namespace: ["subagent"] },
        },
        state,
        callbacks,
      ),
    ).toBe(false);
    expect(callbacks.onMemoryInjected).toHaveBeenNthCalledWith(2, ["ctx-1"], ["subagent"]);

    expect(
      processAGUIEvent(
        "CUSTOM",
        {
          type: "CUSTOM",
          name: "MEMORY_UPDATED",
          value: { memory_ids: ["mem-3"], action: "remember", namespace: [] },
        },
        state,
        callbacks,
      ),
    ).toBe(false);
    expect(callbacks.onMemoryUpdate).toHaveBeenCalledWith(["mem-3"], "remember", []);
  });
});
