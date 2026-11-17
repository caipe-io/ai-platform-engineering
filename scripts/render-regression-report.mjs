#!/usr/bin/env node
/** Deterministic, dependency-free release regression artifacts. No target calls. */
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve, basename, extname } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

const statuses = ["PASS", "FAIL", "BLOCKED", "NOT_RUN", "NOT_APPLICABLE"];
const liveKinds = ["live-browser", "live-api", "live-bot"];
const kinds = [...liveKinds, "CI", "unit", "mocked-browser", "stand-in", "source-review"];
const escape = (value) => String(value ?? "").replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]);
const demand = (condition, message) => { if (!condition) throw new Error(message); };
const text = (value) => typeof value === "string" && value.trim().length > 0;
const counts = (rows) => Object.fromEntries(statuses.map((s) => [s, rows.filter((r) => r.status === s).length]));
const rollup = (rows) => ["FAIL", "BLOCKED", "NOT_RUN"].find((s) => rows.some((r) => r.status === s))
  ?? (rows.every((r) => r.status === "NOT_APPLICABLE") ? "NOT_APPLICABLE" : "PASS");

export function safeHref(value) {
  demand(text(value), "Evidence needs a nonempty href");
  const decoded = decodeURIComponent(value);
  demand(!/[\u0000-\u0020\u007f\\]/.test(value) && !/[\u0000-\u001f\u007f\\]/.test(decoded), "Unsafe evidence URL characters");
  if (/^https:\/\//i.test(value)) {
    const url = new URL(value);
    demand(!url.username && !url.password, "Credentials are forbidden in evidence URLs");
    return value;
  }
  demand(!/^[a-z][a-z0-9+.-]*:/i.test(decoded) && !decoded.startsWith("/"), "Evidence must use HTTPS or a relative artifact path");
  demand(!decoded.split(/[/?#]/).includes(".."), "Evidence cannot escape the artifact directory");
  return value;
}

function links(items = [], isPublic = false) {
  demand(Array.isArray(items), "Evidence must be an array");
  return items.map((item) => {
    demand(item && text(item.label), "Evidence needs a label");
    demand(!isPublic || item.visibility === "public", "Public reports require explicitly public evidence");
    return { ...item, href: safeHref(item.href) };
  });
}

/** Derive counts/verdicts from the declared plan, never caller-supplied totals. */
export function normalizeReport(input) {
  demand(input?.schema_version === 1, "Unsupported report schema_version; expected 1");
  for (const key of ["run_id", "title", "target"]) demand(text(input[key]), `Missing ${key}`);
  demand(["full", "smoke", "readiness", "standalone"].includes(input.scope), "Invalid scope");
  demand(["public", "private"].includes(input.visibility), "Explicit public/private visibility required");
  demand(Array.isArray(input.suites) && input.suites.length > 0, "At least one suite required");
  demand(Array.isArray(input.plan) && input.plan.length > 0, "A nonempty planned-case inventory is required");
  const suites = new Map();
  for (const suite of input.suites) {
    demand(suite && text(suite.id) && text(suite.name), "Suite ID/name required");
    demand(!suites.has(suite.id), `Duplicate suite ${suite.id}`);
    demand(["public", "private"].includes(suite.visibility), "Suite visibility required");
    demand(input.visibility !== "public" || suite.visibility === "public", "Private suites cannot appear in public reports");
    for (const key of ["repository", "baseline_ref", "source_ref", "plan_ref"]) demand(suite[key] == null || text(suite[key]), `Invalid suite ${key}`);
    demand(suite.versions === undefined || (Array.isArray(suite.versions) && suite.versions.every(text)), "Suite versions must be strings");
    suites.set(suite.id, suite);
  }
  const planIds = new Set();
  const assertionIds = new Set();
  for (const planned of input.plan) {
    demand(planned && text(planned.id) && text(planned.capability), "Planned case ID/capability required");
    demand(!planIds.has(planned.id), `Duplicate planned case ${planned.id}`);
    planIds.add(planned.id);
    demand(suites.has(planned.suite), `Unknown suite for ${planned.id}`);
    for (const key of ["required", "live", "cleanup_required"]) demand(planned[key] === undefined || typeof planned[key] === "boolean", `Invalid ${key} for ${planned.id}`);
    demand(Array.isArray(planned.assertions) && planned.assertions.length > 0, `Define assertion IDs for ${planned.id}`);
    for (const assertion of planned.assertions) {
      demand(assertion && text(assertion.id) && text(assertion.label), "Assertion ID/label required");
      demand(!assertionIds.has(assertion.id), `Duplicate assertion ${assertion.id}`);
      assertionIds.add(assertion.id);
    }
  }
  const results = new Map();
  demand(input.results === undefined || Array.isArray(input.results), "Results must be an array");
  for (const result of input.results ?? []) {
    demand(result && planIds.has(result.id), `Unplanned result ${result?.id}`);
    demand(!results.has(result.id), `Duplicate result ${result.id}`);
    results.set(result.id, result);
  }
  const isPublic = input.visibility === "public";
  const rows = input.plan.map((planned) => {
    const result = results.get(planned.id) ?? {};
    demand(result.assertions === undefined || Array.isArray(result.assertions), "Assertion results must be an array");
    const actual = new Map();
    for (const assertion of result.assertions ?? []) {
      demand(planned.assertions.some((a) => a.id === assertion.id), `Unplanned assertion ${assertion.id}`);
      demand(!actual.has(assertion.id), `Duplicate assertion result ${assertion.id}`);
      actual.set(assertion.id, assertion);
    }
    const assertions = planned.assertions.map((definition) => {
      const raw = actual.get(definition.id) ?? { status: "NOT_RUN", detail: "No execution result recorded" };
      demand(statuses.includes(raw.status), `Invalid status for ${definition.id}`);
      if (["BLOCKED", "NOT_APPLICABLE"].includes(raw.status)) demand(text(raw.detail), `Reason required for ${definition.id}`);
      const evidence = links(raw.evidence, isPublic);
      if (["PASS", "FAIL"].includes(raw.status)) {
        demand(kinds.includes(raw.evidence_kind), `Evidence kind required for ${definition.id}`);
        demand(planned.live === false || liveKinds.includes(raw.evidence_kind), `Live evidence required for ${definition.id}`);
        demand(text(raw.detail), `Observed detail required for ${definition.id}`);
      }
      if (raw.status === "PASS") {
        demand(evidence.length > 0, `PASS needs evidence for ${definition.id}`);
      }
      return { ...raw, ...definition, evidence };
    });
    const cleanup = result.cleanup ?? { status: planned.cleanup_required === false ? "NOT_APPLICABLE" : "NOT_RUN", detail: planned.cleanup_required === false ? "Read-only case; no fixture cleanup required" : "Cleanup not recorded" };
    demand(statuses.includes(cleanup.status), `Invalid cleanup status for ${planned.id}`);
    demand(cleanup.status !== "NOT_APPLICABLE" || planned.cleanup_required === false, `Required cleanup cannot be excluded for ${planned.id}`);
    if (cleanup.status === "PASS") demand((cleanup.evidence?.length ?? 0) > 0, `Cleanup PASS needs evidence for ${planned.id}`);
    const cleanupResult = { ...cleanup, evidence: links(cleanup.evidence, isPublic) };
    const derived = rollup([...assertions, ...(planned.cleanup_required === false && cleanup.status === "NOT_APPLICABLE" ? [] : [cleanup])]);
    demand(!result.status || result.status === derived, `Inconsistent case status for ${planned.id}; expected ${derived}`);
    return { ...planned, detail: result.detail ?? "", assertions, cleanup: cleanupResult, status: derived,
      evidence: links(result.evidence, isPublic),
      fully_executed: assertions.some((a) => a.status !== "NOT_APPLICABLE") && assertions.every((a) => ["PASS", "FAIL", "NOT_APPLICABLE"].includes(a.status)) && ["PASS", "FAIL", "NOT_APPLICABLE"].includes(cleanup.status) };
  });
  const gaps = [];
  for (const suite of suites.values()) {
    if (!text(suite.source_ref) || !text(suite.plan_ref)) gaps.push(`${suite.name}: candidate or plan revision missing`);
    if (!rows.some((row) => row.suite === suite.id && row.assertions.some((a) => a.status !== "NOT_APPLICABLE"))) gaps.push(`${suite.name}: no applicable planned assertions`);
  }
  for (const key of ["started_at", "finished_at"]) {
    if (!text(input[key]) || !Number.isFinite(Date.parse(input[key]))) gaps.push(`${key} missing or invalid`);
  }
  if (Date.parse(input.finished_at) < Date.parse(input.started_at)) gaps.push("Run finished before it started");
  const risks = input.accepted_risks ?? [];
  demand(Array.isArray(risks), "accepted_risks must be an array");
  for (const risk of risks) demand(planIds.has(risk.case_id) && text(risk.approver) && text(risk.reason), "Accepted risks need a planned case, approver and reason");
  const failures = rows.filter((row) => !["PASS", "NOT_APPLICABLE"].includes(row.status));
  const unaccepted = failures.filter((row) => row.required !== false || !risks.some((risk) => risk.case_id === row.id));
  const cleanupGap = rows.some((row) => !["PASS", "NOT_APPLICABLE"].includes(row.cleanup.status));
  const assertions = rows.flatMap((row) => row.assertions);
  if (!assertions.some((a) => a.status !== "NOT_APPLICABLE")) gaps.push("No applicable assertions in the declared plan");
  const verdict = gaps.length || unaccepted.length || cleanupGap ? "NO-GO" : failures.length ? "CONDITIONAL" : "GO";
  const suite_summaries = [...suites.values()].map((suite) => {
    const own = rows.filter((row) => row.suite === suite.id);
    const incomplete = own.filter((row) => !["PASS", "NOT_APPLICABLE"].includes(row.status));
    const fatal = incomplete.some((row) => row.required !== false || !risks.some((risk) => risk.case_id === row.id));
    const cleanupMissing = own.some((row) => !["PASS", "NOT_APPLICABLE"].includes(row.cleanup.status));
    const metadataMissing = !text(suite.source_ref) || !text(suite.plan_ref) || !Number.isFinite(Date.parse(input.started_at)) || !Number.isFinite(Date.parse(input.finished_at)) || Date.parse(input.finished_at) < Date.parse(input.started_at);
    const applicable = own.some((row) => row.assertions.some((a) => a.status !== "NOT_APPLICABLE"));
    return { id: suite.id, totals: counts(own), verdict: !applicable || fatal || cleanupMissing || metadataMissing ? "NO-GO" : incomplete.length ? "CONDITIONAL" : "GO" };
  });
  return { ...input, rows, gaps, accepted_risks: risks, verdict, suite_summaries, totals: counts(rows), assertion_totals: counts(assertions),
    fully_executed: rows.filter((row) => row.fully_executed).length,
    release_readiness: ["full", "readiness"].includes(input.scope) ? verdict : "NOT ASSESSED: scoped run only" };
}

const css = `:root{font:15px/1.55 system-ui,sans-serif;color:#18283f;background:#f2f5fa}
*{box-sizing:border-box}
body{margin:0}
main{max-width:1500px;margin:auto;padding:32px}
h1{margin:8px 0;font-size:30px}
h2{font-size:20px;margin-top:30px}
h3{font-size:16px}
p{max-width:110ch}
a{color:#164dae;overflow-wrap:anywhere}
code{overflow-wrap:anywhere}
small,.muted{color:#52627a}
.panel,.card{background:white;border:1px solid #d8e1ec;border-radius:10px;padding:18px;margin:14px 0}
.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px}
.card{margin:0}
.card strong{display:block;font-size:26px}
.badge{display:inline-block;border-radius:5px;padding:3px 9px;font-size:12px;font-weight:750;white-space:nowrap;background:#e5eaf2;color:#23344f}
.PASS,.GO{background:#d9f5e8;color:#075d3b}
.FAIL,.NO-GO{background:#ffe1df;color:#8b1c13}
.BLOCKED,.CONDITIONAL{background:#fff0c2;color:#704400}
.NOT_RUN{background:#e6eafa;color:#344383}
.NOT_APPLICABLE{background:#edf0f4;color:#46556a}
.scroll{overflow:auto}
table{border-collapse:collapse;width:100%;background:white}
th,td{padding:12px;text-align:left;vertical-align:top;border-bottom:1px solid #dfe6ef}
th{background:#edf2f8;font-size:12px}
td{min-width:100px}
td.detail{min-width:260px;max-width:680px;overflow-wrap:anywhere}
ul{padding-left:22px}
summary{cursor:pointer;font-weight:600}
input,select{font:inherit;border:1px solid #aab8cd;border-radius:5px;padding:9px;margin:4px 8px 4px 0}
input{min-width:270px}
details{margin-top:10px}
.private{border-left:5px solid #8b1c13}
.meta{overflow-wrap:anywhere}
footer{margin-top:26px;color:#52627a}
@media(max-width:640px){main{padding:16px}
h1{font-size:24px}
input{width:100%;min-width:0}
}
@media print{input,select,.controls{display:none}
main{padding:0}
details{display:block}
.scroll{overflow:visible}
table{font-size:10px}
th,td{padding:5px}
body{background:white}
}
@media(max-width:640px){
.scroll{overflow:visible}
table,tbody,tr,td{display:block;width:100%}
thead{display:none}
tr{border:1px solid #d8e1ec;border-radius:8px;margin:12px 0;background:white;overflow:hidden}
td,td.detail{min-width:0;max-width:none;padding:10px 14px}
td::before{content:attr(data-label);display:block;font-size:11px;font-weight:700;color:#52627a;margin-bottom:5px}
td:last-child{border-bottom:0}
}
`;
const browserScript = `const search=document.getElementById('search'),status=document.getElementById('status');function filter(){for(const row of document.querySelectorAll('tbody[data-cases] tr[data-status]'))row.hidden=!(row.textContent.toLowerCase().includes(search.value.toLowerCase())&&(!status.value||row.dataset.status===status.value));}search.addEventListener('input',filter);status.addEventListener('change',filter);`;
const badge = (status) => `<span class="badge ${escape(status)}">${escape(status)}</span>`;
const evidenceHtml = (items) => items.length ? `<ul>${items.map((e) => `<li><a href="${escape(e.href)}" target="_blank" rel="noopener noreferrer">${escape(e.label)}</a></li>`).join("")}</ul>` : '<p class="muted">No evidence recorded</p>';
const statusText = (totals) => statuses.map((s) => `${s}: ${totals[s]}`).join(" · ");

export function renderReport(input) {
  const report = normalizeReport(input);
  const hash = createHash("sha256").update(browserScript).digest("base64");
  const json = Buffer.from(JSON.stringify(report, null, 2)).toString("base64");
  const suites = report.suites.map((suite) => `<tr>
    <td data-label="Suite">${escape(suite.name)}<br><small>${escape(suite.id)} · ${escape(suite.visibility)}</small></td>
    <td data-label="Verdict">${badge(report.suite_summaries.find((s) => s.id === suite.id).verdict)}</td>
    <td class="meta" data-label="Repository">${escape(suite.repository ?? "Not recorded")}</td>
    <td class="meta" data-label="Baseline">${escape(suite.baseline_ref ?? "Not recorded")}</td>
    <td class="meta" data-label="Candidate">${escape(suite.source_ref ?? "Not recorded")}</td>
    <td class="meta" data-label="Plan / versions">${escape(suite.plan_ref ?? "Not recorded")}<br>${escape((suite.versions ?? []).join(" · "))}</td>
  </tr>`).join("");
  const rows = report.rows.map((row) => `<tr data-status="${row.status}">
    <td data-label="ID / suite"><code>${escape(row.id)}</code><br><small>${escape(row.suite)}${row.required === false ? " · optional" : " · required"}</small></td>
    <td data-label="Capability / context">${escape(row.capability)}<br><small>${escape(row.context ?? "")}</small></td>
    <td data-label="Status">${badge(row.status)}</td>
    <td class="detail" data-label="Detail / assertions">${escape(row.detail)}<details><summary>Assertions (${row.assertions.length})</summary>
      ${row.assertions.map((a) => `<div class="panel">
        <code>${escape(a.id)}</code> ${badge(a.status)}
        <p>${escape(a.label)}<br>${escape(a.detail ?? "")}</p>
        <small>${escape(a.evidence_kind ?? "Not executed")}</small>${evidenceHtml(a.evidence)}
      </div>`).join("")}
    </details></td>
    <td data-label="Case evidence">${row.evidence.length ? evidenceHtml(row.evidence) : '<span class="muted">See individual assertion evidence</span>'}</td>
    <td data-label="Automatic cleanup">${badge(row.cleanup.status)}<p>${escape(row.cleanup.detail ?? "")}</p>${row.cleanup.status === "NOT_APPLICABLE" ? "" : evidenceHtml(row.cleanup.evidence)}</td>
  </tr>`).join("");
  const cards = [["Planned cases", report.rows.length], ["Fully executed", report.fully_executed], ...statuses.map((s) => [s, report.totals[s]])]
    .map(([name, value]) => `<div class="card"><small>${escape(name)}</small><strong>${value}</strong></div>`).join("");
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'sha256-${hash}'; base-uri 'none'; form-action 'none'">
<title>${escape(report.title)}</title><style>${css}</style>
</head><body><main>
<small>REGRESSION VALIDATION · SCHEMA 1</small><h1>${escape(report.title)}</h1>
<div class="panel ${report.visibility === "private" ? "private" : ""}">
  <strong>${escape(report.visibility.toUpperCase())} · ${escape(report.scope)} · ${escape(report.run_id)}</strong>
  <p>Scope verdict: ${badge(report.verdict)}<br>Release readiness: <strong>${escape(report.release_readiness)}</strong></p>
  <p>Target: ${escape(report.target)}<br>Started: ${escape(report.started_at ?? "Not recorded")}<br>Finished: ${escape(report.finished_at ?? "Not recorded")}</p>
  <p>Coverage is limited to the declared plan. BLOCKED and NOT_RUN are incomplete. A scoped smoke result is not full release sign-off.</p>
  ${report.visibility === "private" ? "<strong>Private artifact: attach only to releases and storage with the same access boundary.</strong>" : "<strong>Public artifact: input and evidence must already be approved for public release.</strong>"}
</div>
<section class="cards">${cards}</section><p>Assertions — ${escape(statusText(report.assertion_totals))}</p>
<h2>Readiness gaps and accepted risks</h2>
${report.gaps.length ? `<ul>${report.gaps.map((gap) => `<li>${escape(gap)}</li>`).join("")}</ul>` : '<p class="muted">No metadata gaps recorded. See failed, blocked and unexecuted cases below.</p>'}
${report.accepted_risks.length ? `<ul>${report.accepted_risks.map((risk) => `<li>${escape(risk.case_id)}: ${escape(risk.reason)} — accepted by ${escape(risk.approver)}</li>`).join("")}</ul>` : "<p>No accepted risk exceptions recorded.</p>"}
<h2>Candidate and plan revisions</h2>
<div class="scroll"><table><thead><tr>
  <th>Suite</th><th>Verdict</th><th>Repository</th><th>Baseline</th><th>Candidate</th><th>Plan / versions</th>
</tr></thead><tbody>${suites}</tbody></table></div>
<h2>Full matrix disposition</h2>
<div class="controls">
  <label for="search">Search</label> <input id="search" type="search" placeholder="Case, capability or detail">
  <label for="status">Status</label> <select id="status"><option value="">All statuses</option>${statuses.map((s) => `<option>${s}</option>`).join("")}</select>
</div>
<div class="scroll"><table><thead><tr>
  <th>ID / suite</th><th>Capability / context</th><th>Status</th><th>Detail / assertions</th><th>Case evidence</th><th>Automatic cleanup</th>
</tr></thead><tbody data-cases>${rows}</tbody></table></div>
<footer>
  <a download="report.normalized.json" href="data:application/json;base64,${json}">Download embedded JSON</a>
  <p>Generated by render-regression-report.mjs · offline layout; evidence links require the companion files or authorized HTTPS storage. No tests or publication were performed by rendering.</p>
</footer></main><script>${browserScript}</script></body></html>`;
}

export function renderSummary(input) {
  const r = normalizeReport(input);
  const clean = (value) => String(value ?? "").replace(/[\r\n]/g, " ").replace(/[\\`*_\[\]<>#]/g, "\\$&");
  const incomplete = r.rows.filter((row) => !["PASS", "NOT_APPLICABLE"].includes(row.status));
  return [
    `Regression validation: ${clean(r.title)}`, "",
    `- Run: ${clean(r.run_id)}; scope: ${r.scope}; visibility: ${r.visibility}.`,
    `- Scope verdict: ${r.verdict}. Release readiness: ${r.release_readiness}.`,
    `- Cases: ${r.rows.length} planned; ${r.fully_executed} fully executed. ${statusText(r.totals)}`,
    `- Assertions: ${statusText(r.assertion_totals)}`,
    ...r.suites.map((s) => `- ${clean(s.name)}: ${r.suite_summaries.find((x) => x.id === s.id).verdict}; candidate ${clean(s.source_ref ?? "unknown")}; plan ${clean(s.plan_ref ?? "unknown")}.`),
    ...incomplete.slice(0, 10).map((row) => `- ${clean(row.id)}: ${row.status}${row.detail ? ` — ${clean(row.detail)}` : "."}`),
    ...(incomplete.length > 10 ? [`- ${incomplete.length - 10} more incomplete cases; see the full HTML disposition.`] : []),
    ...r.gaps.map((gap) => `- Gap: ${clean(gap)}.`), "",
    "Attach report.html and its evidence bundle. Rendering does not run tests or publish a release.", "",
  ].join("\n");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    demand(args.length === 4 && args[0] === "--input" && args[2] === "--output", "Usage: node scripts/render-regression-report.mjs --input RUN/report.json --output RUN/report.html");
    const input = JSON.parse(readFileSync(resolve(args[1]), "utf8"));
    const output = resolve(args[3]);
    const summaryOutput = resolve(dirname(output), `${basename(output, extname(output))}-summary.md`);
    demand(output !== resolve(args[1]) && summaryOutput !== resolve(args[1]), "Outputs must not overwrite the input report");
    demand(extname(output).toLowerCase() === ".html", "Output needs an .html extension");
    const html = renderReport(input);
    const summary = renderSummary(input);
    mkdirSync(dirname(output), { recursive: true });
    writeFileSync(output, html);
    writeFileSync(summaryOutput, summary);
    console.log(`Wrote ${output} and release summary; no tests or publication performed.`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
