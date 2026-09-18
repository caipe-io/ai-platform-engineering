"use client";

import { LoadingScreen } from "@/components/loading-screen";
import { isTokenExpired } from "@/lib/auth-utils";
import { getConfig } from "@/lib/config";
import { signOut,useSession } from "next-auth/react";
import { usePathname,useRouter } from "next/navigation";
import { useCallback,useEffect,useRef,useState } from "react";

interface AuthGuardProps {
  children: React.ReactNode;
}

/**
 * Auth Guard Component
 *
 * Protects routes when SSO is enabled.
 * If SSO is disabled, it renders children directly without authentication check.
 * Also checks for the deployment-configured group-based admission gate.
 */
export function AuthGuard({ children }: AuthGuardProps) {
  const { data: session, status } = useSession();
  const router = useRouter();
  const pathname = usePathname();
  const [loadingTimeout, setLoadingTimeout] = useState(false);
  const [autoResetInitiated, setAutoResetInitiated] = useState(false);
  const refreshFailureSignOutRef = useRef(false);

  /**
   * Build a login URL that preserves the current page as callbackUrl so the
   * user returns here after re-authenticating (e.g. /chat/<uuid>).
   */
  const loginUrl = useCallback((params?: string): string => {
    const cb = pathname && pathname !== '/' && pathname !== '/login'
      ? `callbackUrl=${encodeURIComponent(pathname)}`
      : '';
    const parts = [params, cb].filter(Boolean).join('&');
    return parts ? `/login?${parts}` : '/login';
  }, [pathname]);

  // Check for corrupted session cookies on mount
  useEffect(() => {
    if (typeof window === 'undefined') return;

    // Check if session cookie is oversized (Chrome limit is 4096 bytes)
    const cookies = document.cookie;
    const sessionCookie = cookies.split(';').find(c => c.trim().startsWith('next-auth.session-token='));

    if (sessionCookie && sessionCookie.length > 4096) {
      console.error(`[AuthGuard] Session cookie is too large (${sessionCookie.length} bytes), auto-clearing...`);
      localStorage.clear();
      sessionStorage.clear();
      document.cookie.split(";").forEach((c) => {
        document.cookie = c.replace(/^ +/, "").replace(/=.*/, "=;expires=" + new Date().toUTCString() + ";path=/");
      });
      window.location.href = loginUrl('session_reset=auto');
    }
  }, [loginUrl]);

  // Enhanced timeout mechanism - if stuck for more than 5 seconds, show cancel button
  // If stuck for more than 15 seconds, auto-reset and redirect
  useEffect(() => {
    if (status === "loading") {
      // Show cancel button after 5 seconds
      const timeoutButton = setTimeout(() => {
        console.warn("[AuthGuard] Authorization check taking too long - showing reset option");
        setLoadingTimeout(true);
      }, 5000); // 5 seconds

      // Auto-reset after 15 seconds if still stuck
      const timeoutReset = setTimeout(() => {
        if (!autoResetInitiated) {
          console.error("[AuthGuard] Authorization stuck for 15s - auto-resetting session...");
          setAutoResetInitiated(true);

          // Clear everything
          if (typeof window !== 'undefined') {
            localStorage.clear();
            sessionStorage.clear();
            // Clear all cookies
            document.cookie.split(";").forEach((c) => {
              document.cookie = c.replace(/^ +/, "").replace(/=.*/, "=;expires=" + new Date().toUTCString() + ";path=/");
            });
          }

          // Force redirect to login
          window.location.href = loginUrl('session_reset=auto');
        }
      }, 15000); // 15 seconds

      return () => {
        clearTimeout(timeoutButton);
        clearTimeout(timeoutReset);
      };
    }
  }, [status, autoResetInitiated, loginUrl]);

  useEffect(() => {
    if (!getConfig('ssoEnabled')) {
      return;
    }

    if (status === "loading") {
      return; // Still loading, wait
    }

    if (status === "unauthenticated") {
      router.push(loginUrl());
      return;
    }

    // User is authenticated, check authorization and token expiry
    if (status === "authenticated") {
      // Check if TokenExpiryGuard is already handling expiry (prevents flickering)
      const isTokenExpiryHandling = typeof window !== 'undefined'
        ? sessionStorage.getItem('token-expiry-handling') === 'true'
        : false;

      if (isTokenExpiryHandling) {
        // Let TokenExpiryGuard handle the expiry with its modal
        console.log("[AuthGuard] TokenExpiryGuard is handling expiry, skipping redirect");
        return;
      }

      // Check if token refresh failed
      if (session?.error === "RefreshTokenExpired" || session?.error === "RefreshTokenError") {
        if (refreshFailureSignOutRef.current) return;
        refreshFailureSignOutRef.current = true;
        console.warn("[AuthGuard] Token refresh failed, signing out and redirecting to login...");
        // Sign out to clear the corrupted session, then redirect
        signOut({ redirect: false }).then(() => {
          router.push(loginUrl('session_expired=true'));
        });
        return;
      }

      refreshFailureSignOutRef.current = false;

      // Check if user is authorized (has required group)
      if (session?.isAuthorized === false) {
        router.push("/unauthorized");
        return;
      }

      // Check if token is expired or about to expire (60s buffer)
      const jwtToken = session as unknown as { expiresAt?: number };
      const tokenExpiry = jwtToken.expiresAt;

      if (tokenExpiry && isTokenExpired(tokenExpiry, 60)) {
        console.warn("[AuthGuard] Token expired without refresh, redirecting to login...");
        router.push(loginUrl('session_expired=true'));
        return;
      }

      // Clear any stale token-expiry-handling flag (auth check passed)
      if (typeof window !== 'undefined') {
        sessionStorage.removeItem('token-expiry-handling');
      }

      console.log("[AuthGuard] ✅ Authorization complete, rendering app");
    }
  }, [status, session, router, loginUrl]);

  // If SSO is not enabled, render children directly
  if (!getConfig('ssoEnabled')) {
    return <>{children}</>;
  }

  // Show loading while checking authentication/authorization
  if (status === "loading") {
    const message = loadingTimeout
      ? "Session verification stuck - click below to reset"
      : "Checking authentication...";

    const handleCancel = async () => {
      console.log("[AuthGuard] User manually resetting session...");
      // Clear everything including cookies
      if (typeof window !== 'undefined') {
        localStorage.clear();
        sessionStorage.clear();
        // Clear all cookies
        document.cookie.split(";").forEach((c) => {
          document.cookie = c.replace(/^ +/, "").replace(/=.*/, "=;expires=" + new Date().toUTCString() + ";path=/");
        });
      }
      // Force redirect to login instead of using signOut (which might also be stuck)
      window.location.href = loginUrl('session_reset=manual');
    };

    return (
      <LoadingScreen
        message={message}
        showCancel={loadingTimeout}
        onCancel={handleCancel}
      />
    );
  }

  // If not authenticated and SSO is enabled, show nothing (redirect will happen)
  if (status === "unauthenticated") {
    return null;
  }

  // If not authorized, show nothing (redirect will happen)
  if (session?.isAuthorized === false) {
    return null;
  }

  // Authenticated and authorized - render children
  return <>{children}</>;
}
