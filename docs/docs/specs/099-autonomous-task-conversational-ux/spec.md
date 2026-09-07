# Feature Specification: Conversational UX for Autonomous Tasks

**Feature Branch (umbrella)**: `prebuild/feat/autonomous-agents-conversational-ux`
**Created**: 2026-04-19
**Status**: Draft
**Owners**: autonomous-agents working group
**Input**: Operator feedback on the initial form-based Autonomous tab — three independent pain points distilled from a hands-on walkthrough:

1. The `agent` field forces tribal knowledge ("which sub-agent handles GitHub vs ArgoCD vs Slack?") on every user.
2. After creating a task, there is no way to verify the system will actually fire it correctly. Users go to bed hoping cron works.
3. Scheduled-but-not-yet-fired runs are invisible. The chat sidebar only shows runs *after* they complete (and only when `CHAT_HISTORY_PUBLISH_ENABLED=true`), so an operator has no live view of "what is the supervisor about to do tonight?"

This spec proposes one cohesive UX shift — **every task is a conversation** — and three layered features that build on it.

---

## User Scenarios & Testing *(mandatory)*

### User Story 1 — Pre-flight acknowledgement at creation time (Priority: P1)

When an operator creates an autonomous task, the supervisor MUST acknowledge that it understood the request and can execute it, BEFORE the first scheduled run. The acknowledgement is shown in a chat thread tied to that task and includes:

- Which sub-agent the prompt routed to
- Which tools that sub-agent will use
- Whether required credentials are present and validated (e.g., GitHub PAT can authenticate)
- The next scheduled run time
- A plain-English summary of what the task will do

**Why this priority**: This is the largest single trust gap in the current product. Without an ack, every task is an act of faith until the next morning. With it, broken tokens / missing agents / typo'd prompts surface at creation time, not at 3 AM.

**Independent Test**: From the Autonomous tab, create a new task targeting the GitHub agent with prompt `"list open PRs older than 7 days"` and a daily 9 AM cron. Within 5 seconds of save, the task row MUST display a green check + "Ack received" status, and clicking it MUST open a chat thread whose first message is the supervisor's structured acknowledgement.

**Acceptance Scenarios**:

1. **Given** a valid task targeting an enabled sub-agent with valid credentials, **When** the user clicks Save, **Then** an acknowledgement message from the supervisor appears in the task's chat thread within 30 seconds and the task row reflects "Ack OK".
2. **Given** a task whose target sub-agent is disabled (`ENABLE_X=false`), **When** the user clicks Save, **Then** an error acknowledgement appears in the chat thread explaining the missing agent and the task row reflects "Ack failed: agent disabled".
3. **Given** a task that requires credentials the supervisor cannot validate (e.g. expired PAT), **When** the user clicks Save, **Then** the acknowledgement clearly names the failed credential check and the task row reflects "Ack failed: invalid credentials". The task is still saved (so the user can fix and re-ack).

---

### User Story 2 — Task as conversation (Priority: P1)

Each task in the Autonomous tab MUST appear in the chat sidebar as a single conversation thread, scoped to that task and growing over time as runs complete. The thread MUST be queryable by `task_id`, MUST be filterable by the existing `source: 'autonomous'` chip, and MUST contain (in order):

- The user's original creation intent (form values rendered as a human-readable message OR the literal chat transcript if created via Story 4)
- The supervisor's pre-flight acknowledgement (Story 1)
- A "next run at HH:MM UTC" indicator
- One assistant message per fired run, with the response

**Why this priority**: This is the visibility layer the operator asked for. Without it, the chat sidebar's "autonomous" filter is a tombstone for completed runs only. With it, the operator can scroll the chat sidebar and see exactly what each task has been doing AND what it will do next.

**Independent Test**: Create three tasks (cron, interval, webhook). Open the chat sidebar with the "autonomous" filter active. Three conversation threads MUST be visible, each named after the task. Click any thread — its full history (creation, ack, prior runs, next-run indicator) MUST render in the message pane.

