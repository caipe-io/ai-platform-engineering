import { PRODUCT_TOURS, isProductTourId } from "@/lib/product-tour-catalog";
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
  it("clamps task progress to that tour’s step count", () => {
    expect(normalizeProductTourState({ current_step: 5 }, "chat").current_step).toBe(4);
  });

  it("has safe ids and usable steps for every tour", () => {
    for (const [id, tour] of Object.entries(PRODUCT_TOURS)) {
      expect(isProductTourId(id)).toBe(true);
      expect(tour.steps.length).toBeGreaterThan(1);
      for (const step of tour.steps) {
        expect(() => document.querySelector(step.target)).not.toThrow();
        if (step.href) expect(step.href).toMatch(/^\/(?!\/)/);
      }
    }
    expect(isProductTourId("__proto__")).toBe(false);
  });

});
