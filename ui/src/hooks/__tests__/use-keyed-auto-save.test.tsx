/**
 * @jest-environment jsdom
 */

import { act,renderHook,waitFor } from "@testing-library/react";

import { useKeyedAutoSave } from "@/hooks/use-keyed-auto-save";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise,rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise,reject,resolve };
}

describe("useKeyedAutoSave",() => {
  it("serializes one key and coalesces rapid changes to the latest value",async () => {
    const first = deferred<void>();
    const persist = jest.fn()
      .mockReturnValueOnce(first.promise)
      .mockResolvedValue(undefined);
    const { result } = renderHook(() => useKeyedAutoSave({ persist }));

    act(() => result.current.enqueue("theme","dark"));
    await waitFor(() => expect(persist).toHaveBeenCalledWith("theme","dark"));

    act(() => {
      result.current.enqueue("theme","light");
      result.current.enqueue("theme","nord");
    });
    expect(persist).toHaveBeenCalledTimes(1);

    await act(async () => {
      first.resolve();
      await first.promise;
    });

    await waitFor(() => {
      expect(persist).toHaveBeenCalledTimes(2);
      expect(persist).toHaveBeenLastCalledWith("theme","nord");
      expect(result.current.stateFor("theme").status).toBe("saved");
    });
  });

  it("runs unrelated setting keys independently",async () => {
    const font = deferred<void>();
    const persist = jest.fn((key: string) => key === "font" ? font.promise : Promise.resolve());
    const { result } = renderHook(() => useKeyedAutoSave({ persist }));

    act(() => {
      result.current.enqueue("font","large");
      result.current.enqueue("theme","light");
    });

    await waitFor(() => {
      expect(persist).toHaveBeenCalledWith("font","large");
      expect(persist).toHaveBeenCalledWith("theme","light");
      expect(result.current.stateFor("theme").status).toBe("saved");
      expect(result.current.stateFor("font").status).toBe("saving");
    });

    await act(async () => {
      font.resolve();
      await font.promise;
    });
  });

  it("surfaces a final failure and retries the same desired value",async () => {
    const onError = jest.fn();
    const persist = jest.fn()
      .mockRejectedValueOnce(new Error("network unavailable"))
      .mockResolvedValueOnce(undefined);
    const { result } = renderHook(() => useKeyedAutoSave({ persist,onError }));

    act(() => result.current.enqueue("timestamps",true));
    await waitFor(() => {
      expect(result.current.stateFor("timestamps")).toEqual({
        status: "error",
        error: "network unavailable",
      });
    });
    expect(onError).toHaveBeenCalledWith("timestamps",true,expect.any(Error));
    expect(result.current.pendingValueFor("timestamps")).toBe(true);

    act(() => result.current.retry("timestamps"));
    await waitFor(() => {
      expect(persist).toHaveBeenCalledTimes(2);
      expect(persist).toHaveBeenLastCalledWith("timestamps",true);
      expect(result.current.stateFor("timestamps").status).toBe("saved");
    });
  });
});
