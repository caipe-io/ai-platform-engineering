"use client";

import { IntegrationOrbit } from "@/components/gallery/IntegrationOrbit";
import { Button } from "@/components/ui/button";
import { config,getLogoFilterClass } from "@/lib/config";
import { motion } from "framer-motion";
import { ArrowRight,CheckCircle2,Loader2,LogOut } from "lucide-react";
import { useSession } from "next-auth/react";
import { signOutWithFeedback } from "@/lib/sign-out";
import Image from "next/image";
import { useRouter } from "next/navigation";
import { useEffect,useState } from "react";

export default function LogoutPage() {
  const { status } = useSession();
  const router = useRouter();
  const [isLoggingOut, setIsLoggingOut] = useState(false);
  const [isLoggedOut, setIsLoggedOut] = useState(false);
  const [attempted, setAttempted] = useState(false);

  // Auto logout if user is authenticated
  useEffect(() => {
    if (status === "authenticated" && !attempted && !isLoggingOut && !isLoggedOut) {
      handleLogout();
    } else if (status === "unauthenticated") {
      setIsLoggedOut(true);
    }
  }, [status, attempted, isLoggingOut, isLoggedOut]);

  const handleLogout = async () => {
    setIsLoggingOut(true);
    setAttempted(true);
    try {
      setIsLoggedOut(await signOutWithFeedback({ redirect: false }));
    } catch (err) {
      console.error("Logout error:", err);
    } finally {
      setIsLoggingOut(false);
    }
  };

  const handleBackToLogin = () => {
    router.push("/login");
  };

  const handleBackToHome = () => {
    router.push("/");
  };

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

      {/* Right Panel - Logout Card */}
      <div className="flex-1 flex items-center justify-center p-8 relative">

        <motion.div
          initial={{ opacity: 0, scale: 0.95 }}
          animate={{ opacity: 1, scale: 1 }}
          className="relative z-10 w-full max-w-md"
        >
          <div className="bg-card border border-border rounded-2xl shadow-2xl overflow-hidden">
          {/* Header */}
          <div className="p-8 text-center border-b border-border bg-muted/30">
            <div className="w-16 h-16 mx-auto mb-4 rounded-2xl gradient-primary-br flex items-center justify-center">
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
            {isLoggingOut ? (
              <motion.div
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                className="text-center py-8"
              >
                <Loader2 className="h-12 w-12 animate-spin text-primary mx-auto mb-4" />
                <h2 className="text-lg font-semibold mb-2">Signing Out...</h2>
                <p className="text-sm text-muted-foreground">
                  Please wait while we securely log you out.
                </p>
              </motion.div>
            ) : isLoggedOut ? (
              <motion.div
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                className="text-center py-4"
              >
                <div className="w-16 h-16 mx-auto mb-4 rounded-full bg-green-500/10 border border-green-500/30 flex items-center justify-center">
                  <CheckCircle2 className="h-8 w-8 text-green-500" />
                </div>
                <h2 className="text-xl font-semibold mb-2">Successfully Signed Out</h2>
                <p className="text-sm text-muted-foreground mb-6">
                  You have been securely logged out of {config.appName}.
                </p>

                <div className="space-y-3">
                  <Button
                    onClick={handleBackToLogin}
                    className="w-full h-11 gap-2 gradient-primary text-white hover:opacity-90 transition-opacity"
                  >
                    <LogOut className="h-4 w-4" />
                    Sign In Again
                  </Button>

                  <Button
                    variant="outline"
                    onClick={handleBackToHome}
                    className="w-full h-11 gap-2"
                  >
                    <ArrowRight className="h-4 w-4" />
                    Go to Home
                  </Button>
                </div>
              </motion.div>
            ) : (
              <motion.div
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                className="text-center py-4"
              >
                <div className="w-16 h-16 mx-auto mb-4 rounded-full bg-amber-500/10 border border-amber-500/30 flex items-center justify-center">
                  <LogOut className="h-8 w-8 text-amber-500" />
                </div>
                <h2 className="text-xl font-semibold mb-2">Sign Out?</h2>
                <p className="text-sm text-muted-foreground mb-6">
                  Are you sure you want to sign out of {config.appName}?
                </p>

                <div className="space-y-3">
                  <Button
                    onClick={handleLogout}
                    variant="destructive"
                    className="w-full h-11 gap-2"
                  >
                    <LogOut className="h-4 w-4" />
                    Yes, Sign Out
                  </Button>

                  <Button
                    variant="outline"
                    onClick={handleBackToHome}
                    className="w-full h-11 gap-2"
                  >
                    Cancel
                  </Button>
                </div>
              </motion.div>
            )}
          </div>

            {/* Footer */}
            <div className="px-8 py-4 border-t border-border bg-muted/20">
              <p className="text-[10px] text-center text-muted-foreground">
                Your session has ended. Any unsaved work may be lost.
              </p>
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
