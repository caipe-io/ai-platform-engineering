---
name: caipe-regression-suite
description: Plan and run feature-level E2E regression, backward-compatibility checks, or release-readiness reviews using the maintained repository matrix and explicit execution evidence.
---

# Regression and Release Readiness

Read the [canonical matrix](../../../docs/docs/development/caipe-regression-suite.md)
before choosing tests. It owns case IDs, profiles, acceptance criteria, existing
test adapters, evidence requirements, and the run-record format. Do not maintain
a second case list inside this skill. Codex's `.agents/skills` link and Claude
Code's `.claude/skills` directory resolve to this same implementation.

Read the linked screen/API inventory too. Run `node scripts/validate-regression-inventory.mjs`
before declaring the plan complete. Expand current catch-all tabs, API handlers,
feature flags, installed-app surfaces and stable assertion IDs; a green source
inventory check is planning evidence and does not establish functional coverage.

For an integrated deployment request, follow the matrix's external-suite
composition section. Discover requested app-owned plans from authorized run
configuration, keep their definitions/results in their owning repositories and
compose namespaced dispositions privately when required. Core CAIPE testing must
work without private-app access; host-only success is not integrated sign-off.

## Select the requested mode

- **Run E2E regression:** inventory the target's enabled features, create a full
  run record, then execute the applicable cases through existing tests and actual
  authenticated browser/API/bot flows. Report unexecuted cases explicitly.
- **Smoke test:** execute a stated subset. Name the subset and leave remaining
  cases NOT_RUN; a smoke pass is not release sign-off.
- **Check release readiness:** review current issue/PR state, exact candidate
  source and artifacts, CI, deployment health, migration/upgrade notes, and the
  latest matching live run. Missing or stale live evidence is a gap, not a pass.
  Execute additional tests only within the user's authorized target and scope.

## Prepare and execute

1. Inspect repository instructions and dirty state. Identify the actual deployed
   versions/revisions, baseline version, enabled profiles, and approved target.
   If target or write scope is missing, continue the read-only review and ask
   only for the missing information. Reuse authorization already in the task.
2. Map the full baseline-to-candidate commit graph to case IDs, including merge
   commits. Compare changed behavior with the matrix; add missing cases. For a
   split app, record its independent source/image boundary too.
3. Expand `RUN-*` cases separately for every enabled runtime and bot case for
   each requested provider/context. Preserve legacy baseline chats, agent
   definitions, workflows, skills and app bindings as distinct test subjects.
4. Inspect an existing test's assertions, mocks, authentication, target selection,
   mutations and cleanup before running it. A file named "live" or "E2E" is not
   proof of coverage. Prefer approved real sessions; never bypass the deployed
   session contract with old synthetic-cookie helpers or platform signing keys.
5. Check prerequisites per case. RBAC cases need distinct authorized personas
   and team/outsider membership evidence. Bot sends need the approved destination.
   Runtime/tool cases need an allowed model and harmless tool. Missing bot or
   outside-team access must not block unrelated authorized runtime tests.
6. Execute the steps and capture observed results plus relevant screenshots,
   API/stream traces, authorization decisions and persisted records. Keep CI,
   source review and deployment-health evidence separate from live execution.
7. On a failure, record evidence and clean the affected fixtures. Pause cases
   that share the failed access boundary or uncertain cleanup. Independent safe
   cases may continue within scope; stop all writes for an uncontrolled leak,
   exposed secret or unbounded impact. Do not silently repair the product,
   change grants on existing resources, or deploy fixes to make a test pass.
8. Verify manifest-scoped cleanup, finalize every case disposition, and issue
   the matrix's GO / CONDITIONAL / NO-GO verdict with exact coverage limits.
   Include its full matrix disposition table (ID, capability/runtime/context,
   status, detail, evidence) and matching structured assertion records. Show all
   uncompleted/excluded rows and counts; preserve failed assertions after repair.
9. Follow the matrix's report-artifact contract. Build the complete schema-1
   manifest, then run `node scripts/render-regression-report.mjs --input
   RUN/report.json --output RUN/report.html` to produce the consistent offline
   HTML and `report-summary.md`. Include blocked/unexecuted planning gaps; do not
   omit cases to make a report render. Attach/link artifacts in the final handoff;
   rendering alone does not execute tests, redact private text or publish a release.

## Maintain the plan

- Product changes update the relevant matrix cases in the same PR.
- A reproduced bug strengthens a permanent case; its issue URL and current
  disposition live in the run report. Verify the fix's actual diff and ancestry
  before declaring an issue fixed or a defect newly introduced.
- Do not copy a run's hostnames, identities, credentials or results into reusable
  defaults. Keep approved environment details in that run's protected artifacts.
- Do not deploy, sync GitOps, rotate credentials, reconnect providers or modify
  platform configuration merely because regression or readiness was requested.
