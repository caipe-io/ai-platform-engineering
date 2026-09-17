import { normalizeProductTourState } from "@/lib/product-tour";

describe("product tour state", () => {
  it("normalizes saved progress and clamps the current step", () => {
    expect(normalizeProductTourState({
      status: "in_progress",
      current_step: 12,
      run_count: 2,
      started_at: "2026-09-17T00:00:00.000Z",
    })).toMatchObject({
      status: "in_progress",
      current_step: 5,
      run_count: 2,
      started_at: "2026-09-17T00:00:00.000Z",
    });
  });

  it("falls back safely for malformed persisted state", () => {
    expect(normalizeProductTourState({
      status: "unknown",
      current_step: -3,
      run_count: -1,
    })).toMatchObject({
      status: "not_started",
      current_step: 1,
      run_count: 0,
    });
  });
});
