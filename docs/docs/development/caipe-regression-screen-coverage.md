---
sidebar_position: 8
title: Screen, API and Detailed Case Coverage
description: Maintained route and API-family inventory, numbered assertions, negative dimensions and source-drift validation.
---

# Screen, API and Detailed Case Coverage

Use this inventory with the [feature matrix](./caipe-regression-suite.md). A feature
row can contain multiple assertions: its ID is a stable group, not evidence of a
single completed E2E test. Expand groups into maintained assertion records and
report each applicable runtime/persona/provider/context separately.

## Source inventory gate

```bash
node scripts/validate-regression-inventory.mjs
node --test scripts/validate-regression-inventory.test.mjs
```

CI compares the tables below with current `ui/src/app/**/page.tsx` routes and
`ui/src/app/api/**/route.ts` top-level families. It rejects missing/stale entries,
duplicate IDs/routes and references to undefined feature cases. This is a **plan
completeness check**, not execution evidence. It does not inspect every API method,
catch-all destination, backend-only endpoint or installed app's own repository.

For every release, enumerate those children from the candidate source and API
contracts, map each changed behavior to assertions, and record unresolved mappings.
A new handler inside an existing family still requires review even if this gate
passes. Record actual enabled profiles, inherited settings, roles and app versions.
Optional controls absent by design receive an explicit NOT_APPLICABLE reason;
missing prerequisites for enabled controls are BLOCKED.

## Required personas and expansion

- Fixture owner/admin; independent shared-team ordinary user; outside-team user.
- Anonymous and invalid/expired session; scoped machine identity where enabled.
- Additional organization only for isolated, authorized cross-organization tests.
- Declared supported browsers and desktop/narrow viewport; use the user's chosen
  real browser sessions for live acceptance and label automated engines accurately.
- Each runtime, model/provider, source/document type and bot destination/context
  required by the feature matrix. One member cannot substitute for an outsider.

## Page route inventory

Keep existing SCR IDs when paths persist. Verify navigation, direct URL, reload,
back/forward, loading/empty/error states, keyboard focus and direct API enforcement
for every applicable row. Each row maps to feature cases plus the dimensions below.

