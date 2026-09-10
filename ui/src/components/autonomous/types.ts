// Copyright CAIPE Contributors (https://caipe.io)
// SPDX-License-Identifier: Apache-2.0

/**
 * Types for the autonomous-agents UI surface.
 *
 * These mirror the wire shape produced by `_serialize_task` in
 * `routes/tasks.py` and the `TaskRun` Pydantic model. Keep them in
 * lockstep -- the FastAPI service is the source of truth.
 */

export type TriggerType = 'cron' | 'interval' | 'webhook';

export type TaskStatus = 'pending' | 'running' | 'success' | 'failed' | 'skipped';

export interface AutonomousRuntimeSettings {
  minimum_schedule_interval_seconds: number;
}

export interface CronTrigger {
  type: 'cron';
  schedule: string;
}

export interface IntervalTrigger {
  type: 'interval';
  seconds?: number | null;
  minutes?: number | null;
  hours?: number | null;
}

export interface WebhookTrigger {
  type: 'webhook';
  /**
   * Backend adapter id from autonomous_agents/webhook_providers.yaml.
   * Defaults to "github" server-side for older tasks, but writes should
   * include it so Jira/Slack/PagerDuty webhooks verify against their own
   * signature headers instead of the GitHub default.
   */
  provider?: string | null;
  /**
   * HMAC signing secret accepted on update when rotating a provider-issued
   * Slack/PagerDuty credential. The backend NEVER echoes the stored secret on
   * read paths -- ``_serialize_trigger`` in ``routes/tasks.py``
   * strips the value and replaces it with ``has_secret`` (below) so
   * any UI/XSS leak only learns whether one is configured, not the
   * value itself. POST ignores this field and generates an initial secret;
   * PUT may include it to save or rotate a provider-issued secret.
   */
  secret?: string | null;
  /**
   * Read-only boolean returned by the backend indicating whether
   * a secret is currently configured. Used by the edit dialog to
   * surface a "Replace secret" affordance instead of revealing the
   * value.
   */
  has_secret?: boolean;
}

export type Trigger = CronTrigger | IntervalTrigger | WebhookTrigger;

/**
 * Pre-flight acknowledgement returned by the supervisor when a task is
 * created or its routing-relevant fields change. Mirror of the Python
 * ``Acknowledgement`` model in
 * ``ai_platform_engineering/autonomous_agents/src/autonomous_agents/services/preflight.py``.
 *
 * Spec #099 FR-001..005 / AD-003. The UI surfaces this as a per-row
 * status badge ("Ack OK / Ack failed / Ack pending") with the
 * ``ack_detail`` and ``dry_run_summary`` rendered in a tooltip.
 */
export type AcknowledgementStatus = 'ok' | 'warn' | 'failed' | 'pending';

export interface Acknowledgement {
  ack_status: AcknowledgementStatus;
  ack_detail?: string;
  routed_to?: string | null;
  tools?: string[];
  available_agents?: string[];
  credentials_status?: Record<string, string>;
  dry_run_summary?: string;
  /** ISO-8601 string from the supervisor. */
  ack_at?: string;
}

export interface AutonomousTask {
  id: string;
  name: string;
  description?: string | null;
  agent: string | null;
  /**
   * When set, this task is routed through the dynamic-agents service
   * (custom user-built agent) rather than the supervisor. Mutually
   * exclusive with ``agent`` -- the autonomous-agents backend prefers
   * ``dynamic_agent_id`` and clears ``agent`` if both arrive.
   *
   * The Custom Agent editor stamps this field via
   * ``syncAutonomousTasks.ts``; manually-edited supervisor tasks
   * leave it null.
   */
  dynamic_agent_id?: string | null;
  prompt: string;
  llm_provider?: string | null;
  trigger: Trigger;
  enabled: boolean;
  /** ISO-8601 string from APScheduler; null for webhook/disabled. */
  next_run?: string | null;
  /**
   * Most recent supervisor pre-flight acknowledgement for this task.
   * Null until the first preflight attempt has completed (e.g. the
   * brief window between POST /tasks responding and the background
   * preflight resolving). Spec #099 FR-002.
   */
  last_ack?: Acknowledgement | null;
  /**
   * Deterministic UUIDv5 chat conversation id for this task. Stable
   * across restarts so the UI can deep-link to ``/chat/<id>`` from
   * anywhere. Spec #099 FR-006.
   */
  chat_conversation_id?: string | null;
  /**
   * Email of the user who created the task. Stamped server-side by the
   * autonomous-agents FastAPI service from the
   * `X-Authenticated-User-Email` header on POST /tasks (per-user
   * ownership model, plan section 4.4). Returned by `_serialize_task`
   * on every read path. `null` for legacy tasks created before the
   * per-user feature shipped — those are admin-only by design.
   */
  owner_id?: string | null;
  /**
   * Owner's Keycloak subject (UUID). Stable across email changes and used for
   * authorization when available. May be absent for tasks created before it
   * was exposed on the wire.
   */
  owner_sub?: string | null;
}

