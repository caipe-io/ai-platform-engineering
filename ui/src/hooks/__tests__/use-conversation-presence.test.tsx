import { act, renderHook } from "@testing-library/react";

import { useConversationPresence } from "../use-conversation-presence";

class TestEventSource extends EventTarget {
  static CLOSED = 2;
  static instances: TestEventSource[] = [];
  readyState = 1;
  close = jest.fn();
  constructor(public url: string) { super(); TestEventSource.instances.push(this); }
  publish(value: unknown) { this.dispatchEvent(new MessageEvent("presence", { data: JSON.stringify(value) })); }
}

beforeEach(() => {
  TestEventSource.instances = [];
  Object.defineProperty(globalThis, "EventSource", { configurable: true, value: TestEventSource });
});
afterEach(() => { jest.useRealTimers(); Reflect.deleteProperty(globalThis, "EventSource"); });

it("shares one subscription per conversation in a document until its last consumer leaves", () => {
  const first = renderHook(() => useConversationPresence("chat-example"));
  const second = renderHook(() => useConversationPresence("chat-example"));
  expect(TestEventSource.instances).toHaveLength(1);
  const source = TestEventSource.instances[0];
  const presence = { viewers: [{ id: "primary", name: "Example User", sessions: 2 }], sessionCount: 2 };
  act(() => source.publish(presence));
  expect(first.result.current).toEqual(presence);
  expect(second.result.current).toEqual(presence);
  first.unmount();
  expect(source.close).not.toHaveBeenCalled();
  second.unmount();
  expect(source.close).toHaveBeenCalledTimes(1);
});

it("clears stale identities on errors/revocation and closes revoked streams", () => {
  const hook = renderHook(() => useConversationPresence("chat-example"));
  const source = TestEventSource.instances[0];
  const presence = { viewers: [{ id: "primary", name: "Example User", sessions: 1 }], sessionCount: 1 };
  act(() => source.publish(presence));
  act(() => source.dispatchEvent(new Event("error")));
  expect(hook.result.current).toBeNull();
  act(() => source.publish(presence));
  act(() => source.dispatchEvent(new Event("access-revoked")));
  expect(hook.result.current).toBeNull();
  expect(source.close).toHaveBeenCalled();
});

it("switches conversations without exposing the previous viewers and rejects malformed snapshots", () => {
  const hook = renderHook(({ id }) => useConversationPresence(id), { initialProps: { id: "primary-chat" } });
  act(() => TestEventSource.instances[0].publish({ viewers: [{ id: "primary", name: "Example User", sessions: 1 }], sessionCount: 1 }));
  hook.rerender({ id: "secondary-chat" });
  expect(hook.result.current).toBeNull();
  expect(TestEventSource.instances[0].close).toHaveBeenCalled();
  act(() => TestEventSource.instances[1].publish({ viewers: "invalid" }));
  expect(hook.result.current).toBeNull();
});

it("retries a closed connection when a chat is still being saved and cancels retry on unmount", () => {
  jest.useFakeTimers();
  const hook = renderHook(() => useConversationPresence("chat-example"));
  const source = TestEventSource.instances[0];
  source.readyState = TestEventSource.CLOSED;
  act(() => source.dispatchEvent(new Event("error")));
  act(() => jest.advanceTimersByTime(5_000));
  expect(TestEventSource.instances).toHaveLength(2);
  TestEventSource.instances[1].readyState = TestEventSource.CLOSED;
  act(() => TestEventSource.instances[1].dispatchEvent(new Event("error")));
  hook.unmount();
  act(() => jest.advanceTimersByTime(5_000));
  expect(TestEventSource.instances).toHaveLength(2);
  jest.useRealTimers();
});

it("backs off persistent failures to one minute and resets after valid presence", () => {
  jest.useFakeTimers();
  const hook = renderHook(() => useConversationPresence("chat-example"));
  const delays = [5_000, 10_000, 20_000, 40_000, 60_000, 60_000];
  delays.forEach((delay, index) => {
    const source = TestEventSource.instances[index];
    act(() => source.dispatchEvent(new Event("error")));
    expect(source.close).toHaveBeenCalledTimes(1);
    act(() => jest.advanceTimersByTime(delay - 1));
    expect(TestEventSource.instances).toHaveLength(index + 1);
    act(() => jest.advanceTimersByTime(1));
    expect(TestEventSource.instances).toHaveLength(index + 2);
  });
  const recovered = TestEventSource.instances.at(-1)!;
  act(() => recovered.publish({ viewers: [], sessionCount: 0 }));
  act(() => recovered.dispatchEvent(new Event("error")));
  act(() => jest.advanceTimersByTime(5_000));
  expect(TestEventSource.instances).toHaveLength(delays.length + 2);
  hook.unmount();
});
