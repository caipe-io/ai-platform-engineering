/**
 * @jest-environment jsdom
 */

import { renderHook } from "@testing-library/react";

import { useAgentTimeline } from "@/hooks/useDynamicAgentTimeline";
import type { StreamEvent } from "@/lib/streaming/types";

function contentEvent(id: number,content: string): StreamEvent {
  return {
    id: `content-${id}`,
    timestamp: new Date(id),
    type: "content",
    raw: content,
    namespace: [],
    content,
  };
}

describe("useAgentTimeline",() => {
  it("handles a fresh empty event array without scheduling derived state updates",() => {
    let renderCount = 0;
    const { result } = renderHook(() => {
      renderCount += 1;
      return useAgentTimeline([],false);
    });

    expect(result.current.data).toEqual({
      segments: [],
      finalAnswer: null,
      isStreaming: false,
      hasTools: false,
    });
    expect(renderCount).toBe(1);
  });

  it("projects rapidly growing stream event arrays without losing content",() => {
    const initialEvents = [contentEvent(0,"0")];
    let renderCount = 0;
    const { result,rerender } = renderHook(
      ({ events }: { events: StreamEvent[] }) => {
        renderCount += 1;
        return useAgentTimeline(events,true);
      },
      { initialProps: { events: initialEvents } },
    );

    let events = initialEvents;
    for (let index = 1; index < 150; index += 1) {
      events = [...events,contentEvent(index,String(index))];
      rerender({ events });
    }

    expect(result.current.data.finalAnswer).toBe(
      Array.from({ length: 150 },(_,index) => String(index)).join(""),
    );
    expect(result.current.data.isStreaming).toBe(true);
    expect(renderCount).toBe(150);
  });
});
