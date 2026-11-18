---
id: releases
title: Cutting a Release
sidebar_label: How to Cut a Release
sidebar_position: 3
description: Step-by-step guide for cutting a new ai-platform-engineering release — branch, tag, Helm chart, release notes, and docs update.
---

# Cutting a Release

## Overview

Releases follow this sequence:

```
main → release/x.y.z branch → RC tags → final x.y.z tag → Helm publish + docs
```

`auto-tag.yml` creates RC tags on release branches. `release-manual.yml` also
accepts explicit stable, RC, or hotfix versions from main. For stable tags,
`release-finalize.yml` publishes the draft GitHub Release automatically after
the required builds pass.

RC tags receive a published GitHub **Pre-release** after every required artifact
build succeeds for that tag's commit. Hotfix test tags remain artifacts only.
Neither channel updates `CHANGELOG.md` or the `latest` image alias.
RC Git tags are retained after stable releases and remain available in GitHub's
Tags tab.

---

## Step 1 — Create the release branch

```bash
git checkout main && git pull
git checkout -b release/x.y.z
git push origin release/x.y.z
```

Pushing the branch triggers `auto-tag.yml` which creates `x.y.z-rc.1`.

---

## Step 2 — Validate the RC

| Check | How |
|---|---|
| All CI green | GitHub Actions on the RC tag |
| Helm chart installs cleanly | `helm-chart-test.yml` run against the RC image |
| Smoke test on Kind | `make kind-up && make smoke-test VERSION=x.y.z-rc.1` |
| Feature regression and backward compatibility | Execute the applicable [regression matrix](../development/caipe-regression-suite.md) on the candidate; retain per-runtime, workflow, skill, bot, authorization and cleanup evidence |

Use `$caipe-regression-suite` for "run E2E regression" or "check release readiness".
Review exact CI jobs and skipped checks separately from live results. A smoke
pass or healthy deployment does not establish full release acceptance. Record
unexecuted/blocked cases and the matrix's GO / CONDITIONAL / NO-GO verdict before
finalization; keep a compatible baseline/promotion-revert plan.

If fixes are needed, merge them into the release branch — `auto-tag.yml` creates `x.y.z-rc.2`, `rc.3`, etc.

Each RC pre-release includes:

- Generated changes since the previous reachable RC in the same version series;
  the first RC uses the preceding reachable stable tag.
- A full comparison against that stable tag.
- Exact Helm and image installation commands and a link to open release blockers.

For example, `1.4.0-rc.7` compares against `1.4.0-rc.6`, with a second link for
all changes since `1.3.6`. An RC does not require a release blog post. Both manual
main promotions and release-branch tags use the same publication gate. Missing,
running, failed, skipped, or mismatched-commit required builds block RC publication.
Concurrent completion events are serialized; repeat events preserve published notes.

---

## Step 3 — Finalize the release

Merge the series release post and release branch into `main` before cutting the
stable version. The release-branch merge dispatches `release-manual.yml`; when a
manual dispatch is needed, run:

```bash
gh workflow run release-manual.yml \
  --repo caipe-io/ai-platform-engineering \
  -f version=x.y.z
```

Manual promotion supports these channels:

| Input | Result |
| --- | --- |
| `x.y.z-rc.N` | Versioned candidate images/chart; GitHub pre-release with RC changes and install commands after required builds pass; no stable changelog or `latest` update |
| `x.y.z-hotfix.N` | Versioned hotfix test images/chart; no GitHub Release, stable changelog, or `latest` update |
| `x.y.z` | Stable tag, draft GitHub Release, stable changelog, and eligibility for `latest` |

For example, run the same manual workflow with `version=1.4.0-rc.7`,
`version=1.4.1-hotfix.1`, or `version=1.4.1`. Exact tags cannot be reused;
candidate suffixes must increase within their base/channel. Promotion from
main requires `--ref main` and a base newer than the latest stable version.
`release-prerelease.yml` can build older-series hotfix **test artifacts** from a
release branch. Publishing an older-series **stable** version is not supported
by the current workflows.

A stable promotion creates a draft GitHub Release and folds candidate changes
into the stable changelog section. Tag-triggered CI builds the images and Helm chart; `release-finalize.yml`
publishes the release after those builds pass.

---

## Step 4 — Generate release docs

`docs-release.yml` is manually dispatched and accepts only stable `x.y.z`
versions (an optional leading `v` is normalized). RC, dev, hotfix, and canary
inputs are rejected before release-post metadata is generated. For a new minor
series, generate, review, and merge its post before the stable release step.

To run manually:

```bash
# In the docs worktree
/release-docs
```

The `/release-docs` skill maintains one post per minor series,
`docs/releases/YYYY-MM-DD-release-x-y-0.md`, with release notes and the upgrade guide
inline. Each post covers the cumulative diff since the previous minor's `.0`. An `x.y.0`
tag starts a new post; a patch tag updates the existing one instead of adding a post.

---

## Step 5 — Update docs surfaces

Run the `/update-docs` skill to sync all remaining docs surfaces:

```bash
/update-docs
```

This checks and fixes:

- Homepage Helm `--version` string in `docs/src/pages/index.tsx`
- Navbar version label

> **Versioned docs are no longer committed.** Pushing a release tag runs the
> `[Docs] Register Published Version` workflow, which adds the version to
> `docs/published-versions.json` (applying the retention policy) and opens a tiny
> auto-merging PR. The versioned snapshots are then materialised from release tags
> at build time by `docs/scripts/generate-versioned-docs.js` during the GitHub
> Pages deploy — nothing under `versioned_docs/` is stored in git.

See [Skills → Overview](./skills/) for the full checklist.

---

## Step 6 — Communicate

| Channel | What to post |
|---|---|
| CAIPE community Slack channel | Link to release blog post + one-line highlight |
| GitHub Discussions | Announce new release with upgrade notes link |
| Weekly community meeting | Demo new features if significant |

---

## Hotfix releases

For an urgent patch to the latest stable release, this example assumes `1.2.0`
is still the latest stable tag:

```bash
git fetch origin --tags
git checkout -b release/1.2.1-hotfix tags/1.2.0
# Apply the fix, commit, and push the branch.
# auto-tag creates 1.2.1-hotfix.1; validate those test artifacts.
```

1. Open and merge a PR containing the tested fix into `main`. A `-hotfix` branch
   merge is a merge-back of changes: it does not prepare or automatically publish
   a stable release.
2. Verify the merged fix is present on `main` and validate the merged source.
3. Recheck the latest stable tag, then promote a newer, unused version:

   ```bash
   gh workflow run release-manual.yml --ref main -f version=1.2.1
   ```

If the latest stable is already `1.4.0`, stable `1.2.1` publication is unsupported.
Merge the fix into `main` and release a newer version such as `1.4.1`. Older-series
hotfix tags remain useful for isolated testing, but they do not provide a stable
maintenance-release publication path.

Normal `release/x.y.z` merges automatically dispatch stable promotion. Check the
Actions run before manually dispatching again; never create two promotions for
the same version.

### Prepared changelog entries

- `CHANGELOG.md` sections for a version without a stable tag are generated from
  conventional commits. Preparing that version again regenerates its section to
  include commits added during review; hand-written lines in that section are
  replaced.
- Record change entries as conventional commits. Put curated summaries, migration
  instructions, and other hand-written release notes in the release post under
  `docs/releases/`; changelog generation does not rewrite that post.
- Published stable sections remain historical records and are preserved by
  incremental generation.