**Acceptance Scenarios**:

1. **Given** a task is created, **When** the user opens the chat sidebar with the autonomous filter, **Then** a new conversation thread for that task is present.
2. **Given** a task fires its scheduled run, **When** the supervisor returns a response, **Then** a new assistant message appended to the task's existing thread (not a new thread per run).
3. **Given** a task is updated (prompt or schedule change), **When** the user saves the change, **Then** a system-style message is appended to the thread documenting the change AND a fresh pre-flight acknowledgement is requested.
4. **Given** a task is disabled or deleted, **When** the user confirms, **Then** the thread remains in the sidebar (read-only for deletes) so the historical record is preserved.

---

### User Story 3 — Upcoming-run visibility in the thread (Priority: P2)

Each task's chat thread MUST display the next scheduled fire time as a live, persistent indicator (not just static text). When the cron tick arrives and the run starts, the indicator MUST flip to "Running…" and on completion be replaced by the response message and a refreshed "Next run" indicator.

**Why this priority**: This is the operator's "will my 9 PM task actually fire?" question made visible. P2 because it is purely additive on top of P1+P2 (Stories 1 and 2 deliver the data; this story renders it).

**Independent Test**: Create a task with an interval trigger of 2 minutes. Open its chat thread. The "Next run" indicator MUST count down (or display a relative timestamp). At the 2-minute mark, the indicator MUST flip to "Running…" within 5 seconds of the tick, then to the assistant response message within the run's normal latency.

**Acceptance Scenarios**:

1. **Given** an enabled cron/interval task, **When** the user opens its thread, **Then** the next-run indicator displays an absolute timestamp AND a relative "in X minutes/hours/days" hint.
2. **Given** a webhook-triggered task, **When** the user opens its thread, **Then** the indicator displays "Triggered by external webhook: POST `/api/v1/hooks/{task_id}`" instead of a timestamp.
3. **Given** a disabled task, **When** the user opens its thread, **Then** the indicator displays "Disabled" and no countdown is shown.

---

### User Story 4 — Chat-driven task authoring (Priority: P2)

In addition to the existing form, the Autonomous tab MUST offer a second creation path: a "Describe a task" button that opens a dedicated chat panel. The panel converses with a `task-author` supervisor sub-agent that asks follow-up questions until it has enough information to construct a valid `TaskDefinition`, then creates the task on behalf of the user. The form path MUST remain available unchanged for power users.

**Why this priority**: Removes the `agent` field's tribal-knowledge requirement entirely for non-power users. P2 because the form path is functional today; this lifts UX rather than fixing breakage.

**Independent Test**: From the Autonomous tab, click "Describe a task". In the chat panel, type *"every weekday at 9 AM, summarise yesterday's merged PRs in cisco-eti/ai-platform-engineering"*. The task-author bot MUST ask at most three follow-ups (such as token presence and notification preference) before producing a confirmation card with all task fields pre-filled. On user confirmation, the task MUST exist in `GET /api/v1/tasks` and MUST already have a Story 1 acknowledgement.

**Acceptance Scenarios**:

1. **Given** the user provides a clear natural-language description with intent, target, schedule, **When** they confirm the bot's summary, **Then** a task is created via the same `POST /api/v1/tasks` the form uses.
2. **Given** the user description is ambiguous (no schedule, no target), **When** the bot detects gaps, **Then** it asks targeted follow-up questions one at a time, never more than five total turns before producing a confirmation.
3. **Given** the bot's inferred sub-agent has missing credentials in the supervisor's view, **When** confirming, **Then** the bot proactively asks the user to provide the credential and only finalises the task after the credential is present.

---

### Edge Cases

