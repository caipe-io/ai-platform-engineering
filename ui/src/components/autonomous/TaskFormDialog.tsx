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

import type {
  AutonomousTask,
  TaskFormState,
  TaskSaveResult,
  TriggerType,
  WebhookProvider,
} from "./types";
import {
  DEFAULT_MINIMUM_SCHEDULE_INTERVAL_SECONDS,
  formatScheduleInterval,
  fromFormState,
  toFormState,
} from "./formState";
import { WebhookSetupStep } from "./WebhookSetupStep";

export const DEFAULT_WEBHOOK_PROVIDER_OPTIONS: WebhookProvider[] = [
  "github",
  "jira",
  "slack",
  "pagerduty",
];

const WEBHOOK_PROVIDER_OPTIONS: Array<{ value: WebhookProvider; label: string }> = [
  { value: "github", label: "GitHub" },
  { value: "jira", label: "Jira" },
  { value: "slack", label: "Slack" },
  { value: "pagerduty", label: "PagerDuty" },
];

const GITHUB_WEBHOOK_DOCS_URL =
  "https://docs.github.com/en/webhooks/webhook-events-and-payloads";

const FILTER_EXAMPLES: Record<WebhookProvider, string> = {
  github: "Header X-GitHub-Event = pull_request; payload action = closed",
  jira: "Payload webhookEvent = jira:issue_updated",
  slack: "Payload type = event_callback; payload event.type = message",
  pagerduty: "Payload event.event_type = incident.triggered",
};

const FEATURED_TIME_ZONES = [
  "UTC",
  "Europe/London",
  "Europe/Paris",
  "America/New_York",
  "America/Chicago",
  "America/Denver",
  "America/Los_Angeles",
  "Asia/Kolkata",
  "Asia/Singapore",
  "Asia/Tokyo",
  "Australia/Sydney",
];

const TIME_ZONE_LABELS: Record<string, string> = {
  UTC: "UTC (UTC+00:00)",
  "Europe/London": "London — Europe/London (GMT/BST, UTC+0/+1)",
  "Europe/Paris": "Paris — Europe/Paris (CET/CEST)",
  "America/New_York": "New York — America/New_York (EST/EDT)",
  "America/Chicago": "Chicago — America/Chicago (CST/CDT)",
  "America/Denver": "Denver — America/Denver (MST/MDT)",
  "America/Los_Angeles": "Los Angeles — America/Los_Angeles (PST/PDT)",
  "Asia/Kolkata": "India — Asia/Kolkata (UTC+05:30)",
  "Asia/Singapore": "Singapore — Asia/Singapore (UTC+08:00)",
  "Asia/Tokyo": "Tokyo — Asia/Tokyo (UTC+09:00)",
  "Australia/Sydney": "Sydney — Australia/Sydney (AEST/AEDT)",
};

