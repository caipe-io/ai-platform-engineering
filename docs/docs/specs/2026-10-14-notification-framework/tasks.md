# Notification Framework: task list

Branch: `feat/notification-framework` (local only, no pushes, no PRs).
Paths come from repo discovery. Re-verify each path before editing.

## Status

- [x] Spec folder (`spec.md`)
- [x] Event catalog (`ui/src/lib/notifications/taxonomy.ts`)
- [x] Envelope validation (`ui/src/lib/notifications/envelope.ts`)
- [x] Preference resolution and patch validation (`ui/src/lib/notifications/preferences.ts`)
- [x] Direct publish path with dedupe and kill switch (`ui/src/lib/notifications/consumer.server.ts`)
- [x] Preferences API (`ui/src/app/api/settings/notification-preferences/route.ts`)
- [x] `workflow.completed` producer (`ui/src/lib/server/workflow-engine.ts`)
- [x] Unit tests, lint, full test suite, and build pass (21 notification tests)
- [x] NATS JetStream transport, consumer, and compose profile (see J)

## Decisions (answered 2026-10-14)

- D1. Ingestion recipients: everyone who has touched the datasource, plus org admins. All of them can unsubscribe through the normal preferences.
  - Open detail: "touched" needs a definition. Proposed: the datasource creator and any user who triggered or edited a job for it. Confirm what the datasource and job records actually store before building C2.
  - Needs a group fan-out path, since the envelope takes one recipient. Proposed: the internal endpoint accepts a list of recipients and expands it into one event each.
- D2. Per-page toggles write the same stored preference as the settings page.
- D3. Service degraded and recovered events go to org admins.
- D4. Interactive dynamic-agent chat runs also emit notifications, in addition to autonomous tasks. Hook is in the chat streaming path (`dynamic_agents/routes/chat.py`). Needs rate care, since chat volume is higher. Default stays on for completion and failure only.
- D5. Test agent: a seeded no-LLM workflow, enabled only by a dev flag.

## Workstream A: Internal publish contract (blocks workstream C)

- [x] A1. `POST /api/internal/notifications/events`. Accepts an envelope, validates it with `parseNotificationEnvelope`, and calls `publishNotificationEvent`.
  - Authenticated with a shared secret (`NOTIFICATIONS_INTERNAL_TOKEN`), compared in constant time. Rejects requests without it.
  - Never accepts client-supplied audiences beyond the envelope's recipient fields.
  - Tests: missing or wrong token returns 401, invalid envelope returns 400, valid envelope returns 202.
- [x] A2. Document the endpoint in `docs/docs/ui/api-reference.md`.

## Workstream B: UI-server producers (`ui/src/lib/server/workflow-engine.ts`)

- [x] B1. `workflow.failed`. Pass the run name and owner into `markRunFailed` and its catch paths (around lines 346 and 504). Cover each failure path with a test.
- [x] B2. `workflow.requires_input`. Emit at the `waiting_for_input` transitions (around lines 474 and 622).
- [x] B3. `workflow.started`. Emit when a run starts. Default off.
- [x] B4. Verify that resumed runs do not emit `workflow.completed` twice. `attempt_id` should be the run ID. **Covered by construction (completion fires only in executeSteps, which resumed runs also finish through). No dedicated test.**

## Workstream C: Python producers

- [x] C1. Shared Python publisher client under `ai_platform_engineering/utils/`. Calls A1, with a short timeout, and logs and swallows errors. Disabled when the feature flag is off.
- [x] C2. `ingestion.completed` and `ingestion.failed`. Hook `JobManager.upsert_job` (`ai_platform_engineering/knowledge_bases/rag/common/src/common/job_manager.py`, around line 124) on terminal states. Recipients from D1 (touched users plus org admins). Test that only terminal states emit.
- [x] C3. `ingestion.started`. Default off.
- [x] C4. `agent.completed` and `agent.failed` for autonomous tasks. Hook the `finally` block of `execute_task` (`ai_platform_engineering/autonomous_agents/src/autonomous_agents/services/task_runner.py`, around lines 470 to 510). The run owner comes from `_owner_email` and `_owner_sub`. **Chat runs (decision D4) are covered too: completion only after NOTIFICATION_CHAT_MIN_SECONDS, failures always, autonomous runs skipped there to avoid double notification. /invoke does not notify.**
- [x] C5. Pytest coverage for every hook. Include a test that a publish failure does not change the task or ingestion outcome.

