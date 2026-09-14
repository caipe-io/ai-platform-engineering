# caipe-scheduler

Cron schedule registry + Kubernetes `CronJob` orchestrator. Receives schedule
requests from Dynamic Agents through the scheduler MCP, validates them,
persists them to Mongo, and creates per-schedule `CronJob`s from a hard-coded
podTemplate. It also dispatches delayed one-off `Job`s from those CronJob
templates for retries and explicit schedule exceptions.

## Trust model

| Component        | Can do                                               | Cannot do                                  |
|------------------|------------------------------------------------------|--------------------------------------------|
| `dynamic-agents` | HTTP POST to scheduler-svc                           | Touch k8s API, mount secrets, choose image |
| `caipe-scheduler`| Create/delete `CronJob`s and delayed one-off `Job`s from hard-coded podTemplate | Run arbitrary containers (template baked)  |
| `caipe-cron-runner` (per fire) | Read the scheduler service token; POST chat API | Talk to Mongo or k8s API           |

The podTemplate lives in `caipe_scheduler/k8s.py` - only the `schedule`,
`timeZone`, and `SCHEDULE_ID` env are user-controlled.

## Endpoints

```
POST   /v1/schedules                  - create
GET    /v1/schedules?agent_id=...       - list for authenticated owner
GET    /v1/schedules/{id}             - single
PATCH  /v1/schedules/{id}             - enable/disable, change cron/tz/msg
DELETE /v1/schedules/{id}             - remove (Mongo + CronJob)
POST   /v1/schedules/{id}/one-off-runs - create delayed one-off fire
GET    /v1/schedules/{id}/one-off-runs - list delayed one-off fires
POST   /v1/schedules/{id}/runs        - runner reports status (status/error/http_status)
GET    /v1/internal/schedules/{id}    - runner schedule lookup
POST   /v1/admin/reconcile-cronjobs   - dry-run/apply runner image refresh for existing CronJobs
GET    /v1/settings                   - non-sensitive deployed scheduler limits
GET    /healthz
```

New schedules require a human-readable `title`. They may also include an
`attributes` JSON object for small UI display labels and an optional
`edit_agent_id` that tells UIs which agent should handle user-initiated edits.
Domain-specific display context belongs in `attributes`; the scheduler does
not interpret it.

Recurring schedules must leave at least `MINIMUM_SCHEDULE_INTERVAL_SECONDS`
between fires (`1800`, or 30 minutes, by default). The scheduler enforces this
on both creation and cron edits before changing MongoDB or Kubernetes.

All but `/healthz` require `X-Scheduler-Token: <SCHEDULER_SERVICE_TOKEN>`.
User-owned create/list/get/patch/delete and one-off endpoints additionally
require a caller bearer. The service validates that JWT and derives immutable
`owner_sub`; ownership is not accepted in request bodies. Internal runner and
admin endpoints use only the service token.

`PATCH /v1/schedules/{id}` with `{"enabled": false}` pauses a schedule by
setting Mongo `enabled=false` and Kubernetes `CronJob.spec.suspend=true`.
`{"enabled": true}` resumes future fires with `spec.suspend=false`. The
cron-runner also checks `enabled` after fetching the schedule and exits without
posting chat for recurring fires if the schedule is disabled, which protects
against manual k8s/Mongo drift. Pausing does not kill a Job that is already
running.

`POST /v1/schedules/{id}/one-off-runs` stores a UTC `run_at` (or
`delay_minutes`) in Mongo. The scheduler pod wakes near the due time, claims
pending one-offs atomically, and creates a normal Kubernetes `Job` by copying
the parent CronJob's `jobTemplate`. One-off Jobs are independent of the parent
schedule's `enabled` state: they still dispatch and run when the recurring
CronJob is paused, as long as the parent schedule and CronJob template still
exist. One-offs may carry an optional small `metadata` object into
`SCHEDULED_RUN_METADATA` and the chat `client_context`; this supports domain
retries and explicit exceptions without teaching the scheduler domain logic.

On startup, the scheduler automatically checks every persisted schedule CronJob
and patches only the runner image and pull policy in future `jobTemplate`s when
they differ from `CRON_RUNNER_IMAGE` and `CRON_RUNNER_IMAGE_PULL_POLICY`. The
operation is idempotent and isolates per-CronJob failures. Successful image or
pull-policy changes are recorded in the schedule's change history.

`POST /v1/admin/reconcile-cronjobs` remains available as an operator fallback.
Use `{"dry_run": true}` to inspect drift and `{"dry_run": false}` to repair it.

## Run locally

```sh
uv sync
SCHEDULER_SERVICE_TOKEN=devtoken \
MONGODB_URI=mongodb://admin:changeme@localhost:27017/caipe?authSource=admin \
caipe-scheduler
```

For dev without a real cluster, `kubernetes.config.load_kube_config()` is
attempted - point your `KUBECONFIG` at a kind/minikube cluster.