| ID | Route | Feature cases | Positive assertion | Negative assertion |
|---|---|---|---|---|
| SCR-001 | `/` | SET-01, SET-03, DEP-01 | Correct enabled home cards and navigation | Anonymous and disabled capabilities disclose no privileged data |
| SCR-002 | `/admin` | RBAC-01, SET-02, OBS-01 | Permitted category and default destination load | Ordinary users cannot invoke privileged mutation APIs |
| SCR-003 | `/agent-builder` | AGT-05 | Create, validate, run, cancel and save an owned definition | Invalid schema or foreign agent/tool cannot execute |
| SCR-004 | `/agent-builder/history` | AGT-05 | Owned history and rerun retain inputs | Foreign/missing run cannot disclose inputs |
| SCR-006 | `/apps` | APP-01, APP-03 | Installed permitted applications launch | Hidden/disabled/uninstalled entries follow direct-access policy |
| SCR-011 | `/apps/embed/[appId]` | APP-01, APP-05 | Frame context, navigation and scoped requests work | Foreign app tokens and unsafe targets are denied |
| SCR-012 | `/chat` | CHAT-01, SET-01 | Accessible default agent and new/resumed chat work | Missing default and removed agent recover safely |
| SCR-013 | `/chat/[uuid]` | CHAT-01, CHAT-02, CHAT-03, CHAT-04, CHAT-05, CHAT-06, CHAT-07 | Owner and shared reader/writer receive intended capabilities | Revoked/foreign readers cannot replay or mutate |
| SCR-014 | `/credentials` | CRED-01, CRED-02, CRED-03, CRED-04 | Owned secrets and connections have correct lifecycle | Foreign credentials and callback forgery disclose no secret |
| SCR-015 | `/dynamic-agents` | AGT-01, AGT-02, AGT-03, AGT-04 | Owned agent lifecycle and real execution work | Viewer/outsider and invalid bindings cannot mutate or execute |
| SCR-016 | `/insights` | OBS-03 | Permitted aggregates and ranges match fixture events | Raw foreign activity and privileged aggregates remain private |
| SCR-017 | `/knowledge-bases` | KB-01, KB-04 | Redirect to the first permitted enabled knowledge view | No-access and disabled features do not leak gated navigation |
| SCR-018 | `/knowledge-bases/graph` | KB-04 | Query, expand, reset and deep-link allowed entities | Disabled graph, foreign entities and malformed IDs fail safely |
| SCR-019 | `/knowledge-bases/ingest` | KB-01, KB-03, KB-05 | Create, monitor, retry and delete a marker source | Search-only users, invalid credentials and duplicates cannot bypass policy |
| SCR-020 | `/knowledge-bases/mcp-tools` | KB-02 | Create and actually call an allowed search tool | Revoked or foreign tool calls are denied |
| SCR-021 | `/knowledge-bases/search` | KB-06 | Scoped search, citations and source opening work | Revoked/deleted sources and malformed filters reveal no content |
| SCR-022 | `/login` | SEC-01, SEC-03 | Real SSO and safe callback return to requested route | External callback, stale state and forged identity cannot authenticate |
| SCR-023 | `/logout` | SEC-01 | Session clears across UI, API and stale tabs | Back navigation and replay cannot restore revoked access |
| SCR-024 | `/projects` | APP-06 | Project compatibility entry resolves through installed app contract | Unavailable app and foreign project fail safely |
| SCR-029 | `/schedules` | WF-04, AUTO-03 | Create, validate, observe one invocation, disable and delete | Foreign owner, invalid timezone and revoked identity cannot execute |
| SCR-030 | `/skills` | SKL-01, SKL-02 | Discover, filter, preview and install allowed skill | Private/foreign and flagged packages cannot install |
| SCR-031 | `/skills/editor` | SKL-01, SKL-03 | Legacy editor resolves to owned workspace | Crafted query and foreign ID cannot edit |
| SCR-032 | `/skills/gateway` | SKL-03 | Configured source discovery and permitted installs work | Unsafe/disallowed sources and non-admin changes are denied |
| SCR-033 | `/skills/scan-history` | SKL-03 | Owned scan status/findings/report links agree | Foreign scans and scanner errors do not leak content |
| SCR-034 | `/skills/workspace/[id]` | SKL-01, SKL-02, SKL-03 | Files, tools, versions, scan and unsaved edits work | Built-in/foreign edits, traversal and stale saves fail safely |
| SCR-035 | `/unauthorized` | SEC-01, RBAC-01 | Stable denial and safe support navigation | No privileged details; denied APIs remain denied |
| SCR-036 | `/workflows` | WF-01, WF-02, WF-03, WF-05 | Owned definition and sharing lifecycle persist | Viewer/outsider and invalid steps cannot mutate/run |
| SCR-037 | `/workflows/run/[id]` | WF-01, WF-02, WF-03, WF-05 | Actual inputs, step handoffs, history and cancellation work | Foreign/disabled workflow and stale permissions cannot execute |
| SCR-038 | `/admin/[...path]` | RBAC-01, SET-02, IDN-01, IDN-02, SVC-01, POL-01 | Every registered admin destination and subview deep-links | Unknown destinations and privileged direct API requests are denied |
| SCR-039 | `/agentic-app-routes/[appId]/[...path]` | APP-03, APP-05, APP-06 | Owned host route resolves to installed app with query state | Route collision, disabled app and traversal cannot bypass gateway |
| SCR-040 | `/apps/[appId]/[[...path]]` | APP-01, APP-02, APP-06 | Each installed app virtual route survives refresh/back | Unauthorized nested route and foreign resource ID fail safely |
| SCR-041 | `/autonomous` | AUTO-01, AUTO-02, AUTO-03, AUTO-04 | Owned tasks/triggers/runs and pause/delete work | Foreign task, invalid webhook and disabled automation cannot run |
| SCR-042 | `/chat/webhooks/[taskId]` | AUTO-02, AUTO-04 | Authorized webhook conversation preserves task identity | Missing/foreign task or run does not disclose history |
| SCR-043 | `/credentials/[section]` | CRED-04, IDN-03 | Supported connection sections deep-link and preserve state | Unknown section, expired state and foreign identity cannot connect |
| SCR-044 | `/knowledge-bases/collections` | KB-04, KB-06, POL-02 | Permitted collections, details and publication state work | Foreign/private collection and stale approval cannot publish/search |
| SCR-045 | `/knowledge-bases/ingestion-sources` | KB-03, KB-05 | Per-source status, incremental ingest and retry work | Foreign source, invalid connector and partial failure stay visible |
| SCR-046 | `/native-extensions/[extensionId]/[[...path]]` | APP-04, APP-05, APP-06 | Trusted native entry receives correct host props/routes | Missing/mismatched module and disabled installation fail safely |
| SCR-047 | `/settings` | SET-01, SET-02 | Personal defaults and accessible platform sections load | Foreign preferences and non-admin platform changes are denied |
| SCR-048 | `/settings/[section]` | SET-01, SET-02, NOTIF-01 | Each registered section deep-links and autosaves correctly | Unknown section, failed save and View as cannot persist unauthorized state |

