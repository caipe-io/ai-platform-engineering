"use client";

// assisted-by Codex Codex-sonnet-4-6

import { IntegrationOrbit } from "@/components/gallery/IntegrationOrbit";
import { LoadingScreen } from "@/components/loading-screen";
import { Button } from "@/components/ui/button";
import { config,getLogoFilterClass } from "@/lib/config";
import { motion } from "framer-motion";
import { AlertCircle,Loader2,LogIn } from "lucide-react";
import { signIn,useSession } from "next-auth/react";
import Image from "next/image";
import { useRouter,useSearchParams } from "next/navigation";
import { Suspense,useEffect,useState } from "react";

// Circuit breaker: detect redirect loops via sessionStorage counter.
// If we've been redirected to /login more than 3 times within 10 seconds,
// force a full session reset to break the loop.
const LOOP_KEY = "login-redirect-count";
const LOOP_TS_KEY = "login-redirect-ts";
const LOOP_THRESHOLD = 3;
const LOOP_WINDOW_MS = 10_000;

function detectAndBreakRedirectLoop(): boolean {
  if (typeof window === "undefined") return false;

  const now = Date.now();
  const lastTs = parseInt(sessionStorage.getItem(LOOP_TS_KEY) || "0", 10);
  let count = parseInt(sessionStorage.getItem(LOOP_KEY) || "0", 10);

  // Reset counter if outside the time window
  if (now - lastTs > LOOP_WINDOW_MS) {
    count = 0;
  }

  count += 1;
  sessionStorage.setItem(LOOP_KEY, String(count));
  sessionStorage.setItem(LOOP_TS_KEY, String(now));

  if (count >= LOOP_THRESHOLD) {
    console.error(`[Login] Redirect loop detected (${count} redirects in ${LOOP_WINDOW_MS}ms). Breaking loop...`);
    // Clear everything to break the loop
    sessionStorage.removeItem(LOOP_KEY);
    sessionStorage.removeItem(LOOP_TS_KEY);
    sessionStorage.removeItem("token-expiry-handling");
    localStorage.clear();
    // Clear all cookies
    document.cookie.split(";").forEach((c) => {
      document.cookie = c
        .replace(/^ +/, "")
        .replace(/=.*/, "=;expires=" + new Date().toUTCString() + ";path=/");
    });
    return true; // Loop detected — caller should NOT redirect
  }

  return false;
}

function clearRedirectLoopCounter() {
  if (typeof window === "undefined") return;
  sessionStorage.removeItem(LOOP_KEY);
  sessionStorage.removeItem(LOOP_TS_KEY);
}

function safeCallbackUrl(value: string | null): string {
  if (!value || !value.startsWith("/") || value.startsWith("//")) {
    return "/";
  }
  return value.startsWith("/login") ? "/" : value;
}

