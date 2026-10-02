"use client";

// assisted-by Codex Codex-sonnet-4-6

import { ImpersonationBanner } from "@/components/auth/ImpersonationBanner";
import { Button } from "@/components/ui/button";
import { config } from "@/lib/config";
import { motion } from "framer-motion";
import { LogOut,Mail,ShieldX } from "lucide-react";
import { signOut } from "next-auth/react";

export default function UnauthorizedPage() {
  const requiredGroup = config.oidcRequiredGroup;

  return (
    <div className="flex min-h-screen flex-col bg-background">
      <ImpersonationBanner />
      <div className="flex flex-1 items-center justify-center p-4">
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5 }}
          className="max-w-md w-full"
        >
        <div className="bg-card border border-border rounded-2xl p-8 shadow-xl">
          {/* Icon */}
          <div className="flex justify-center mb-6">
            <div className="relative">
              <div className="absolute inset-0 bg-destructive/20 rounded-full blur-xl" />
              <div className="relative h-20 w-20 rounded-full bg-gradient-to-br from-destructive/20 to-destructive/5 border border-destructive/30 flex items-center justify-center">
                <ShieldX className="h-10 w-10 text-destructive" />
              </div>
            </div>
          </div>

          {/* Title */}
          <h1 className="text-2xl font-bold text-center mb-2">
            Access Needed
          </h1>

          {/* Description */}
          <p className="text-muted-foreground text-center mb-6">
            This account does not have access yet. Ask an admin to add you to the required group,
            or sign in with a different account.
          </p>

          {/* Required Group Info */}
          <div className="bg-muted/50 rounded-lg p-4 mb-6 border border-border">
            <p className="text-xs text-muted-foreground mb-1">Required group</p>
            <code className="text-sm font-mono text-foreground bg-background px-2 py-1 rounded">
              {requiredGroup}
            </code>
          </div>

          {/* What to do */}
          <div className="space-y-3 mb-6">
            <p className="text-sm font-medium">What you can do</p>
            <ul className="text-sm text-muted-foreground space-y-2">
              <li className="flex items-start gap-2">
                <span className="text-primary mt-0.5">•</span>
                Ask an admin to add you to <strong>{requiredGroup}</strong>
              </li>
              <li className="flex items-start gap-2">
                <span className="text-primary mt-0.5">•</span>
                Sign in with another account that already has access
              </li>
              <li className="flex items-start gap-2">
                <span className="text-primary mt-0.5">•</span>
                Contact support if this looks wrong
              </li>
            </ul>
          </div>

          {/* Actions */}
          <div className="space-y-3">
            <Button
              variant="outline"
              className="w-full gap-2"
              onClick={() => signOut({ callbackUrl: "/login" })}
            >
              <LogOut className="h-4 w-4" />
              Try Another Account
            </Button>

            <Button
              variant="ghost"
              className="w-full gap-2 text-muted-foreground"
              asChild
            >
              <a href={`mailto:${config.supportEmail}?subject=${config.appName} Access Request`}>
                <Mail className="h-4 w-4" />
                Contact Support
              </a>
            </Button>
          </div>
        </div>

        {/* Footer */}
        <p className="text-center text-xs text-muted-foreground mt-6">
          {config.appName} - {config.tagline}
        </p>
        </motion.div>
      </div>
    </div>
  );
}
