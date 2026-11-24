---
sidebar_position: 7
title: Regression and Release Readiness
description: Maintained feature acceptance matrix, backward-compatibility cases, test adapters, and release evidence requirements.
---

# Regression and Release Readiness

This is the canonical, human-maintained feature acceptance matrix. `AGENTS.md`
routes "run E2E regression" and "check release readiness" to
`.agents/skills/caipe-regression-suite/SKILL.md`, shared with Claude Code through
the existing skills link.

Use the [screen, API and negative-test inventory](./caipe-regression-screen-coverage.md)
alongside this feature matrix. Its source-drift check inventories page routes and
API families; catch-all tabs, individual API methods and application-owned routes
still require explicit expansion. No fixed case count establishes exhaustiveness.

**This plan is not a claim that its cases are automated or have passed.** Reuse
the existing tests below, supplement missing assertions with live checks, and
record actual coverage for every run. A working catalog, healthy container, unit
test or mocked browser test does not prove a model, tool, workflow or bot works.

## Maintaining the matrix

- Keep case IDs stable. Add or strengthen cases in the same PR as a feature,
  compatibility change or bug fix; include the IDs in PR validation.
- Treat rows with several assertions as case groups. Maintain stable numbered
  assertion IDs such as `SEC-01.01` in the inventory's detailed case register;
  record prerequisites, steps, expected outcomes and evidence before execution.
  Undefined assertions are planning gaps, never automatic coverage credits.
- Retain legacy cases when adding a new runtime or replacing an implementation.
  Retire a case only with the product's documented removal/migration decision.
- Test the candidate's actual source and API/session contract. An older helper
  that cannot authenticate is a test-harness gap; do not weaken authentication.
- Keep current failures, issue links and run evidence in run reports. A new
  issue becomes a durable assertion here, rather than a permanent release label.
- Before extending a runner, inspect the owning component's tests and open PRs.
  Reuse its auth, streaming, fixture and cleanup contracts.
- Keep environments, identities, tokens and messaging destinations out of this
  reusable plan. Supply them through protected run configuration.

## Scope and execution records

Inventory enabled features **before** executing. `core` cases apply to every
full run. Declare optional profiles: `deepagents`, `sdk-remote`, `sdk-acp`,
`claude-code`, `agentcore`, `a2a`, `acp`, `app-assistant`, `rag`, `slack` and `webex`. A requested/enabled feature with missing prerequisites is
BLOCKED, not excluded. Record why a profile is disabled or outside scope and the
configuration evidence supporting that decision.

Expand each `RUN-*` case for **every enabled runtime**, using child IDs such as
`RUN-01/sdk-remote` and `RUN-01/deepagents`. For A2A/ACP, identify the protocol and
deployed adapter. For bots, repeat the required flows across the selected legacy,
remote and app-assistant bindings. One SDK reply cannot pass another runtime.
Expand ingestion cases per enabled source provider and supported document type;
one text source cannot qualify a workbook, attachment or meeting transcript.

Each assertion below is a separate result within its case. A case passes only
when all applicable assertions pass; one successful first turn is partial
coverage. Define expected capability denial for an unsupported operation before
testing it; do not invent exclusions after a failure.

| Status | Meaning |
|---|---|
| PASS | Required assertions executed successfully with the declared evidence kind |
| FAIL | An executed assertion contradicted expected behavior |
| BLOCKED | An applicable assertion could not run; record the exact dependency |
| NOT_RUN | Planned but not executed; never count as a pass |
| NOT_APPLICABLE | Feature absent/outside the declared scope, with reason and configuration evidence |

Separate evidence kinds: `live-browser`, `live-api`, `live-bot`, `CI`, `unit`,
`mocked-browser`, and `source-review`. Only actual execution against the target
passes a live case. Release-history and artifact/document checks use source/CI
evidence. Inspect test bodies: filenames and green workflow summaries are not
enough to determine which kind of evidence they provide.

## Core platform and backward compatibility

