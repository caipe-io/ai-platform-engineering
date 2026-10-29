/** @jest-environment node */

import { PHASE_PRODUCTION_BUILD } from "next/constants";

import {
  startConversationRetention,
  stopConversationRetention,
  tickConversationRetention,
} from "../conversation-retention.server";

let mockMongoConfigured = true;
const mockPurgeExpiredConversations = jest.fn();

jest.mock("@/lib/mongodb", () => ({
  get isMongoDBConfigured() { return mockMongoConfigured; },
}));
jest.mock("@/app/api/chat/conversations/delete-permanently", () => ({
  purgeExpiredConversations: (...args: unknown[]) => mockPurgeExpiredConversations(...args),
}));

const originalPhase = process.env.NEXT_PHASE;
const now = new Date("2026-01-20T12:00:00.000Z");

beforeEach(() => {
  jest.useFakeTimers({ now });
  mockMongoConfigured = true;
  delete process.env.NEXT_PHASE;
  mockPurgeExpiredConversations.mockReset().mockResolvedValue({ examined: 0, deleted: 0, failed: 0 });
  jest.spyOn(console, "error").mockImplementation(() => undefined);
  jest.spyOn(console, "log").mockImplementation(() => undefined);
});

afterEach(() => {
  stopConversationRetention();
  jest.useRealTimers();
  jest.restoreAllMocks();
  if (originalPhase === undefined) delete process.env.NEXT_PHASE;
  else process.env.NEXT_PHASE = originalPhase;
});

it("runs a bounded all-owner cleanup pass without a user request", async () => {
  await tickConversationRetention(now);

  expect(mockPurgeExpiredConversations).toHaveBeenCalledTimes(1);
  expect(mockPurgeExpiredConversations).toHaveBeenCalledWith(now, 100);
});

it("starts immediately and runs once per minute without stacking duplicate timers", async () => {
  startConversationRetention();
  startConversationRetention();
  await jest.advanceTimersByTimeAsync(0);
  expect(mockPurgeExpiredConversations).toHaveBeenCalledTimes(1);

  await jest.advanceTimersByTimeAsync(59_999);
  expect(mockPurgeExpiredConversations).toHaveBeenCalledTimes(1);
  await jest.advanceTimersByTimeAsync(1);
  expect(mockPurgeExpiredConversations).toHaveBeenCalledTimes(2);
  expect(mockPurgeExpiredConversations).toHaveBeenLastCalledWith(
    new Date(now.getTime() + 60_000), 100,
  );
});

it("does not overlap a slow pass with another timer or direct tick", async () => {
  let complete!: (result: { examined: number; deleted: number; failed: number }) => void;
  const pending = new Promise<{ examined: number; deleted: number; failed: number }>(resolve => { complete = resolve; });
  mockPurgeExpiredConversations.mockReturnValueOnce(pending);
  startConversationRetention();
  try {
    await jest.advanceTimersByTimeAsync(120_000);
    await tickConversationRetention(new Date(now.getTime() + 120_000));
    expect(mockPurgeExpiredConversations).toHaveBeenCalledTimes(1);
  } finally {
    complete({ examined: 1, deleted: 1, failed: 0 });
    await jest.advanceTimersByTimeAsync(0);
  }

  await jest.advanceTimersByTimeAsync(60_000);
  expect(mockPurgeExpiredConversations).toHaveBeenCalledTimes(2);
});

it("retries on the next scheduled pass after cleanup fails", async () => {
  mockPurgeExpiredConversations.mockRejectedValueOnce(new Error("Cleanup temporarily unavailable"));
  startConversationRetention();
  await jest.advanceTimersByTimeAsync(0);
  expect(console.error).toHaveBeenCalledWith(
    expect.stringContaining("will retry on the next tick"), "Cleanup temporarily unavailable",
  );

  await jest.advanceTimersByTimeAsync(60_000);
  expect(mockPurgeExpiredConversations).toHaveBeenCalledTimes(2);
});

it("stops scheduling new passes and can restart without duplicate work", async () => {
  startConversationRetention();
  await jest.advanceTimersByTimeAsync(0);
  stopConversationRetention();
  stopConversationRetention();
  await jest.advanceTimersByTimeAsync(120_000);
  expect(mockPurgeExpiredConversations).toHaveBeenCalledTimes(1);

  startConversationRetention();
  await jest.advanceTimersByTimeAsync(0);
  expect(mockPurgeExpiredConversations).toHaveBeenCalledTimes(2);
});

it("does not schedule or execute cleanup in local-storage-only mode", async () => {
  mockMongoConfigured = false;
  startConversationRetention();
  await tickConversationRetention(now);
  await jest.advanceTimersByTimeAsync(120_000);

  expect(mockPurgeExpiredConversations).not.toHaveBeenCalled();
  expect(jest.getTimerCount()).toBe(0);
});

it("does not execute cleanup during a production build even with MongoDB configured", async () => {
  process.env.NEXT_PHASE = PHASE_PRODUCTION_BUILD;
  startConversationRetention();
  await tickConversationRetention(now);
  await jest.advanceTimersByTimeAsync(120_000);

  expect(mockPurgeExpiredConversations).not.toHaveBeenCalled();
  expect(jest.getTimerCount()).toBe(0);
});

