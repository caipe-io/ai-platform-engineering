"use client";

import React from "react";
import { CheckCircle2, FlaskConical, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { ModelTestResult } from "@/lib/model-connections";

export function ModelConnectionTest({
  request,
  disabled,
  onSuccess,
}: {
  request: Record<string, unknown>;
  disabled?: boolean;
  onSuccess?: () => void;
}) {
  const [running, setRunning] = React.useState(false);
  const [result, setResult] = React.useState<ModelTestResult | null>(null);
  const signature = JSON.stringify(request);
  React.useEffect(() => setResult(null), [signature]);
  return (
    <div className="space-y-2" onClick={(event) => event.stopPropagation()}>
      <Button
        type="button"
        size="sm"
        variant="outline"
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
            // Dynamic Agents returns a direct diagnostic; BFF configuration errors use its usual envelope.
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
          <Loader2 className="mr-2 h-4 w-4 animate-spin" />
        ) : (
          <FlaskConical className="mr-2 h-4 w-4" />
        )}
        {running ? "Testing…" : "Test Connection"}
      </Button>
      {result && (
        <div
          role="status"
          className={`max-w-lg rounded-lg border p-3 text-left text-xs ${result.success ? "border-emerald-500/30 bg-emerald-500/5" : "border-destructive/30 bg-destructive/5"}`}
        >
          <p className="flex items-center gap-1 font-medium">
            {result.success && <CheckCircle2 className="h-3.5 w-3.5" />}
            {result.success ? "Connected" : "Connection failed"} ·{" "}
            {result.elapsed_ms} ms
          </p>
          <details className="mt-1">
            <summary className="cursor-pointer">
              {result.success
                ? "View result"
                : `View details · ${result.category.replaceAll("_", " ")}`}
            </summary>
            <p className="mt-2 whitespace-pre-wrap break-words">
              {result.message}
            </p>
            {result.status_code && <p>HTTP {result.status_code}</p>}
          </details>
        </div>
      )}
    </div>
  );
}