| ID | Profile | Required acceptance assertions |
|---|---|---|
| REL-00 | core | Repository skill discovery resolves to the maintained implementation; metadata, canonical links and prompt routing agree |
| REL-01 | core | Record baseline/candidate SHAs and image/chart digests; map every reachable commit, including merges, to cases; unresolved mappings remain visible |
| REL-02 | core | Matrix and detailed inventories build, appear in documentation navigation and preserve previously assigned case IDs |
| REL-03 | core | Source-drift validation passes for all current page routes and API families; inspect catch-all destinations, tabs, handlers and feature flags separately |
| REL-04 | core | Versioned run input generates deterministic offline HTML and a matching release summary; planned-but-missing cases stay NOT_RUN; counts, suite/verdict rollups, cleanup failures and sharing boundaries remain accurate |
| REL-05 | core | RC entries publish only after required artifact builds succeed for the tagged commit; incremental/full comparison baselines and install commands are exact; stable changelog rollups and latest aliases remain isolated from candidates |
| PRE-01 | core | Verify target, versions, personas and enabled-profile inventory; scope each case's model/tool, destination and cleanup prerequisites |
| DEP-01 | core | Verify UI/API/worker versions, readiness and critical routes; distinguish deployment health from functional execution |
| DEP-02 | core | Upgrade an isolated baseline with retained configuration/data; preserve existing models, catalogs, assistant bindings, credentials and volumes; verify rollback compatibility |
| DEP-03 | core | Validate minimal first install independently of upgrade; fresh defaults, sign-in and first real agent reply work without optional providers |
| SEC-01 | core | Exercise login, session renewal, logout and stale tabs; anonymous/invalid credentials are rejected; secrets stay redacted |
| SEC-02 | core | Remove inherited admin/identity membership on test identities; renewed sessions and direct APIs lose access; preserve independent intentional grants |
| FGA-01 | core | Verify exact expected and absent stale grants for create/share/downgrade/revoke/delete; check effective decisions and API enforcement for owner, member and outsider |
| MCP-01 | core | Private server owner executes a harmless tool; non-owner invocation is denied; no unintended team/global grants |
| MCP-02 | core | Shared-team member executes an allowed tool; outsider and unauthorized management are denied |
| MCP-03 | core | Global server follows its declared discover/use/invoke/manage policy for both admin and ordinary users |
| MCP-04 | core | Private/team/global/private transitions persist and immediately remove obsolete grants; timeout/auth/tool errors remain actionable |
| CRED-01 | core | Create a harmless marker credential; reads stay redacted; unauthorized metadata/use/manage is denied; cleanup removes owned references |
| CRED-02 | core | Team sharing and revoke enforce metadata/use/manage independently and remove stale grants |
| CRED-03 | core | Organization sharing permits only intended actions; rotation/revocation invalidates cached use without exposing values |
| AGT-01 | core | Private agent creation/edit/version/delete persist; owner executes; another user cannot discover/read/run/manage it |
| AGT-02 | core | Team agent member can discover/run but cannot manage; outsider is denied; owner/team-admin policy holds |
| AGT-03 | core | Global agent execution and management follow declared policy; exact global grants are present and revocable |
| AGT-04 | core | Selected MCP tools and credential bindings persist; an actual allowed tool executes with caller/agent identity after caller-token refresh, including existing chats; unavailable or unauthorized tools fail closed |
| MODEL-01 | core | Existing environment models still run; saved provider/model create/test/edit/reload works; credential revisions and revoked access invalidate cached clients |
| LEGACY-01 | deepagents | Capture a baseline-created SRE/Deep Agents chat; candidate resumes it with original runtime, context, tools and history; changing defaults does not silently migrate it |
| LEGACY-02 | deepagents | Existing saved agent definitions, MCP bindings and model settings execute after upgrade; explicit migration, if supported, preserves history and can recover from interruption |
| CHAT-01 | core | New chat retains selected agent/runtime; rename, history, navigation and deep-link reload preserve actual completed messages |
| CHAT-02 | core | Direct user view/edit sharing permits exactly the intended read/write actions; downgrade/revoke persists after reload and denies direct requests |
| CHAT-03 | core | Team view/edit sharing, downgrade and actual Remove controls persist; outsider/revoked user is denied in UI, API and live replay |
| CHAT-04 | core | Message ordering, concurrent viewers, feedback, retry and error recovery work without duplicate messages or producers |
| CHAT-05 | core | Archive/restore and permanent delete act only on owned fixtures; messages, runtime state and every conversation grant are cleaned; failed deletion remains visible |
| WF-01 | core | Run a baseline-created workflow on the candidate; preserve inputs, agent/tool bindings, variables, outputs and saved history |
| WF-02 | core | Create/edit/save/reload/run a disposable multi-step workflow; verify actual step outputs and data handoff using harmless tools |
| WF-03 | core | Exercise workflow interruption/approval/resume, failure, retry and cancellation; no duplicate tool side effects; unauthorized run/edit/share/revoke is denied |
| WF-04 | core | Create an owned schedule; verify timezone/next run and one bounded real invocation; disable prevents another run; delete cleans jobs and grants |
| SKL-01 | core | Discover/filter/preview/import or clone a safe skill; edit/save/reload/update/remove it; invalid/flagged packages fail without partial install |
| SKL-02 | core | Private/team/global skill access and revoke hold in catalog, direct API and execution; installed baseline skills survive upgrade |
| INT-01 | core | Existing connected-provider calls preserve caller scope; missing/expired/revoked connections produce an actionable denial without bypass credentials |
| OBS-01 | core | Health, audit and metrics agree with observed operations; mutations have attributable audit records without secrets |
| RBAC-01 | core | Non-admin admin surfaces and direct mutation APIs enforce their declared boundary; UI hiding alone is insufficient |
| UX-01 | core | Changed routes/tabs support direct URL, refresh/back, async search, empty/error states, keyboard focus and narrow viewport; no stale page links |
| QUAL-01 | core | Match tested SHA/digests to CI and publication; inspect skipped jobs and image scans; release/upgrade notes cover behavior changes and known limitations |
| CLEAN-01 | core | Manifest-only cleanup runs even on failure; verify resource absence, zero stale grants and no active runs/schedules; report any repair separately |

