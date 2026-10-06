"use client";

import { Button } from "@/components/ui/button";
import { formatTimeUntilExpiry,getTimeUntilExpiry,getWarningTimestamp,isTokenExpired } from "@/lib/auth-utils";
import { getConfig } from "@/lib/config";
import { AnimatePresence,motion } from "framer-motion";
import { AlertCircle,LogOut } from "lucide-react";
import { signOut,useSession } from "next-auth/react";
import { useCallback,useEffect,useRef,useState } from "react";

const LOGIN_REDIRECT_COUNTDOWN_SECONDS = 5;
// Keepalive fires at 75% of the Keycloak SSO session idle timeout (default 8h → 6h).
// Each successful token exchange resets the server-side idle timer, preventing
// users from being silently logged out while the tab is open but idle.
const SESSION_KEEPALIVE_INTERVAL_MS = 6 * 60 * 60 * 1000;
// AccessTokenMissing is intentionally absent here — it has its own retry-budget
// handling above (lines 198-211) and must never fall through to immediate logout.
const SESSION_CREDENTIAL_ERRORS = new Set([
  "RefreshTokenExpired",
  "RefreshTokenError",
]);
/**
 * How many consecutive 30s check cycles we tolerate seeing the token as
 * expired / access-token-missing before giving up and forcing a re-login.
 *
 * A single bad reading can be caused by a transient blip (a slow/aborted
 * `updateSession()` fetch, a brief server-side token-store cache miss, or the
 * client momentarily racing ahead of an in-flight refresh) even though the
 * underlying OIDC refresh token is still perfectly valid and the very next
 * check would see a healthy session. Forcing an immediate sign-out on the
 * first bad reading produces exactly the symptom users report as "the
 * auto-refresh banner shows but I still get logged out" — the session gets
 * torn down before a retry ever gets a chance to run.
 *
 * This counter is driven by wall-clock check cycles (not by whether
 * `updateSession()` happens to throw), so it always terminates within a
 * bounded time even if retries keep "succeeding" without actually resolving
 * the underlying problem.
 */
const MAX_CONSECUTIVE_PROBLEM_TICKS = 3;

/**
 * TokenExpiryGuard Component
 *
 * Monitors SSO token expiry and gracefully handles session expiration:
 * - Silently refreshes token when user is active on the page
 * - Shows warning toast 5 minutes before expiry (only if silent refresh failed)
 * - Shows critical alert when expired
 * - Redirects to login on expiry
 * - Dismiss persists until the warning window resets (token refreshed or new expiry cycle)
 */
