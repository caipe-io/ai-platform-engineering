/**
 * @jest-environment node
 */

import type { StreamCallbacks } from "../callbacks";
import { createAGUIProtocolState,processAGUIEvent } from "../protocols/agui";

describe("AG-UI context usage",() => {
  it("dispatches the protocol-neutral context usage callback",() => {
    const onContextUsage = jest.fn();
    const callbacks: StreamCallbacks = { onContextUsage };

    const terminal = processAGUIEvent(
      "CUSTOM",
      {
        name: "CONTEXT_USAGE",
        value: {
          used_tokens: 25,
          compaction_threshold: 100,
          remaining_tokens: 75,
          remaining_percent: 75,
          namespace: [],
        },
      },
      createAGUIProtocolState(),
      callbacks,
    );

    expect(terminal).toBe(false);
    expect(onContextUsage).toHaveBeenCalledWith(
      {
        used_tokens: 25,
        compaction_threshold: 100,
        remaining_tokens: 75,
        remaining_percent: 75,
      },
      [],
    );
  });
});