## Additional platform acceptance cases

These cases close named surface gaps; they do not replace the core or runtime
cases. Optional profiles below also include `autonomous`, `service-accounts`,
`notifications`, `native-app` and `performance`. Inventory availability and
authorization before choosing them. Configuration or recovery tests requiring
platform changes use an isolated deployment with explicit scope.

| ID | Profile | Required acceptance assertions |
|---|---|---|
| SEC-03 | core | Safe callback and deep-link redirects; CSRF/origin and security-header contracts hold; encoded external destinations and forged identity headers cannot grant access |
| SEC-04 | core | Enforce upload size/type, safe download names/headers and ownership; malformed files, markup, paths and unsafe fetch destinations fail without executing content or exposing secrets |
| IDN-01 | core | Test-team create/member add/remove/role change/delete enforce API policy; shared-team, outside-team, anonymous and cross-organization access remain distinct |
| IDN-02 | core | Directory-sync preview/apply/reconcile on isolated identities removes stale inherited access, preserves intentional grants and reports partial failures; service outage cannot widen permissions |
| IDN-03 | core | Secondary identity linking/unlinking and provider callback conflicts preserve the primary identity; foreign-account linking and replay are denied |
| SVC-01 | service-accounts | Create an owned machine identity scoped only to caller-accessible resources; secret is shown once; unauthorized creation or scope expansion is denied |
| SVC-02 | service-accounts | Actual token-authenticated model/tool/API requests enforce resource and caller scopes; list/read and invoke permissions remain distinct; expired/invalid tokens fail |
| SVC-03 | service-accounts | Scope reduction, key rotation, revoke and delete invalidate old access and cached clients; unrelated machine identities keep their grants; no secret appears in audit or responses |
| CRED-04 | core | Provider connection start/callback/test/disconnect and failed/expired state follow the deployed OAuth/PAT contract; ownership, CSRF and redaction hold without reconnecting existing users |
| MCP-05 | core | Catalog discovery, tool schema/pagination, supported transport/auth and connection retry work; schema changes, oversized output and unavailable tools yield bounded actionable errors |
| AGT-05 | core | Builder create/validate/run/cancel/save/history/rerun preserve owned definitions and inputs; invalid schemas, inaccessible agent/tool/model references and foreign history cannot execute |
| WF-05 | core | Workflow configuration, run history, variables and delegation enforce private/team/global policy where supported; snapshots and scheduled runs cannot retain revoked caller access |
| SKL-03 | core | Configured hubs/templates import only permitted sources; file/version/scan views, scan overrides and update conflicts enforce roles; traversal, flagged archives and scanner failure cannot install partial unsafe state |
| SKL-04 | core | Owned catalog API key creation returns its value once; metadata stays redacted; actual catalog reads respect declared key scope; foreign-key management, widened scope and revoked-key reuse are denied |
| CHAT-06 | core | Supported file/image attachment uploads reach the intended runtime, survive reload and are accessible only to permitted readers; unsupported formats, oversize files and foreign file IDs fail clearly |
| CHAT-07 | core | Declared memory/checkpoint behavior preserves intended same-chat context and scoped cross-thread memory; another user's marker never appears; history/deletion follow the documented retention contract |
| POL-01 | core | AI Review configuration and enforced allow/block/approval outcomes agree in UI, direct APIs and runtime tool admission; failure and bypass attempts cannot silently execute a blocked action |
| POL-02 | core | Publication request submit/review/approve/reject/withdraw and notification state persist for supported resources; self-approval, stale decisions and unauthorized publication are denied |
| POL-03 | core | Policy preview and enforcement agree for ordinary users, admins, scoped accounts and View as; malformed/unavailable policy evaluation fails according to the documented boundary |
| SET-01 | core | Personal appearance/chat/features/notification/default-agent preferences save independently, survive reload and remain user-scoped; failed autosave rolls back with an actionable error |
| SET-02 | core | Platform defaults, announcements and feature/navigation settings enforce admin policy; personal/channel default precedence and missing-agent fallbacks hold; View as cannot mutate |
| SET-03 | core | First-user setup/tour/onboarding completion and dismissal persist; unauthorized setup APIs and repeat submissions cannot reset another user's state or overwrite platform resources |
| AUTO-01 | autonomous | Disposable task create/edit/manual run/pause/delete preserve agent, allowed tools, execution identity and conversation link; invalid/foreign task operations fail without partial state |
| AUTO-02 | autonomous | Approved fixture webhook verifies signature/secret, timestamp and declarative filters; replay, malformed/oversized payloads, mismatched task identity and KMS/secret failures cannot trigger execution |
| AUTO-03 | autonomous | Cron/timezone, enable/disable and one bounded trigger produce the intended run; missed/overlapping schedules, restart and delivery retries follow declared policy without duplicate side effects |
| AUTO-04 | autonomous | Trigger-instance state, logs and streamed history remain correlated after reconnect/restart; error/cancel/retry and follow-up handling cannot attach another task's run |
| NOTIF-01 | notifications | Real allowed events create the correct recipient's in-app notification; unread counts, pagination, mark-read and safe deep links persist; other users cannot read or update it |
| NOTIF-02 | notifications | Preferences, severity/channel filters, deduplication and approved Slack/Webex delivery behave as configured; opt-out and invalid destinations prevent delivery; retries do not duplicate actions |
| NOTIF-03 | notifications | App-scoped notification publishing validates declared capability, recipient and installation scope; disabled/foreign apps, forged publisher identity and unsafe action links are denied |
| OBS-02 | core | Audit queries/filtering/pagination and actor/object/run correlation match real success/failure; storage or writer failure is visible; private prompts, credentials and another tenant's records stay concealed |
| OBS-03 | core | Insights/statistics/feedback date ranges and aggregation match disposable fixture operations; feedback edits and raw activity enforce ownership and admin policy |
| DEP-04 | core | Isolated mixed host/app/worker versions and migration interruption preserve compatibility or reject unsupported combinations visibly; compatible restore/revert recovers stored catalogs, bindings and grants |
| DEP-05 | core | Isolated dependency outage/restart and interrupted persistence exercise bounded retries, readiness recovery, event/checkpoint durability and producer fencing without acknowledged-data loss |
| PERF-01 | performance | Approved isolated baseline measures bounded login/catalog/chat/tool/replay latency, concurrency and resource growth; record workload, percentiles and error rate against declared budgets, without load-testing shared users |

