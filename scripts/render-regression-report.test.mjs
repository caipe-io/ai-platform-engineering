import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { normalizeReport, renderReport, renderSummary, safeHref } from "./render-regression-report.mjs";

const evidence = [{ label: "Fixture trace", href: "https://example.test/evidence/trace.json", visibility: "public" }];
function fixture() {
  return {
    schema_version: 1, run_id: "example-run", title: "Example regression", target: "https://example.test", scope: "full", visibility: "private",
    started_at: "2026-01-01T00:00:00Z", finished_at: "2026-01-01T00:01:00Z",
    suites: [{ id: "primary", name: "Primary", visibility: "public", repository: "example/primary", source_ref: "candidate-ref", plan_ref: "plan-ref" }],
    plan: [{ id: "primary:SEC-01", suite: "primary", capability: "Authentication", cleanup_required: false, assertions: [{ id: "primary:SEC-01.01", label: "Sign-in" }] }],
    results: [{ id: "primary:SEC-01", assertions: [{ id: "primary:SEC-01.01", status: "PASS", detail: "Fixture identity matched", evidence_kind: "live-api", evidence }] }],
  };
}

test("renders deterministically from evidence, ignoring supplied verdict and totals", () => {
  const input = fixture();
  input.verdict = "NO-GO";
  input.totals = { PASS: 999 };
  const result = normalizeReport(input);
  assert.equal(result.verdict, "GO");
  assert.equal(result.totals.PASS, 1);
  assert.equal(result.fully_executed, 1);
  assert.equal(renderReport(input), renderReport(structuredClone(input)));
  assert.match(renderSummary(input), /1 planned; 1 fully executed/);
});

test("includes missing planned cases and assertions as unexecuted", () => {
  const input = fixture();
  input.plan[0].assertions.push({ id: "primary:SEC-01.02", label: "Logout" });
  input.plan.push({ id: "primary:WF-01", suite: "primary", capability: "Workflow", cleanup_required: false, assertions: [{ id: "primary:WF-01.01", label: "Run" }] });
  const result = normalizeReport(input);
  assert.equal(result.rows.length, 2);
  assert.equal(result.totals.NOT_RUN, 2);
  assert.equal(result.assertion_totals.PASS, 1);
  assert.equal(result.assertion_totals.NOT_RUN, 2);
  assert.equal(result.fully_executed, 0);
  assert.equal(result.verdict, "NO-GO");
});

test("preserves a failure with partial blocked coverage and manual cleanup repair", () => {
  const input = fixture();
  input.plan[0].cleanup_required = true;
  input.plan[0].assertions.push({ id: "primary:SEC-01.02", label: "Revocation" });
  input.results[0].assertions[0].status = "FAIL";
  input.results[0].assertions.push({ id: "primary:SEC-01.02", status: "BLOCKED", detail: "Dependent access boundary failed" });
  input.results[0].cleanup = { status: "FAIL", detail: "Automatic cleanup failed; manual residue repair completed", evidence };
  const result = normalizeReport(input);
  assert.equal(result.rows[0].status, "FAIL");
  assert.equal(result.rows[0].cleanup.status, "FAIL");
  assert.equal(result.fully_executed, 0);
  assert.equal(result.verdict, "NO-GO");
});

test("rejects evidence-free, mocked or inconsistent live PASS claims", () => {
  const input = fixture();
  input.results[0].assertions[0].evidence = [];
  assert.throws(() => normalizeReport(input), /PASS needs evidence/);
  input.results[0].assertions[0].evidence = evidence;
  input.results[0].assertions[0].evidence_kind = "unit";
  assert.throws(() => normalizeReport(input), /Live evidence required/);
  input.plan[0].live = false;
  input.results[0].status = "FAIL";
  assert.throws(() => normalizeReport(input), /Inconsistent case status/);
});

test("smoke output stays scoped and missing candidate metadata prevents readiness", () => {
  const input = fixture();
  input.scope = "smoke";
  assert.match(normalizeReport(input).release_readiness, /NOT ASSESSED/);
  input.scope = "readiness";
  input.suites[0].source_ref = null;
  assert.equal(normalizeReport(input).verdict, "NO-GO");
  assert.equal(normalizeReport(input).suite_summaries[0].verdict, "NO-GO");
});

test("optional accepted risks produce CONDITIONAL without relabelling failures", () => {
  const input = fixture();
  input.plan[0].required = false;
  input.results[0].assertions[0].status = "FAIL";
  assert.equal(normalizeReport(input).verdict, "NO-GO");
  input.accepted_risks = [{ case_id: "primary:SEC-01", approver: "test-reviewer", reason: "Bounded fixture-only risk" }];
  const report = normalizeReport(input);
  assert.equal(report.verdict, "CONDITIONAL");
  assert.equal(report.rows[0].status, "FAIL");
});