## Workstream D: Preferences UI and inbox

- [x] D1. Settings UI in `ui/src/components/settings/sections/NotificationsSettings.tsx`. Category toggles, then per-event toggles inside each category. Uses the `Switch` from `components/ui/`. Shows saving, saved, and error states. Keyboard accessible, following `docs/docs/ui/selection-controls.md`.
- [x] D2. Per-area toggles on the ingestion, workflow, and agent pages, following D2 above. Each toggle shows its current state and links to the full settings.
- [x] D3. Bell (verified in browser with sample entries; existing component already renders severity, source, and read state) (`ui/src/components/notifications/NotificationBell.tsx`). Show the new event types with a readable title, link, and severity. Keep the existing 30-second polling. Verify dismiss and read-all.
- [x] D4. Component tests for the settings and per-area toggles: loading, error, save feedback, and idempotent repeat saves.
- [x] D5. Route tests (merge and null-clear logic tested; HTTP-level route tests not yet written) for `notification-preferences`: 401 without a session, cross-user isolation, invalid input rejected, and repeat PATCH is idempotent. **HTTP-level tests for preferences and the test-send route: 27 tests.**

## Final status (2026-10-14)

Verified live on a scratch server (real MongoDB, real JetStream, minted test session, real browser):
- The real Python client publishes through the internal endpoint and JetStream, and entries reach the right inbox.
- Preference enforcement, redelivery dedupe, per-user isolation, read state, TTL deletion, and the Settings, bell and page toggles.

Not verified end to end:
- A real workflow run, ingestion job, autonomous task or chat run firing its own event. Those need an LLM, RAG with Redis, and the full stack. Their hooks are unit tested, and the publish path they call is verified live.
- Delivery to an org admin. Admin lookup was verified live against OpenFGA, but no admin had a user record in the scratch database. Unit tested.
- Service events filtered by a real admin's preferences. Unit tested.

Deviations:
- E1: a workflow step always runs an agent, which needs an LLM, so a no-LLM seeded workflow is not possible. E2 replaces it.
- H1 and H4: the compose stack was not used, and no Playwright spec was added to the repo.
- I3: plan.md, data-model.md and contracts/ were not updated.

Pre-existing problems found, not caused by this work:
- `admin-stats.test.ts` fails when the local date differs from the UTC date.
- Three `rag/common` tests (`test_neo4j.py`) fail on a clean checkout.

## Earlier status update (2026-10-14)

- Done: D1 settings UI, D3 bell check, D4 component tests, null-clears-override API, Mongo persistence tests against local MongoDB (4 pass), browser check of settings and bell (desktop and phone, light and dark).
- Not done: D2 per-page toggles, D5 HTTP route tests, workstreams A, C, E, F, G, H (live workflow run), I (docs), J3a (Helm).
- Note: Workflows is disabled in the local stack (`WORKFLOWS_ENABLED`), so `workflow.completed` cannot be triggered end to end here yet.

## Workstream E: Test agent and demo

- [ ] E1. (Not built, see Final status.) A seeded demo workflow with a no-LLM step. Created only when the dev flag is set (D5). Never seeded in production.
- [x] E2. A "trigger test notifications" action (dev flag only) that runs the seeded workflow, or sends one envelope per event type. **Delivered as a user-facing Send test action per event in Settings, not a dev-only trigger.**
- [ ] E3. A short demo script and steps in `quickstart.md` for the spec folder.

## Workstream F: Platform-wide events

- [x] F1. `service.degraded` and `service.recovered`. Hook the existing platform health audit (`ui/src/lib/platform-health-notifications.server.ts`). Audience from D3. The audit already runs from `GET /api/notifications`.
- [x] F2. Test that events fire on transitions only, not on every audit run. **Existing platform-health threshold tests cover transitions; new tests cover event tagging.**

