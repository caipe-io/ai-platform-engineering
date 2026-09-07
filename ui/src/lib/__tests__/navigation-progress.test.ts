/** @jest-environment jsdom */

import {
  beginNavigationProgress,
  finishNavigationProgress,
  pushWithNavigationProgress,
} from "../navigation-progress";

describe("navigation progress feedback", () => {
  beforeEach(() => {
    jest.useFakeTimers();
    window.history.replaceState({},"","/current");
    finishNavigationProgress();
  });

  afterEach(() => {
    finishNavigationProgress();
    jest.useRealTimers();
  });

  it("shows progress for a different internal path and clears it on completion", () => {
    beginNavigationProgress("/next");
    expect(document.documentElement).toHaveAttribute("data-navigation-pending","true");

    finishNavigationProgress();
    expect(document.documentElement).not.toHaveAttribute("data-navigation-pending");
  });

  it("ignores same-path, hash-only, and external destinations", () => {
    beginNavigationProgress("/current?view=details");
    beginNavigationProgress("/current#section");
    beginNavigationProgress("https://example.com/next");

    expect(document.documentElement).not.toHaveAttribute("data-navigation-pending");
  });

  it("uses router.push and has a timeout fallback for interrupted navigation", () => {
    const router = { push: jest.fn() };

    pushWithNavigationProgress(router,"/next");
    expect(router.push).toHaveBeenCalledWith("/next");
    expect(document.documentElement).toHaveAttribute("data-navigation-pending","true");

    jest.advanceTimersByTime(10_000);
    expect(document.documentElement).not.toHaveAttribute("data-navigation-pending");
  });
});
