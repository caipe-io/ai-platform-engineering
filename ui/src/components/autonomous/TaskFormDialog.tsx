"use client";

import React, { useEffect, useMemo, useState } from "react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";

import type { AutonomousTask, TaskFormState, TaskSaveResult, TriggerType } from "./types";
import {
  DEFAULT_MINIMUM_SCHEDULE_INTERVAL_SECONDS,
  formatScheduleInterval,
  fromFormState,
  toFormState,
} from "./formState";
import { WebhookSetupStep } from "./WebhookSetupStep";

const WEBHOOK_PROVIDER_OPTIONS = [
  { value: "github", label: "GitHub" },
  { value: "jira", label: "Jira" },
  { value: "slack", label: "Slack" },
  { value: "pagerduty", label: "PagerDuty" },
];

interface TaskFormDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** When provided we render in "edit" mode. */
  task?: AutonomousTask | null;
  /**
   * Pre-select this dynamic agent in *create* mode (e.g. launched from an
   * agent row's "+ Add autonomous task"). Ignored when `task` is provided
   * (edit mode round-trips the task's own agent).
   */
  initialAgentId?: string | null;
  /**
   * Names of the caller's other tasks. Drives a non-blocking duplicate-name
   * warning -- names are deliberately not unique (ids are), so this guides
   * without preventing.
   */
  existingNames?: string[];
  minimumScheduleIntervalSeconds?: number;
  onSubmit: (task: AutonomousTask) => Promise<TaskSaveResult>;
  onSaveWebhookSecret: (task: AutonomousTask, secret: string) => Promise<AutonomousTask>;
}

function seededFormState(
  task: AutonomousTask | null | undefined,
  initialAgentId: string | null | undefined,
): TaskFormState {
  const state = toFormState(task);
  if (!task && initialAgentId) {
    state.dynamic_agent_id = initialAgentId;
  }
  return state;
}

