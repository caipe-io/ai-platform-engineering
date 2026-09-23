"use client";

import { Button } from "@/components/ui/button";
import { getErrorMessage } from "@/lib/error-utils";
import { useChatStore } from "@/store/chat-store";
import { AlertTriangle, LogOut, X } from "lucide-react";
import { useSession } from "next-auth/react";
import { useRouter } from "next/navigation";
import React from "react";

export function ImpersonationBanner(): React.ReactElement | null {
  const { data: session, update } = useSession();
  const router = useRouter();
  const [exiting, setExiting] = React.useState(false);
  const [exitError, setExitError] = React.useState<string | null>(null);

  if (!session?.impersonation && !session?.impersonationNotice) return null;

  const exit = async (): Promise<void> => {
    setExiting(true);
    setExitError(null);
    try {
      await update({ impersonation: { action: "stop" } });
      useChatStore.getState().clearAllConversations();
      router.replace("/admin/security/impersonation");
      router.refresh();
    } catch (error) {
      setExitError(getErrorMessage(error, "Unable to exit impersonation"));
    } finally {
      setExiting(false);
    }
  };

  const dismiss = async (): Promise<void> => {
    await update({ impersonation: { action: "dismiss-notice" } });
  };

  if (session.impersonation) {
    return (
      <div
        role="alert"
        className="flex min-h-11 flex-wrap items-center justify-center gap-3 border-b border-amber-400 bg-amber-100 px-4 py-2 text-sm text-amber-950 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-100"
      >
        <AlertTriangle className="h-4 w-4 shrink-0" />
        <span>
          You are logged in as <strong>{session.impersonation.target.name}</strong> ({session.impersonation.target.email}).
        </span>
        <Button
          className="border-amber-950 bg-amber-950 text-white hover:bg-amber-900 hover:text-white dark:border-amber-100 dark:bg-amber-100 dark:text-amber-950 dark:hover:bg-amber-200 dark:hover:text-amber-950"
          size="sm"
          variant="outline"
          onClick={() => void exit()}
          disabled={exiting}
        >
          <LogOut className="mr-1.5 h-4 w-4" />
          {exiting ? "Exiting…" : "Exit impersonation"}
        </Button>
        {exitError ? <span className="text-xs font-medium" role="status">{exitError}</span> : null}
      </div>
    );
  }

  return (
    <div
      role="alert"
      className="flex min-h-11 flex-wrap items-center justify-center gap-3 border-b border-red-400 bg-red-50 px-4 py-2 text-sm text-red-950 dark:border-red-800 dark:bg-red-950/50 dark:text-red-100"
    >
      <AlertTriangle className="h-4 w-4 shrink-0" />
      <span>{session.impersonationNotice}</span>
      <Button size="icon" variant="ghost" aria-label="Dismiss" onClick={() => void dismiss()}>
        <X className="h-4 w-4" />
      </Button>
    </div>
  );
}