/** A mutation result kept separate so one-time secrets never enter task state. */
export interface TaskSaveResult {
  task: AutonomousTask;
  webhookSetupRequired?: boolean;
  webhookSetupSecret?: string;
}

export interface TaskRun {
  run_id: string;
  task_id: string;
  task_name: string;
  status: TaskStatus;
  started_at: string;
  finished_at?: string | null;
  response_preview?: string | null;
  error?: string | null;
  /**
   * When this run was produced by an inbound follow-up reply (e.g.
   * the Webex bot forwarding an in-thread message), this points at
   * the run the operator was replying to. Lets the run-history UI
   * render a single threaded timeline instead of two unrelated rows.
   * Null for the original webhook fire and for cron / interval /
   * manual runs.
   */
  parent_run_id?: string | null;
  /** Root webhook delivery shared by this run and its follow-ups. */
  root_run_id?: string | null;
  /** Backend execution context; unrelated webhook deliveries use different ids. */
  execution_context_id?: string | null;
  /** Exact operator turn for follow-up runs, without the task-prompt prefix. */
  follow_up_text?: string | null;
  follow_up_transport?: string | null;
  /**
   * Prompt materialised for this specific run. Follow-up runs include
   * the inbound operator reply appended by the autonomous-agents
   * service; legacy runs may omit this and should fall back to the
   * task's current prompt.
   */
  request_prompt?: string | null;
  /**
   * Deterministic UUID derived from ``run_id`` by the autonomous
   * service when chat-history publishing is enabled (IMP-13). Lets
   * the run-row UI deep-link straight to ``/chat/<conversation_id>``.
   * Null when chat publishing is disabled or when the run pre-dates
   * the IMP-13 ship.
   */
  conversation_id?: string | null;
  /**
   * Spec #099 Phase B — full supervisor response text and captured A2A
   * streaming events. The synthesiser replays ``events`` so past
   * scheduled fires render with the same plan / tools / timeline a
   * typed chat reply gets, instead of the 500-char ``response_preview``
   * tombstone. ``response_full`` is the unabridged text from the
   * supervisor's final_result artifact (kept alongside the events so
   * non-rich consumers — search, audit logs — don't have to walk the
   * event list).
   */
  response_full?: string | null;
  events?: Record<string, unknown>[];
}

export interface TaskRunFollowUpResult {
  status: "accepted";
  task_id: string;
  run_id: string;
  parent_run_id: string;
}

/**
 * Form-level shape used by `TaskFormDialog`. Distinct from
 * `AutonomousTask` because the form needs free-text inputs
 * (e.g. "minutes" as a string before parsing) and lets us version
 * the form schema without churning the API contract.
 */
export interface TaskFormState {
  id: string;
  name: string;
  description: string;
  agent: string;
  /**
   * Dynamic-agents service agent id when the task should route through
   * a custom agent instead of a supervisor sub-agent. Persisted on
   * ``AutonomousTask.dynamic_agent_id`` server-side; round-tripped here
   * verbatim so editing a custom-agent task in the standalone form
   * does NOT silently demote it back to a supervisor task.
   *
   * Today the standalone TaskFormDialog has no UI control for picking
   * a dynamic agent (see TODO ``ux-1``); the value flows through
   * untouched from the wire and back, exactly as for any other field
   * the form doesn't yet expose. The Custom Agent editor's Step 6
   * stamps this field via ``syncAutonomousTasks.ts`` on save.
   */
  dynamic_agent_id: string | null;
  prompt: string;
  llm_provider: string;
  enabled: boolean;
  triggerType: TriggerType;
  cronSchedule: string;
  intervalSeconds: string;
  intervalMinutes: string;
  intervalHours: string;
  webhookProvider: string;
  /** Used only to rotate provider-issued Slack/PagerDuty secrets on edit. */
  webhookSecret: string;
}
