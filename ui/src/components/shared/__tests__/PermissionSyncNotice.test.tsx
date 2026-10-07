import { act, render, screen } from "@testing-library/react";
import { PermissionSyncNotice } from "../PermissionSyncNotice";
import { PERMISSIONS_PENDING_MESSAGE } from "@/lib/authz/permission-sync-contract";

const pending = { id: "example-operation", state: "pending" as const, requested_at: "2026-01-01" };
beforeEach(() => {
  jest.useFakeTimers();
  global.fetch = jest.fn();
  jest.spyOn(AbortSignal, "timeout").mockReturnValue(new AbortController().signal);
  jest.spyOn(AbortSignal, "any").mockImplementation(signals => signals[0]);
});
afterEach(() => { jest.useRealTimers(); jest.restoreAllMocks(); });

it("shows durable pending state on mount, without a perpetual spinner", () => {
  render(<PermissionSyncNotice status={pending} />);
  expect(screen.getByRole("status")).toHaveTextContent(PERMISSIONS_PENDING_MESSAGE);
  expect(screen.getByRole("status")).toHaveTextContent("You can leave this page");
  expect(document.querySelector(".animate-spin")).toBeNull();
});

it("confirms completion only for the matching server operation", async () => {
  const onApplied = jest.fn();
  const completed = { ...pending, state: "applied" };
  jest.mocked(fetch).mockResolvedValue({ ok: true, json: async () => ({ data: completed }) } as Response);
  render(<PermissionSyncNotice status={pending} onApplied={onApplied} />);
  await act(async () => { await jest.advanceTimersByTimeAsync(5000); });
  expect(onApplied).toHaveBeenCalledWith(completed);
  expect(fetch).toHaveBeenCalledWith("/api/access/operations/example-operation", expect.objectContaining({ cache: "no-store" }));
});

it("keeps uncertainty visible on a network failure and retries", async () => {
  const onApplied = jest.fn();
  jest.mocked(fetch).mockRejectedValue(new Error("offline"));
  render(<PermissionSyncNotice status={pending} onApplied={onApplied} />);
  await act(async () => { await jest.advanceTimersByTimeAsync(10_000); });
  expect(fetch).toHaveBeenCalledTimes(2);
  expect(screen.getByRole("status")).toHaveTextContent("Completion has not been confirmed");
  expect(onApplied).not.toHaveBeenCalled();
});

it("asks for a resource refresh on deletion, not a success notification", async () => {
  const onMissing = jest.fn();
  const onApplied = jest.fn();
  jest.mocked(fetch).mockResolvedValue({ ok: false, status: 404 } as Response);
  render(<PermissionSyncNotice status={pending} onMissing={onMissing} onApplied={onApplied} />);
  await act(async () => { await jest.advanceTimersByTimeAsync(5000); });
  expect(onMissing).toHaveBeenCalledTimes(1);
  expect(onApplied).not.toHaveBeenCalled();
});

it("stops browser polling after navigation; server recovery is independent", async () => {
  const { unmount } = render(<PermissionSyncNotice status={pending} />);
  unmount();
  await act(async () => { await jest.advanceTimersByTimeAsync(20_000); });
  expect(fetch).not.toHaveBeenCalled();
});