## Runtime matrix

Apply **each row** separately to Deep Agents, SDK Remote, SDK ACP, Claude Code,
AgentCore, A2A, ACP and app assistants enabled for the target. Record the real
worker/profile and immutable conversation binding, rather than trusting the
agent's text about its runtime.

| ID | Profile | Required acceptance assertions |
|---|---|---|
| RUN-01 | each runtime | Real model reply; follow-up recalls a unique marker; one approved tool call has successful execution evidence; result persists after reload |
| RUN-02 | each runtime | Reload/reconnect during a running tool; attach another authorized viewer; recover the same run with ordered replay and exactly one producer |
| RUN-03 | each runtime | Stop, reload while stopping, then send another turn; cancellation waits for the local producer to release its session even if terminal status is already persisted; workers drain and uncertain admission does not duplicate a run |
| RUN-04 | each runtime | Exercise supported form/approval interrupt and typed resume/rejection; invalid resume and read-only send/stop are denied |
| RUN-05 | each runtime | Execute an attached safe skill and verify its output marker; baseline skill instructions and tool scope survive restart/reload |
| RUN-06 | each runtime | Exercise supported attachments/subagents or the declared rejection; delegation uses the saved child runtime and caller's allowed tools, without flattening or scope expansion |
| PROFILE-01 | sdk-remote/sdk-acp/claude-code | Operator profile create/edit/test/rename/conflict/disable follows permissions; secrets are redacted; existing chats keep their assigned profile |
| REMOTE-01 | a2a/acp | Discover/read/test remote card; preserve declared protocol and auth; unsupported versions, unsafe destinations and unavailable endpoints fail clearly |
| ROUTE-01 | deepagents | Test new-chat Engine routing, existing native binding and explicit migration separately; outages fail according to the documented provenance policy |