Historical SCR-005, SCR-007 through SCR-010 and SCR-025 through SCR-028 referred
to former host-owned app/project routes. Their IDs are reserved; do not reuse
them. Verify their candidate-supported redirects or documented removal through
APP-06 and the app-owned cases, rather than pretending removed pages still exist.

## API-family inventory

For each family, inventory every current handler and exported method during run
planning, including internal/test/admin endpoints. Exercise allowed requests and
anonymous, foreign-resource, revoked-access and invalid-input denial as applicable;
verify persisted state, audit, pagination, retry and cleanup. Do not treat all
methods as equivalent because they share a URL. Internal/test routes must meet
their deployment exposure policy, including being unavailable when disabled.

| ID | API family | Feature cases |
|---|---|---|
| APIF-001 | `/api/[...path]` | APP-05, APP-06, SEC-03 |
| APIF-002 | `/api/_test` | SEC-03, RBAC-01 |
| APIF-003 | `/api/access` | FGA-01, RBAC-01 |
| APIF-004 | `/api/admin` | RBAC-01, IDN-01, IDN-02, SET-02, SVC-01, POL-01, OBS-02 |
| APIF-005 | `/api/agentic-apps` | APP-01, APP-03, APP-05 |
| APIF-006 | `/api/ai` | AGT-05, MODEL-01 |
| APIF-007 | `/api/audit` | OBS-02 |
| APIF-008 | `/api/auth` | SEC-01, SEC-03, IDN-03 |
| APIF-009 | `/api/authz` | FGA-01, RBAC-01 |
| APIF-010 | `/api/autonomous` | AUTO-01, AUTO-02, AUTO-03, AUTO-04 |
| APIF-011 | `/api/catalog-api-keys` | SKL-04 |
| APIF-012 | `/api/changelog` | SET-02, QUAL-01 |
| APIF-013 | `/api/chat` | CHAT-01, CHAT-02, CHAT-03, CHAT-04, CHAT-05, CHAT-06, CHAT-07, RUN-01, RUN-02, RUN-03, RUN-04 |
| APIF-014 | `/api/config` | SET-01, SET-02 |
| APIF-015 | `/api/credentials` | CRED-01, CRED-02, CRED-03, CRED-04 |
| APIF-016 | `/api/dynamic-agents` | AGT-01, AGT-02, AGT-03, AGT-04, PROFILE-01 |
| APIF-017 | `/api/feedback` | OBS-03 |
| APIF-018 | `/api/files` | SEC-04, CHAT-06 |
| APIF-019 | `/api/harness-engine` | RUN-01, RUN-02, RUN-03, RUN-04, RUN-05, RUN-06, ROUTE-01 |
| APIF-020 | `/api/health` | DEP-01, OBS-01 |
| APIF-021 | `/api/integrations` | INT-01, SLACK-01, WEBEX-01 |
| APIF-022 | `/api/internal` | SEC-03, SVC-02, APP-05 |
| APIF-023 | `/api/llm-models` | MODEL-01 |
| APIF-024 | `/api/mcp-servers` | MCP-01, MCP-02, MCP-03, MCP-04, MCP-05 |
| APIF-025 | `/api/native-extensions` | APP-04, APP-05 |
| APIF-026 | `/api/notifications` | NOTIF-01, NOTIF-02, NOTIF-03 |
| APIF-027 | `/api/onboarding` | SET-03 |
| APIF-028 | `/api/platform` | SET-02, OBS-01 |
| APIF-029 | `/api/policies` | POL-01, POL-03 |
| APIF-030 | `/api/publication-requests` | POL-02 |
| APIF-031 | `/api/rag` | KB-01, KB-02, KB-03, KB-04, KB-05, KB-06 |
| APIF-032 | `/api/rbac` | FGA-01, RBAC-01 |
| APIF-033 | `/api/release-notes` | SET-02, QUAL-01 |
| APIF-034 | `/api/remote-agents` | REMOTE-01, PROFILE-01, RUN-01 |
| APIF-035 | `/api/review-configs` | POL-01 |
| APIF-036 | `/api/schedules` | WF-04, AUTO-03 |
| APIF-037 | `/api/settings` | SET-01, SET-02 |
| APIF-038 | `/api/skill-hubs` | SKL-03 |
| APIF-039 | `/api/skill-templates` | SKL-01, SKL-03 |
| APIF-040 | `/api/skills` | SKL-01, SKL-02, SKL-03, RUN-05 |
| APIF-041 | `/api/tickets` | INT-01, POL-02 |
| APIF-042 | `/api/user` | SET-01, IDN-03 |
| APIF-043 | `/api/users` | IDN-01, RBAC-01 |
| APIF-044 | `/api/v1` | SVC-02, MCP-05, RUN-01 |
| APIF-045 | `/api/version` | DEP-01, QUAL-01 |
| APIF-046 | `/api/workflow-configs` | WF-01, WF-02, WF-05 |
| APIF-047 | `/api/workflow-runs` | WF-02, WF-03, WF-05 |

