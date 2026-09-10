"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useEffect, useState } from "react";

import { AuthGuard } from "@/components/auth-guard";
import { autonomousApi, AutonomousApiError } from "@/components/autonomous/api";
import { RunHistory } from "@/components/autonomous/RunHistory";
import type { AutonomousTask } from "@/components/autonomous/types";
import { Button } from "@/components/ui/button";

function WebhookTaskHistory() {
  const params = useParams<{ taskId: string }>();
  const taskId = params?.taskId;
  const [loadState, setLoadState] = useState<{
    taskId: string | null;
    task: AutonomousTask | null;
    error: string | null;
  }>({ taskId: null, task: null, error: null });

  useEffect(() => {
    let cancelled = false;

    if (!taskId) {
      return () => {
        cancelled = true;
      };
    }

    void autonomousApi
      .getTask(taskId)
      .then((result) => {
        if (cancelled) return;
        if (result.trigger.type !== "webhook") {
          setLoadState({
            taskId,
            task: null,
            error: "This autonomous task is not webhook-triggered.",
          });
          return;
        }
        setLoadState({ taskId, task: result, error: null });
      })
      .catch((err) => {
        if (cancelled) return;
        setLoadState({
          taskId,
          task: null,
          error:
            err instanceof AutonomousApiError
              ? err.message
              : "Failed to load webhook history.",
        });
      });

    return () => {
      cancelled = true;
    };
  }, [taskId]);

  const loading = Boolean(taskId && loadState.taskId !== taskId);

  if (loading) {
    return (
      <main className="min-h-0 flex-1 overflow-y-auto p-6 text-sm text-muted-foreground">
        Loading webhook history…
      </main>
    );
  }

  const task = loadState.task;
  const error = taskId ? loadState.error : "Webhook task id is missing.";

  if (error || !task || task.trigger.type !== "webhook") {
    return (
      <main className="min-h-0 flex-1 overflow-y-auto p-6">
        <div className="mx-auto max-w-5xl space-y-4">
          <div className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
            {error ?? "Webhook task not found."}
          </div>
          <Button asChild variant="outline" size="sm">
            <Link href="/autonomous">Back to Autonomous</Link>
          </Button>
        </div>
      </main>
    );
  }

  const provider = task.trigger.provider ?? "webhook";

  return (
    <main className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto w-full max-w-5xl space-y-5 p-6">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <p className="text-xs font-medium uppercase tracking-wide text-orange-600 dark:text-orange-300">
              Webhook runs · {provider}
            </p>
            <h1 className="text-lg font-semibold text-foreground">{task.name}</h1>
            {task.description && (
              <p className="mt-1 text-sm text-muted-foreground">{task.description}</p>
            )}
          </div>
          <Button asChild variant="outline" size="sm">
            <Link href="/autonomous">Manage task</Link>
          </Button>
        </div>

        <div className="rounded-md border border-orange-500/30 bg-orange-500/10 px-3 py-2 text-sm text-foreground">
          Each webhook delivery has its own conversation context. Expand a completed run and
          choose <span className="font-medium">Continue this run</span> to follow up using only
          that delivery&apos;s context.
        </div>

        <RunHistory
          taskId={task.id}
          triggerType="webhook"
          allowWebhookFollowUp
        />
      </div>
    </main>
  );
}

export default function WebhookTaskHistoryPage() {
  return (
    <AuthGuard>
      <WebhookTaskHistory />
    </AuthGuard>
  );
}