## Knowledge, apps and integrations

| ID | Profile | Required acceptance assertions |
|---|---|---|
| KB-01 | rag | Ingest a tiny unique marker from an allowed source; final indexed results are searchable; owner/team/outsider policy and source deletion hold |
| KB-02 | rag | Custom search tool grants follow private/team/global transitions; selected KB and source permissions are enforced on actual calls |
| KB-03 | rag | Failed ingest request and per-document processing failure preserve retryability; checkpoint/job completion matches indexed documents, not HTTP acceptance alone |
| KB-04 | rag | Collections and graph query/expand/reset/deep-link honor source/collection permissions; disabled graph, foreign entity, malformed cursor and backend outage reveal no hidden content |
| KB-05 | rag | Ingestion source create/update/status/retry/cancel/delete and incremental deduplication work per provider/document type; credential expiry and partial extraction remain visible and retryable |
| KB-06 | rag | Retrieval filter/rerank/citation/source opening stay grounded and scoped; empty/no-match queries, deleted sources and publication transitions cannot return revoked content |
| APP-01 | app-assistant | Launch existing and fresh iframe/native app declarations; sign-in/context, base paths, deep links, frame boundaries and disabled-app denial hold |
| APP-02 | app-assistant | Existing assistant binding and chat data survive upgrade; app launcher, regular chat and bot entry points select the intended authorized assistant |
| APP-03 | app-assistant | Manifest installation validates selected UI profile, version and exclusive route/slot/API ownership; legacy manifests migrate explicitly; duplicate claims, invalid capability requests and disabled installation fail safely |
| APP-04 | native-app | Trusted native module/descriptor versions match; host navigation, styles, context, slots and API base paths work; invalid packages, missing exports and declared server hooks are rejected by publisher/host checks |
| APP-05 | app-assistant | Gateway forwarding enforces app-scoped identity, allowed methods/paths and caller access; forged headers, unsafe targets, foreign app tokens, cancellation and upstream failures preserve the boundary |
| APP-06 | app-assistant | Inventory each installed app's virtual routes/tabs and service-only/UI-only/hidden modes; legacy bookmarks, query state, viewport scrolling and direct unauthorized requests follow its declared contract |
| SLACK-01 | slack | Real approved DM and channel mention receive complete replies; thread follow-up retains context; messages map to persisted host conversations |
| SLACK-02 | slack | Repeat legacy, remote-runtime and app-assistant routing; existing thread binding survives default/preference changes and reconnects |
| SLACK-03 | slack | Real form/tool approval and rejection resume correctly through the deployed BFF; timeout/cancellation and retry do not duplicate replies/actions |
| SLACK-04 | slack | Linked-user, channel/team and tool access are enforced; unlinked/revoked users and unmapped channels cannot execute; restore fixture-only preferences/routes |
| WEBEX-01 | webex | Real approved 1:1 and space mention receive complete replies; thread follow-up retains context and persisted host history |
| WEBEX-02 | webex | Repeat legacy, remote-runtime and app-assistant routing; existing threads survive default/preference changes and reconnects |
| WEBEX-03 | webex | Exercise supported attachments, form/approval, stop/retry and provider failures; verify real delivery, processing and typed resume |
| WEBEX-04 | webex | Linking/unlinking, user/space/team permissions and revocation enforce UI/API/bot access without changing existing users' connections |

