"use client";

import { Button } from "@/components/ui/button";
import type { AutoSaveState } from "@/hooks/use-keyed-auto-save";
import { cn } from "@/lib/utils";
import { AlertCircle,Check,Loader2,RotateCcw } from "lucide-react";

interface AutoSaveStatusProps {
  className?: string;
  onRetry?: () => void;
  state: AutoSaveState;
}

export function AutoSaveStatus({
  className,
  onRetry,
  state,
}: AutoSaveStatusProps): React.ReactElement | null {
  if (state.status === "idle") return null;

  return (
    <div
      aria-live="polite"
      className={cn(
        "flex min-h-5 items-center gap-1.5 text-xs text-muted-foreground",
        state.status === "error" && "text-destructive",
        className,
      )}
      role={state.status === "error" ? "alert" : "status"}
    >
      {state.status === "saving" ? (
        <>
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
          Saving…
        </>
      ) : null}
      {state.status === "saved" ? (
        <>
          <Check className="h-3.5 w-3.5 text-emerald-500" />
          Saved
        </>
      ) : null}
      {state.status === "error" ? (
        <>
          <AlertCircle className="h-3.5 w-3.5 shrink-0" />
          <span>{state.error || "Could not save"}</span>
          {onRetry ? (
            <Button
              className="ml-1 h-6 gap-1 px-2 text-xs"
              onClick={onRetry}
              size="sm"
              type="button"
              variant="outline"
            >
              <RotateCcw className="h-3 w-3" />
              Retry
            </Button>
          ) : null}
        </>
      ) : null}
    </div>
  );
}
