import { act, renderHook } from "@testing-library/react";
import { useSession } from "next-auth/react";
import { refreshMigrationStatus, useMigrationStatus } from "../use-migration-status";

jest.mock("next-auth/react", () => ({ useSession: jest.fn() }));
const mockFetch = jest.fn();
const originalFetch = global.fetch;
const summary = { release: "example-release", is_blocking: true };
const flush = () => act(async () => { await Promise.resolve(); });
beforeEach(() => {
  jest.useFakeTimers();
  global.fetch = mockFetch;
  mockFetch.mockReset().mockResolvedValue({ ok: true, status: 200, json: async () => ({ data: summary }) });
  (useSession as jest.Mock).mockReturnValue({ status: "authenticated", data: { sub: "example-user" } });
});
afterEach(() => { jest.useRealTimers(); global.fetch = originalFetch; });
it("does not request the admin endpoint unless explicitly enabled", async () => {
  renderHook(() => useMigrationStatus());
  await act(async () => { jest.advanceTimersByTime(180_000); window.dispatchEvent(new Event("focus")); refreshMigrationStatus(); });
  expect(mockFetch).not.toHaveBeenCalled();
});
it("requires an authenticated session even when enabled", () => {
  (useSession as jest.Mock).mockReturnValue({ status: "loading", data: null });
  renderHook(() => useMigrationStatus({ enabled: true }));
  expect(mockFetch).not.toHaveBeenCalled();
});
it("polls and refreshes an authorized admin", async () => {
  const { result } = renderHook(() => useMigrationStatus({ enabled: true }));
  await flush();
  expect(result.current.status).toEqual(summary);
  await act(async () => { jest.advanceTimersByTime(60_000); });
  expect(mockFetch).toHaveBeenCalledTimes(2);
});
it.each([401, 403])("suspends interval, focus and event refresh after %i", async status => {
  mockFetch.mockResolvedValue({ ok: false, status });
  const { result } = renderHook(() => useMigrationStatus({ enabled: true }));
  await flush();
  await act(async () => { jest.advanceTimersByTime(180_000); window.dispatchEvent(new Event("focus")); refreshMigrationStatus(); });
  expect(mockFetch).toHaveBeenCalledTimes(1);
  expect(result.current.status).toBeNull();
});
it("retries transient server failures", async () => {
  mockFetch.mockResolvedValueOnce({ ok: false, status: 503 });
  renderHook(() => useMigrationStatus({ enabled: true }));
  await flush();
  await act(async () => { jest.advanceTimersByTime(60_000); });
  expect(mockFetch).toHaveBeenCalledTimes(2);
});
it("does not accumulate requests while a response is pending", async () => {
  mockFetch.mockReturnValue(new Promise(() => {}));
  renderHook(() => useMigrationStatus({ enabled: true }));
  await act(async () => { jest.advanceTimersByTime(180_000); window.dispatchEvent(new Event("focus")); });
  expect(mockFetch).toHaveBeenCalledTimes(1);
});
it("clears stale data and aborts when admin eligibility is removed", async () => {
  const { result, rerender } = renderHook(({ enabled }) => useMigrationStatus({ enabled }), { initialProps: { enabled: true } });
  await flush();
  const signal = mockFetch.mock.calls[0][1].signal;
  rerender({ enabled: false });
  expect(signal.aborted).toBe(true);
  expect(result.current.status).toBeNull();
  await act(async () => { jest.advanceTimersByTime(60_000); });
  expect(mockFetch).toHaveBeenCalledTimes(1);
});
it("resets a denial for a new authenticated principal", async () => {
  mockFetch.mockResolvedValueOnce({ ok: false, status: 403 });
  const { rerender } = renderHook(() => useMigrationStatus({ enabled: true }));
  await flush();
  (useSession as jest.Mock).mockReturnValue({ status: "authenticated", data: { sub: "different-user" } });
  rerender();
  await flush();
  expect(mockFetch).toHaveBeenCalledTimes(2);
});
