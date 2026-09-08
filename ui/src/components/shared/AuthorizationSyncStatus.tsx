"use client";

import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import type { AuthzSyncMetadata } from "@/types/authz-sync";
import { Loader2, ShieldAlert, ShieldCheck } from "lucide-react";

type AuthorizationSyncPresentation = {
  label: string;
  description: string;
  icon: typeof ShieldCheck;
  className: string;
  animate?: boolean;
};

function syncPresentation(
  document: AuthzSyncMetadata | null | undefined,
  busy: boolean,
  canRetry: boolean,
): AuthorizationSyncPresentation | null {
  if (busy || document?.authz_sync_state === "pending") {
    return {
      label: "Syncing access",
      description:
        "Applying ownership and sharing access. Using this resource is briefly paused.",
      icon: Loader2,
      className:
        "border-sky-500/25 bg-sky-500/10 text-sky-700 dark:text-sky-300",
      animate: true,
    };
  }

  const rawRevision = document?.authz_revision;
  const revision =
    Number.isSafeInteger(rawRevision) && (rawRevision ?? -1) >= 0
      ? (rawRevision ?? 0)
      : 0;
  const revisionMismatch =
    document?.authz_sync_state === "ready" &&
    revision !== document.authz_last_synced_revision;
  if (document?.authz_sync_state === "error" || revisionMismatch) {
    return {
      label: "Access sync needed",
      description: canRetry
        ? "Ownership and sharing access could not be synced. Save again to retry; use remains paused until it succeeds."
        : "Ownership and sharing access could not be synced. Use remains paused until an administrator repairs it.",
      icon: ShieldAlert,
      className:
        "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300",
    };
  }

  if (document?.authz_sync_state === "ready") {
    return {
      label: "Access synced",
      description: "Ownership and sharing access are in sync.",
      icon: ShieldCheck,
      className: "border-border/60 bg-muted/40 text-muted-foreground",
    };
  }

  return null;
}

export function AuthorizationSyncStatus({
  document,
  busy = false,
  canRetry = true,
  className,
}: {
  document?: AuthzSyncMetadata | null;
  busy?: boolean;
  canRetry?: boolean;
  className?: string;
}) {
  const presentation = syncPresentation(document, busy, canRetry);
  if (!presentation) return null;

  const Icon = presentation.icon;
  return (
    <TooltipProvider delayDuration={250}>
      <Tooltip>
        <TooltipTrigger asChild>
          <span
            role="status"
            aria-label={presentation.label}
            className={cn(
              "inline-flex h-7 items-center gap-1.5 rounded-full border px-2.5 text-xs font-medium",
              presentation.className,
              className,
            )}
          >
            <Icon
              className={cn(
                "h-3.5 w-3.5",
                presentation.animate && "animate-spin",
              )}
              aria-hidden="true"
            />
            <span className="hidden sm:inline">{presentation.label}</span>
          </span>
        </TooltipTrigger>
        <TooltipContent className="max-w-64 text-xs">
          {presentation.description}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
