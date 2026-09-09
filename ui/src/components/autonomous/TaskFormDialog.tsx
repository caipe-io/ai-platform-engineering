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
import { MultiSelect } from "@/components/ui/multi-select";
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

const GITHUB_WEBHOOK_DOCS_URL =
  "https://docs.github.com/en/webhooks/webhook-events-and-payloads";

interface GitHubEventOption {
  value: string;
  label: string;
  /** null means GitHub permits caller-defined action values. */
  actions: readonly string[] | null;
}

// GitHub has no API that enumerates valid webhook event/action combinations.
// Keep common repository events here and retain an "Other event" escape hatch;
// the linked GitHub catalogue remains the source of truth.
const GITHUB_EVENT_OPTIONS: readonly GitHubEventOption[] = [
  {
    value: "pull_request",
    label: "Pull request",
    actions: [
      "assigned",
      "auto_merge_disabled",
      "auto_merge_enabled",
      "closed",
      "converted_to_draft",
      "demilestoned",
      "dequeued",
      "edited",
      "enqueued",
      "labeled",
      "locked",
      "milestoned",
      "opened",
      "ready_for_review",
      "reopened",
      "review_request_removed",
      "review_requested",
      "synchronize",
      "unassigned",
      "unlabeled",
      "unlocked",
    ],
  },
  { value: "push", label: "Push", actions: [] },
  {
    value: "issues",
    label: "Issues",
    actions: [
      "assigned",
      "closed",
      "deleted",
      "demilestoned",
      "edited",
      "labeled",
      "locked",
      "milestoned",
      "opened",
      "pinned",
      "reopened",
      "transferred",
      "unassigned",
      "unlabeled",
      "unlocked",
      "unpinned",
    ],
  },
  { value: "issue_comment", label: "Issue comment", actions: ["created", "deleted", "edited"] },
  { value: "pull_request_review", label: "Pull request review", actions: ["dismissed", "edited", "submitted"] },
  { value: "pull_request_review_comment", label: "Pull request review comment", actions: ["created", "deleted", "edited"] },
  { value: "pull_request_review_thread", label: "Pull request review thread", actions: ["resolved", "unresolved"] },
  { value: "check_run", label: "Check run", actions: ["completed", "created", "rerequested", "requested_action"] },
  { value: "check_suite", label: "Check suite", actions: ["completed", "requested", "rerequested"] },
  { value: "workflow_job", label: "Workflow job", actions: ["completed", "in_progress", "queued", "waiting"] },
  { value: "workflow_run", label: "Workflow run", actions: ["completed", "in_progress", "requested"] },
  { value: "release", label: "Release", actions: ["created", "deleted", "edited", "prereleased", "published", "released", "unpublished"] },
  { value: "deployment", label: "Deployment", actions: ["created"] },
  { value: "deployment_status", label: "Deployment status", actions: ["created"] },
  { value: "create", label: "Branch or tag created", actions: [] },
  { value: "delete", label: "Branch or tag deleted", actions: [] },
  { value: "repository_dispatch", label: "Repository dispatch", actions: null },
  { value: "status", label: "Commit status", actions: [] },
  { value: "watch", label: "Repository starred", actions: ["started"] },
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

  const githubEventOption = GITHUB_EVENT_OPTIONS.find(
    (option) => option.value === form.webhookFilterEvent,
  );
  const selectedGitHubActions = Array.from(new Set(
    form.webhookFilterActions
      .split(",")
      .map((action) => action.trim().toLowerCase())
      .filter(Boolean),
  ));
  const githubActionOptions = githubEventOption?.actions == null
    ? null
    : Array.from(new Set([...githubEventOption.actions, ...selectedGitHubActions]));

  const updateGitHubEvent = (value: string) => {
    setForm((current) => ({
      ...current,
      webhookFilterEvent: value === "__other__" ? "" : value,
      // Actions are event-specific; never carry a stale action into another event.
      webhookFilterActions: "",
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
                {form.webhookProvider === "github" && (
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
                        Only run the agent for matching GitHub events
                      </label>
                    </div>

                    {form.webhookFilterEnabled && (
                      <>
                        <div className="space-y-1">
                          <Label htmlFor="task-webhook-filter-event">GitHub event</Label>
                          <Select
                            id="task-webhook-filter-event"
                            value={githubEventOption?.value ?? "__other__"}
                            onChange={(e) => updateGitHubEvent(e.target.value)}
                            required
                            className="flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm text-foreground shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
                          >
                            {GITHUB_EVENT_OPTIONS.map((option) => (
                              <option key={option.value} value={option.value}>
                                {option.label} ({option.value})
                              </option>
                            ))}
                            <option value="__other__">Other event…</option>
                          </Select>
                          {!githubEventOption && (
                            <Input
                              value={form.webhookFilterEvent}
                              onChange={(e) => update("webhookFilterEvent", e.target.value)}
                              placeholder="GitHub event name"
                              aria-label="Other GitHub event"
                              required
                            />
                          )}
                          <p className="text-[11px] text-muted-foreground">
                            Matches <code>X-GitHub-Event</code>. Common repository events are
                            listed above; choose Other for any additional documented event.{" "}
                            <a
                              href={GITHUB_WEBHOOK_DOCS_URL}
                              target="_blank"
                              rel="noreferrer"
                              className="underline underline-offset-2 hover:text-foreground"
                            >
                              GitHub event documentation
                            </a>
                            .
                          </p>
                        </div>

                        <div className="space-y-1">
                          <Label>GitHub actions (optional)</Label>
                          {githubActionOptions === null ? (
                            <Input
                              id="task-webhook-filter-actions"
                              value={form.webhookFilterActions}
                              onChange={(e) => update("webhookFilterActions", e.target.value)}
                              placeholder="Comma-separated action values"
                              aria-label="GitHub actions (optional)"
                            />
                          ) : githubActionOptions.length > 0 ? (
                            <MultiSelect
                              options={githubActionOptions}
                              selected={selectedGitHubActions}
                              onChange={(actions) => update(
                                "webhookFilterActions",
                                actions.join(", "),
                              )}
                              ariaLabel="GitHub actions (optional)"
                              allowCustom
                              placeholder="All actions"
                              searchPlaceholder="Search actions..."
                              emptyLabel="No matching actions"
                              badgeLabel="actions"
                              className="h-9 w-full max-w-full"
                              portalled={false}
                            />
                          ) : null}
                          <p className="text-[11px] text-muted-foreground">
                            {githubActionOptions?.length === 0
                              ? "This event has no documented top-level action filter. "
                              : "Leave blank to accept every action for this event. "}
                            <a
                              href={`${GITHUB_WEBHOOK_DOCS_URL}#${encodeURIComponent(form.webhookFilterEvent)}`}
                              target="_blank"
                              rel="noreferrer"
                              className="underline underline-offset-2 hover:text-foreground"
                            >
                              View valid actions
                            </a>
                            .
                          </p>
                        </div>
                      </>
                    )}
                    <p className="text-[11px] text-muted-foreground">
                      Non-matching deliveries are acknowledged without creating a run or invoking
                      the agent.
                    </p>
                  </div>
                )}
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
