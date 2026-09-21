---
sidebar_position: 6
---

# CI/CD and Releases

This page is the map for the repo's CI/CD flow: prebuild artifacts, the `canary` main tag, RC/hotfix tags, and final releases.

## The Release Ladder

Every image and Helm chart carries the same tag, so you can tell how stable a build is just by looking at it. RCs and hotfixes both graduate into a final release using the same steps — see [Final Release Flow](#final-release-flow) below.

| Tag | Stage | Created from | Meaning |
| --- | --- | --- | --- |
| `canary` | Alpha | every merge to `main` | Always the newest main build. Gets replaced on every merge — don't rely on it staying the same. |
| `x.y.z-rc.N` | Beta | every push to `release/x.y.z` | A release candidate. Fixed — never changes once created. |
| `x.y.z-hotfix.N` | Beta (patch) | every push to `release/x.y.z-hotfix` | A candidate fix for a version that already shipped. Fixed — never changes once created. |
| `x.y.z` | Stable | `release-manual.yml` | The production release. Also tagged `latest`. Fixed — never changes once created. |

Chart version and image tag always match — with one exception. Helm requires a chart's `version` field to be strict SemVer, and `canary` isn't, so the canary chart is packaged as `0.0.0-canary` instead. Its `appVersion` still reads `canary`, so it still deploys the matching `canary` images by default.

## Artifact Locations

| Artifact type | Flow | Registry path |
| --- | --- | --- |
| Docker images | all release and prebuild flows | `ghcr.io/caipe-io/<image>` |
| Helm charts | all release and prebuild flows | `ghcr.io/caipe-io/charts` |

## PR Flow

`pr-version-bump.yml` runs on every PR targeting `main` or `release/**`:

1. Checks whether the PR branch contains the latest base branch and whether GitHub reports merge conflicts, posting an update comment and failing the check if not.
2. Applies a PR flow label such as `dev`, `0.4.0`, `0.4.0-hotfix`, or `release/0.4.0`.
3. For a `release/x.y.z -> main` PR specifically, uses `.github/actions/prepare-release/action.yml` to commit the final `x.y.z` version files and changelog onto that PR branch ahead of merge.

Ordinary PRs get no commit — prebuild and canary tags are worked out fresh at build time instead of being written into the repo.

## Docker and Helm Image CI

Every image and chart workflow (`ci-*.yml`, `ci-helm.yml` — see the reference table below) triggers on two ref shapes:

- **Push to `main`** — builds `canary`, but only for the component(s) whose own paths actually changed in that push. A docs-only or single-component merge does not rebuild everything.
- **Push of a tag** (`x.y.z`, `x.y.z-rc.N`, `x.y.z-hotfix.N`) — builds every component fresh, regardless of which paths changed. This is what makes an RC or final release a complete, reproducible artifact set.

Each workflow figures out its own tag via `.github/actions/determine-release-tag/action.yml`: `canary` for a main push, the pushed tag for a tag push, or whatever you typed in if you triggered the build by hand.

## Prebuild Artifacts

Prebuild artifacts let you test Docker images or Helm charts from a PR before it merges, without waiting for an official tag.

1. Create a branch called `prebuild/*`, for example `prebuild/feat/add-feature-a`.
2. Open a PR from the prebuild branch to the intended target branch.
3. Each `prebuild-*.yml` workflow triggers directly off that PR and publishes only the component(s) whose paths changed, tagged `<latest-stable-tag>-<branch>-<N>` — for example `1.1.0-feat-add-feature-a-3`, where `1.1.0` is the latest stable release and `3` is the commit count on the branch.
4. Each new commit increments `N` and publishes a new tag.
5. `prebuild-image-cleanup.yml` deletes every tag for that branch once the PR merges or closes.

## Release Candidate & Hotfix Flow

Use a `release/x.y.z` branch to prepare a new release, or `release/x.y.z-hotfix` to patch an already-released version — the flow is identical either way:

1. Create or update the branch.
2. Open PRs targeting it and merge them.
3. `auto-tag.yml` creates `x.y.z-rc.N` (or `x.y.z-hotfix.N`) on every push to the branch.
4. The tag push triggers Docker and Helm CI for every component.
5. Test the published artifacts from GHCR.

When ready to publish, run the final release flow below with the intended final semver tag.

## Final Release Flow

Final releases use plain `x.y.z` tags and are always cut manually:

1. Open a PR from `release/x.y.z` to `main`. `pr-version-bump.yml` detects the release merge and commits the final version files and changelog onto that PR branch.
2. Merge the release PR to `main`. `auto-tag.yml` detects the merge and dispatches `release-manual.yml`.
3. `release-manual.yml` validates the version — it must be a plain semver or an RC, and strictly greater than the latest existing stable tag — then creates the final tag, pushes it, and creates a draft GitHub Release.
4. The tag triggers Docker and Helm CI for every component; each notifies `release-finalize.yml` on completion.
5. `release-finalize.yml` publishes the draft once all required workflows pass, then dispatches post-release security scanning and sanity tests, and deletes RC tags older than the new release.

If a required workflow fails, the release stays a draft with a failure note for investigation.

## Useful Workflow Reference

| Workflow or action | Responsibility |
| --- | --- |
| `.github/workflows/pr-version-bump.yml` | PR labels, branch freshness checks, release/*→main version preparation |
| `.github/workflows/auto-tag.yml` | Detects release-branch merges to main; creates `-rc.N`/`-hotfix.N` tags on release branch pushes |
| `.github/workflows/release-manual.yml` | Validates and creates the final `x.y.z` tag and draft GitHub Release |
| `.github/workflows/release-prerelease.yml` | Manually cuts an `-rc.N`/`-hotfix.N` tag on demand |
| `.github/workflows/release-finalize.yml` | Publishes draft release after required CI workflows pass |
| `.github/workflows/ci-*.yml` | Publishes `canary` on main pushes, and every tag on tag pushes |
| `.github/workflows/ci-helm.yml` | Publishes the Helm chart the same way |
| `.github/workflows/prebuild-*.yml` | Publishes temporary prebuild images and charts for PR testing |
| `.github/actions/prebuild-version/action.yml` | Computes `<latest-stable-tag>-<branch>-<N>` for prebuild builds |
| `.github/actions/validate-release-tag/action.yml` | Enforces the semver/RC format and monotonicity rules on manual release tags |
| `.github/actions/update-version-files/action.yml` | Sets version + appVersion + local dependency refs across pyproject, lockfile, and every chart |
| `.github/actions/determine-release-tag/action.yml` | Resolves the tag used by image and chart CI workflows (`canary`, a pushed tag, or a manual input) |
| `.github/actions/prepare-release/action.yml` | Updates final release files and generates changelog |

## Troubleshooting

- **PR check fails with a branch update comment** — merge the latest target branch into the PR branch and push again.
- **A `canary` build didn't pick up your change** — check whether your component's own paths actually changed in that push; a main push only rebuilds affected components, not everything.
- **A final release stays as a draft** — inspect the required CI workflows listed in `release-finalize.yml`. It publishes only after all required workflows pass or are skipped successfully.