## Composing external application suites

This public repository owns CAIPE platform behavior and generic external-app
contracts. Application-specific test definitions, fixtures, source adapters and
findings belong in each application's owning repository. The core suite and its
CI must remain usable without access to private applications.

For a user-requested integrated deployment regression:

1. Discover installed apps and the requested scope from authorized deployment
   metadata and environment-owned run configuration. Resolve each app's test-plan
   and skill location in its own repository; keep those pointers outside this
   public source. Reuse access and target authorization already given.
2. Read the host and requested app plans independently, record their actual
   candidate/plan revisions and expand their cases. Run compatible owning tests
   and explicit host/app boundary assertions; do not copy application features
   into the platform matrix.
3. Keep a run index with namespaced case IDs and separate host/app evidence and
   verdicts. Reuse shared preflight evidence by reference only where it proves
   the actual assertion. Missing requested app coverage is BLOCKED and prevents
   an integrated GO; it does not turn a host-only release into an app dependency.
4. Store restricted app definitions and detailed combined results privately.
   Public reports contain only intentionally sanitized host-contract evidence.
   Label host-only scope explicitly so it cannot imply application sign-off.

The operator or integrator supplies the composition; CAIPE does not hardcode an
application repository or require a private skill to run its own regression.

## Existing test adapters and prior art

These are starting points, **not automatic coverage credits**. Inspect their
current implementation and prerequisites before use.

