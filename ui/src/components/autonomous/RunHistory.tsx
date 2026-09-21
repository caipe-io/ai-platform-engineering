// Copyright CAIPE Contributors (https://caipe.io)
// SPDX-License-Identifier: Apache-2.0

"use client";

import React, { useEffect, useState, useCallback, useMemo, useRef } from "react";
import Link from "next/link";
import { RefreshCw, ChevronDown, ChevronRight, MessageSquare } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { MarkdownRenderer } from "@/components/shared/timeline/MarkdownRenderer";
import { cn } from "@/lib/utils";

import { autonomousApi, AutonomousApiError } from "./api";
import type { TaskRun, TriggerType } from "./types";

interface RunHistoryProps {
  taskId: string;
  triggerType?: TriggerType;
  /**
   * Refresh trigger — bump this counter from the parent (e.g. right
   * after manually firing a task) to force a reload without waiting
   * for the polling interval.
   */
  refreshKey?: number;
  /** Require an explicit run selection before showing the webhook composer. */
  allowWebhookFollowUp?: boolean;
}

const STATUS_BADGE_VARIANT: Record<TaskRun["status"], "default" | "secondary" | "destructive" | "outline"> = {
  pending: "outline",
  running: "default",
  success: "default",
  failed: "destructive",
  skipped: "secondary",
};

const STATUS_TONE: Record<TaskRun["status"], string> = {
  pending: "bg-muted text-muted-foreground",
  // ``running`` deserves a distinct hue — the default badge variant
  // collapses into the same blue we use for ``success``, which buries
  // the in-progress state in long lists.
  running: "bg-amber-500/15 text-amber-700 dark:text-amber-300 border-amber-500/30",
  success: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300 border-emerald-500/30",
  failed: "bg-red-500/15 text-red-700 dark:text-red-300 border-red-500/30",
  skipped: "bg-muted text-muted-foreground",
};

/**
 * Identity of the rendered run list. Compared on every poll so an unchanged
 * response keeps the previous array reference and skips a re-render.
 */
function runsSignature(runs: TaskRun[]): string {
  return runs
    .map((r) => `${r.run_id}:${r.status}:${r.started_at}:${r.finished_at ?? ""}`)
    .join("|");
}

function formatTimestamp(value: string | null | undefined): string {
  if (!value) return "—";
  try {
    return new Date(value).toLocaleString();
  } catch {
    return value;
  }
}

function formatDuration(start: string, end: string | null | undefined): string {
  if (!end) return "—";
  try {
    const ms = new Date(end).getTime() - new Date(start).getTime();
    if (Number.isNaN(ms) || ms < 0) return "—";
    if (ms < 1000) return `${ms}ms`;
    const seconds = Math.round(ms / 100) / 10;
    return `${seconds}s`;
  } catch {
    return "—";
  }
}

interface OrderedRun {
  run: TaskRun;
  depth: number;
}

/** Root deliveries newest-first, with each delivery's follow-ups nested below it. */
function orderRunThreads(runs: TaskRun[]): OrderedRun[] {
  const byId = new Map(runs.map((run) => [run.run_id, run]));
  const children = new Map<string, TaskRun[]>();
  const roots: TaskRun[] = [];

  for (const run of runs) {
    if (run.parent_run_id && byId.has(run.parent_run_id)) {
      const siblings = children.get(run.parent_run_id) ?? [];
      siblings.push(run);
      children.set(run.parent_run_id, siblings);
    } else {
      roots.push(run);
    }
  }

  const timestamp = (run: TaskRun) => new Date(run.started_at).getTime() || 0;
  roots.sort((a, b) => timestamp(b) - timestamp(a));
  children.forEach((siblings) => siblings.sort((a, b) => timestamp(a) - timestamp(b)));

  const ordered: OrderedRun[] = [];
  const visited = new Set<string>();
  const append = (run: TaskRun, depth: number) => {
    if (visited.has(run.run_id)) return;
    visited.add(run.run_id);
    ordered.push({ run, depth });
    for (const child of children.get(run.run_id) ?? []) append(child, depth + 1);
  };
  roots.forEach((run) => append(run, 0));
  // Defensive cycle/orphan fallback: no persisted run should disappear.
  runs.forEach((run) => append(run, 0));
  return ordered;
}