export function TokenExpiryGuard() {
  const { data: session, status, update: updateSession } = useSession();
  const [showWarning, setShowWarning] = useState(false);
  const [showExpired, setShowExpired] = useState(false);
  const [refreshFailed, setRefreshFailed] = useState(false);
  const [timeRemaining, setTimeRemaining] = useState<string>("");
  const [redirectCountdown, setRedirectCountdown] = useState(LOGIN_REDIRECT_COUNTDOWN_SECONDS);
  const checkIntervalRef = useRef<NodeJS.Timeout | null>(null);
  const countdownIntervalRef = useRef<NodeJS.Timeout | null>(null);
  const redirectTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const keepaliveIntervalRef = useRef<NodeJS.Timeout | null>(null);
  /** Tracks user dismissal — stores the expiresAt timestamp for which the warning was dismissed.
   *  This way, if the token is refreshed (new expiresAt), the warning can show again for the new cycle. */
  const dismissedForExpiryRef = useRef<number | null>(null);
  /** Tracks whether a silent refresh is in flight to prevent concurrent attempts. */
  const isRefreshingRef = useRef(false);
  /** Cooldown: timestamp of the last successful refresh to prevent rapid re-refresh loops. */
  const lastRefreshAtRef = useRef<number>(0);
  /**
   * Consecutive 30s check cycles that observed a bad token state (expired or
   * access-token-missing). Reset to 0 whenever a check cycle sees a healthy
   * token. See MAX_CONSECUTIVE_PROBLEM_TICKS for why this drives the
   * give-up decision instead of individual `updateSession()` failures.
   */
  const consecutiveProblemTicksRef = useRef(0);

  const clearRedirectTimers = useCallback(() => {
    if (countdownIntervalRef.current) {
      clearInterval(countdownIntervalRef.current);
      countdownIntervalRef.current = null;
    }
    if (redirectTimeoutRef.current) {
      clearTimeout(redirectTimeoutRef.current);
      redirectTimeoutRef.current = null;
    }
  }, []);

  // Handle relogin — must sign out first to clear the session cookie,
  // otherwise the login page sees "authenticated" status and bounces back,
  // creating an infinite redirect loop.
  const handleRelogin = useCallback(async () => {
    clearRedirectTimers();
    setShowWarning(false);
    setShowExpired(false);
    setRefreshFailed(false);
    // Set flag to prevent AuthGuard from also redirecting (prevents flickering)
    if (typeof window !== 'undefined') {
      sessionStorage.setItem('token-expiry-handling', 'true');
    }
    await signOut({ callbackUrl: buildSessionExpiredLoginUrl() });
  }, [clearRedirectTimers]);

  const beginLoginCountdown = useCallback((reason: "expired" | "refresh_failed") => {
    setShowWarning(false);
    setShowExpired(true);
    setRefreshFailed(reason === "refresh_failed");
    setRedirectCountdown(LOGIN_REDIRECT_COUNTDOWN_SECONDS);

    if (typeof window !== 'undefined') {
      sessionStorage.setItem('token-expiry-handling', 'true');
    }
    if (checkIntervalRef.current) {
      clearInterval(checkIntervalRef.current);
      checkIntervalRef.current = null;
    }

    clearRedirectTimers();
    countdownIntervalRef.current = setInterval(() => {
      setRedirectCountdown((current) => Math.max(0, current - 1));
    }, 1000);
    redirectTimeoutRef.current = setTimeout(() => {
      void handleRelogin();
    }, LOGIN_REDIRECT_COUNTDOWN_SECONDS * 1000);
  }, [clearRedirectTimers, handleRelogin]);

  // Handle dismiss — persist until this expiry cycle ends
  const handleDismiss = useCallback((currentExpiresAt: number | null) => {
    setShowWarning(false);
    dismissedForExpiryRef.current = currentExpiresAt;
  }, []);

  /**
   * Silently refresh the session token.
   *
   * NextAuth's JWT callback (auth-config.ts) already handles the OIDC refresh_token
   * exchange when the token is within 5 minutes of expiry. However, the JWT callback
   * only runs on server-side requests. If the user is idle on the page (no API calls),
   * the token expires without being refreshed.
   *
   * Calling `updateSession()` (NextAuth's `update` from `useSession`) triggers a
   * server-side session check which runs the JWT callback, causing a token refresh.
   */
  const attemptSilentRefresh = useCallback(async () => {
    if (isRefreshingRef.current) return false;
    if (!session?.hasRefreshToken) {
      console.log("[TokenExpiryGuard] No refresh token available, cannot silently refresh");
      return false;
    }

    const now = Date.now();
    const COOLDOWN_MS = 60_000;
    if (now - lastRefreshAtRef.current < COOLDOWN_MS) {
      return false;
    }

    isRefreshingRef.current = true;
    try {
      console.log("[TokenExpiryGuard] Attempting silent token refresh...");
      await updateSession();
      lastRefreshAtRef.current = Date.now();
      console.log("[TokenExpiryGuard] Silent refresh triggered successfully");
      return true;
    } catch (error) {
      // Don't force a logout here — this may run during the proactive 5-minute
      // warning window where plenty of time remains, or as a bounded retry
      // from checkTokenExpiry. Callers decide whether/when to give up based on
      // consecutiveProblemTicksRef so a single transient failure never directly
      // tears down the session.
      console.error("[TokenExpiryGuard] Silent refresh failed:", error);
      return false;
    } finally {
      isRefreshingRef.current = false;
    }
  }, [session?.hasRefreshToken, updateSession]);

  // Check token expiry
  const checkTokenExpiry = useCallback(() => {
    if (!getConfig('ssoEnabled')) {
      return; // SSO not enabled
    }

    if (status !== "authenticated" || !session) {
      return; // Not authenticated
    }

    // Check if token refresh failed or the server-side token cache was lost.
    //
    // "AccessTokenMissing" can be transient — a momentary miss on the
    // server-side token store (see auth-token-store.ts's short-TTL L1 cache
    // falling through to MongoDB) rather than a genuinely dead session — so
    // it gets one retry via the shared budget before we give up.
    //
    // "RefreshTokenExpired"/"RefreshTokenError", by contrast, are only ever
    // set by the jwt() callback *after* it already tried the OIDC refresh_token
    // grant and failed (auth-config.ts refreshAccessToken()). Once set, the
    // server-side callback intentionally skips retrying
    // ("Token refresh already failed, skipping refresh attempt") until a
    // fresh login, so retrying client-side here would just loop forever
    // without ever recovering — keep the original immediate-logout behavior
    // for those two.
    if (session.error === "AccessTokenMissing") {
      consecutiveProblemTicksRef.current += 1;
      console.error(
        `[TokenExpiryGuard] Session credentials unavailable: ${session.error} ` +
        `(tick ${consecutiveProblemTicksRef.current}/${MAX_CONSECUTIVE_PROBLEM_TICKS})`,
      );
      if (session.hasRefreshToken && consecutiveProblemTicksRef.current < MAX_CONSECUTIVE_PROBLEM_TICKS) {
        if (!isRefreshingRef.current) {
          void attemptSilentRefresh();
        }
      } else {
        beginLoginCountdown("refresh_failed");
      }
      return;
    }
    if (SESSION_CREDENTIAL_ERRORS.has(session.error ?? "")) {
      console.error(`[TokenExpiryGuard] Session credentials unavailable: ${session.error}`);
      beginLoginCountdown("refresh_failed");
      return;
    }

    // Get expiresAt from session (NextAuth JWT)
    const expiresAt = session.user as unknown as { expiresAt?: number };
    const tokenExpiresAt = expiresAt?.expiresAt;

    // Check if token exists (from auth-config.ts line 108)
    const jwtToken = session as unknown as { expiresAt?: number };
    const actualExpiresAt = tokenExpiresAt || jwtToken.expiresAt;

    if (!actualExpiresAt) {
      console.warn("[TokenExpiryGuard] No expiry time found in session");
      return;
    }

    const secondsUntilExpiry = getTimeUntilExpiry(actualExpiresAt);
    const isExpired = isTokenExpired(actualExpiresAt, 0); // No buffer for expiry check
    const warningTime = getWarningTimestamp(actualExpiresAt);

    // Update time remaining for display
    setTimeRemaining(formatTimeUntilExpiry(secondsUntilExpiry));

    // Token has expired (per the client's current copy of the session).
    //
    // This does NOT necessarily mean the refresh token is dead — session.error
    // would already have been set and caught above in that case. It's more
    // often the client briefly racing ahead of an in-flight or just-completed
    // server-side refresh (e.g. concurrent requests reading a stale cookie
    // before the browser applies an updated Set-Cookie, per auth-config.ts's
    // in-flight refresh dedup). Give the retry budget a chance to catch up
    // before forcing a re-login.
    if (isExpired) {
      consecutiveProblemTicksRef.current += 1;
      console.error(
        `[TokenExpiryGuard] Token expired! Attempting recovery before logout... ` +
        `(tick ${consecutiveProblemTicksRef.current}/${MAX_CONSECUTIVE_PROBLEM_TICKS})`,
      );
      if (session.hasRefreshToken && consecutiveProblemTicksRef.current < MAX_CONSECUTIVE_PROBLEM_TICKS) {
        if (!isRefreshingRef.current) {
          void attemptSilentRefresh();
        }
      } else {
        beginLoginCountdown("expired");
      }
      return;
    }

    // Token state is healthy this cycle — clear the problem-tick counter so a
    // future isolated blip gets the full retry budget again.
    consecutiveProblemTicksRef.current = 0;
    // Release the AuthGuard coordination flag if we set it during the warning
    // window or expired retry ticks. Without this, AuthGuard stays suppressed
    // even after the session has fully recovered.
    if (typeof window !== 'undefined') {
      sessionStorage.removeItem('token-expiry-handling');
    }

    // If the token was refreshed (expiresAt changed), clear the dismissed state
    // so the warning can show again for the next expiry cycle.
    if (dismissedForExpiryRef.current !== null && dismissedForExpiryRef.current !== actualExpiresAt) {
      console.log("[TokenExpiryGuard] Token was refreshed, clearing dismissed state");
      dismissedForExpiryRef.current = null;
    }

    // Within warning window (5 min before expiry)
    const now = Math.floor(Date.now() / 1000);
    if (warningTime && now >= warningTime && !showExpired) {
      // Claim ownership of expiry handling so AuthGuard doesn't race us with its
      // own 60s-buffer redirect while we are attempting a silent refresh.
      if (typeof window !== 'undefined') {
        sessionStorage.setItem('token-expiry-handling', 'true');
      }

      // First: attempt silent refresh automatically (the user shouldn't have to do anything)
      if (!isRefreshingRef.current) {
        attemptSilentRefresh().then((refreshed) => {
          if (refreshed) {
            // Refresh was triggered — next check cycle will see the new expiresAt
            // and hide the warning (or never show it)
            console.log("[TokenExpiryGuard] Silent refresh initiated, waiting for updated session");
          }
        });
      }

      // Show warning only if not dismissed for this expiry cycle
      const isDismissed = dismissedForExpiryRef.current === actualExpiresAt;
      if (!showWarning && !isDismissed) {
        console.warn(`[TokenExpiryGuard] Token expiring in ${formatTimeUntilExpiry(secondsUntilExpiry)}`);
        setShowWarning(true);
      }
    } else if (showWarning && !isExpired) {
      // Token was refreshed (we're outside warning window now), hide warning and
      // release the coordination flag so AuthGuard resumes normal checks.
      setShowWarning(false);
      dismissedForExpiryRef.current = null;
      if (typeof window !== 'undefined') {
        sessionStorage.removeItem('token-expiry-handling');
      }
    }
  }, [status, session, showWarning, showExpired, beginLoginCountdown, attemptSilentRefresh]);

  // Set up periodic token expiry checking
  useEffect(() => {
    if (!getConfig('ssoEnabled') || status !== "authenticated") {
      return;
    }

    // Check immediately
    checkTokenExpiry();

    // Check every 30 seconds
    checkIntervalRef.current = setInterval(checkTokenExpiry, 30 * 1000);

    return () => {
      if (checkIntervalRef.current) {
        clearInterval(checkIntervalRef.current);
      }
    };
  }, [status, checkTokenExpiry]);

  // Proactive session keepalive: force-refresh the token on a fixed interval so
  // the Keycloak SSO session idle timer never reaches its limit while the tab is
  // open. Without this, a user idle for longer than ssoSessionIdleTimeout (8h)
  // has their refresh token invalidated server-side, causing the next expiry check
  // to fail with invalid_token and immediately log them out.
  useEffect(() => {
    if (
      !getConfig('ssoEnabled') ||
      status !== "authenticated" ||
      !session?.hasRefreshToken ||
      !!session?.error
    ) {
      return;
    }

    keepaliveIntervalRef.current = setInterval(async () => {
      console.log("[TokenExpiryGuard] Proactive keepalive — refreshing token to reset SSO idle timer");
      try {
        await updateSession({ forceRefresh: true });
      } catch (error) {
        console.warn("[TokenExpiryGuard] Keepalive refresh failed:", error);
      }
    }, SESSION_KEEPALIVE_INTERVAL_MS);

    return () => {
      if (keepaliveIntervalRef.current) {
        clearInterval(keepaliveIntervalRef.current);
        keepaliveIntervalRef.current = null;
      }
    };
  }, [status, session?.hasRefreshToken, session?.error, updateSession]);

  useEffect(() => clearRedirectTimers, [clearRedirectTimers]);

  // Don't render if SSO is not enabled
  if (!getConfig('ssoEnabled')) {
    return null;
  }

  // Compute current expiresAt for the dismiss handler (same logic as in checkTokenExpiry)
  const sessionExpiresAt = (() => {
    if (!session) return null;
    const userExpiry = (session.user as unknown as { expiresAt?: number })?.expiresAt;
    const jwtExpiry = (session as unknown as { expiresAt?: number }).expiresAt;
    return userExpiry || jwtExpiry || null;
  })();

  return (
    <>
      {/* Warning Toast - Token expiring soon */}
      <AnimatePresence>
        {showWarning && !showExpired && (
          <motion.div
            initial={{ opacity: 0, y: -20 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -20 }}
            className="fixed top-20 right-4 z-50 w-96"
          >
            <div className="bg-amber-500/10 border border-amber-500/30 rounded-lg p-4 shadow-lg backdrop-blur-sm">
              <div className="flex items-start gap-3">
                <AlertCircle className="h-5 w-5 text-amber-500 mt-0.5 flex-shrink-0" />
                <div className="flex-1">
                  <h3 className="font-semibold text-amber-500 mb-1">
                    Session Expiring Soon
                  </h3>
                  <p className="text-sm text-muted-foreground mb-3">
                    Your session will expire in <strong className="text-foreground">{timeRemaining}</strong>.
                    {session?.hasRefreshToken
                      ? " Attempting to refresh automatically..."
                      : " Please re-login to continue."}
                  </p>
                  <div className="flex gap-2">
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={handleRelogin}
                      className="gap-2"
                    >
                      <LogOut className="h-4 w-4" />
                      Sign in again
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => handleDismiss(sessionExpiresAt)}
                    >
                      Dismiss
                    </Button>
                  </div>
                </div>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Critical Alert - Token expired */}
      <AnimatePresence>
        {showExpired && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-[100] bg-background/80 backdrop-blur-sm flex items-center justify-center p-4"
          >
            <motion.div
              initial={{ scale: 0.95, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              exit={{ scale: 0.95, opacity: 0 }}
              className="bg-card border border-destructive/50 rounded-lg p-6 shadow-2xl max-w-md w-full"
            >
              <div className="flex items-start gap-4">
                <div className="p-2 bg-destructive/10 rounded-full">
                  <AlertCircle className="h-6 w-6 text-destructive" />
                </div>
                <div className="flex-1">
                  <h2 className="text-lg font-semibold text-foreground mb-2">
                    {refreshFailed ? "Sign-in Needed" : "Session Expired"}
                  </h2>
                  <p className="text-sm text-muted-foreground mb-4">
                    {refreshFailed
                      ? "We could not refresh your session. Please sign in again to continue."
                      : "Please sign in again to continue."}
                  </p>
                  <p className="text-xs text-muted-foreground mb-4">
                    Redirecting to login in {redirectCountdown} seconds...
                  </p>
                  <div className="flex gap-2">
                    <Button
                      onClick={handleRelogin}
                      className="gap-2 w-full"
                      variant="default"
                    >
                      <LogOut className="h-4 w-4" />
                      Sign In Again
                    </Button>
                  </div>
                </div>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </>
  );
}

function buildSessionExpiredLoginUrl(): string {
  if (typeof window === "undefined") {
    return "/login?session_expired=true";
  }
  const currentPath =
    window.location.pathname +
    window.location.search +
    window.location.hash;
  return `/login?session_expired=true&callbackUrl=${encodeURIComponent(currentPath || "/")}`;
}
