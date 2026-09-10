# Autonomous Agents

A standalone FastAPI service that schedules and triggers AI agents to run in the background — without a human in the loop.

Part of the [CAIPE (Community AI Platform Engineering)](https://cnoe-io.github.io/ai-platform-engineering/) project, developed in collaboration with **Cisco Outshift** and **UCL**.

---

## Overview

While the CAIPE UI handles on-demand, chat-driven work, Autonomous Agents handles **scheduled and event-driven** tasks:

- Run an agent on a **cron schedule** (e.g. daily security scan at 09:00 UTC)
- Run an agent at a fixed **interval** (e.g. health check every 30 minutes)
- Run an agent when an external system fires a **webhook** (e.g. GitHub PR opened)

Tasks are managed through the CAIPE UI. Its authenticated server-side
`/api/autonomous` route forwards requests to this cluster-internal service,
which persists task definitions to MongoDB. MongoDB is required in the current
runtime.

---

## Architecture

```text
CAIPE UI --> authenticated /api/autonomous route --> Autonomous Agents
                                                           |
                                                           v
                                                        MongoDB

Autonomous Agents (one process / pod)
  |-- APScheduler (cron / interval) --+
  |-- webhook receiver                |--> Task Runner --> Dynamic Agents
  |     `-- process-local task FIFO ---+       (SSE, as task owner)
  `-- run history / optional Chat publisher --> MongoDB
```

Task definitions live in MongoDB and are managed through the authenticated
`/api/autonomous` proxy. Every task targets a **dynamic agent** (by
`dynamic_agent_id`): when a trigger fires, the Task Runner POSTs the prompt to
the dynamic-agents service's `/api/v1/chat/stream/start` endpoint, which runs
it through that custom agent (its tools / system prompt / model / middleware).

Identity and access:

- Each run carries the task owner's identity in the gateway `X-User-Context`
  header, so the dynamic-agents service attributes the conversation to the
  owner and enforces per-user / per-group authorization (OpenFGA) on the
  target agent.
- A missing or unauthorized agent surfaces as a failed run with a clear
  error rather than silently doing nothing.
- Cron/interval tasks execute directly from APScheduler. Webhook deliveries
  use a bounded, process-local FIFO with one active execution per task.
- The current deployment is intentionally single-replica. See
  [Current scaling limitation](#current-scaling-limitation).

---

## Project Structure

```
autonomous_agents/
  src/autonomous_agents/
    main.py               # FastAPI app entrypoint
    config.py             # Settings (env vars)
    models.py             # Pydantic models: TaskDefinition, triggers, run records
    log_config.py         # Logging with task_id context
    routes/
      health.py           # GET /health
      tasks.py            # GET /api/v1/tasks, /runs, POST /tasks/{id}/run
      webhooks.py         # POST /api/v1/hooks/{task_id}
    services/
      task_lifecycle.py        # Task store, runtime hot-reload, preflight
      task_runner.py           # Per-run execution pipeline
      scheduler.py             # APScheduler registration for cron/interval
      dynamic_agents_client.py # Runs prompts on the dynamic-agents service
      mongo.py                 # MongoDB-backed task + run stores
      schedule_validation.py   # Configurable cron/interval frequency floor
      secret_encryption.py     # KMS envelope encryption for webhook secrets
      webhook_runtime.py       # Registry, per-task FIFO, capacity limits
  pyproject.toml
  Dockerfile
```

---

## Trigger Types

### Cron
Runs on a standard cron schedule (UTC).

```yaml
trigger:
  type: cron
  schedule: "0 9 * * 1-5"   # 09:00 UTC, Monday-Friday
```

### Interval
Runs repeatedly at a fixed time interval.

```yaml
trigger:
  type: interval
  minutes: 30              # also supports: seconds, hours
```

### Webhook
Runs when an external system POSTs to `/api/v1/hooks/{task_id}`.

```yaml
trigger:
  type: webhook
  provider: "github"               # UI: github, jira, slack, pagerduty
  # The API requires a signing secret and securely stores it.
```

The server generates the task id and therefore the final endpoint:
`/api/v1/hooks/<task-id>`. For GitHub and Jira it also generates a signing
secret and returns it once after creation. Slack and PagerDuty issue their own
secret, which the setup modal requires the user to paste back into CAIPE.

The service also ships a `generic_hmac` adapter for API/configuration users,
but it is intentionally absent from the UI task form.

---

## Configuration

### Task definition schema

A task (the shape stored in MongoDB / accepted by `POST /api/v1/tasks`,
shown here as YAML for readability):

```yaml
tasks:
  - id: "my-task"                    # unique identifier (used in API + webhook URL)
    name: "My Task"                  # human-readable label
    description: "Optional"
    dynamic_agent_id: "agent-123"    # REQUIRED: the dynamic agent that runs this
                                     # task. The prompt executes through that
                                     # agent's tools / system prompt / model.
    prompt: |                        # prompt sent to the agent
      Check all open PRs and flag any that have been open for more than 7 days.
    trigger:
      type: cron
      schedule: "0 9 * * *"
    enabled: true
```

> **Note:** the legacy `agent` (sub-agent hint) and `llm_provider` fields are
> deprecated no-ops kept only so task definitions persisted before the
> dynamic-only routing model still load. The dynamic agent's own configuration
> governs which tools and model a task uses; pick the behaviour by selecting
> the right `dynamic_agent_id`.

### Environment Variables

| Variable | Default | Description |
|---|---|---|
| `DYNAMIC_AGENTS_URL` | `None` | Dynamic-agents service base URL (e.g. `http://dynamic-agents:8001`). Required to run tasks. |
| `DYNAMIC_AGENTS_TIMEOUT_SECONDS` | `300` | Deployment-wide timeout for each dynamic-agents streaming call. |
| `DYNAMIC_AGENTS_PREFLIGHT_TIMEOUT_SECONDS` | `10` | Timeout budget for the preflight check. |
| `DYNAMIC_AGENTS_SYSTEM_EMAIL` | `autonomous@system` | Fallback identity for tasks created before per-user ownership existed. |
| `MINIMUM_SCHEDULE_INTERVAL_SECONDS` | `1800` | Minimum allowed gap between cron/interval fires. Webhook triggers are exempt. |
| `LLM_PROVIDER` | `anthropic-claude` | Informational default; the dynamic agent's own model config governs execution. |
| `HOST` | `0.0.0.0` | Server bind host |
| `PORT` | `8002` | Server port |
| `WEBHOOK_SECRET` | `None` | Global HMAC fallback for tasks without a per-task key and for the first-party follow-up bridge. New UI tasks use per-task secrets. |
| `WEBHOOK_PROVIDERS_FILE` | bundled YAML | Optional replacement provider-adapter file. The bundled registry contains GitHub, Jira, Slack, PagerDuty, Webex, and generic HMAC. |
| `WEBHOOK_REPLAY_WINDOW_SECONDS` | `0` | Optional replay window for adapters without a mandatory provider window. Slack always enforces its bundled 300-second window. |
| `WEBHOOK_MAX_PAYLOAD_BYTES` | `1048576` | Maximum accepted webhook request body. Larger bodies are rejected with HTTP 413 before parsing. |
| `WEBHOOK_MAX_PENDING_PER_TASK` | `100` | Maximum queued + running deliveries for one webhook task. Each task's FIFO still executes exactly one at a time. |
| `WEBHOOK_MAX_PENDING_PER_OWNER` | `500` | Maximum queued + running webhook deliveries owned by one user. |
| `WEBHOOK_MAX_PENDING_GLOBAL` | `5000` | Process-wide queued + running delivery ceiling. |
| `WEBHOOK_MAX_PENDING_PAYLOAD_BYTES_GLOBAL` | `67108864` | Process-wide raw-payload byte budget across queued + running webhook deliveries. |
| `WEBHOOK_MAX_CONCURRENT_PER_OWNER` | `20` | Execution concurrency across different webhook tasks owned by one user. |
| `WEBHOOK_MAX_CONCURRENT_GLOBAL` | `100` | Execution concurrency across different webhook tasks. Same-task runs are always serialized. |
| `CREDENTIAL_KMS_CMK_ID` | `None` | AWS KMS CMK id/ARN/alias used to envelope-encrypt per-task webhook secrets. Required when any task has its own HMAC secret. |
| `CREDENTIAL_KMS_REGION` | AWS SDK default | AWS region for the KMS client. The pod also needs `kms:GenerateDataKey` and `kms:Decrypt`, normally through IRSA. |
| `LOG_LEVEL` | `INFO` | `DEBUG`, `INFO`, `WARNING`, `ERROR` |
| `MONGODB_URI` | `None` | Required MongoDB connection for task definitions, runs, deduplication, and optional Chat publishing. |
| `MONGODB_DATABASE` | `None` | Required MongoDB database name. |
| `MONGODB_COLLECTION` | `autonomous_runs` | MongoDB collection name for run history. |
| `MONGODB_TASKS_COLLECTION` | `autonomous_tasks` | MongoDB collection name for task definitions. |
| `MONGODB_TRIGGER_INSTANCES_COLLECTION` | `trigger_instances` | MongoDB collection for webhook deduplication claims. |
| `TRIGGER_INSTANCE_TTL_DAYS` | `7` | Retention period for webhook deduplication claims. |
| `CHAT_HISTORY_PUBLISH_ENABLED` | `false` | Publishes cron and interval task activity into the UI's `conversations` / `messages` collections. Webhook tasks are always excluded. Requires `MONGODB_URI`. See *Chat History Integration*. |
| `CHAT_HISTORY_OWNER_EMAIL` | `autonomous@system` | Fallback owner for records without a task owner; current conversations use the task owner's email. |
| `CHAT_HISTORY_DATABASE` | `None` | Optional override of the chat database name when the UI's chat data lives in a different database than `MONGODB_DATABASE`. |
| `CHAT_HISTORY_CONVERSATIONS_COLLECTION` | `conversations` | Collection that the UI sidebar reads. |
| `CHAT_HISTORY_MESSAGES_COLLECTION` | `messages` | Collection that the UI message panel reads. |

---

### Per-task webhook secret storage

Per-task HMAC secrets use the same envelope-encryption pattern as the UI
credential store used by integrations such as Webex OAuth. Mongo stores an
AES-256-GCM ciphertext and a KMS-wrapped, one-time data key; it never stores
the plaintext secret. The task id is bound into both AES additional
authenticated data and the KMS encryption context, so an envelope cannot be
moved to another task.

If KMS is not configured or is unavailable, reads/writes involving a per-task
secret fail closed. Because every new UI webhook task has a per-task secret,
configure KMS before enabling webhook creation.

---

## Webhook Dispatch

Webhook requests are HMAC-verified through the selected provider adapter,
deduplicated through MongoDB, queued, and acknowledged with `202` plus a
preallocated run id. Duplicate deliveries return `200` with the original run
id. GitHub configuration pings are ignored without creating a run.

The request body is capped at 1 MiB by default. Each task has one process-local
FIFO consumer, so the same webhook never runs concurrently with itself.
Different tasks may run concurrently within the per-owner and global limits in
the configuration table above. Queue overflow returns `429` with
`Retry-After: 1`; dedup-store failure returns `503`.

The FIFO is not durable. A pod restart loses queued or running webhook work.
Edge rate limiting and WAF controls are still required for an internet-facing
receiver.

---

## Run History Persistence

MongoDB is required. Startup fails closed unless both `MONGODB_URI` and
`MONGODB_DATABASE` are configured and the connection succeeds within the
configured retry budget.

The service records one `TaskRun` document per execution and exposes it via
`GET /api/v1/runs` and `GET /api/v1/tasks/{id}/runs`. Each document is upserted
with `_id = run_id`: observers see `RUNNING` first and the same row later moves
to `SUCCESS` or `FAILED`. Current records include the request prompt, a
500-character preview, full final response, captured SSE events, error,
task owner, and webhook trigger-instance link when applicable.

MongoDB's automatic `_id_` index enforces run-id uniqueness. Two additional
indexes are created at startup:

- Compound `(task_id ASC, started_at DESC)` — backs the
  list-by-task query (`GET /tasks/{id}/runs`) without a collection
  scan.
- `started_at DESC` — backs the global list-all query
  (`GET /runs`). The compound index above leads on `task_id`, so
  Mongo will not use it for an unfiltered sort across tasks.

Run-history writes are best-effort observability: a write failure is logged but
does not abort an agent already executing.

---

## Chat History Integration

Chat publishing is disabled by default. When
`CHAT_HISTORY_PUBLISH_ENABLED=true`, cron and interval task lifecycle events
are mirrored into the UI's `conversations` and `messages` collections.
Webhook tasks are always excluded and appear only in the Autonomous page's
Run history.

| Document | Collection | Deterministic key | Notes |
|---|---|---|---|
| Conversation (1 per task) | `CHAT_HISTORY_CONVERSATIONS_COLLECTION` (default `conversations`) | `_id = uuid5("task:<task-id>")` | Stable across runs; `source: "autonomous"`, `task_id`, and the task owner's `owner_id` are set. |
| Run request | `CHAT_HISTORY_MESSAGES_COLLECTION` (default `messages`) | `run:<run-id>:request` | Prompt sent to the dynamic agent. |
| Run response/error | same | `run:<run-id>:response` | Running placeholder, full final response, or error. |
| Task lifecycle | same | Deterministic task/ack key | Creation intent and preflight acknowledgement. |

Conversation and message writes are idempotent upserts. When a run moves from
`RUNNING` to `SUCCESS` or `FAILED`, the same response message is updated in
place rather than duplicated.

The publisher is wired into `_publish_safely`, which mirrors
`_record_safely`: any exception inside the publisher is logged at
`ERROR` and swallowed. Chat-history outages can never abort a task or
prevent a run from being recorded in the canonical `RunStore`.

### UI access model

`/api/chat/conversations?source=autonomous` is a content filter only. It is
combined with the normal ownership and sharing query and cannot bypass
conversation authorization.

The sidebar shows three sections:

- **Autonomous Runs** with a violet task badge, collapsed by default.
- **Scheduled Runs** with a cyan schedule badge, collapsed by default.
- **History** for ordinary conversations.

### Disabling

`CHAT_HISTORY_PUBLISH_ENABLED=false` swaps in a no-op publisher. Runs completed
while publishing is disabled are not backfilled later.

---

## Task call reliability

Each task run makes a single streaming call to the dynamic-agents service.
That call is treated as a normal HTTP dependency: it can be slow, restart,
or briefly fall over. The streaming endpoint is deliberately **not** retried
-- SSE isn't safely resumable mid-flight. A transient blip fails the run
cleanly and the next scheduled fire is a fresh attempt.

How the streaming caller classifies failures:

| Failure mode | Outcome |
|---|---|
| Transport error (connect refused, DNS, read timeout) | Run recorded `FAILED` with a "did not respond" message. |
| HTTP 4xx / 5xx | Run recorded `FAILED` with the status and target agent. |
| In-band SSE `error` event | Run recorded `FAILED` with the streamed error. |
| Missing agent | Run recorded `FAILED` with an actionable message. |
| Owner no longer eligible or authorized for the agent | Run recorded `FAILED` and the task is automatically disabled until the owner explicitly re-enables it after access is restored. |

---

## Getting Started

### Prerequisites

- Python 3.13+
- [uv](https://docs.astral.sh/uv/)
- A running dynamic-agents service (see root [README](../../../../README.md))

### Install and Run Locally

```bash
cd ai_platform_engineering/autonomous_agents

# Install dependencies
uv venv --python python3.13 .venv
uv pip install -e .

# Configure
cp ../../.env .env
echo "DYNAMIC_AGENTS_URL=http://localhost:8001" >> .env
echo "MONGODB_URI=mongodb://localhost:27017" >> .env
echo "MONGODB_DATABASE=caipe" >> .env

# Run
uv run uvicorn autonomous_agents.main:app --port 8002 --reload
```

### Run with Docker

The image runs as the unprivileged `app` user (UID/GID `1001`) by
default — `USER app:app` is set in the Dockerfile, so the container
is already non-root without any extra runtime flags. The hardening
flags below add **defence in depth** (read-only filesystem, no new
privileges, dropped capabilities, resource limits) on top of that.

```bash
docker build -t autonomous-agents .

docker run \
  --user app:app \
  --read-only \
  --tmpfs /tmp \
  --security-opt=no-new-privileges \
  --cap-drop=ALL \
  --pids-limit=256 \
  --memory=512m --cpus=1 \
  -p 8002:8002 \
  -e DYNAMIC_AGENTS_URL=http://host.docker.internal:8001 \
  autonomous-agents
```

Notes:

- `--user app:app` is redundant with the image's `USER app:app` but
  documents intent. If you build with non-default `APP_UID` /
  `APP_GID` build args, use those numeric IDs (or just `app:app`,
  since the username resolves inside the container either way).
- `--read-only` is what makes `/app` effectively immutable at runtime.
  The application source files are root-owned with
  default 644 perms (the `app` user can read but not write them even
  without `--read-only`). Only `/app/.venv` is `app`-owned, and it
  isn't mutated during normal operation.
- `--security-opt=no-new-privileges` blocks setuid escalation even if a
  vulnerable binary somehow lands in the image later.
- `--cap-drop=ALL` is safe — uvicorn doesn't need any Linux capability
  to bind to `8002` (port > 1024).
- Drop `--memory` / `--cpus` for local dev; keep them for prod so a
  runaway agent prompt can't starve the host.

### API

Once running, the interactive API docs are at `http://localhost:8002/docs`.

| Endpoint | Description |
|---|---|
| `GET /health` | Service health + scheduler status |
| `GET /api/v1/tasks` | List all tasks and next scheduled run |
| `POST /api/v1/tasks` | Create a task; server generates its id and webhook secret when applicable |
| `GET /api/v1/tasks/{id}` | Get one task; webhook secrets are redacted to `has_secret` |
| `PUT /api/v1/tasks/{id}` | Update a task and hot-reload its runtime registration |
| `DELETE /api/v1/tasks/{id}` | Delete a task and its persisted task history |
| `GET /api/v1/tasks/{id}/runs` | Run history for a specific task |
| `POST /api/v1/tasks/{id}/run` | Manually trigger a task immediately |
| `GET /api/v1/runs` | Full run history across all tasks |
| `GET /api/v1/settings` | Non-sensitive runtime constraints used by the task form |
| `POST /api/v1/hooks/{task_id}` | Webhook endpoint for a task |

---

## Adding a New Task

Tasks are managed through the CAIPE UI's **Autonomous** page. Its authenticated
server-side `/api/autonomous` route forwards task creation to the service's
cluster-internal `POST /api/v1/tasks` endpoint. The user must belong to an
Autonomous-enabled team and must already have `can_use` access to the target
agent. Organization admins manage team eligibility under **Admin → Security &
Policy → Autonomous Enablement**; there is no per-agent enablement switch or
task-oversight page.

Each task must set a `dynamic_agent_id`; new definitions without one are
rejected. The server generates an immutable task id. No service restart is
required because create/update/delete operations hot-reload APScheduler or the
webhook runtime.

---

## Current Scaling Limitation

Keep the Helm deployment at one replica. APScheduler has no distributed
leader election, while webhook queues, limits, and task registrations are
process-local. Multiple replicas could double-fire scheduled tasks, run the
same webhook concurrently, and retain different task registries. The chart
therefore uses `replicaCount: 1`, a `Recreate` strategy, and no HPA.

The current implementation does not use a durable broker or separate workers.
See the [architecture guide](../../docs/docs/architecture/autonomous-agents.md)
for the complete current-state flow and limits.

---

## LLM provider / model

The model a task uses is part of the **dynamic agent** it targets
(`dynamic_agent_id`), configured in the dynamic-agents service. The
autonomous-agents service does not pick a model itself; the per-task
`llm_provider` field is a deprecated no-op retained only for backward
compatibility with older task definitions.

---

## Contributing

Follow the project-wide contribution guidelines in [AGENTS.md](../../../../AGENTS.md) and [CLAUDE.md](../../../../CLAUDE.md):

- Branch naming: `prebuild/feat/autonomous-agents-<description>`
- Commits: conventional commits + DCO sign-off (`git commit -s`)
- Lint before committing: `uv run ruff check src/`