function availableTimeZones(): string[] {
  const intl = Intl as typeof Intl & {
    supportedValuesOf?: (key: "timeZone") => string[];
  };
  const supported = intl.supportedValuesOf?.("timeZone") ?? [];
  return Array.from(new Set([...FEATURED_TIME_ZONES, ...supported]));
}

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
  enabledWebhookProviders?: WebhookProvider[];
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
  enabledWebhookProviders = DEFAULT_WEBHOOK_PROVIDER_OPTIONS,
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
      const next = seededFormState(task, initialAgentId);
      if (!task && !enabledWebhookProviders.includes(next.webhookProvider as WebhookProvider)) {
        next.webhookProvider = enabledWebhookProviders[0] ?? "";
      }
      setForm(next);
      setError(null);
      setSubmitting(false);
      setWebhookSetup(null);
    }
  }, [open, task, initialAgentId, enabledWebhookProviders]);

  const update = <K extends keyof TaskFormState>(key: K, value: TaskFormState[K]) => {
    setForm((prev) => ({ ...prev, [key]: value }));
  };

  const triggerOptions = useMemo<TriggerType[]>(() => ["cron", "interval", "webhook"], []);
  const timeZoneOptions = useMemo(availableTimeZones, []);

  // Case- and whitespace-insensitive: "daily REPORT " should still warn.
  const duplicateName = useMemo(() => {
    const candidate = form.name.trim().toLowerCase();
    if (!candidate) return false;
    return existingNames.some((n) => n.trim().toLowerCase() === candidate);
  }, [form.name, existingNames]);

  const availableProviderOptions = WEBHOOK_PROVIDER_OPTIONS.filter((option) =>
    enabledWebhookProviders.includes(option.value),
  );

  const updateWebhookProvider = (provider: WebhookProvider) => {
    setForm((current) => ({
      ...current,
      webhookProvider: provider,
      webhookFilterEnabled: false,
      webhookFilterConditions: [{ source: "payload", field: "", values: "" }],
    }));
  };

  const updateFilterCondition = (
    index: number,
    patch: Partial<TaskFormState["webhookFilterConditions"][number]>,
  ) => {
    setForm((current) => ({
      ...current,
      webhookFilterConditions: current.webhookFilterConditions.map((condition, currentIndex) =>
        currentIndex === index ? { ...condition, ...patch } : condition,
      ),
    }));
  };

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
              <div className="space-y-3">
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
                <div className="space-y-1">
                  <Label htmlFor="task-cron-timezone">Time zone</Label>
                  <Select
                    id="task-cron-timezone"
                    value={form.cronTimezone}
                    onChange={(e) => update("cronTimezone", e.target.value)}
                    className="flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm text-foreground"
                  >
                    {timeZoneOptions.map((timeZone) => (
                      <option key={timeZone} value={timeZone}>
                        {TIME_ZONE_LABELS[timeZone] ?? timeZone}
                      </option>
                    ))}
                  </Select>
                  <p className="text-[11px] text-muted-foreground">
                    UTC by default. Named zones automatically follow daylight-saving changes.
                  </p>
                </div>
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
                  {formatScheduleInterval(minimumScheduleIntervalSeconds)}. Intervals are elapsed
                  durations, so time zones do not apply.
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
                    onChange={(e) => updateWebhookProvider(e.target.value as WebhookProvider)}
                    className="flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm text-foreground shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    {task?.trigger.type === "webhook" &&
                      !enabledWebhookProviders.includes(form.webhookProvider as WebhookProvider) && (
                        <option value={form.webhookProvider} disabled>
                          {form.webhookProvider} (disabled by deployment)
                        </option>
                      )}
                    {availableProviderOptions.map((opt) => (
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
                <div className="space-y-3 rounded-md border border-border p-3">
                  <div className="space-y-1">
                    <Label>Filter deliveries</Label>
                    <label className="flex items-center gap-2 text-sm">
                      <input
                        type="checkbox"
                        checked={form.webhookFilterEnabled}
                        onChange={(e) => update("webhookFilterEnabled", e.target.checked)}
                        className="h-4 w-4 rounded border-border"
                      />
                      Only run the agent when all conditions match
                    </label>
                  </div>

                  {form.webhookFilterEnabled && (
                    <div className="space-y-3">
                      {form.webhookFilterConditions.map((condition, index) => (
                        <div
                          key={index}
                          className="grid gap-2 rounded-md border border-border p-2 sm:grid-cols-[8rem_1fr_1fr_auto]"
                          data-testid="webhook-filter-condition"
                        >
                          <Select
                            value={condition.source}
                            onChange={(e) => updateFilterCondition(index, {
                              source: e.target.value as "payload" | "header",
                              field: "",
                            })}
                            aria-label={`Filter ${index + 1} source`}
                            className="h-9 rounded-md border border-input bg-background px-2 text-sm"
                          >
                            <option value="payload">Payload</option>
                            <option value="header">Header</option>
                          </Select>
                          <Input
                            value={condition.field}
                            onChange={(e) => updateFilterCondition(index, { field: e.target.value })}
                            placeholder={condition.source === "payload" ? "event.type" : "X-Event-Type"}
                            aria-label={`Filter ${index + 1} field`}
                          />
                          <Input
                            value={condition.values}
                            onChange={(e) => updateFilterCondition(index, { values: e.target.value })}
                            placeholder="Accepted values, comma-separated"
                            aria-label={`Filter ${index + 1} accepted values`}
                          />
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            aria-label={`Remove filter ${index + 1}`}
                            onClick={() => update(
                              "webhookFilterConditions",
                              form.webhookFilterConditions.filter((_, currentIndex) => currentIndex !== index),
                            )}
                          >
                            Remove
                          </Button>
                        </div>
                      ))}
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        disabled={form.webhookFilterConditions.length >= 16}
                        onClick={() => update("webhookFilterConditions", [
                          ...form.webhookFilterConditions,
                          { source: "payload", field: "", values: "" },
                        ])}
                      >
                        Add condition
                      </Button>
                      <p className="text-[11px] text-muted-foreground">
                        Field names and exact accepted values only; no filter code is executed.
                        Conditions use AND, while comma-separated values within one condition use OR.
                        Example: {FILTER_EXAMPLES[form.webhookProvider as WebhookProvider] ?? "Payload event.type = created"}.
                        {form.webhookProvider === "github" && (
                          <>{" "}<a
                            href={GITHUB_WEBHOOK_DOCS_URL}
                            target="_blank"
                            rel="noreferrer"
                            className="underline underline-offset-2 hover:text-foreground"
                          >
                            GitHub event documentation
                          </a>.</>
                        )}
                      </p>
                    </div>
                  )}
                  <p className="text-[11px] text-muted-foreground">
                    Non-matching signed deliveries are acknowledged without creating a run or
                    invoking the agent.
                  </p>
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