function LoginContent() {
  const { status, data: session } = useSession();
  const router = useRouter();
  const searchParams = useSearchParams();
  const [isLoading, setIsLoading] = useState(false);
  // Initialize loopBroken synchronously so the redirect effect sees it immediately.
  // Using a lazy initializer ensures detectAndBreakRedirectLoop() runs exactly once
  // during the first render, before any effects fire.
  const [loopBroken] = useState(() => detectAndBreakRedirectLoop());
  const error = searchParams.get("error");
  const sessionExpired = searchParams.get("session_expired") === "true";
  const sessionReset = searchParams.get("session_reset");
  const callbackUrl = safeCallbackUrl(searchParams.get("callbackUrl"));

  // Redirect if already logged in. A stale session_expired URL can remain after
  // a successful OIDC callback, so only explicit reset/loop recovery should hold
  // the user on the login page.
  useEffect(() => {
    if (loopBroken || sessionReset) {
      // User is here intentionally or we broke a loop — show login form
      return;
    }

    if (status === "authenticated" && !session?.error) {
      // Clear counter on successful auth redirect (not a loop)
      clearRedirectLoopCounter();
      router.push(callbackUrl);
    }
  }, [status, session?.error, router, callbackUrl, sessionReset, loopBroken]);

  const handleSignIn = async () => {
    setIsLoading(true);
    // Clear loop detection state on intentional sign-in
    clearRedirectLoopCounter();
    if (typeof window !== "undefined") {
      sessionStorage.removeItem("token-expiry-handling");
    }
    try {
      await signIn("oidc", { callbackUrl });
    } catch (err) {
      console.error("Sign in error:", err);
      setIsLoading(false);
    }
  };

  // Show loading screen while checking auth or during redirect
  if (status === "loading" || isLoading) {
    return <LoadingScreen message={isLoading ? "Redirecting to SSO..." : "Loading..."} />;
  }

  return (
    <div className="min-h-screen flex bg-background relative overflow-hidden">
      {/* Full-page background gradients that span both panels */}
      <div 
        className="absolute inset-0" 
        style={{
          background: `linear-gradient(to bottom right, color-mix(in srgb, var(--gradient-from) 8%, transparent), transparent, color-mix(in srgb, var(--gradient-to) 8%, transparent))`
        }}
      />
      <div 
        className="absolute inset-0" 
        style={{
          background: `radial-gradient(ellipse at 30% 50%, color-mix(in srgb, var(--gradient-from) 10%, transparent), transparent)`
        }}
      />
      <div 
        className="absolute inset-0" 
        style={{
          background: `radial-gradient(ellipse at 70% 50%, color-mix(in srgb, var(--gradient-to) 8%, transparent), transparent)`
        }}
      />

      {/* Left Panel - Integration Animation */}
      <div className="hidden lg:flex lg:w-1/2 relative items-center justify-center">
        <div className="relative z-10 flex flex-col items-center">
          <IntegrationOrbit />
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.3 }}
            className="text-center mt-8 max-w-sm px-4"
          >
            <h2 className="text-2xl font-bold gradient-text mb-3">
              {config.tagline}
            </h2>
            <p className="text-muted-foreground">
              {config.description}
            </p>
          </motion.div>
        </div>
      </div>

      {/* Right Panel - Login Card */}
      <div className="flex-1 flex items-center justify-center p-8 relative">

        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          className="relative z-10 w-full max-w-md"
        >
          <div className="bg-card border border-border rounded-2xl shadow-2xl overflow-hidden">
            {/* Header */}
            <div className="p-8 text-center border-b border-border bg-muted/30">
              <div className="w-16 h-16 mx-auto mb-4 rounded-2xl gradient-primary-br flex items-center justify-center animate-pulse-glow">
                <Image
                  src={config.logoUrl}
                  alt={config.appName}
                  width={40}
                  height={40}
                  unoptimized
                  className={`h-10 w-10 ${getLogoFilterClass(config.logoStyle)}`}
                />
              </div>
              <div className="flex items-center justify-center gap-2">
                <h1 className="text-2xl font-bold gradient-text">{config.appName}</h1>
                {config.envBadge && (
                  <span className="px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider bg-amber-500/20 text-amber-500 border border-amber-500/30 rounded">
                    {config.envBadge}
                  </span>
                )}
              </div>
              <p className="text-sm text-muted-foreground mt-1">
                {config.tagline}
              </p>
            </div>

            {/* Content */}
            <div className="p-8">
              {/* Redirect Loop Recovery Message */}
              {loopBroken && (
                <motion.div
                  initial={{ opacity: 0, y: -10 }}
                  animate={{ opacity: 1, y: 0 }}
                  className="mb-6 p-4 rounded-lg bg-destructive/10 border border-destructive/30 flex items-start gap-3"
                >
                  <AlertCircle className="h-5 w-5 text-destructive shrink-0 mt-0.5" />
                  <div>
                    <p className="text-sm font-medium text-destructive">
                      Session reset
                    </p>
                    <p className="text-xs text-destructive/80 mt-1">
                      We reset your session to fix a sign-in loop. Please sign in again.
                    </p>
                  </div>
                </motion.div>
              )}

              {/* Session Expired Message */}
              {sessionExpired && !loopBroken && (
                <motion.div
                  initial={{ opacity: 0, y: -10 }}
                  animate={{ opacity: 1, y: 0 }}
                  className="mb-6 p-4 rounded-lg bg-amber-500/10 border border-amber-500/30 flex items-start gap-3"
                >
                  <AlertCircle className="h-5 w-5 text-amber-500 shrink-0 mt-0.5" />
                  <div>
                    <p className="text-sm font-medium text-amber-500">
                      Session expired
                    </p>
                    <p className="text-xs text-amber-500/80 mt-1">
                      Please sign in again to continue.
                    </p>
                  </div>
                </motion.div>
              )}

              {/* Error Message */}
              {error && !sessionExpired && (
                <motion.div
                  initial={{ opacity: 0, y: -10 }}
                  animate={{ opacity: 1, y: 0 }}
                  className="mb-6 p-4 rounded-lg bg-destructive/10 border border-destructive/30 flex items-start gap-3"
                >
                  <AlertCircle className="h-5 w-5 text-destructive shrink-0 mt-0.5" />
                  <div>
                    <p className="text-sm font-medium text-destructive">
                      Sign-in failed
                    </p>
                    <p className="text-xs text-destructive/80 mt-1">
                      {error === "OAuthSignin" && "We could not start sign-in."}
                      {error === "OAuthCallback" && "We could not finish sign-in."}
                      {error === "OAuthCreateAccount" && "We could not create your account."}
                      {error === "Callback" && "We could not finish sign-in."}
                      {error === "AccessDenied" && "This account does not have access."}
                      {error === "SessionStorageRequired" && "SSO requires MongoDB session storage. Ask an administrator to configure it."}
                      {!["OAuthSignin", "OAuthCallback", "OAuthCreateAccount", "Callback", "AccessDenied", "SessionStorageRequired"].includes(error) &&
                        "An unexpected error occurred. Please try again."}
                    </p>
                  </div>
                </motion.div>
              )}

              {/* SSO Login Button */}
              <Button
                onClick={handleSignIn}
                disabled={isLoading}
                className="w-full h-12 text-base gap-2 gradient-primary text-white hover:opacity-90 transition-opacity"
              >
                {isLoading ? (
                  <Loader2 className="h-5 w-5 animate-spin" />
                ) : (
                  <LogIn className="h-5 w-5" />
                )}
                {isLoading ? "Redirecting..." : "Sign in with SSO"}
              </Button>
            </div>
          </div>

          {/* Additional Info */}
          {config.showPoweredBy && (
            <p className="text-center text-xs text-muted-foreground mt-6">
              Powered by OSS{" "}
              <a
                href="https://caipe.io"
                target="_blank"
                rel="noopener noreferrer"
                className="text-primary hover:underline"
              >
                caipe.io
              </a>
            </p>
          )}
        </motion.div>
      </div>
    </div>
  );
}

export default function LoginPage() {
  return (
    <Suspense fallback={<LoadingScreen message="Loading..." />}>
      <LoginContent />
    </Suspense>
  );
}
