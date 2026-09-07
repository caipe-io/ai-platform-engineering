const NAVIGATION_PROGRESS_TIMEOUT_MS = 10_000;

let progressTimeout: ReturnType<typeof setTimeout> | null = null;

function isDifferentInternalPath(href: string): boolean {
  if (typeof window === "undefined") return false;

  const current = new URL(window.location.href);
  const target = new URL(href,current);
  return target.origin === current.origin && target.pathname !== current.pathname;
}

export function finishNavigationProgress(): void {
  if (typeof document === "undefined") return;

  delete document.documentElement.dataset.navigationPending;
  if (progressTimeout !== null) {
    clearTimeout(progressTimeout);
    progressTimeout = null;
  }
}

/**
 * Shows a pointer-plus-busy cursor while a Next.js route transition is pending.
 */
export function beginNavigationProgress(href: string): void {
  if (!isDifferentInternalPath(href)) return;

  finishNavigationProgress();
  document.documentElement.dataset.navigationPending = "true";
  progressTimeout = setTimeout(finishNavigationProgress,NAVIGATION_PROGRESS_TIMEOUT_MS);
}

export function pushWithNavigationProgress(
  router: { push: (href: string,options?: { scroll?: boolean }) => void },
  href: string,
  options?: { scroll?: boolean },
): void {
  beginNavigationProgress(href);
  if (options) {
    router.push(href,options);
  } else {
    router.push(href);
  }
}