## Catch-all and application-owned surfaces

- Enumerate admin destinations from
  `ui/src/components/admin/workspace/admin-routes.ts`, and personal sections from
  `ui/src/components/settings/settings-routes.ts`. Test every destination, gate,
  direct URL and backing method with admin and ordinary identities.
- Admin coverage includes users/teams/sync, defaults/setup/tour/announcements,
  agent/runtime/MCP/RAG/skill catalogs, credentials/service accounts, bots,
  health/metrics/statistics/feedback, access-before-sign-in, AI Review/audit,
  publication approvals and access operations. Expand nested diagnostics,
  relationship/tuple viewers and migration controls from the actual candidate.
- Settings: expand appearance, chat/default agents, notifications, features,
  developer/account/access views and each permitted platform setting. Verify
  autosave rollback, independent web/bot preferences and read-only View as.
- Apps: enumerate installed manifests, selected native/iframe profile, owned
  routes/API mounts/slots and public/hidden/disabled/service-only modes. Include
  each app's own test plan and source boundary. Inventory the installed SDLC app's
  repository/epic/metrics/settings flows only when that app is actually present.
- Knowledge: collections, ingestion sources, graph, MCP tools and search need
  their own role gates and direct API checks; a redirect is not a passed search.
- Skills: Overview, Files, Tools, Versions and Scan include unsaved edits, conflict,
  built-in read-only behavior, hub/template provenance and scanner decisions.
- Application-owned feature routes, data models and source-provider flows are
  inventoried and tested in the application's own repository. This public plan
  verifies only the host/app contract. Discover app suites through protected run
  configuration when the requested scope includes external applications.

## Cross-cutting assertion dimensions

Expand applicable dimensions with stable child IDs, for example
`SCR-013/DIM-02/shared-reader`. Record explicit exclusions; do not silently omit
negative cases because the positive flow succeeded.

