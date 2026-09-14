#!/usr/bin/env node
// Generate an interactive HTML triage dashboard of OPEN GitHub issues,
// auto-classified by area + type. Reproducible replacement for the old
// hand-curated triage/caipe-open-issues-classification.html snapshot.
//
// Requires the GitHub CLI (`gh`) to be installed and authenticated.
//
// Usage:
//   node scripts/triage/classify-open-issues.mjs [--repo OWNER/NAME] [--out FILE] [--stale-days N]
//
// Defaults: --repo caipe-io/ai-platform-engineering  --out open-issues-classification.html  --stale-days 90
//
// assisted-by Cursor

import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";

// ---------- args ----------
const argv = process.argv.slice(2);
function arg(name, fallback) {
  const i = argv.indexOf(name);
  return i !== -1 && argv[i + 1] ? argv[i + 1] : fallback;
}
const REPO = arg("--repo", "caipe-io/ai-platform-engineering");
const OUT = arg("--out", "open-issues-classification.html");
const STALE_DAYS = parseInt(arg("--stale-days", "90"), 10);
const TAGS_N = parseInt(arg("--tags", "10"), 10); // last N final releases for the "Releases by area" view

// ---------- classification config ----------
// Bucketed display order for the "Issues by area" chart + filter pills.
const AREA_ORDER = [
  "Agent Arch/A2A", "Dynamic Agents", "RAG/KB", "RBAC/Auth", "Infra/NFR",
  "UI/Admin", "Bots/Webhooks", "LLM/Budget", "Persistence/Obs", "Docs/Misc",
];
const TYPE_LABEL = { bug: "Bug", feature: "Feature", arch: "Architecture", chore: "Chore", docs: "Docs", ops: "Ops" };

// Per-area colors for the stacked "Releases by area" bars + legend.
const AREA_COLOR = {
  "Agent Arch/A2A": "#4c8dff", "Dynamic Agents": "#b07cf0", "RAG/KB": "#3fb37f",
  "RBAC/Auth": "#e5534b", "Infra/NFR": "#d99b3d", "UI/Admin": "#45c4d6",
  "Bots/Webhooks": "#e08ac0", "LLM/Budget": "#7f8c99", "Persistence/Obs": "#c9d05b",
  "Docs/Misc": "#6b7480",
  "Runtime/Streaming": "#8f7bd6",
};

// Area heuristics: first match wins, evaluated against `${labels} ${title}`.
// Order matters — most specific buckets first.
const AREA_RULES = [
  ["RBAC/Auth", /\b(rbac|authz|authn|auth\b|keycloak|openfga|oidc|oauth|token[- ]?exchange|impersonat|permission|policy|jwks|rebac|tuple|broker)\b/i],
  ["RAG/KB", /\b(rag|ingest|embedding|vector|milvus|knowledge[- ]?base|\bkb\b|retrieval|ragas|deepeval|graph(rag)?|ontology|snippet|chunk)\b/i],
  ["Bots/Webhooks", /\b(slack|webex|bot\b|webhook|hitl|human[- ]?in[- ]?the[- ]?loop)\b/i],
  ["Dynamic Agents", /\b(dynamic agent|custom agent|task config|task builder|skills?middleware|persona|sub[- ]?agent)\b/i],
  ["LLM/Budget", /\b(llm|litellm|token (budget|quota)|quota|bedrock|model per agent|throttl|fallback model)\b/i],
  ["UI/Admin", /\b(ui\b|admin|dashboard|frontend|combobox|dropdown|pagination|skill builder|tab\b|modal|page\b|next\.?js|react)\b/i],
  ["Runtime/Streaming", /\b(a2a|langgraph|streaming|recursion|agent scaling|thread_id|compute worker|knative)\b/i],
  ["Infra/NFR", /\b(helm|kind\b|docker|kubernetes|\bpod\b|health check|liveness|readiness|auto[- ]?scal|kyverno|seccomp|security context|ansible|sandbox|resource (default|limit)|kustomize|setup-caipe)\b/i],
  ["Persistence/Obs", /\b(mongo|langfuse|checkpoint|schema|collection|long[- ]?term memory|observability|metric|telemetry|ttl)\b/i],
  ["Docs/Misc", /\b(docs?|documentation|tutorial|llms\.txt|release notes|readme|badge)\b/i],
];

