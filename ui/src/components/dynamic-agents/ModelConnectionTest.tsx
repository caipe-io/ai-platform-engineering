"use client";

import React from "react";
import { AlertCircle, CheckCircle2, FlaskConical, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import type { ModelTestResult } from "@/lib/model-connections";

export function ModelConnectionTest({
  request,
  disabled,
  onSuccess,
  compact = false,
}: {
  request: Record<string, unknown>;
  disabled?: boolean;
  onSuccess?: () => void;
  compact?: boolean;
}) {
  const [running, setRunning] = React.useState(false);
  const [result, setResult] = React.useState<ModelTestResult | null>(null);
  const signature = JSON.stringify(request);
  React.useEffect(() => setResult(null), [signature]);
  const description = result
    ? `${result.success ? "Connected" : "Connection failed"} · ${result.elapsed_ms} ms`
    : "";
  const detailText = result && (
    <>
      <p className="whitespace-pre-wrap break-words">{result.message}</p>
      {result.status_code && <p className="mt-1">HTTP {result.status_code}</p>}
    </>
  );
  return (
    <div
      className={
        compact ? "inline-flex shrink-0 items-center gap-1" : "space-y-2"
      }
      onClick={(event) => event.stopPropagation()}
    >
      <Button
        type="button"
        size="sm"
        variant="outline"
        className={compact ? "h-8 w-36 shrink-0" : undefined}
        disabled={disabled || running}
        onClick={async () => {
          setRunning(true);
          setResult(null);
          try {
            const response = await fetch("/api/llm-models/test", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: signature,
            });
            const payload = await response.json();
            if (!response.ok || Boolean(payload.error))
              throw new Error(
                payload.error || "Connection test could not run.",
              );
            const outcome = (payload.data ?? payload) as ModelTestResult;
            setResult(outcome);
            if (outcome.success) onSuccess?.();
          } catch (error) {
            setResult({
              success: false,
              category: "configuration",
              elapsed_ms: 0,
              message:
                error instanceof Error
                  ? error.message
                  : "Connection test could not run.",
            });
          } finally {
            setRunning(false);
          }
        }}
      >
        {running ? (
          <Loader2 className="h-4 w-4 animate-spin" />
        ) : (
          <FlaskConical className="h-4 w-4" />
        )}
        {running ? "Testing…" : "Test Connection"}
      </Button>
      {compact ? (
        result ? (
          <Popover>
            <PopoverTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className={cn(
                  "h-8 w-8 shrink-0",
                  result.success
                    ? "text-emerald-600 dark:text-emerald-400"
                    : "text-destructive",
                )}
                aria-label={`Connection result: ${description}`}
                title={description}
              >
                {result.success ? (
                  <CheckCircle2 className="h-4 w-4" />
                ) : (
                  <AlertCircle className="h-4 w-4" />
                )}
              </Button>
            </PopoverTrigger>
            <PopoverContent
              align="end"
              className="w-80 max-w-[calc(100vw-2rem)] p-4 text-xs"
            >
              <p className="mb-2 font-medium">{description}</p>
              {detailText}
            </PopoverContent>
            <span role="status" className="sr-only">
              {description}
            </span>
          </Popover>
        ) : (
          <span aria-hidden="true" className="h-8 w-8 shrink-0" />
        )
      ) : (
        result && (
          <div
            role="status"
            className={cn(
              "max-w-lg rounded-lg border p-3 text-left text-xs",
              result.success
                ? "border-emerald-500/30 bg-emerald-500/5"
                : "border-destructive/30 bg-destructive/5",
            )}
          >
            <p className="flex items-center gap-1 font-medium">
              {result.success && <CheckCircle2 className="h-3.5 w-3.5" />}
              {description}
            </p>
            <details className="mt-1">
              <summary className="cursor-pointer">
                {result.success
                  ? "View result"
                  : `View details · ${result.category.replaceAll("_", " ")}`}
              </summary>
              <div className="mt-2">{detailText}</div>
            </details>
          </div>
        )
      )}
    </div>
  );
}
