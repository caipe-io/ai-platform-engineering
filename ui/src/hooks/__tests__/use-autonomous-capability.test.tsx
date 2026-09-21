/**
 * @jest-environment jsdom
 */
import { renderHook, waitFor } from "@testing-library/react";

jest.mock("@/lib/config", () => ({
  getConfig: (k: string) => k === "autonomousAgentsEnabled",
}));

import { useAutonomousCapability } from "@/hooks/use-autonomous-capability";

beforeEach(() => {
  jest.clearAllMocks();
});

it("reports team eligibility from the summary endpoint", async () => {
  global.fetch = jest.fn().mockResolvedValue({
    ok: true,
    json: async () => ({ success: true, data: { eligible: true, can_manage_automation: false } }),
  }) as never;

  const { result } = renderHook(() => useAutonomousCapability());
  await waitFor(() => expect(result.current.loading).toBe(false));
  expect(result.current.canUseAutonomous).toBe(true);
  expect(global.fetch).toHaveBeenCalledWith("/api/autonomous/agents?summary=true");
});

it("hides the entry for a user whose teams are not autonomous-eligible", async () => {
  global.fetch = jest.fn().mockResolvedValue({
    ok: true,
    json: async () => ({ success: true, data: { eligible: false, can_manage_automation: false } }),
  }) as never;

  const { result } = renderHook(() => useAutonomousCapability());
  await waitFor(() => expect(result.current.loading).toBe(false));
  expect(result.current.canUseAutonomous).toBe(false);
});

it("fails closed when the request errors", async () => {
  global.fetch = jest.fn().mockRejectedValue(new Error("network")) as never;

  const { result } = renderHook(() => useAutonomousCapability());
  await waitFor(() => expect(result.current.loading).toBe(false));
  expect(result.current.canUseAutonomous).toBe(false);
});

it("fails closed on a non-ok response", async () => {
  global.fetch = jest.fn().mockResolvedValue({ ok: false, status: 404, json: async () => ({}) }) as never;

  const { result } = renderHook(() => useAutonomousCapability());
  await waitFor(() => expect(result.current.loading).toBe(false));
  expect(result.current.canUseAutonomous).toBe(false);
});
