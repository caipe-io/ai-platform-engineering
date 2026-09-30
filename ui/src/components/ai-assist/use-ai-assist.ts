"use client";

/**
 * useAiAssist — generic streaming hook that drives any registered task on
 * `POST /api/ai/assist`.
 *
 * Pairs with `<AiAssistButton>` and `<AiAssistPopover>`, but is also usable
 * standalone for surfaces that want to host the AI Assist flow inside their
 * own UI (the existing `useSkillAiAssist` continues to drive the heavy
 * SkillAiAssistPanel until that surface is folded in).
 *
 * The hook owns:
 *   - AbortController lifecycle (cancel/cleanup)
 *   - SSE parsing + accumulation
 *   - Status state machine (idle | streaming | error)
 *   - Per-call snapshot of the field value for diff/rollback
 *
 * It does NOT toast, does NOT render UI. Consumers receive `error`,
 * `cancelled`, `result`, and `status` and decide what to do.
 */

import { getConfig } from "@/lib/config";
import type { AiAssistTaskId } from "@/lib/server/ai-assist-tasks";
import { useSession } from "next-auth/react";
import { useCallback,useRef,useState } from "react";

export type AiAssistStatus = "idle" | "streaming" | "error" | "cancelled";

export interface AiAssistContext {
  /** What the user typed in the popover input (the "ask"). */
  instruction?: string;
  /** Existing value of the field being assisted. */
  current_value?: string;
  /** Skill / agent name when relevant. */
  name?: string;
  /** Surrounding skill description, if any. */
  skill_description?: string;
  /** Surrounding agent description, if any. */
  agent_description?: string;
  /** Programming language (code-snippet). */
  language?: string;
  /** Shell flavor (shell-script). */
  shell?: string;
  /** Free additional context. */
  extra_context?: string;
}

export interface UseAiAssistOptions {
  task: AiAssistTaskId;
}

export interface UseAiAssistResult {
  status: AiAssistStatus;
  /** True while a request is in flight. */
  isBusy: boolean;
  /** Last error from a non-aborted request. */
  error: Error | null;
  /** Token-by-token accumulator — updates while streaming. */
  result: string;
  /** Snapshot of `current_value` taken at the start of the run. */
  snapshot: string;
  /** Per-task limit reported by the server on the start event. */
  rateLimit: { limit: number; remaining: number; windowMs: number } | null;

  /**
   * Kick off a request. Returns when the stream closes (resolves or rejects).
   * Pass `taskOverride` to use a different registered task for this single
   * call (e.g. switch generate ↔ enhance based on whether the field is empty).
   */
  run: (ctx: AiAssistContext, taskOverride?: AiAssistTaskId) => Promise<void>;
  /** Abort the in-flight request. */
  cancel: () => void;
  /** Reset state to idle and clear the result/error. */
  reset: () => void;
}

interface ServerEvent {
  type?: string;
  text?: string;
  message?: string;
  task?: string;
  model?: string;
  rate_limit?: { limit: number; remaining: number; window_ms: number };
}

export function useAiAssist({ task }: UseAiAssistOptions): UseAiAssistResult {
  const { data: session } = useSession();
  const ssoEnabled = getConfig("ssoEnabled");
  const accessToken = ssoEnabled ? session?.accessToken : undefined;

  const [status, setStatus] = useState<AiAssistStatus>("idle");
  const [error, setError] = useState<Error | null>(null);
  const [result, setResult] = useState<string>("");
  const [snapshot, setSnapshot] = useState<string>("");
  const [rateLimit, setRateLimit] = useState<UseAiAssistResult["rateLimit"]>(
    null,
  );

  const abortRef = useRef<AbortController | null>(null);

  const cancel = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
  }, []);

  const reset = useCallback(() => {
    cancel();
    setStatus("idle");
    setError(null);
    setResult("");
    setSnapshot("");
    setRateLimit(null);
  }, [cancel]);

  const run = useCallback(
    async (ctx: AiAssistContext, taskOverride?: AiAssistTaskId) => {
      const effectiveTask = taskOverride ?? task;
      // Replace any prior in-flight request.
      cancel();
      const controller = new AbortController();
      abortRef.current = controller;

      setStatus("streaming");
      setError(null);
      setResult("");
      setRateLimit(null);
      setSnapshot(ctx.current_value ?? "");

      try {
        const response = await fetch("/api/ai/assist", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Accept: "text/event-stream",
            ...(accessToken
              ? { Authorization: `Bearer ${accessToken}` }
              : {}),
          },
          body: JSON.stringify({
            task: effectiveTask,
            context: ctx,
          }),
          signal: controller.signal,
        });

        if (!response.ok) {
          // 429 + non-2xx come back as JSON, not SSE.
          const data = (await response.json().catch(() => ({}))) as {
            error?: string;
          };
          throw new Error(
            data.error ||
              `AI assist request failed: ${response.status} ${response.statusText}`,
          );
        }
        if (!response.body) throw new Error("No response body");

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        let accum = "";

        readLoop: for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() ?? "";

          for (const line of lines) {
            if (!line.startsWith("data: ")) continue;
            let event: ServerEvent;
            try {
              event = JSON.parse(line.slice(6));
            } catch {
              continue;
            }
            switch (event.type) {
              case "start":
                if (event.rate_limit) {
                  setRateLimit({
                    limit: event.rate_limit.limit,
                    remaining: event.rate_limit.remaining,
                    windowMs: event.rate_limit.window_ms,
                  });
                }
                break;
              case "content":
                if (event.text) {
                  accum += event.text;
                  setResult(accum);
                }
                break;
              case "error":
                throw new Error(event.message || "AI assist error");
              case "done":
                break readLoop;
            }
          }
        }

        setStatus("idle");
      } catch (err: unknown) {
        if ((err as { name?: string })?.name === "AbortError") {
          setStatus("cancelled");
        } else {
          setError(err instanceof Error ? err : new Error(String(err)));
          setStatus("error");
        }
      } finally {
        if (abortRef.current === controller) {
          abortRef.current = null;
        }
      }
    },
    [accessToken, cancel, task],
  );

  return {
    status,
    isBusy: status === "streaming",
    error,
    result,
    snapshot,
    rateLimit,
    run,
    cancel,
    reset,
  };
}