| ID | Dimension | Required checks |
|---|---|---|
| DIM-01 | Authentication | Real login, renewal, logout, stale/revoked/invalid sessions, safe callback and cross-origin policy |
| DIM-02 | Authorization | Owner/member/outsider/machine allow/deny; direct URL/API, ID substitution, cross-team/org and revoked cache boundaries |
| DIM-03 | Visibility lifecycle | Private → Team → Global → Private, downgrade/revoke/delete where supported; exact persisted grants, stale-grant absence and effective decisions |
| DIM-04 | Input boundaries | Valid minimum/maximum/Unicode/multiline; required/oversize/duplicate/malformed values, unsafe markup/path/URL and unsupported files |
| DIM-05 | Concurrency | Double-submit, stale version, update/delete and share/revoke races, idempotent retry, duplicate callback/event/run admission |
| DIM-06 | Async recovery | Loading/progress/completion, timeout, partial result, cancellation, 409/422/429/5xx and unavailable dependency |
| DIM-07 | Navigation | Menu/direct link, query/filters, refresh/back/forward, unknown/disabled destination and unsaved-change escape |
| DIM-08 | Data safety | Scoped lists/redaction, private metadata, attachment/download ownership, safe links and secret-free evidence |
| DIM-09 | Accessibility | Keyboard-only, visible/returned focus, labels/announcements, reduced motion, dialog escape and usable validation |
| DIM-10 | Responsive layout | Desktop/narrow viewport, long labels, scrolling and overflow; dialogs/actions/errors remain reachable |
| DIM-11 | Observability | Request/run correlation, actor/object, attributable success/failure audit and bounded secret-free logs |
| DIM-12 | Cleanup | Manifest-scoped deletion, dependent bindings, grants/checkpoints/jobs, zero residue; preserve failure after manual repair |

## Detailed numbered case register

A new or changed assertion must have a permanent ID and enough information to
repeat it. Keep the feature group ID, stable child ID, prerequisites, steps,
expected result, adapter/location and required evidence. Reuse an existing test
when its actual contract matches; record whether it is live, mocked or unit-only.
These initial detailed cases anchor security and the previously under-tested
runtime/workflow/skill/bot flows. Other groups must be expanded before execution;
they remain planning work until their required assertions and adapters are named.
Do not renumber existing children when inserting a new assertion.

