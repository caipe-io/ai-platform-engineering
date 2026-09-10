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

The `auto-tag.yml` workflow handles tag creation automatically. A human triggers `release-finalize.yml` to promote an RC to a stable release.

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

If fixes are needed, merge them into the release branch — `auto-tag.yml` creates `x.y.z-rc.2`, `rc.3`, etc.

---

## Step 3 — Finalize the release

Trigger `release-finalize.yml` via GitHub Actions or CLI:

```bash
gh workflow run release-finalize.yml \
  --repo caipe-io/ai-platform-engineering \
  -f version=x.y.z
```

This workflow:
- Promotes `x.y.z-rc.N` → `x.y.z`
- Publishes the Helm chart to `oci://ghcr.io/caipe-io/charts/ai-platform-engineering`
- Creates a GitHub Release with auto-generated notes

---

## Step 4 — Generate release docs

`docs-release.yml` triggers automatically on the `x.y.z` tag and opens a PR with a generated release blog post. Review and merge it.

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

For urgent fixes on an already-released version:

```bash
git checkout -b release/x.y.z-hotfix tags/x.y.z
# apply fix, push
# auto-tag creates x.y.z-hotfix.1
# when ready:
gh workflow run release-manual.yml -f version=x.y.z.1
```