- **Supervisor unreachable at creation time** (Story 1): The task MUST be saved with status `Ack pending`. The pre-flight call MUST be retried on a backoff (matching the existing `a2a_max_retries` knob). After the budget is exhausted the row shows `Ack failed: supervisor unreachable` and the user can retry from the row's overflow menu.
- **Sub-agent dynamically reloads after task creation** (Stories 1, 2): When a sub-agent is enabled or disabled at runtime, all tasks targeting it MUST re-acknowledge automatically and the chat thread MUST receive a system message about the topology change.
- **Conversation deduplication** (Story 2): If a user creates a task whose generated `conversation_id` collides with an existing chat conversation (extremely unlikely with UUIDv5), the publisher MUST detect collision and append a discriminator rather than overwriting.
- **Long-running runs** (Story 3): The "Running…" indicator MUST display elapsed time. Past 10 minutes (configurable) the UI MUST surface a "Run is taking longer than usual" hint without cancelling the run.
- **Bot-confused authoring** (Story 4): If the task-author bot exceeds five turns without a viable summary, it MUST hand off to the form ("I'm having trouble — let's switch to the form") and pre-fill whatever fields it has captured.

---

## Requirements *(mandatory)*

### Functional Requirements

#### Pre-flight acknowledgement (Story 1)

- **FR-001**: The supervisor's A2A interface MUST expose a pre-flight method (proposed: `tasks/preflight`, or equivalent — see Open Questions) that accepts `{prompt, target_agent_hint?, llm_provider?}` and returns a structured `Acknowledgement` containing at minimum `{routed_to, tools, credentials_status, dry_run_summary, next_run?}`. The pre-flight MUST NOT execute any side-effecting tool.
- **FR-002**: The autonomous-agents service MUST call pre-flight on every successful `POST /api/v1/tasks` and `PUT /api/v1/tasks/{id}` (when the prompt, agent, or trigger changed). The result MUST be persisted on the task record under `last_ack`.
- **FR-003**: The autonomous-agents service MUST expose `last_ack` on the existing task list/get endpoints so the UI can render an "Ack OK / Ack failed / Ack pending" badge per row without a separate round-trip.
- **FR-004**: Pre-flight failures MUST NOT block task creation. A failed ack is a warning, not an error — the user still gets the task and can re-ack via a UI control.
- **FR-005**: The supervisor's pre-flight MUST be idempotent — calling it twice with the same inputs MUST return functionally equivalent acknowledgements.

#### Task-as-conversation (Story 2)

- **FR-006**: Every task MUST own exactly one conversation in the existing chat-history collections, identified by a deterministic `conversation_id = uuid5(NAMESPACE_URL, f"autonomous-task:{task_id}")` (matches the contextId scheme already used for A2A calls — see `services/a2a_client.py` post-099 fix).
- **FR-007**: The chat publisher MUST write at minimum the following message kinds into the task's conversation: `creation_intent`, `preflight_ack`, `next_run_marker`, `run_request`, `run_response`, `run_error`, `task_updated`, `task_disabled`, `task_deleted`, `task_reauthored`. Each kind MUST be tagged in message metadata so the UI can render type-specific affordances.
- **FR-008**: The publisher MUST be enabled by default in this feature (replacing the current `chat_history_publish_enabled=false` default), guarded by a single Mongo-availability probe at startup. When Mongo is not configured, the publisher MUST log once at INFO and disable itself silently rather than fail startup.
- **FR-009**: The publisher MUST never include raw secrets in messages — credentials are referenced by presence/absence (`PAT_present: true`) and by validation outcome (`auth_check: ok`), never by value.

#### Upcoming-run indicator (Story 3)