| Existing location | Reuse | Coverage limit |
|---|---|---|
| `tests/rbac/rbac-matrix.yaml`, `scripts/validate-rbac-matrix.py` | Detailed resource/action/persona policy matrix and lint | Complements this feature plan; does not prove real UI, model or bot behavior |
| `ui/e2e/rbac/README.md`, `ui/playwright.rbac.config.ts` | Existing browser setup and domain specs | Inspect mocks, session helpers and opt-in flags per spec |
| `tests/harness_engine/live_e2e.py`, `browser_e2e.cjs` | Real BFF/Engine lifecycle and browser adapters | Require isolated identity/model fixtures; inspect provisioning and cleanup before a shared deployment |
| `ui/e2e/rbac/workflows-rbac-regression.spec.ts`, `workflow-agent-user-delegation-live.spec.ts` | Workflow policy/delegation assertions | Neither filename establishes full multi-step/scheduled live acceptance |
| `ui/e2e/rbac/skills-catalog-auth.spec.ts` and component/runtime tests | Skill scope and parsing contracts | Real attached-skill execution still needs RUN-05 per runtime |
| `tests/rbac/end_to_end/test_slack_dm.sh`, `test_webex_1to1.sh` | Provider preference/dispatch scenarios with manual checkpoints | Scripts alter saved preferences and require isolated accounts; Enter alone is not bot evidence |
| `tests/test_bot_harness_gateway.py` and integration-specific tests | Bot request/event contracts and transport selection | Mocked contract tests do not replace actual messages, approvals or attachments |
| `ui/e2e/rbac/service-accounts.spec.ts`, `ui/src/app/api/admin/service-accounts/__tests__/` | Machine identity lifecycle, ownership, scopes and token contracts | Verify actual token issuance and scoped tool invocation separately |
| `ui/e2e/rbac/identity-sync-regression.spec.ts`, `ai-review-block.spec.ts`, `audit-log.spec.ts` | Identity, policy and audit browser assertions | Inspect request mocks and target state before counting live coverage |
| `ai_platform_engineering/autonomous_agents/tests/`, `ai_platform_engineering/scheduler/tests/` | Webhook, encryption, trigger-instance, schedule and dispatch contracts | Actual fixture event delivery, execution, restart and cleanup need live evidence |
| `ui/src/app/api/catalog-api-keys/__tests__/`, `ui/src/components/settings/__tests__/` | Catalog key and preference contracts | Token use, real notification delivery and cross-session persistence need live checks |
| `scripts/validate-regression-inventory.mjs` and its `.test.mjs` | Route/family drift, case references and stable assertion definitions | Static planning gate; no handler-level, model, bot or authorization execution |
| `scripts/render-regression-report.mjs` and its `.test.mjs` | Structured report validation, computed dispositions/verdicts and portable HTML/Markdown artifacts | Renders collected evidence; cannot execute tests, discover omitted plan cases, redact content or publish a release |
| `.claude/skills/{docker-compose-first-install,integration-testing,streaming-testing}` | First install, legacy routing and stream comparison procedures | Use only matching environments/contracts; do not run old fixed-port instructions blindly |

This plan uses stable IDs, commit mapping, role-negative checks, evidence and
bounded cleanup. It adds explicit runtime, legacy, skill, workflow and bot execution so
those areas cannot disappear inside a generic catalog or health result.

## Safe execution and failure containment

- Reuse the user's chosen target/browser and authorization already in the task.
  Verify displayed identities. Use owner/member/outsider roles only where needed.
- Use uniquely prefixed fixtures, an ID manifest written before dependent
  mutations, neutral markers, allowed models and harmless tools. Do not run a
  provisioning workflow against real infrastructure as a smoke test.
- Use baseline-created disposable fixtures or an isolated restored environment
  for compatibility tests. Do not mutate unrelated existing chats or workflows.
- Verify the persisted resource, exact grants, effective decisions and direct API
  enforcement for each sharing transition. Capture screenshots for UI assertions
  and request/stream/log evidence for backend assertions; redact credentials.
- Never reconnect a user's existing provider, expose signing keys, deploy a fix
  or change platform policy as an implicit part of testing.
- On an access/cleanup failure, preserve evidence and clean affected fixtures.
  Pause dependent cases; continue independent safe cases when scope permits.
  Stop all writes for an uncontrolled leak, exposed secret or unbounded impact.