export function TaskFormDialog({
  open,
  onOpenChange,
  task,
  initialAgentId,
  existingNames = [],
  minimumScheduleIntervalSeconds = DEFAULT_MINIMUM_SCHEDULE_INTERVAL_SECONDS,
  onSubmit,
  onSaveWebhookSecret,
}: TaskFormDialogProps) {
  const isEdit = Boolean(task);
  const [form, setForm] = useState<TaskFormState>(() => seededFormState(task, initialAgentId));
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [webhookSetup, setWebhookSetup] = useState<{
    task: AutonomousTask;
    generatedSecret?: string;
  } | null>(null);

  // Reset whenever the dialog opens or the underlying task changes.
  // Without this, editing task A then opening "create" would inherit
  // A's fields.
  useEffect(() => {
    if (open) {
      setForm(seededFormState(task, initialAgentId));
      setError(null);
      setSubmitting(false);
      setWebhookSetup(null);
    }
  }, [open, task, initialAgentId]);

  const update = <K extends keyof TaskFormState>(key: K, value: TaskFormState[K]) => {
    setForm((prev) => ({ ...prev, [key]: value }));
  };

  const triggerOptions = useMemo<TriggerType[]>(() => ["cron", "interval", "webhook"], []);

  // Case- and whitespace-insensitive: "daily REPORT " should still warn.
  const duplicateName = useMemo(() => {
    const candidate = form.name.trim().toLowerCase();
    if (!candidate) return false;
    return existingNames.some((n) => n.trim().toLowerCase() === candidate);
  }, [form.name, existingNames]);

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    setError(null);
    // Every autonomous task must target a dynamic agent (the dynamic-agents
    // runtime is the only execution backend; the backend rejects creates
    // without one). Enforce it here so the operator gets immediate feedback
    // instead of a round-trip 400.
    if (!form.dynamic_agent_id) {
      setError(
        "This task has no target agent. Open the dialog from an agent's autonomous drawer.",
      );
      return;
    }
    const result = fromFormState(form, minimumScheduleIntervalSeconds);
    if ("error" in result) {
      setError(result.error);
      return;
    }
    setSubmitting(true);
    try {
      const saved = await onSubmit(result.task);
      if (saved.task.trigger.type === "webhook" && (!isEdit || saved.webhookSetupRequired)) {
        setWebhookSetup({ task: saved.task, generatedSecret: saved.webhookSetupSecret });
      } else {
        onOpenChange(false);
      }
    } catch (err) {
      // Mirror the API client's error shape — `.message` already
      // carries the FastAPI ``detail`` string when available.
      setError(err instanceof Error ? err.message : "Failed to save task.");
    } finally {
      setSubmitting(false);
    }
  };

  const webhookUrl = webhookSetup
    ? `${typeof window === "undefined" ? "" : window.location.origin}/api/v1/hooks/${encodeURIComponent(webhookSetup.task.id)}`
    : "";

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{webhookSetup ? "Configure webhook" : isEdit ? "Edit task" : "New autonomous task"}</DialogTitle>
          {!webhookSetup && <DialogDescription>
            Tasks are scheduled via the autonomous-agents service and dispatched to
            CAIPE supervisor over A2A. Cron and interval tasks fire automatically;{" "}
            {isEdit ? (
              <>
                webhook tasks fire when a POST hits{" "}
                <code className="text-xs">/api/v1/hooks/{form.id}</code>.
              </>
            ) : (
              <>webhook setup continues here after the task is created.</>
            )}
          </DialogDescription>}
        </DialogHeader>

        {webhookSetup ? (
          <WebhookSetupStep
            task={webhookSetup.task}
            generatedSecret={webhookSetup.generatedSecret}
            webhookUrl={webhookUrl}
            onSaveProviderSecret={async (secret) => {
              const updated = await onSaveWebhookSecret(webhookSetup.task, secret);
              setWebhookSetup((current) => current ? { ...current, task: updated } : current);
            }}
            onDone={() => onOpenChange(false)}
          />
        ) : <form onSubmit={handleSubmit} className="space-y-4">
          {/* Create mode has no ID field at all -- the server generates the id
              -- so Name takes the full width. Edit mode shows the id as
              read-only text because operators need it for the webhook URL. */}
          <div className="space-y-3">
            {isEdit && (
              <div className="space-y-1">
                <Label>ID</Label>
                <p
                  className="font-mono text-xs text-muted-foreground"
                  data-testid="task-id-readonly"
                >
                  {form.id}
                </p>
                <p className="text-[11px] text-muted-foreground">
                  Generated by the server and immutable.
                </p>
              </div>
            )}
            <div className="space-y-1">
              <Label htmlFor="task-name">Name</Label>
              <Input
                id="task-name"
                value={form.name}
                onChange={(e) => update("name", e.target.value)}
                placeholder="Daily Incident Summary"
                required
              />
              {duplicateName && (
                <p
                  className="text-[11px] text-amber-600 dark:text-amber-400"
                  data-testid="duplicate-name-warning"
                >
                  Another of your tasks is already called &quot;{form.name.trim()}&quot;.
                </p>
              )}
            </div>
          </div>

          <div className="space-y-1">
            <Label htmlFor="task-description">Description</Label>
            <Input
              id="task-description"
              value={form.description}
              onChange={(e) => update("description", e.target.value)}
              placeholder="What does this task do?"
            />
          </div>

          {/* The target dynamic agent is not editable here: the dialog is
              only launched from an agent's drawer, which seeds
              `dynamic_agent_id` on create and round-trips it on edit. The
              deprecated no-op `llm_provider` is likewise round-tripped
              unchanged — the agent's own model config governs execution. */}

          <div className="space-y-1">
            <Label htmlFor="task-prompt">Prompt</Label>
            <Textarea
              id="task-prompt"
              value={form.prompt}
              onChange={(e) => update("prompt", e.target.value)}
              rows={4}
              placeholder="Summarise yesterday's incidents and post to #ops."
              required
            />
          </div>

          <div className="space-y-2 rounded-md border border-border p-3">
            <Label>Trigger</Label>
            <div className="flex gap-2">
              {triggerOptions.map((opt) => (
                <button
                  type="button"
                  key={opt}
                  onClick={() => update("triggerType", opt)}
                  className={`px-3 py-1 text-xs rounded-md border transition-colors ${
                    form.triggerType === opt
                      ? "bg-primary text-primary-foreground border-primary"
                      : "bg-background text-foreground border-border hover:bg-muted"
                  }`}
                >
                  {opt}
                </button>
              ))}
            </div>

            {form.triggerType === "cron" && (
              <div className="space-y-1">
                <Label htmlFor="task-cron">Schedule (cron)</Label>
                <Input
                  id="task-cron"
                  value={form.cronSchedule}
                  onChange={(e) => update("cronSchedule", e.target.value)}
                  placeholder="0 9 * * *"
                  required
                />
                <p className="text-[11px] text-muted-foreground">
                  Standard 5-field cron expression (minute hour dom month dow). Runs
                  must be at least {formatScheduleInterval(minimumScheduleIntervalSeconds)} apart.
                </p>
              </div>
            )}

            {form.triggerType === "interval" && (
              <div className="space-y-1">
                <div className="grid grid-cols-3 gap-2">
                  <div className="space-y-1">
                    <Label htmlFor="task-interval-seconds">Seconds</Label>
                    <Input
                      id="task-interval-seconds"
                      value={form.intervalSeconds}
                      onChange={(e) => update("intervalSeconds", e.target.value)}
                      inputMode="numeric"
                      placeholder="0"
                    />
                  </div>
                  <div className="space-y-1">
                    <Label htmlFor="task-interval-minutes">Minutes</Label>
                    <Input
                      id="task-interval-minutes"
                      value={form.intervalMinutes}
                      onChange={(e) => update("intervalMinutes", e.target.value)}
                      inputMode="numeric"
                      placeholder="0"
                    />
                  </div>
                  <div className="space-y-1">
                    <Label htmlFor="task-interval-hours">Hours</Label>
                    <Input
                      id="task-interval-hours"
                      value={form.intervalHours}
                      onChange={(e) => update("intervalHours", e.target.value)}
                      inputMode="numeric"
                      placeholder="0"
                    />
                  </div>
                </div>
                <p className="text-[11px] text-muted-foreground">
                  Fill in at least one field; empty fields count as 0. Values
                  add up (e.g. 1 hour + 30 minutes = every 90 minutes). Minimum: {" "}
                  {formatScheduleInterval(minimumScheduleIntervalSeconds)}.
                </p>
              </div>
            )}

            {form.triggerType === "webhook" && (
              <div className="space-y-3">
                <div className="space-y-1">
                  <Label htmlFor="task-webhook-provider">Provider</Label>
                  <Select
                    id="task-webhook-provider"
                    value={form.webhookProvider}
                    onChange={(e) => update("webhookProvider", e.target.value)}
                    className="flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm text-foreground shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    {WEBHOOK_PROVIDER_OPTIONS.map((opt) => (
                      <option
                        key={opt.value}
                        value={opt.value}
                        style={{
                          backgroundColor: "hsl(var(--background))",
                          color: "hsl(var(--foreground))",
                        }}
                      >
                        {opt.label}
                      </option>
                    ))}
                  </Select>
                </div>
                {isEdit && ["slack", "pagerduty"].includes(form.webhookProvider) ? (
                  <div className="space-y-1">
                    <Label htmlFor="task-webhook-secret">
                      {form.webhookProvider === "slack" ? "Slack" : "PagerDuty"} signing secret
                    </Label>
                    <Input
                      id="task-webhook-secret"
                      value={form.webhookSecret}
                      onChange={(e) => update("webhookSecret", e.target.value)}
                      type="password"
                      placeholder="Paste a new provider-issued secret to rotate it"
                    />
                    {task?.trigger.type === "webhook" && task.trigger.has_secret && (
                      <p className="text-xs text-muted-foreground">
                        A signing secret is securely stored. Leave this blank to keep it unchanged.
                      </p>
                    )}
                  </div>
                ) : (
                  <p className="text-xs text-muted-foreground">
                    {form.webhookProvider === "slack" || form.webhookProvider === "pagerduty"
                      ? "After creation, paste the signing secret issued by this provider."
                      : "A strong signing secret will be generated automatically and shown once after creation."}
                  </p>
                )}
              </div>
            )}
          </div>

          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={form.enabled}
              onChange={(e) => update("enabled", e.target.checked)}
              className="h-4 w-4 rounded border-border"
            />
            Enabled
          </label>

          {error && (
            <div className="rounded-md border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-700 dark:text-red-300">
              {error}
            </div>
          )}

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
              disabled={submitting}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={submitting}>
              {submitting ? "Saving…" : isEdit ? "Save changes" : "Create task"}
            </Button>
          </DialogFooter>
        </form>}
      </DialogContent>
    </Dialog>
  );
}