export function RunHistory({
  taskId,
  triggerType,
  refreshKey = 0,
  allowWebhookFollowUp = false,
}: RunHistoryProps) {
  const [runs, setRuns] = useState<TaskRun[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [replyingTo, setReplyingTo] = useState<string | null>(null);
  const [followUpText, setFollowUpText] = useState("");
  const [submittingFollowUp, setSubmittingFollowUp] = useState(false);
  const [followUpError, setFollowUpError] = useState<string | null>(null);
  const [followUpNotice, setFollowUpNotice] = useState<string | null>(null);
  // Track in-flight requests so a slow response doesn't clobber a
  // newer one — important once the auto-poll kicks in.
  const inflightRef = useRef(0);

  const load = useCallback(async (options: { silent?: boolean } = {}) => {
    const requestId = ++inflightRef.current;
    // Background polls must not touch `loading`: doing so spun the refresh
    // icon and disabled the button every 5s, which read as the panel
    // twitching while a task row was open.
    if (!options.silent) setLoading(true);
    try {
      const data = await autonomousApi.listRuns(taskId);
      if (requestId !== inflightRef.current) return;
      // Replace the array only when something actually changed, so an
      // unchanged poll does not re-render (and visibly jitter) open rows.
      setRuns((prev) => (runsSignature(prev) === runsSignature(data) ? prev : data));
      setError(null);
    } catch (err) {
      if (requestId !== inflightRef.current) return;
      // 404 with "Task not found" is benign for a brand-new task that
      // hasn't run yet AND has no definition (deleted). We surface it
      // anyway so operators can spot a typo'd task id.
      const message =
        err instanceof AutonomousApiError ? err.message : "Failed to load run history";
      setError(message);
      setRuns([]);
    } finally {
      if (requestId === inflightRef.current && !options.silent) setLoading(false);
    }
  }, [taskId]);

  useEffect(() => {
    load();
  }, [load, refreshKey]);

  // Light auto-poll so a freshly triggered run shows its terminal
  // state without the operator hitting refresh. 5s is conservative;
  // the run-history endpoint is read-only and goes through Mongo's
  // primary index, so the load is negligible.
  useEffect(() => {
    const interval = setInterval(() => {
      void load({ silent: true });
    }, 5000);
    return () => clearInterval(interval);
  }, [load]);

  const toggleExpanded = (runId: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(runId)) next.delete(runId);
      else next.add(runId);
      return next;
    });
  };

  const orderedRuns = useMemo(() => orderRunThreads(runs), [runs]);

  const beginFollowUp = (runId: string) => {
    setReplyingTo(runId);
    setFollowUpText("");
    setFollowUpError(null);
    setFollowUpNotice(null);
  };

  const cancelFollowUp = () => {
    setReplyingTo(null);
    setFollowUpText("");
    setFollowUpError(null);
  };

  const submitFollowUp = async (run: TaskRun) => {
    const message = followUpText.trim();
    if (!message) {
      setFollowUpError("Enter a message before continuing this run.");
      return;
    }
    setSubmittingFollowUp(true);
    setFollowUpError(null);
    try {
      const accepted = await autonomousApi.followUpRun(taskId, run.run_id, message);
      setFollowUpNotice(
        `Follow-up queued for run ${run.run_id}. New run: ${accepted.run_id}.`,
      );
      setReplyingTo(null);
      setFollowUpText("");
      await load({ silent: true });
    } catch (err) {
      setFollowUpError(
        err instanceof AutonomousApiError ? err.message : "Failed to continue this run.",
      );
    } finally {
      setSubmittingFollowUp(false);
    }
  };

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-medium text-foreground">Run history</h3>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => void load()}
          disabled={loading}
          aria-label="Refresh run history"
        >
          <RefreshCw className={cn("h-3.5 w-3.5", loading && "animate-spin")} />
        </Button>
      </div>

      {error && (
        <div className="rounded-md border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-700 dark:text-red-300">
          {error}
        </div>
      )}

      {followUpNotice && (
        <div className="rounded-md border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-xs text-emerald-800 dark:text-emerald-200">
          {followUpNotice}
        </div>
      )}

      {!error && runs.length === 0 && !loading && (
        <div className="rounded-md border border-dashed border-border px-3 py-6 text-center text-xs text-muted-foreground">
          No runs yet. Trigger the task to generate history.
        </div>
      )}

      <ul className="flex flex-col gap-1">
        {orderedRuns.map(({ run, depth }) => {
          const isOpen = expanded.has(run.run_id);
          const response =
            triggerType === "webhook"
              ? run.response_full ?? run.response_preview
              : run.response_preview;
          return (
            <li
              key={run.run_id}
              className={cn(
                "rounded-md border border-border bg-card text-card-foreground",
                depth > 0 && "border-l-orange-500/40",
              )}
              style={{ marginLeft: `${Math.min(depth, 3) * 16}px` }}
              data-run-depth={depth}
            >
              <button
                type="button"
                onClick={() => toggleExpanded(run.run_id)}
                className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs hover:bg-muted/50 transition-colors"
              >
                {isOpen ? (
                  <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                ) : (
                  <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                )}
                <Badge
                  variant={STATUS_BADGE_VARIANT[run.status]}
                  className={cn("uppercase tracking-wide", STATUS_TONE[run.status])}
                >
                  {run.status}
                </Badge>
                {depth > 0 && (
                  <Badge variant="outline" className="border-orange-500/30 text-[10px] text-orange-700 dark:text-orange-300">
                    Follow-up
                  </Badge>
                )}
                <span className="font-mono text-muted-foreground truncate">
                  {run.run_id}
                </span>
                <span className="ml-auto text-muted-foreground">
                  {formatTimestamp(run.started_at)}
                </span>
                <span className="text-muted-foreground tabular-nums">
                  {formatDuration(run.started_at, run.finished_at)}
                </span>
              </button>
              {isOpen && (
                <div className="border-t border-border px-3 py-2 text-xs space-y-2">
                  <div className="grid grid-cols-2 gap-2 text-muted-foreground">
                    <div>
                      <span className="font-medium text-foreground">Started:</span>{" "}
                      {formatTimestamp(run.started_at)}
                    </div>
                    <div>
                      <span className="font-medium text-foreground">Finished:</span>{" "}
                      {formatTimestamp(run.finished_at)}
                    </div>
                  </div>
                  {run.conversation_id && (
                    // IMP-13 wired conversation_id onto the run; this
                    // closes the UX loop by giving operators a one-click
                    // jump from a run row to the full prompt + response
                    // thread in /chat/<id>. Hidden when the field is
                    // absent (chat publishing disabled or pre-IMP-13
                    // run) so the row stays tidy in those modes.
                    <div className="flex justify-end">
                      <Button
                        asChild
                        type="button"
                        variant="outline"
                        size="sm"
                        className="h-7 gap-1.5 text-xs"
                      >
                        <Link
                          href={`/chat/${run.conversation_id}`}
                          aria-label={`Open run ${run.run_id} in chat`}
                          data-testid="run-chat-link"
                        >
                          <MessageSquare className="h-3.5 w-3.5" />
                          Open in chat
                        </Link>
                      </Button>
                    </div>
                  )}
                  {triggerType === "webhook" && (
                    <div className="space-y-1">
                      <div className="font-medium text-foreground">
                        {run.parent_run_id ? "Follow-up message" : "Task request"}
                      </div>
                      <div className="rounded-lg border border-blue-500/20 bg-blue-500/5 p-3">
                        <MarkdownRenderer
                          content={run.follow_up_text ?? run.request_prompt ?? "Request unavailable."}
                          variant="final"
                        />
                      </div>
                    </div>
                  )}
                  {run.error && (
                    <div>
                      <div className="font-medium text-foreground mb-1">Error</div>
                      <pre className="whitespace-pre-wrap break-words rounded bg-red-500/10 p-2 text-red-700 dark:text-red-300">
                        {run.error}
                      </pre>
                    </div>
                  )}
                  {response && (
                    <div>
                      <div className="font-medium text-foreground mb-1">
                        {triggerType === "webhook" ? "Result" : "Response preview"}
                      </div>
                      {triggerType === "webhook" ? (
                        <div
                          className="min-w-0 overflow-hidden rounded bg-muted p-3"
                          data-testid="webhook-run-result"
                        >
                          <MarkdownRenderer content={response} variant="final" />
                        </div>
                      ) : (
                        <pre className="whitespace-pre-wrap break-words rounded bg-muted p-2 text-foreground">
                          {response}
                        </pre>
                      )}
                    </div>
                  )}
                  {!run.error && !response && (
                    <div className="text-muted-foreground italic">
                      No response captured.
                    </div>
                  )}
                  {allowWebhookFollowUp &&
                    triggerType === "webhook" &&
                    !["pending", "running"].includes(run.status) && (
                      <div className="border-t border-border pt-2">
                        {replyingTo === run.run_id ? (
                          <div className="space-y-2" data-testid={`run-follow-up-form-${run.run_id}`}>
                            <label
                              htmlFor={`run-follow-up-${run.run_id}`}
                              className="text-xs font-medium text-foreground"
                            >
                              Continue this run
                            </label>
                            <textarea
                              id={`run-follow-up-${run.run_id}`}
                              value={followUpText}
                              onChange={(event) => setFollowUpText(event.target.value)}
                              rows={3}
                              maxLength={10_000}
                              disabled={submittingFollowUp}
                              className="w-full resize-y rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground outline-none focus-visible:ring-1 focus-visible:ring-ring"
                              placeholder="Ask a follow-up using only this run's context…"
                            />
                            {followUpError && (
                              <p className="text-xs text-destructive">{followUpError}</p>
                            )}
                            <div className="flex justify-end gap-2">
                              <Button
                                type="button"
                                variant="ghost"
                                size="sm"
                                onClick={cancelFollowUp}
                                disabled={submittingFollowUp}
                              >
                                Cancel
                              </Button>
                              <Button
                                type="button"
                                size="sm"
                                onClick={() => void submitFollowUp(run)}
                                disabled={submittingFollowUp || !followUpText.trim()}
                              >
                                {submittingFollowUp ? "Queuing…" : "Send follow-up"}
                              </Button>
                            </div>
                          </div>
                        ) : (
                          <div className="flex justify-end">
                            <Button
                              type="button"
                              variant="outline"
                              size="sm"
                              onClick={() => beginFollowUp(run.run_id)}
                            >
                              Continue this run
                            </Button>
                          </div>
                        )}
                      </div>
                    )}
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