// Type heuristics from labels (preferred) then title keywords.
function classifyType(labels, title) {
  const L = labels.map((s) => s.toLowerCase());
  if (L.some((l) => /bug|defect|regression/.test(l))) return "bug";
  if (L.some((l) => /doc/.test(l))) return "docs";
  if (L.some((l) => /enhancement|feature/.test(l))) return "feature";
  if (L.some((l) => /architecture|design|spike|research|epic/.test(l))) return "arch";
  if (L.some((l) => /chore|cleanup|tech[- ]?debt|test|\bci\b/.test(l))) return "chore";
  const t = title.toLowerCase();
  if (/\b(fix|bug|broken|crash|fails?|error|incorrect|regression|leak|balloon|not working|doesn'?t)\b/.test(t)) return "bug";
  if (/\b(refactor|architecture|design|investigate|research|spike|rework|move .* behind|simplify)\b/.test(t)) return "arch";
  if (/\b(docs?|document|tutorial|readme|release notes)\b/.test(t)) return "docs";
  if (/\b(quota|budget increase|token .* increase)\b/.test(t)) return "ops";
  if (/\b(cleanup|clean[- ]?up|audit|drop old|prune|remove stale|testing the)\b/.test(t)) return "chore";
  return "feature";
}

function classifyArea(labels, title) {
  const hay = `${labels.join(" ")} ${title}`;
  for (const [area, re] of AREA_RULES) if (re.test(hay)) return area;
  return "Docs/Misc";
}

// ---------- fetch ----------
function fetchIssues() {
  // gh api paginates; issues endpoint includes PRs, so filter them out.
  const raw = execFileSync(
    "gh",
    ["api", "--paginate", `repos/${REPO}/issues?state=open&per_page=100`,
     "--jq", ".[] | select(.pull_request == null) | {number,title,labels:[.labels[].name],milestone:(.milestone.title // null),updated_at,created_at,comments,assignees:[.assignees[].login]}"],
    { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }
  );
  // --jq emits one JSON object per line.
  return raw.trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
}

// Release-bot / version-bump noise we never want counted as feature work.
const RELEASE_NOISE = /^chore\(release\)|^chore: (bump|release)|^bump|^docs: publish|^chore: bump version/i;

// Last N final releases (X.Y.Z, no -rc), oldest->newest. Each release's area
// breakdown is built from the *git commit range* (prevTag..tag] — the only
// reliable per-release signal in this repo. (GitHub's auto release-notes are
// unreliable here: some tags have no "What's Changed" list and others mis-detect
// their base and list hundreds of out-of-range PRs.) Commit subjects also can't
// be mapped back to PR numbers (squash merges carry no `(#N)`), so the drill-down
// shows commit subjects rather than PR links. Returns [] when git is unavailable.
function fetchReleases(n) {
  let tags;
  try {
    tags = execFileSync("git", ["tag"], { encoding: "utf8" })
      .split("\n")
      .filter((t) => /^[0-9]+\.[0-9]+\.[0-9]+$/.test(t))
      .sort((a, b) => a.split(".").map(Number).reduce((acc, v, i) => acc || v - b.split(".").map(Number)[i], 0));
  } catch {
    return [];
  }
  const window = tags.slice(-(n + 1)); // n ranges => n+1 tags
  const out = [];
  for (let i = 1; i < window.length; i++) {
    const prev = window[i - 1], tag = window[i];
    let subjects = [];
    try {
      subjects = execFileSync("git", ["log", `${prev}..${tag}`, "--no-merges", "--format=%s"], { encoding: "utf8" })
        .split("\n").filter(Boolean);
    } catch { /* unreachable range */ }
    const commits = subjects
      .filter((s) => !RELEASE_NOISE.test(s))
      .map((s) => ({ title: s, area: classifyArea([], s) }));
    const byArea = {};
    for (const c of commits) byArea[c.area] = (byArea[c.area] || 0) + 1;
    out.push({ tag, prev, total: commits.length, byArea, commits });
  }
  return out;
}

// ---------- build ----------
const now = Date.now();
const staleMs = STALE_DAYS * 24 * 60 * 60 * 1000;

const issues = fetchIssues().map((i) => {
  const type = classifyType(i.labels, i.title);
  const area = classifyArea(i.labels, i.title);
  const ageDays = Math.floor((now - Date.parse(i.updated_at)) / 86400000);
  return {
    n: i.number,
    t: i.title,
    area,
    type,
    labels: i.labels,
    milestone: i.milestone, // target release (GitHub milestone) or null
    assignees: i.assignees,
    age: ageDays,
    stale: now - Date.parse(i.updated_at) > staleMs,
  };
});

// Always embed up to 20 releases so the in-page slider can scale without
// re-running; --tags sets the initial number shown (clamped to 1..available).
const REL_MAX = 20;
const releases = fetchReleases(REL_MAX);
const relInitN = Math.max(1, Math.min(TAGS_N, releases.length));

const generated = new Date().toISOString().replace("T", " ").slice(0, 16) + " UTC";
const DATA = JSON.stringify(issues);
const RELEASES = JSON.stringify(releases);

// ---------- HTML (self-contained, interactive) ----------
const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>CAIPE Open Issues — Classification</title>
<style>
  :root {
    --bg:#0d0f12; --panel:#15181d; --panel-2:#1b1f26; --stroke:#2a2f38;
    --text:#e6e9ee; --text-2:#aab2bf; --text-3:#6b7480; --accent:#4c8dff;
    --bug:#e5534b; --feature:#4c8dff; --arch:#b07cf0; --chore:#d99b3d; --docs:#3fb37f; --ops:#8a93a0; --warn:#d99b3d;
  }
  * { box-sizing:border-box; }
  body { margin:0; background:var(--bg); color:var(--text); font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif; padding:28px; }
  .wrap { max-width:1120px; margin:0 auto; }
  h1 { font-size:24px; margin:0 0 4px; font-weight:650; }
  h2 { font-size:16px; margin:28px 0 12px; font-weight:600; }
  .caption { color:var(--text-3); font-size:12px; margin:0 0 20px; }
  a { color:var(--accent); text-decoration:none; }
  a:hover { text-decoration:underline; }
  .stats { display:grid; grid-template-columns:repeat(6,1fr); gap:12px; margin-bottom:18px; }
  .stat { background:var(--panel); border:1px solid var(--stroke); border-radius:8px; padding:12px 14px; }
  .stat .v { font-size:22px; font-weight:650; }
  .stat .l { font-size:11px; color:var(--text-3); text-transform:uppercase; letter-spacing:.04em; margin-top:2px; }
  .stat.bug .v { color:var(--bug); } .stat.feature .v { color:var(--feature); } .stat.warn .v { color:var(--warn); }
  .callout { background:rgba(76,141,255,.08); border:1px solid rgba(76,141,255,.4); border-radius:8px; padding:12px 14px; margin-bottom:8px; }
  .callout .t { color:var(--accent); font-weight:600; margin-bottom:2px; }
  .callout p { margin:0; color:var(--text-2); }
  .chart { display:flex; flex-direction:column; gap:7px; }
  .barrow { display:grid; grid-template-columns:140px 1fr 40px; align-items:center; gap:10px; }
  .barrow .name { color:var(--text-2); font-size:12px; text-align:right; }
  .barrow .track { background:var(--panel-2); border-radius:4px; height:20px; overflow:hidden; }
  .barrow .fill { background:var(--accent); height:100%; border-radius:4px; }
  .barrow .num { color:var(--text-2); font-size:12px; }
  .filters { display:flex; flex-direction:column; gap:8px; margin:6px 0 14px; }
  .filterline { display:flex; flex-wrap:wrap; gap:6px; align-items:center; }
  .flabel { width:46px; color:var(--text-3); font-size:12px; }
  .pill { border:1px solid var(--stroke); background:transparent; color:var(--text-2); border-radius:999px; padding:3px 11px; font-size:12px; cursor:pointer; user-select:none; }
  .pill:hover { border-color:var(--text-3); }
  .pill.active { background:var(--accent); border-color:var(--accent); color:#fff; }
  .pill.t-bug.active { background:var(--bug); border-color:var(--bug); }
  .pill.t-feature.active { background:var(--feature); border-color:var(--feature); }
  .pill.t-arch.active { background:var(--arch); border-color:var(--arch); }
  .pill.t-chore.active { background:var(--chore); border-color:var(--chore); }
  .pill.t-docs.active { background:var(--docs); border-color:var(--docs); }
  .pill.t-ops.active { background:var(--ops); border-color:var(--ops); }
  table { width:100%; border-collapse:collapse; border:1px solid var(--stroke); border-radius:8px; overflow:hidden; }
  thead th { background:var(--panel); text-align:left; font-size:11px; text-transform:uppercase; letter-spacing:.04em; color:var(--text-3); padding:9px 12px; position:sticky; top:0; }
  tbody td { padding:8px 12px; border-top:1px solid var(--stroke); vertical-align:top; }
  tbody tr.bug td { background:rgba(229,83,75,.05); }
  tbody tr.stale td { background:rgba(217,155,61,.06); }
  .tag { display:inline-block; border-radius:999px; padding:1px 8px; font-size:11px; font-weight:600; }
  .tag.bug { color:var(--bug); border:1px solid var(--bug); }
  .tag.feature { color:var(--feature); border:1px solid var(--feature); }
  .tag.arch { color:var(--arch); border:1px solid var(--arch); }
  .tag.chore { color:var(--chore); border:1px solid var(--chore); }
  .tag.docs { color:var(--docs); border:1px solid var(--docs); }
  .tag.ops { color:var(--ops); border:1px solid var(--ops); }
  .flag { display:inline-block; border-radius:999px; padding:1px 7px; font-size:10px; margin:0 4px 2px 0; }
  .flag.stale { color:var(--warn); border:1px solid rgba(217,155,61,.5); }
  .flag.ms { color:var(--accent); border:1px solid rgba(76,141,255,.5); }
  .flag.lbl { color:var(--text-3); border:1px solid var(--stroke); }
  .status { color:var(--text-2); font-size:12px; }
  .muted { color:var(--text-3); }
  .count { color:var(--text-2); font-size:12px; margin-bottom:6px; }
  /* Releases-by-area stacked bars */
  .relchart { display:flex; flex-direction:column; gap:8px; }
  .relrow { display:grid; grid-template-columns:70px 1fr 46px; align-items:center; gap:10px; }
  .relrow .rtag { color:var(--text-2); font-size:12px; text-align:right; font-variant-numeric:tabular-nums; }
  .relrow .rtotal { color:var(--text-3); font-size:12px; }
  .relbar { display:flex; height:22px; background:var(--panel-2); border-radius:4px; overflow:hidden; }
  .relseg { height:100%; }
  .relseg:hover { outline:1px solid rgba(255,255,255,.35); outline-offset:-1px; }
  .relrow.clickable { cursor:pointer; padding:2px 4px; margin:0 -4px; border-radius:6px; }
  .relrow.clickable:hover { background:var(--panel-2); }
  .relrow .rtag .caret { color:var(--text-3); margin-left:4px; font-size:10px; }
  .relrow.open .rtag .caret { color:var(--accent); }
  .relpanel { margin:2px 0 8px 80px; border-left:2px solid var(--stroke); padding:4px 0 4px 12px; display:flex; flex-direction:column; gap:6px; }
  .relpanel .pgroup { font-size:11px; color:var(--text-3); text-transform:uppercase; letter-spacing:.04em; margin-top:4px; }
  .pritem { display:flex; align-items:baseline; gap:8px; font-size:13px; line-height:1.35; }
  .pritem .prdot { width:8px; height:8px; border-radius:2px; flex:none; transform:translateY(1px); }
  .pritem a { color:var(--accent); text-decoration:none; font-variant-numeric:tabular-nums; flex:none; }
  .pritem a:hover { text-decoration:underline; }
  .pritem .prtitle { color:var(--text); }
  .pritem .prby { color:var(--text-3); }
  .relsrc { font-size:11px; color:var(--text-3); font-style:italic; }
  .legend { display:flex; flex-wrap:wrap; gap:10px 16px; margin:10px 0 4px; }
  .legend .item { display:flex; align-items:center; gap:6px; color:var(--text-2); font-size:12px; }
  .legend .sw { width:11px; height:11px; border-radius:3px; display:inline-block; }
  .relctl { display:flex; flex-wrap:wrap; align-items:center; gap:16px; margin:4px 0 12px; }
  .relctl .grp { display:flex; align-items:center; gap:8px; }
  .relctl label { color:var(--text-3); font-size:12px; }
  .relctl input[type=range] { width:180px; accent-color:var(--accent); }
  .relctl .nval { color:var(--text); font-size:13px; font-variant-numeric:tabular-nums; min-width:20px; }
  .toggle { display:inline-flex; border:1px solid var(--stroke); border-radius:999px; overflow:hidden; }
  .toggle button { background:transparent; color:var(--text-2); border:0; padding:4px 14px; font-size:12px; cursor:pointer; }
  .toggle button.active { background:var(--accent); color:#fff; }
  .pie-wrap { display:flex; flex-wrap:wrap; align-items:center; gap:28px; }
  .pie-legend { display:flex; flex-direction:column; gap:6px; }
  .pie-legend .item { display:flex; align-items:center; gap:8px; color:var(--text-2); font-size:13px; }
  .pie-legend .sw { width:12px; height:12px; border-radius:3px; }
  .pie-legend .pct { color:var(--text-3); font-variant-numeric:tabular-nums; }
</style>
</head>
<body>
<div class="wrap">
  <h1>CAIPE Open Issues — Classification</h1>
  <p class="caption" id="caption"></p>
  <div class="stats" id="stats"></div>
  <div class="callout">
    <div class="t">Auto-generated snapshot</div>
    <p>Areas and types are heuristically derived from GitHub labels + title keywords; verify before acting.
       Re-run <code>scripts/triage/classify-open-issues.mjs</code> to refresh.</p>
  </div>
  <h2>Issues by area</h2>
  <div class="chart" id="chart"></div>
  <div id="relsection" style="display:none">
    <h2>Releases by area <span class="muted" style="font-weight:400;font-size:13px" id="reltitle"></span></h2>
    <div class="relctl">
      <div class="grp">
        <label for="relN">Releases</label>
        <input type="range" id="relN" min="1" max="2" value="1" />
        <span class="nval" id="relNval">1</span>
      </div>
      <div class="grp">
        <span class="toggle" id="relmode">
          <button data-mode="bars" class="active">Bars</button>
          <button data-mode="pie">Pie</button>
        </span>
      </div>
    </div>
    <div id="relbody"></div>
  </div>
  <h2>Browse</h2>
  <div class="filters">
    <div class="filterline"><span class="flabel">Area</span><span id="areaPills"></span></div>
    <div class="filterline"><span class="flabel">Type</span><span id="typePills"></span></div>
    <div class="filterline"><span class="flabel">Release</span><span id="relPills"></span></div>
  </div>
  <div class="count" id="count"></div>
  <table>
    <thead><tr><th>Issue</th><th>Type</th><th>Title</th><th>Labels / flags</th><th>Last update</th></tr></thead>
    <tbody id="tbody"></tbody>
  </table>
</div>
<script>
const REPO = "https://github.com/${REPO}/issues";
const GENERATED = ${JSON.stringify(generated)};
const TYPE_LABEL = ${JSON.stringify(TYPE_LABEL)};
const AREA_ORDER = ${JSON.stringify(AREA_ORDER)};
const AREA_COLOR = ${JSON.stringify(AREA_COLOR)};
const ISSUES = ${DATA};
const RELEASES = ${RELEASES};
const REL_INIT_N = ${relInitN};
const NO_MILESTONE = "\\u0000none"; // sentinel for "Unscheduled" (no milestone)
let fArea = "All", fType = "All", fRelease = "All";
let relMode = "bars", relN = REL_INIT_N;
let relExpanded = new Set(); // release tags whose PR drill-down is open

// Distinct milestones present on open issues, version-sorted desc (newest first).
function milestoneOrder() {
  const set = new Set(ISSUES.map(i => i.milestone).filter(Boolean));
  return [...set].sort((a, b) => {
    const pa = a.split(".").map(Number), pb = b.split(".").map(Number);
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
      const d = (pb[i] || 0) - (pa[i] || 0); if (d) return d;
    }
    return a < b ? 1 : -1;
  });
}
function esc(s){ return String(s).replace(/[&<>"]/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c])); }
function render() {
  const total = ISSUES.length;
  const byType = t => ISSUES.filter(i => i.type === t).length;
  const stale = ISSUES.filter(i => i.stale).length;
  document.getElementById("caption").textContent =
    "Source: ${REPO} · " + total + " open issues · generated " + GENERATED;
  const stats = [
    ["",total,"Open total"],["bug",byType("bug"),"Bugs"],["feature",byType("feature"),"Features"],
    ["",byType("arch"),"Architecture"],["warn",stale,"Stale (>${STALE_DAYS}d)"],["",byType("docs")+byType("chore")+byType("ops"),"Docs/Chore/Ops"],
  ];
  document.getElementById("stats").innerHTML = stats.map(([c,v,l]) =>
    '<div class="stat '+c+'"><div class="v">'+v+'</div><div class="l">'+l+'</div></div>').join("");
  const counts = {}; ISSUES.forEach(i => counts[i.area] = (counts[i.area]||0)+1);
  const cats = AREA_ORDER.filter(a => counts[a]);
  const max = Math.max(1, ...cats.map(a => counts[a]));
  document.getElementById("chart").innerHTML = cats.map(a =>
    '<div class="barrow"><div class="name">'+esc(a)+'</div><div class="track"><div class="fill" style="width:'+(counts[a]/max*100).toFixed(1)+'%"></div></div><div class="num">'+counts[a]+'</div></div>').join("");
  document.getElementById("areaPills").innerHTML =
    '<button class="pill '+(fArea==="All"?"active":"")+'" data-area="All">All ('+total+')</button>' +
    cats.map(a => '<button class="pill '+(fArea===a?"active":"")+'" data-area="'+esc(a)+'">'+esc(a)+' ('+counts[a]+')</button>').join("");
  document.getElementById("typePills").innerHTML =
    '<button class="pill '+(fType==="All"?"active":"")+'" data-type="All">All</button>' +
    Object.keys(TYPE_LABEL).map(t => '<button class="pill t-'+t+' '+(fType===t?"active":"")+'" data-type="'+t+'">'+TYPE_LABEL[t]+'</button>').join("");
  // release (milestone) pills
  const mers = milestoneOrder();
  const mCount = m => ISSUES.filter(i => i.milestone === m).length;
  const noneCount = ISSUES.filter(i => !i.milestone).length;
  document.getElementById("relPills").innerHTML =
    '<button class="pill '+(fRelease==="All"?"active":"")+'" data-rel="All">All</button>' +
    mers.map(m => '<button class="pill '+(fRelease===m?"active":"")+'" data-rel="'+esc(m)+'">'+esc(m)+' ('+mCount(m)+')</button>').join("") +
    (noneCount ? '<button class="pill '+(fRelease===NO_MILESTONE?"active":"")+'" data-rel="'+NO_MILESTONE+'">Unscheduled ('+noneCount+')</button>' : "");
  const relMatch = i => fRelease==="All" || (fRelease===NO_MILESTONE ? !i.milestone : i.milestone===fRelease);
  const rows = ISSUES.filter(i => (fArea==="All"||i.area===fArea) && (fType==="All"||i.type===fType) && relMatch(i)).sort((a,b)=>b.n-a.n);
  const relTxt = fRelease==="All" ? "" : (fRelease===NO_MILESTONE ? " · Unscheduled" : " · "+fRelease);
  document.getElementById("count").textContent =
    "Showing "+rows.length+" of "+total + (fArea!=="All"?" · "+fArea:"") + (fType!=="All"?" · "+TYPE_LABEL[fType]:"") + relTxt;
  document.getElementById("tbody").innerHTML = rows.map(i => {
    const cls = i.stale ? "stale" : (i.type==="bug" ? "bug" : "");
    const lbls = (i.labels||[]).slice(0,4).map(l => '<span class="flag lbl">'+esc(l)+'</span>').join("");
    const ms = i.milestone ? '<span class="flag ms">'+esc(i.milestone)+'</span>' : "";
    const flags = (i.stale?'<span class="flag stale">stale</span>':"") + ms + lbls;
    return '<tr class="'+cls+'">'+
      '<td><a href="'+REPO+'/'+i.n+'" target="_blank" rel="noopener">#'+i.n+'</a></td>'+
      '<td><span class="tag '+i.type+'">'+TYPE_LABEL[i.type]+'</span></td>'+
      '<td>'+esc(i.t)+'</td>'+
      '<td>'+(flags||'<span class="muted">—</span>')+'</td>'+
      '<td><span class="status">'+i.age+'d ago</span></td></tr>';
  }).join("");
}
// Last relN releases, newest first.
function selectedReleases() { return RELEASES.slice(-relN).reverse(); }

// Drill-down: list a release's commits grouped by area (prev..tag range).
function renderRelPanel(r) {
  if (!r.commits || !r.commits.length) {
    return '<div class="relpanel"><div class="relsrc">No non-bump commits in '+esc(r.prev)+'..'+esc(r.tag)+'.</div></div>';
  }
  const groups = AREA_ORDER.filter(a => r.commits.some(c => c.area === a)).map(a => {
    const items = r.commits.filter(c => c.area === a).map(c =>
      '<div class="pritem"><span class="prdot" style="background:'+AREA_COLOR[a]+'"></span>'+
      '<span class="prtitle">'+esc(c.title)+'</span></div>').join("");
    return '<div class="pgroup">'+esc(a)+'</div>'+items;
  }).join("");
  const note = '<div class="relsrc" style="margin-bottom:4px">'+r.total+' commits in '+esc(r.prev)+'..'+esc(r.tag)+'</div>';
  return '<div class="relpanel">'+note+groups+'</div>';
}

function renderRelBars(rows) {
  const present = AREA_ORDER.filter(a => rows.some(r => r.byArea[a]));
  const legend = present.map(a =>
    '<span class="item"><span class="sw" style="background:'+AREA_COLOR[a]+'"></span>'+esc(a)+'</span>').join("");
  const bars = rows.map(r => {
    const segs = AREA_ORDER.filter(a => r.byArea[a]).map(a => {
      const pct = (r.byArea[a] / Math.max(1, r.total) * 100).toFixed(2);
      return '<div class="relseg" style="width:'+pct+'%;background:'+AREA_COLOR[a]+'" title="'+esc(a)+': '+r.byArea[a]+'"></div>';
    }).join("");
    const open = relExpanded.has(r.tag);
    const caret = '<span class="caret">'+(open ? '\\u25be' : '\\u25b8')+'</span>';
    const row = '<div class="relrow clickable'+(open?' open':'')+'" data-tag="'+esc(r.tag)+'">'+
      '<div class="rtag">'+esc(r.tag)+caret+'</div>'+
      '<div class="relbar">'+segs+'</div><div class="rtotal">'+r.total+'</div></div>';
    return row + (open ? renderRelPanel(r) : "");
  }).join("");
  const hint = '<div class="relsrc" style="margin-bottom:6px">Click a release to see the commits that shipped in it (by area).</div>';
  return '<div class="legend">'+legend+'</div>'+hint+'<div class="relchart">'+bars+'</div>';
}

function renderRelPie(rows) {
  // aggregate area counts across the selected releases
  const agg = {}; let total = 0;
  rows.forEach(r => AREA_ORDER.forEach(a => { if (r.byArea[a]) { agg[a] = (agg[a]||0)+r.byArea[a]; total += r.byArea[a]; } }));
  const present = AREA_ORDER.filter(a => agg[a]).sort((a,b) => agg[b]-agg[a]);
  const cx=110, cy=110, r=100; let ang=-Math.PI/2; // start at 12 o'clock
  const slices = present.map(a => {
    const frac = agg[a]/Math.max(1,total), a0=ang, a1=ang+frac*2*Math.PI; ang=a1;
    const large = (a1-a0) > Math.PI ? 1 : 0;
    const x0=cx+r*Math.cos(a0), y0=cy+r*Math.sin(a0), x1=cx+r*Math.cos(a1), y1=cy+r*Math.sin(a1);
    // full-circle guard when a single area is 100%
    if (frac >= 0.999) return '<circle cx="'+cx+'" cy="'+cy+'" r="'+r+'" fill="'+AREA_COLOR[a]+'"></circle>';
    return '<path d="M'+cx+','+cy+' L'+x0.toFixed(2)+','+y0.toFixed(2)+' A'+r+','+r+' 0 '+large+' 1 '+x1.toFixed(2)+','+y1.toFixed(2)+' Z" fill="'+AREA_COLOR[a]+'"></path>';
  }).join("");
  const svg = '<svg width="220" height="220" viewBox="0 0 220 220">'+slices+
    '<circle cx="'+cx+'" cy="'+cy+'" r="52" fill="var(--bg)"></circle>'+
    '<text x="'+cx+'" y="'+(cy-4)+'" text-anchor="middle" fill="var(--text)" font-size="26" font-weight="650">'+total+'</text>'+
    '<text x="'+cx+'" y="'+(cy+16)+'" text-anchor="middle" fill="var(--text-3)" font-size="11">commits</text></svg>';
  const legend = '<div class="pie-legend">'+present.map(a =>
    '<span class="item"><span class="sw" style="background:'+AREA_COLOR[a]+'"></span>'+esc(a)+
    ' <span class="pct">'+agg[a]+' · '+(agg[a]/Math.max(1,total)*100).toFixed(0)+'%</span></span>').join("")+'</div>';
  return '<div class="pie-wrap">'+svg+legend+'</div>';
}

function renderReleases() {
  if (!RELEASES.length) return;
  document.getElementById("relsection").style.display = "";
  const slider = document.getElementById("relN");
  slider.max = String(RELEASES.length);
  slider.value = String(relN);
  document.getElementById("relNval").textContent = String(relN);
  const rows = selectedReleases();
  const oldest = rows[rows.length-1], newest = rows[0];
  document.getElementById("reltitle").textContent =
    "· last " + relN + " release" + (relN>1?"s":"") + " (" + oldest.prev + " → " + newest.tag + ", by merged commits)";
  document.getElementById("relbody").innerHTML = relMode === "pie" ? renderRelPie(rows) : renderRelBars(rows);
  document.querySelectorAll("#relmode button").forEach(b =>
    b.classList.toggle("active", b.dataset.mode === relMode));
}

document.addEventListener("click", e => {
  const pill = e.target.closest("button.pill");
  if (pill) {
    if (pill.dataset.area !== undefined) fArea = pill.dataset.area;
    if (pill.dataset.type !== undefined) fType = pill.dataset.type;
    if (pill.dataset.rel !== undefined) fRelease = pill.dataset.rel;
    render();
    return;
  }
  const mode = e.target.closest("#relmode button");
  if (mode) { relMode = mode.dataset.mode; renderReleases(); return; }
  const relrow = e.target.closest(".relrow.clickable");
  if (relrow) {
    const tag = relrow.dataset.tag;
    if (relExpanded.has(tag)) relExpanded.delete(tag); else relExpanded.add(tag);
    renderReleases();
  }
});
document.addEventListener("input", e => {
  if (e.target.id === "relN") { relN = parseInt(e.target.value, 10); renderReleases(); }
});
render();
renderReleases();
</script>
</body>
</html>
`;

writeFileSync(OUT, html);
const counts = {};
issues.forEach((i) => (counts[i.area] = (counts[i.area] || 0) + 1));
console.error(`Wrote ${OUT} — ${issues.length} open issues from ${REPO}`);
console.error("By area: " + AREA_ORDER.filter((a) => counts[a]).map((a) => `${a}=${counts[a]}`).join("  "));