| Assertion ID | Prerequisites and steps | Expected result / required evidence |
|---|---|---|
| REL-04.01 | Declared plan with missing/partial results, scoped evidence, cleanup failure, excluded assertions with successful cleanup, and an optional accepted risk: render twice | Deterministic artifacts and recomputed counts/verdicts agree; missing coverage and failed cleanup remain visible; successful cleanup leaves excluded cases NOT_APPLICABLE; see renderer tests |
| REL-04.02 | Open locally generated HTML at desktop/narrow viewport; search/filter, expand assertions and download JSON | No external layout dependencies or script errors; readable numbered dispositions, controls and embedded records agree; filtered-out rows stay hidden at both viewport widths |
| REL-04.03 | Try private-suite/private-evidence public export, unsafe evidence URLs, untrusted text, inconsistent PASS records, and planned assertions containing result fields | Invalid export/records reject; text is escaped; planned fields cannot replace validated execution results or mark missing results PASS; no automatic upload/redaction; release summary preserves actual scope |
| REL-05.01 | Run release-policy and finalization tests with first/subsequent RC tags, unrelated branch tags, and mocked release APIs | Generated RC delta uses the previous reachable same-series RC or preceding stable; full stable comparison and Helm/image commands use the exact candidate version; retain unit/CI evidence from `.github/actions/tests/test_release_policy.py` |
| REL-05.02 | Exercise required-build success, failure, missing/running/skipped runs, wrong commit, PR/fork completion, existing draft and repeated publication | Only successful builds for the tag's exact commit permit publication with prerelease enabled and Latest disabled; retries preserve published notes; retain mocked/CI evidence from release-policy and `tests/test_release_finalization.py` tests |
| REL-05.03 | Run stable changelog, stable release-note baseline and image-channel regression tests for stable, RC, dev, hotfix and canary versions | Stable history and candidate rollups are preserved; stable notes start at the preceding stable tag even after RC publication; candidates never move image Latest or require a stable blog; retain unit/CI evidence from release-policy and Harness publication tests |
| REL-05.04 | Exercise manual dispatch from main/tag/feature refs, hotfix merge-back detection, unavailable Git remotes, padded/large suffix histories and each publishing metadata step | Non-main manual dispatches reject before release credentials; hotfix merge-backs do not prepare or auto-promote stable versions; remote errors stop validation; suffixes compare numerically without overflow; every image metadata step independently protects Latest; retain unit/CI evidence from release-policy tests |
| SEC-01.01 | Real approved ordinary-user session: sign in and open a permitted protected page/API | Displayed identity and returned subject agree; screenshot and redacted API evidence |
| SEC-01.02 | Same session: exercise its actual renewal boundary and revisit a protected API | Session renews per deployed contract without changed identity or widened grants; redacted before/after results |
| SEC-01.03 | Owned session: log out, revisit protected URL and call protected API | Server and UI enforce logout; no authenticated data reappears through back navigation; API/status and screenshot |
| SEC-01.04 | Two approved tabs: revoke/expire fixture session, then replay/read/send from stale tab | Every protected operation denies according to declared policy; stale UI cannot authorize a write; request/stream evidence |
| SEC-01.05 | Anonymous/invalid fixture credentials: read and mutate representative protected endpoints | Contract-appropriate denial or safe login redirect; no persisted mutation or protected payload; API/state evidence |
| SEC-01.06 | Approved fixture operations: inspect responses, errors, audit and generated artifacts | Tokens/secrets remain redacted; record checks and sanitized evidence without copying secret values |
| RUN-01.01 | Each enabled runtime with owned agent and allowed model: send a unique marker prompt | Real selected worker/model completes; runtime binding and persisted response prove execution |
| RUN-01.02 | Same conversation: ask for the earlier marker without repeating it | Correct marker follows from retained context; both turn records and stream evidence |
| RUN-01.03 | Same runtime with approved harmless tool: require an actual tool call | Successful tool request/result and caller authorization agree; narrative claims alone fail |
| RUN-01.04 | Completed owned chat: reload, navigate away/back and reopen deep link | Actual completed turns, tool lineage and immutable runtime binding persist |
| WF-02.01 | Owned disposable definition: create two harmless dependent steps with marker input | Save/reload preserves ordered steps, variable references and allowed agent/tool bindings |
| WF-02.02 | Saved fixture workflow: execute with marker input | Both real step outputs and handoff agree with run history; catalog rendering is insufficient |
| WF-02.03 | Independent ordinary identity: attempt unauthorized edit/run using fixture ID | Declared owner/team policy enforced by direct APIs; no unauthorized run or changed definition |
| WF-02.04 | After workflow run: clean only manifest IDs | No owned definition/run/job residue or stale grants; automatic failures remain visible |
| RUN-05.01 | Each enabled runtime with a safe owned marker skill: attach and execute it | Output and runtime trace demonstrate skill instructions actually applied |
| RUN-05.02 | Saved baseline skill and agent: restart/reload within approved isolated scope and run again | Saved attachment, instructions and tool scope survive upgrade/reconnect without widened access |
| SLACK-01.01 | Approved test identity/destination: send labelled DM, then same-thread follow-up | Real replies and host history preserve marker/context with one admitted run per turn |
| SLACK-01.02 | Approved fixture channel mapping: mention bot, then follow up in its thread | Correct scoped route/identity, delivered reply and persisted conversation binding; record provider message IDs |
| WEBEX-01.01 | Approved test identity/destination: send labelled 1:1, then contextual follow-up | Delivered replies and host history preserve marker/context without duplicate runs |
| WEBEX-01.02 | Approved fixture space mapping: mention bot, then follow up in its thread | Correct scoped route/identity and actual delivery agree with stored host conversation |

Record adapter gaps explicitly. This register and inventory do not restore the old
Playwright runners, synthetic-cookie helpers or monolithic app endpoints. Port
only compatible assertions to current owning suites; track every remaining gap
in the run report and feature plan.