- Delete children before parents; verify resource absence, inactive workers/jobs
  and zero object grants. Manual residue repair is recorded separately and does
  not turn a failed automatic-cleanup assertion into a pass.

## Run report and release decision

Store run artifacts outside tracked source, using a unique run directory. Include:

- Target, timestamp, baseline/candidate revisions and actual image/chart versions;
  enabled profiles, chosen subset and the complete commit-to-case ledger.
- Personas/role relationships and approved messaging destinations in protected
  environment-owned records; no session credentials in the report.
- One record per applicable case/runtime and each assertion, with **planned,
  executed and remaining counts**. List every excluded case with its reason.
- Status, evidence kind, exact observed result, artifact references and current
  issue/fix links; distinguish reproduced failures from source-reviewed risks.
- Fixture IDs and cleanup results, including failures and manual remediation.

### Full matrix disposition

Every run report must include a readable table with the columns below, alongside
its structured assertion records. Include **every matrix case**, expanding runtime,
provider and context rows; show NOT_APPLICABLE rows with their exclusion reason.
Use the same records for both outputs so their statuses and counts agree.

**BLOCKED and NOT_RUN rows are uncompleted coverage, even when a read-only or
first-turn portion passed. They are not successful end-to-end tests.**

| ID | Capability / runtime / context | Status | Detail | Evidence |
|---|---|---|---|---|
| RUN-01/sdk-remote | Model, follow-up, tool and persisted history / SDK Remote | NOT_RUN | Required assertions have not been executed in this run | None yet |
| WF-02 | Multi-step workflow execution | NOT_RUN | Required assertions have not been executed in this run | None yet |

Replace these illustrative rows with the complete run inventory. In each detail
cell, state which assertions passed, failed or remain unexecuted and why. Link
each available screenshot, request/stream trace, persisted-state check or ledger;
explain missing evidence rather than leaving a successful-looking empty cell.

Roll up assertion results without hiding failures: any failed assertion makes
the case FAIL, even if other assertions are blocked or unexecuted. Otherwise,
any blocked assertion makes it BLOCKED; remaining unexecuted assertions make it
NOT_RUN. PASS requires every applicable assertion to pass. NOT_APPLICABLE requires
an explicit scope/capability reason, not an execution problem.

Summarize case counts by all five statuses, applicable planned cases, fully
executed cases, and remaining coverage. Count assertion execution separately:
PASS/FAIL assertions executed; BLOCKED/NOT_RUN assertions did not. A partially
executed FAIL or BLOCKED case is not a fully executed case. Include the resulting
release verdict and unresolved issue/blocker references.

For cleanup, distinguish **automatic product cleanup** from **final fixture
residue after manual repair**. A failed automatic-cleanup assertion remains FAIL
when manual remediation leaves zero residue; report both outcomes explicitly.

Use the versioned [report artifact contract](./regression-report-artifacts.md)
for structured records and generation of `report.html` plus `report-summary.md`.
Declare the complete expanded plan before execution; the renderer fills missing
results as NOT_RUN and derives totals/verdicts from assertion and cleanup records.
Keep source JSON and evidence with the report so release attachments remain
inspectable. Rendering is not live execution or authorization to publish.

| Verdict | Requirement |
|---|---|
| GO | All required in-scope live assertions pass on the matching candidate; artifacts, upgrades/docs and cleanup are verified |
| CONDITIONAL | Only explicitly accepted, bounded noncritical risks remain; name approver, scope and follow-up; never relabel a failed/skipped test PASS |
| NO-GO | Critical authorization/data-integrity/cleanup failure, candidate drift, or required coverage is failed, blocked, unexecuted or supported only by mocks |

For readiness reviews, verify issue/fix status and whether the fix is actually
included in the candidate; distinguish pre-existing defects from new regressions.
Inspect CI jobs and skipped scans, not just a green workflow summary. Record the
current healthy baseline and a compatible promotion-revert plan. A smoke-only run
must never be reported as full backward compatibility or stable-release sign-off.