test("suite verdicts remain independent while incomplete app coverage blocks combined GO", () => {
  const input = fixture();
  input.suites.push({ id: "secondary", name: "Secondary", visibility: "private", source_ref: "candidate-ref", plan_ref: "plan-ref" });
  input.plan.push({ id: "secondary:APP-01", suite: "secondary", capability: "App", cleanup_required: false, assertions: [{ id: "secondary:APP-01.01", label: "Load" }] });
  const result = normalizeReport(input);
  assert.equal(result.suite_summaries[0].verdict, "GO");
  assert.equal(result.suite_summaries[1].verdict, "NO-GO");
  assert.equal(result.verdict, "NO-GO");
  input.visibility = "public";
  assert.throws(() => normalizeReport(input), /Private suites/);
});

test("public evidence needs an explicit public label; visibility is not redaction", () => {
  const input = fixture();
  input.visibility = "public";
  assert.equal(normalizeReport(input).verdict, "GO");
  input.results[0].assertions[0].evidence = [{ label: "Trace", href: "trace.json" }];
  assert.throws(() => normalizeReport(input), /explicitly public evidence/);
});

test("a declared suite with no cases cannot inherit another suite's GO", () => {
  const input = fixture();
  input.suites.push({ id: "secondary", name: "Secondary", visibility: "private", source_ref: "candidate-ref", plan_ref: "plan-ref" });
  const report = normalizeReport(input);
  assert.equal(report.suite_summaries[0].verdict, "GO");
  assert.equal(report.suite_summaries[1].verdict, "NO-GO");
  assert.equal(report.verdict, "NO-GO");
  assert(report.gaps.some((gap) => gap.includes("Secondary: no applicable")));
});

test("escapes untrusted content and rejects executable, credential and traversal links", () => {
  const input = fixture();
  input.title = '<script>alert("example")</script>';
  const html = renderReport(input);
  assert(!html.includes(input.title));
  assert.match(html, /&lt;script&gt;/);
  for (const href of ["javascript:alert(1)", "data:text/html,example", "//example.test", "file:///tmp/example", "../secret", "%2e%2e/secret", "https://user:secret@example.test", "https://example.test/\nexample"]) assert.throws(() => safeHref(href));
  assert.equal(safeHref("evidence/trace.json"), "evidence/trace.json");
  assert.equal(safeHref("evidence/screen%20one.png"), "evidence/screen%20one.png");
});

test("rejects duplicate or unplanned results and all-excluded plans cannot claim GO", () => {
  const input = fixture();
  input.results.push(structuredClone(input.results[0]));
  assert.throws(() => normalizeReport(input), /Duplicate result/);
  input.results[1].id = "unplanned";
  assert.throws(() => normalizeReport(input), /Unplanned result/);
  input.results.pop();
  input.results[0].assertions[0] = { id: "primary:SEC-01.01", status: "NOT_APPLICABLE", detail: "Feature absent by declared scope" };
  assert.equal(normalizeReport(input).verdict, "NO-GO");
});

test("CLI writes the offline artifact and release summary, leaving input unchanged", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "regression-report-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const source = JSON.stringify(fixture());
  writeFileSync(join(dir, "report.json"), source);
  const run = spawnSync(process.execPath, [resolve("scripts/render-regression-report.mjs"), "--input", join(dir, "report.json"), "--output", join(dir, "report.html")], { encoding: "utf8" });
  assert.equal(run.status, 0, run.stderr);
  const html = readFileSync(join(dir, "report.html"), "utf8");
  assert.match(html, /Content-Security-Policy/);
  assert.match(html, /data:application\/json;base64/);
  assert.match(readFileSync(join(dir, "report-summary.md"), "utf8"), /Scope verdict: GO/);
  assert.equal(readFileSync(join(dir, "report.json"), "utf8"), source);
  writeFileSync(join(dir, "report-summary.md"), source);
  const collision = spawnSync(process.execPath, [resolve("scripts/render-regression-report.mjs"), "--input", join(dir, "report-summary.md"), "--output", join(dir, "report.html")], { encoding: "utf8" });
  assert.notEqual(collision.status, 0);
  assert.equal(readFileSync(join(dir, "report-summary.md"), "utf8"), source);
});

test("release summary preserves text while escaping Markdown and flattening newlines", () => {
  const input = fixture();
  input.title = "Run #1\nnext *step*";
  assert.equal(renderSummary(input).split("\n")[0], "Regression validation: Run \\#1 next \\*step\\*");
});