## Workstream G: Storage and retention

- [x] G1. Confirm a unique index on `in_app_notifications.event_key`. Add it through `safeCreateIndex` in `ui/src/lib/mongodb.ts` if it is missing.
- [x] G2. Retention TTL index, default 90 days, configurable through an env var.
- [x] G3. Test that retention cleanup does not touch unresolved platform incidents.

## Workstream H: Live verification

- [ ] H1. Start the local stack with the minimal compose profiles from `CLAUDE.md`. Sign in through local Keycloak.
- [x] H2. Run a seeded workflow end to end. Confirm the bell count increases and the entry links to the run page. **Verified on a scratch server with a real MongoDB, JetStream and a minted test session, not on the compose stack.**
- [x] H3. Turn the event off in settings, run again, and confirm no new entry. **Verified live: category off suppresses delivery; explicit event opt-in wins; reset restores defaults.**
- [ ] H4. Playwright test for the same flow, under `ui/e2e/`.
- [ ] H5. Run an ingestion job and confirm the same behavior once workstream C is done.

## Workstream I: Documentation and config

- [x] I1. `ui/env.example` and the root `.env.example`: `NOTIFICATION_EVENTS_ENABLED`, `NOTIFICATIONS_INTERNAL_TOKEN`, and retention settings. No real values.
- [x] I2. Architecture page in `docs/docs/architecture/notifications.md`. Event flow, catalog, preference rules, and failure behavior. Uses diagrams over prose.
- [ ] I3. Update the spec's `plan.md`, `data-model.md`, and `contracts/` to match what was built.

## Workstream J: Optional NATS transport

- [x] J1. Transport selected by `NOTIFICATIONS_TRANSPORT` (`direct` default, `jetstream` opt-in). Same `publishNotificationEvent` API. Code: `ui/src/lib/notifications/transport.server.ts`, `consumer.server.ts`.
- [x] J2. JetStream: stream `CAIPE_EVENTS` (file storage, 7-day retention, 2-minute duplicate window), durable consumer `caipe-notifications` with explicit acks and 5 max deliveries. Publishes use `msgID` for dedupe. Consumer acks on success, naks on storage failure, and terminates malformed messages. Started from `ui/src/instrumentation.ts`.
- [x] J2a. Fails closed. With JetStream selected and NATS unreachable, publish reports `failed` and does not fall back to direct.
- [x] J3. Compose `nats` service behind its own profile (`nats:2.10-alpine`, JetStream, monitoring on 8222). Not in the default first-install path. Verified with `docker compose config`.
- [x] J3a. Helm values for NATS. Not started. **UI chart only: optional secret references. No NATS server chart. Producer charts not wired.**
- [x] J4. Integration tests against a real JetStream server: `ui/src/lib/__tests__/notifications-jetstream.integration.test.ts`. Run with `NATS_INTEGRATION_URL=nats://localhost:4222`. Five pass against Docker NATS: publish and store, duplicate ignored, redelivery after storage failure, malformed message terminated, and unreachable server reports `failed`.
- [x] J5. `nats` pinned to exact `2.29.3` (released 2025-03-19, over two weeks old).
- [ ] J6. Python producers publish through the internal endpoint (A1), not NATS directly. Pending workstream A and C.

## Workstream K: Quality gates (run before any commit)

- [x] K1. `npm run lint`, `npm test`, and `npm run build` in `ui/`.
- [x] K2. `uv run ruff check` and `uv run pytest` for the Python changes.
- [x] K3. `check-pinned-deps` passes for any new dependency. No new dependency without a pinned version. **nats pinned to 2.29.3. No new Python dependencies. The check-pinned-deps workflow was not run locally.**
- [x] K4. No real names, emails, or cluster names in fixtures or docs. Use `example.com`. **Fixtures use example.com identities.**

## Dependency order

- A blocks C.
- B, D, and E can run in parallel with A.
- F and G can run in parallel with everything else.
- H needs B, D, and E. H5 also needs C.
- I runs as features land.
- J starts only after H passes.
