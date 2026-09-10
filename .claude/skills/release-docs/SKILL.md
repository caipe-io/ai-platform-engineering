---
name: release-docs
description: >
  Generate a combined release blog post for ai-platform-engineering.
  Produces a single docs/releases/YYYY-MM-DD-release-X-Y-Z.md file containing
  release notes and the upgrade guide (migration guide) inline.
  Use when cutting a release, when a user asks "what changed in 0.4.x", or when
  upgrading their values.yaml to a new chart version.
---

# Release Blog Post Generator

Produce one combined blog post for an `ai-platform-engineering` release:

**`docs/releases/YYYY-MM-DD-release-X-Y-Z.md`** — release notes narrative
(highlights, what's new, bug fixes, breaking changes) followed by the full
upgrade guide (Helm values diff, step-by-step runbook, personal impact
analysis) as an embedded section.

The file is picked up by the Docusaurus `releases` blog plugin and published at
`/blog/releases/release-X.Y.Z`.

---

## Execution context

Runs in two modes:

- **Coding agent** (Claude Code, Cursor) with shell access — run `git` and `helm`
  commands directly and write the file to disk.
- **Chat-only** (CAIPE chat, Slack, web UI) — render output as a fenced markdown
  block the user can copy; note which commands to run manually.

Detect by whether a `Bash`/shell tool is available.

---

## Step 1 — Gather inputs

Ask the user for:

| Input | Example | Required |
|-------|---------|----------|
| **To version** | `0.4.9` | Yes |
| **From version** | `0.4.8` | Yes (defaults to previous tag) |
| **User's `values.yaml`** | paste or path | No — enables personal impact analysis |
| **Environment** | `dev` / `preview` / `prod` / `vm` | No — enables env-specific notes |

If from/to are not provided, detect from the repo:

```bash
git tag --sort=-version:refname | grep -E '^[0-9]+\.[0-9]+\.[0-9]+$' | head -2
```

---

## Step 2 — Collect raw data

Run all of the following in parallel where possible.

### 2a — Git log between versions

```bash
git log <from>..<to> --oneline --no-merges
```

Fetch full PR bodies for non-chore commits:

```bash
# for each PR number in the log, e.g. (#1324):
gh pr view <number> --json title,body,labels
```

### 2b — Helm values diff

```bash
CHART=oci://ghcr.io/caipe-io/charts/ai-platform-engineering
helm show values "$CHART" --version <from> > /tmp/values-from.yaml
helm show values "$CHART" --version <to>   > /tmp/values-to.yaml
diff -u /tmp/values-from.yaml /tmp/values-to.yaml
```

### 2c — Chart metadata

```bash
helm show chart "$CHART" --version <to>
```

### 2d — CHANGELOG.md

```bash
sed -n '/^## <to>/,/^## <from>/p' CHANGELOG.md
```

---

## Step 3 — Classify changes

### Classify git commits

| Type | Criteria |
|------|----------|
| **Feature** | `feat(*)` commits |
| **Fix** | `fix(*)` commits |
| **Security** | commits touching Dockerfile, securityContext, PSS/PSA |
| **Breaking** | commit body contains "BREAKING CHANGE" or PR label `breaking-change` |
| **Chore / Internal** | `chore`, `refactor`, `ci`, `test` — omit from user-facing notes |

### Classify Helm values diff lines

| Category | Criteria |
|----------|----------|
| **Breaking** | Key renamed, removed, or type changed |
| **New required** | New key with no default |
| **New optional** | New key with working default |
| **Deprecated** | Key still works but will be removed |
| **Default changed** | Same key, different default value |

---

## Step 4 — Write `docs/releases/YYYY-MM-DD-release-X-Y-Z.md`

Use the date the tag was pushed (or today's date if cutting now).

```markdown
---
slug: release-<to>
title: "Release <to> — <2-5 word subtitle capturing the biggest change>"
date: <YYYY-MM-DD>
authors: [sriaradhyula]
tags: [release]
---

## Highlights

<2-4 sentence narrative of the most significant changes in plain English.
Focus on operator/user impact, not internal implementation details.>

<!-- truncate -->

## What's New

### <Feature area 1>
- **<Title>** — <one-line description linking to PR #NNNN>

### <Feature area 2>
- ...

## Bug Fixes

- **<scope>**: <description> ([#NNNN](https://github.com/caipe-io/ai-platform-engineering/pull/NNNN))

## Security

<Any security-context, PSS, or CVE-related changes. Omit section if none.>

## Breaking Changes

<If none:>
No breaking changes. Drop-in upgrade from <from>.

## Known Issues

<If none:>
None known at this time.

---

## Upgrade Guide: <from> → <to>

### Overview

<One paragraph: overall theme, e.g. "Drop-in upgrade — no values.yaml edits required.">

### Helm Values Changes

<If no diff:>
No Helm values changes between <from> and <to>. Drop-in upgrade.

<If diff exists, use these subsections:>

#### Breaking Changes

**Affected key**: `global.foo.bar`

**Before (<from>)**:
```yaml
global:
  foo:
    bar: "old-value"
```

**After (<to>)**:
```yaml
global:
  foo:
    bar: "new-value"
```

**Action**: Update your `values.yaml`. If left unchanged, <consequence>.

#### New Optional Fields

| Env Var / Key | Default | Description |
|---------------|---------|-------------|
| `TOOL_CALL_LIMIT` | `0` (disabled) | Max tool invocations per run |

#### Deprecated / Removed Keys

| Key | Removed in | Replacement |
|-----|-----------|-------------|
| `tags.old-key` | <to> | `global.newKey` |

### Upgrade Runbook

#### 1. Update chart version

```bash
helm upgrade ai-platform-engineering \
  oci://ghcr.io/caipe-io/charts/ai-platform-engineering \
  --version <to> \
  -f your-values.yaml
```

#### 2. Apply values.yaml changes

<Paste exact diffs for each breaking change.>

#### 3. Verify

```bash
kubectl get pods -n <namespace>
```

### Personal Impact Analysis

<If user provided values.yaml: cross-reference against breaking-changes list.>
<If not: prompt them to provide it for a personalised checklist.>

### Full Values Diff

<details>
<summary>Raw diff (<from> → <to>)</summary>

```diff
<paste diff output>
```

</details>
```

---

## Step 5 — Write file to disk (coding agent)

```bash
mkdir -p docs/releases

cat > docs/releases/<YYYY-MM-DD>-release-<X-Y-Z>.md << 'EOF'
<generated content>
EOF
```

---

## Step 6 — Snapshot and prune Docusaurus versions (coding agent)

After writing the blog post, snapshot the current `docs/` tree as the new version
and prune old snapshots to stay within the retention policy.

**Retention policy**:
- Latest **5** releases from the current minor series (e.g. `0.4.7`–`0.4.11`)
- Highest release from **each previous minor series** (e.g. `0.3.11`, `0.2.x`)

Run from repo root:

```bash
NEW_VERSION=<to> node docs/scripts/snapshot-and-prune-versions.js
```

This script:
1. Runs `docusaurus docs:version <to>` — snapshots `docs/` into `versioned_docs/version-<to>/`
2. Prunes `versioned_docs/`, `versioned_sidebars/`, and `versions.json` to the retention policy
3. Updates `docs/versions-config.json` — sets `lastVersion`, marks `<to>` as `(Latest)`, removes pruned entries

Commit all release artifacts together:

```bash
git add docs/releases/<YYYY-MM-DD>-release-<X-Y-Z>.md
git add docs/versioned_docs/ docs/versioned_sidebars/
git add docs/versions.json docs/versions-config.json
git commit -s -m "docs: release <to> — blog post, docs snapshot, version prune"
```

---

## Guidelines

### Voice and audience

- **Write for end users, not operators or engineers.** The release notes section (Highlights, What's New, Bug Fixes) is read by people deciding whether to upgrade and by users discovering new capabilities. The Upgrade Guide section is the only place technical operator details belong.
- **Describe what users can do or what changed for them** — not how it was implemented. "Team members can now connect their own Slack channels" is good. "Non-admin users can self-serve `integration_panel_modes`" is not.
- **Describe bug fixes by the symptom users experienced**, not the root cause. "Users were randomly logged out in multi-replica deployments" is good. "Per-pod in-memory token Map replaced with MongoDB-backed L1+L2 store" is not.
- **No internal identifiers in release notes** — no API route paths, env var names, function names, internal module names, Helm key paths, or code-level details. Those belong only in the Upgrade Guide if they are operator-actionable.
- **Keep feature bullets short and outcome-focused.** One sentence: what you can do now that you couldn't before, or what problem went away.

### Structure and formatting

- `<!-- truncate -->` goes immediately after the Highlights section so the blog list shows just the intro paragraph
- Show concrete before/after YAML for every breaking change in the Upgrade Guide — never prose-only
- For breaking changes, state the *consequence* of not updating
- Keep the upgrade runbook linear — steps should be self-contained
- If `helm show values` is unavailable, ask the user to paste output — never guess
- Highlight environment-specific notes (VM kind clusters use `standard` storageClass; EKS uses `gp2`/`gp3`)
- For `ExternalSecret` additions, list the exact Vault path and key the chart now expects
- Omit `chore`, `ci`, `test`, and `refactor` commits from user-facing notes
- If there are zero helm value changes, say so explicitly and reassure it is a drop-in upgrade
- Do NOT create separate migration guide files — the upgrade guide lives inside the release post
