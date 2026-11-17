---
sidebar_position: 9
title: Regression Report Artifacts
description: Versioned input contract and deterministic offline HTML and release-summary artifacts.
---

# Regression Report Artifacts

Every regression/readiness run finishes with a machine-readable manifest and the
same HTML report layout. `AGENTS.md` routes execution to the skills; the renderer
turns collected results into artifacts. Rendering does not execute tests, approve
a release, upload evidence or attach anything to a release automatically.

## Generate the report

Run from the source checkout containing the renderer, using Node 24:

```bash
node scripts/render-regression-report.mjs \
  --input /path/to/run/report.json \
  --output /path/to/run/report.html
```

Outputs:

- `report.html`: offline layout, search/status filter, per-suite and combined
  verdicts, versions/revisions, coverage totals, full case/assertion dispositions,
  observed details, evidence links, cleanup and accepted risks.
- `report-summary.md`: short scope/readiness summary for release notes, generated
  from the same records and computed totals.
- The HTML embeds a downloadable normalized JSON record. Keep the original
  `report.json` beside it for independent review and future re-rendering.

Attach the HTML and summary to the appropriate release. Evidence is linked, not
silently downloaded or embedded. Keep relative evidence paths below the run
directory, place the HTML beside the input, and include those files in an archive
when attaching a portable evidence bundle. Authorized HTTPS links may instead
point to retained evidence storage. Verify recipients can access those links.

The page has no external script/style dependencies. Its appearance is stable for
the same renderer revision; record that revision with the run. Use browser Print
only as a convenience, not as a substitute for the HTML/JSON evidence record.

## Input contract: schema 1

`docs/examples/regression-report.json` is a runnable, fictional example showing
all five dispositions. It is labelled EXAMPLE and is not test evidence:

```bash
node scripts/render-regression-report.mjs \
  --input docs/examples/regression-report.json \
  --output /tmp/example-run/report.html
```

Required top-level fields:

| Field | Contract |
|---|---|
| `schema_version` | Integer `1`; unsupported versions fail validation |
| `run_id`, `title`, `target` | Nonempty strings; target is the approved environment label/URL |
| `scope` | `full`, `readiness`, `smoke` or `standalone`; smoke/standalone do not establish full release readiness |
| `visibility` | Explicit `private` or `public`; this is a sharing boundary, not automated content redaction |
| `started_at`, `finished_at` | Timestamp strings; missing/invalid or reversed timing blocks GO |
| `suites` | Nonempty array of independent suite metadata records |
| `plan` | Nonempty complete inventory of expanded cases and stable assertion IDs, prepared before execution |
| `results` | Case results; missing planned cases/assertions become NOT_RUN automatically |
| `accepted_risks` | Optional array of `{case_id, approver, reason}` for explicitly optional noncritical cases |

Suite records contain `id`, `name`, `visibility`, `repository`, `baseline_ref`,
`source_ref`, `plan_ref` and optional `versions` (array of strings). Candidate and
plan refs are independent; missing either prevents GO. Do not put credentials or
session records in metadata. Independent suite verdicts do not substitute for the
overall verdict when the requested scope includes multiple suites.

Each `plan` entry contains:

- `id`: stable namespaced group/runtime/context ID, such as `host:SEC-01`.
- `suite`: an existing suite ID, and `capability`: its human-readable name.
- Optional `context`: runtime/provider/persona description.
- `required`: defaults true. Only an explicitly optional noncritical case can
  use an accepted risk; critical security/data/cleanup cases remain required.
- `live`: defaults true. Set false only for declared static/artifact/CI checks.
- `cleanup_required`: defaults true. Set false for read-only or excluded cases
  that create no fixtures; this must not excuse a cleanup failure after writes.
- `assertions`: nonempty array of stable `{id, label}` definitions; expand the
  actual required steps rather than using one first-reply assertion for a group.

Each result contains its planned case `id`, optional observed `detail` and case
`evidence`, plus `assertions` with `id`, `status`, observed `detail`,
`evidence_kind` and `evidence`. Cleanup is a separate `{status, detail, evidence}`
record. Missing required cleanup remains NOT_RUN. A supplied group `status` must
match the computed rollup; it cannot override failed or missing assertions.

Evidence entries contain `{label, href}`. Use a relative artifact path or an
HTTPS URL without embedded credentials; executable schemes, parent traversal and
protocol-relative URLs are rejected. Executed PASS/FAIL assertions need an
evidence kind and observed detail; PASS also requires evidence links. Live cases
require `live-browser`, `live-api` or `live-bot`. Review cases may use `CI`, `unit`,
`mocked-browser`, `stand-in` or `source-review`, clearly labelled.

## Counts and verdicts

- Counts come from the declared plan and actual results, never supplied totals.
  Missing results remain visible. The renderer cannot discover a case omitted
  from the plan; reconcile it with the maintained matrices and source inventory.
- Any failed assertion or automatic cleanup makes its group FAIL. Otherwise,
  BLOCKED precedes NOT_RUN; all applicable assertions and cleanup must pass for
  PASS. Explicit exclusions retain their reason and are not executed coverage.
- Partial groups are not fully executed. Assertion PASS/FAIL counts are distinct
  from group completion, and failed automatic cleanup remains failed after repair.
- Required incomplete/failed cases, unresolved cleanup and missing candidate/plan
  metadata produce NO-GO. Accepted optional risks can produce CONDITIONAL without
  relabelling failures. An entirely excluded plan cannot claim GO.
- A smoke/standalone report may have a scoped GO; **release readiness remains
  NOT ASSESSED**. This renderer does not grant approval to tag or deploy.

## Public and private output

- Combined or restricted application results stay in private run storage and
  private release attachments. A public report cannot contain a suite marked
  private, and every public evidence reference must explicitly say
  `"visibility": "public"`.
- Labels do not redact text, validate whether a URL is publicly accessible, or
  grant access control. Review the entire input and evidence before public export.
  Create a separate deliberately sanitized host-only manifest when needed.
- Applications can use this generic renderer from an authorized checkout. Public
  CAIPE does not need application-specific code, repository pointers or fixtures.