- **FR-010**: The `/api/v1/tasks` response MUST include a `next_run` ISO8601 timestamp for cron and interval tasks, or a `webhook` discriminator object for webhook tasks (this already exists in the model; this requirement just locks it in).
- **FR-011**: The UI MUST poll `/api/v1/tasks/{id}` (or subscribe via SSE/WebSocket if available) to keep the per-thread next-run indicator fresh without a full page reload. Poll cadence MUST default to 30 s and be overridable by feature flag.
- **FR-012**: The UI MUST render the indicator with both an absolute timestamp (user's locale) and a relative hint (`"in 4 hours"`).

#### Chat-driven authoring (Story 4)

- **FR-013**: A new sub-agent named `task-author` MUST be registered in the supervisor with at minimum these tools: `list_available_agents`, `validate_cron`, `dry_run_preflight`, `create_task`, `update_task`, `delete_task`, `trigger_task_now`. All `*_task` tools MUST call the existing autonomous-agents REST API rather than poking storage directly.
- **FR-014**: The Autonomous tab UI MUST surface a "Describe a task" button alongside the existing "+ New task" button. Clicking it MUST open a chat panel scoped to the `task-author` sub-agent with conversation isolation (one author session per draft task).
- **FR-015**: On user confirmation in the chat panel, the bot MUST submit `POST /api/v1/tasks` and surface a deep-link to the freshly-created task's row. The form path MUST continue to function unchanged.
- **FR-016**: The task-author bot MUST refuse to invent credentials. When a credential is missing, it MUST ask the user to paste one OR direct them to the existing credential-management UI; it MUST NEVER fabricate a token, app ID, or webhook secret.

#### Cross-cutting

- **FR-017**: All new code MUST follow the existing autonomous-agents structured logging conventions (`task=<task_id>` field, no raw secrets, JSON-friendly format).
- **FR-018**: All new public endpoints/methods MUST be covered by unit tests AND at least one integration test that exercises the autonomous-agents → supervisor path (using the existing FakeSupervisor fixture pattern from `tests/test_a2a_client.py`).
- **FR-019**: Native-dev parity: every new feature MUST work in the in-memory store mode (no Mongo, no Docker) so cloud-PC contributors can develop without external infrastructure. Mongo-dependent capabilities MUST degrade gracefully (log + disable) rather than crash startup.

### Non-Functional Requirements

- **NFR-001 (latency)**: Pre-flight ack p95 latency MUST stay under 5 seconds in the happy path (no actual sub-agent tool execution).
- **NFR-002 (reliability)**: Chat publisher writes MUST NOT block run completion. Publisher failures MUST be logged as warnings and MUST NOT mark the run itself as failed.
- **NFR-003 (privacy)**: Webhook payloads MUST continue to honour the existing `chat_history_include_context` flag — defaulting OFF means raw payloads are NEVER published into chat threads (reuse existing redaction code).
- **NFR-004 (back-compat)**: Existing tasks created before this feature MUST keep working without re-creation. On first read after upgrade, the autonomous-agents service MUST lazily backfill a `creation_intent` message into each pre-existing task's chat thread (best-effort; failures are logged, not fatal).

### Key Entities

- **Task** (`TaskDefinition`): existing model, augmented with two new persisted fields:
  - `last_ack: Acknowledgement | None` — most recent pre-flight result. `None` when no ack has been attempted yet.
  - `chat_conversation_id: str` — deterministic UUIDv5 derived from `task_id`, persisted for fast lookup; redundant with FR-006's derivation but stored to avoid recomputation in hot paths.
- **Acknowledgement** (new): `{routed_to: str, tools: list[str], credentials_status: dict[str,str], dry_run_summary: str, next_run: datetime | None, ack_at: datetime, ack_status: "ok" | "warn" | "failed", ack_detail: str}`.
- **Chat conversation** (existing UI schema, extended): adds messages with `metadata.kind` from FR-007's enumeration. No schema change to the conversations collection itself; only message-payload conventions.
- **Task-author session** (new, transient): a single chat conversation between a UI user and the supervisor's `task-author` sub-agent. Lives only until the user confirms or abandons; not persisted long-term unless explicitly preserved.

---

## Architecture & Contracts

### Pre-flight protocol

The supervisor today exposes one A2A method (`message/send`) used for normal conversational requests. This spec adds a complementary method whose contract is:

```
Method:  message/send                    (existing — unchanged)
Method:  tasks/preflight                 (new)
  Request:
    {
      jsonrpc: "2.0",
      id: <uuid>,
      method: "tasks/preflight",
      params: {
        prompt: <str>,                   # the task's prompt
        agent_hint: <str | null>,        # optional target sub-agent
        llm_provider: <str | null>,
        contextId: <uuid>,               # same UUIDv5 the runs will use
      }
    }
  Response (success):
    {
      jsonrpc: "2.0",
      id: <uuid>,
      result: {
        routed_to: "github",
        tools: ["list_pull_requests","search_repositories"],
        credentials_status: {"github_pat": "ok"},
        dry_run_summary: "Will list open PRs in any repo the PAT can read, filter to age > 7d, summarise.",
        next_run: "2026-04-22T09:00:00Z" | null,
        ack_status: "ok"
      }
    }
  Response (failure):
    {
      jsonrpc: "2.0",
      id: <uuid>,
      error: {
        code: -32099,                    # custom: preflight failed
        message: "agent 'foo' is not enabled",
        data: { ack_status: "failed", details: {...} }
      }
    }
```

Implementation note: rather than introduce a brand-new method, an alternative is to use `metadata.preflight: true` on the existing `message/send` and have the supervisor short-circuit before any tool execution. That has the advantage of zero protocol-version bump but the disadvantage of overloading semantics on a method that today always executes. The Open Questions section asks for a decision before Phase 1 starts.

### Per-task chat thread schema

No new collections. Reuse `conversations` and `messages` from the UI's MongoDB schema (`ui/src/lib/mongodb.ts`). The autonomous publisher already writes here today; this spec only changes:

- **conversation_id**: deterministic per task (FR-006), so updates are append-only to a stable thread instead of one-conversation-per-run.
- **message metadata**: new `kind` field with the enumerated values from FR-007.
- **owner**: continues to use `chat_history_owner_email` (synthetic identity), unchanged.

UI rendering will branch on `metadata.kind` to render type-specific affordances (e.g., the `next_run_marker` becomes a live countdown rather than a static text bubble).

### Phasing into PRs

Each phase is independently shippable and gated behind a feature flag so any single PR can land without blocking the others.

| Phase  | PR title                                                                                              | Touches                                              | Feature flag                            |
|--------|--------------------------------------------------------------------------------------------------------|------------------------------------------------------|-----------------------------------------|
| 0      | `docs(autonomous-agents): spec — conversational UX for autonomous tasks (#099)`                        | `docs/`                                              | n/a                                     |
| 1      | `feat(autonomous-agents): per-task chat thread w/ supervisor preflight ack`                            | `autonomous-agents`, `multi-agents/platform-engineer`| `AUTONOMOUS_PREFLIGHT_ENABLED` (default on) |
| 2      | `feat(ui): render per-task chat thread with upcoming-run indicator`                                    | `ui/`                                                | `NEXT_PUBLIC_AUTONOMOUS_THREAD_VIEW` (default on) |
| 3      | `feat(autonomous-agents): chat-driven task author sub-agent (second creation door)`                    | `autonomous-agents`, `multi-agents`, `ui/`           | `NEXT_PUBLIC_AUTONOMOUS_AUTHOR_BOT` (default off → on after dogfood) |

Each phase MUST land green CI (lint + tests for both Python services and the UI) and MUST update the existing autonomous-agents README if user-visible behaviour changes.

---

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: After Phase 1 lands, 100% of new tasks (cron, interval, webhook) have a non-null `last_ack` within 30 seconds of creation in happy-path environments.
- **SC-002**: After Phase 2 lands, dogfood operators report (informal survey N≥3) that they can answer "what is each autonomous task currently scheduled to do?" using only the chat sidebar — no need to open the form.
- **SC-003**: After Phase 3 lands, ≥40% of newly-created tasks in the dogfood week are authored via the chat door (measured by a `created_via: "form" | "chat"` tag on `creation_intent` messages).
- **SC-004**: Zero regressions in existing autonomous-agents tests across all phases (existing test suite stays green; new tests added for new code).
- **SC-005**: Native-dev (no Mongo, no Docker) cold start of autonomous-agents stays under 5 seconds across all phases.

---

## Out of Scope

- **Per-message persistence of expand/collapse state** in chat threads (UI behavior; tracked separately).
- **Cross-task chat threads** (e.g., "show me all GitHub-targeted tasks in one combined view") — single-task threads only for now.
- **Multi-tenant isolation of task-author sessions** beyond the existing supervisor session model — task-author conversations inherit whatever isolation the supervisor already provides.
- **Replacing the existing form** — the form remains the system of record for task fields and the chat door is a translator on top of it. A future spec may revisit this once dogfood data shows whether anyone still prefers the form.
- **A separate "scheduling supervisor"** as the operator originally suggested. The existing single supervisor handles both real-time and scheduled requests; a dedicated scheduler-supervisor would be over-engineering for the current scale.

---

## Assumptions

- The supervisor's existing single-node mode (`main_single:app`) remains the deployed topology. Multi-node A2A binding is supported but not required for this spec.
- The UI's chat schema (`conversations`, `messages` collections) remains stable. Any breaking change to that schema would require a coordinated migration that is out of scope here.
- Pre-flight latency is acceptable in the seconds range. If a credential check (e.g. GitHub `/user`) is slow, the ack reflects that latency; we do NOT introduce a separate background worker for pre-flight in this spec.
- The cloud-PC native-dev story stays first-class. Every phase MUST be testable without Docker, Mongo, or any other external infrastructure (in-memory fallbacks already exist for runs and tasks; this spec does not regress them).
- AGENTS.md DCO and AI attribution policies apply to every PR in this series. Each commit is conventional-commits formatted; the human committer adds `Signed-off-by`; AI assistance is acknowledged via `Assisted-by` only.

---

## Open Questions

- **OQ-1 (P1, blocker for Phase 1)**: Should the pre-flight be a new A2A method (`tasks/preflight`) or a flag on `message/send` (`metadata.preflight: true`)? The spec leans toward the flag approach (smaller blast radius, no client SDK bump), but the supervisor maintainers should weigh in. Defer to maintainers; default to flag if no objection within review window.
- **OQ-2 (P2, can land in Phase 2)**: Should the next-run indicator use polling (FR-011) or push (SSE/WebSocket)? Push is nicer UX but adds infrastructure. Recommendation: ship polling at 30 s in Phase 2 and revisit push in a follow-up if real-world cadence demands it.
- **OQ-3 (P2, blocker for Phase 3)**: Where do `task-author` sub-agent system prompts live? Reuse the existing `prompt_config.<agent>.yaml` convention (`prompt_config.task_author_agent.yaml`) for consistency. Decision: yes, do that.
- **OQ-4 (P3, nice-to-have)**: Should the existing `daily-pr-check`-style YAML-seeded tasks ALSO get backfilled chat threads on first read? Recommendation: yes, but lazily (FR-NFR-004) and best-effort, to keep upgrade flexible.

---

## Risks

- **R-1 (Medium)**: Pre-flight could become slow if a sub-agent's credential check hits a flaky upstream (e.g., GitHub API rate limit). Mitigation: respect the existing `a2a_timeout_seconds` config; treat timeouts as `ack_status=warn` not `failed`.
- **R-2 (Medium)**: Chat-history publisher writing per-task threads will increase write volume on the messages collection (multiple writes per run vs. one per run today). Mitigation: bench against a realistic task fleet (50 tasks × 10 runs/day = 500 writes/day baseline; this spec adds ~3-5 writes per task lifecycle). Should remain trivial for any production Mongo deployment.
- **R-3 (Low)**: The task-author bot may produce non-deterministic task definitions across LLM provider switches. Mitigation: bot's final step is always to display the constructed `TaskDefinition` JSON to the user for explicit confirmation before submission; user is the final gate.
- **R-4 (Low)**: Backfilling pre-existing tasks (NFR-004) may write to chat history concurrently with the dogfood runs. Mitigation: backfill runs once per task on first read post-upgrade with an idempotent guard (`if conversation has any messages, skip`).
