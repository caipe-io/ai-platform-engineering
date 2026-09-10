---
sidebar_position: 2
sidebar_label: Specification
id: 098-release-branch-pipelines-spec
---

# Spec: Release Branch CI/CD Pipelines

**Feature Branch**: `098-release-branch-pipelines`
**Created**: 2026-04-09
**Status**: Draft
**Input**: Release pipelines for `release/*` branches that mirror the prebuild pipeline model — producing release candidates for container images and Helm charts for all fixes going into versioned release branches, including hotfix variants.

## Overview

The platform's main-branch pipeline produces release candidates automatically whenever code merges. Release branches (`release/0.3.0`, `release/0.4.0`, `release/0.2.41-hotfix`) need the same capability: every push should produce testable, installable artifacts scoped to that release line without touching or conflating with the main pipeline's versioning.

## Motivation

When a fix is needed in a released version (e.g., a backported bug fix or a security patch), the team must be able to ship a verifiable, versioned artifact quickly. Currently there is no automated pipeline for release branches — teams must manually build, tag, and publish images and charts, which is error-prone, slow, and breaks traceability. The absence of automated Helm chart RC publishing for release branches means testers cannot use standard `helm upgrade` commands to validate a fix before shipping.

Additionally, the existing chart auto-bump workflow is designed for the main branch's version scheme. Running it against a release branch would corrupt chart versions with the wrong base version, making the release branch unusable.

## Scope

### In Scope

- Automatically create RC image tags when code changes are pushed to any `release/**` branch
- Automatically publish Helm chart release candidates when chart changes are pushed to any `release/**` branch
- Support both regular releases (`release/0.3.0`) and hotfix releases (`release/0.2.41-hotfix`) with distinct, non-conflicting version schemes
- Prevent the main-branch chart auto-bump from running on PRs that target release branches
- Version derivation from branch name rather than any shared configuration file, so release lines are fully autonomous

### Out of Scope

- Triggering release branch pipelines from pull requests (only direct pushes to release branches)
- Promoting a release candidate to a final release (handled by the existing release-finalize workflow)
- Creating or managing release branches themselves
- Syncing changes from main to release branches (handled by the existing sync-release-branches workflow)
- Backporting automation — committing the same fix to multiple branches is out of scope

---

## User Scenarios & Testing *(mandatory)*

### User Story 1 — Backport fix gets an installable artifact (Priority: P1)

A developer merges a cherry-picked fix into `release/0.3.0`. Within a few minutes, a new container image tag and Helm chart RC are available in the registry so that a QA engineer can install the fix to a test cluster using a single `helm upgrade` command.

**Why this priority**: The primary motivation for this feature. Without it, the team cannot safely validate a fix before shipping it to production customers.

**Independent Test**: Push a code change to a `release/0.3.0` branch. Confirm that a new git tag (`0.3.0-rc.N`) is created and that CI image-build workflows run against that tag. Pull the resulting image to verify it exists.

**Acceptance Scenarios**:

1. **Given** a developer pushes a code change to `release/0.3.0`, **When** the pipeline runs, **Then** a new tag `0.3.0-rc.N` (where N increments from the last existing RC) is created within 5 minutes.
2. **Given** the RC tag is created, **When** existing image-build CI workflows complete, **Then** container images are available in the registry tagged with `0.3.0-rc.N`.
3. **Given** `N` existing RC tags for `0.3.0`, **When** a new push triggers the pipeline, **Then** the new tag is `0.3.0-rc.(N+1)` — no gaps and no reuse of existing numbers.
4. **Given** no prior RC tags exist for `0.3.0`, **When** the first push occurs, **Then** the tag `0.3.0-rc.1` is created.

---

### User Story 2 — Helm chart fix on a release branch gets published as an RC (Priority: P1)

A developer updates the Helm chart values on `release/0.3.0` (e.g., adjusting a default config for the release). The chart is packaged and published to the GHCR pre-release registry so that the QA team can `helm upgrade` immediately without waiting for a final release.

**Why this priority**: Without chart RCs for release branches, there is no automated way to validate chart-only fixes before shipping.

**Independent Test**: Push a chart change to `release/0.3.0`. Confirm that a pre-release Helm chart with version `0.3.0-rc.N` is published and installable via `helm upgrade --install ... oci://ghcr.io/.../charts/ai-platform-engineering --version 0.3.0-rc.N`.

**Acceptance Scenarios**:

1. **Given** a chart change is pushed to `release/0.3.0`, **When** the pipeline runs, **Then** the chart is packaged with version `0.3.0-rc.N` and published to the pre-release Helm registry.
2. **Given** only non-chart files change on a release branch, **When** the pipeline runs, **Then** no Helm chart is published (chart publication is triggered only by chart file changes).
3. **Given** both `rag-stack` and `ai-platform-engineering` charts change, **When** the pipeline runs, **Then** both are packaged and published with matching RC versions, and the parent chart's dependency reference points to the same RC version.
4. **Given** the chart RC is published, **When** a QA engineer runs `helm upgrade`, **Then** the install succeeds and all expected sub-chart dependencies (rag-stack, neo4j, milvus) are present.

---

### User Story 3 — Hotfix branch gets its own RC series (Priority: P1)

A developer pushes a critical security fix to `release/0.2.41-hotfix`. The pipeline creates tags in the format `0.2.41-hotfix.1`, `0.2.41-hotfix.2`, etc. — a distinct series that does not collide with the `0.3.0-rc.N` series and clearly communicates its hotfix nature to operators.

**Why this priority**: Hotfix releases are urgent. The versioning must be unambiguous so operators can quickly identify the lineage of a deployed artifact.

**Independent Test**: Push to `release/0.2.41-hotfix`. Confirm the created tag matches `0.2.41-hotfix.1` (or `.2`, `.3`, etc.) and does not follow the `-rc.` format used by regular releases.

**Acceptance Scenarios**:

1. **Given** a push to `release/0.2.41-hotfix`, **When** the pipeline runs, **Then** a tag `0.2.41-hotfix.N` is created (no `-rc.` infix).
2. **Given** a push to `release/0.2.41-hotfix` with chart changes, **When** the Helm pipeline runs, **Then** the chart version is `0.2.41-hotfix.N` — matching the image tag exactly, with no separate `-rc.helm.` infix.
3. **Given** both a regular release branch and a hotfix branch are active, **When** both receive pushes, **Then** their tag series are completely independent and non-overlapping.

---

### User Story 4 — Chart auto-bump does not corrupt release branch PRs (Priority: P2)

A developer opens a pull request targeting `release/0.3.0` with a chart change. The main-branch chart auto-bump workflow — which validates chart versions against the latest stable release and commits version bumps — does not run. The PR is not modified by a bot commit that would set an incorrect version derived from main's release history.

**Why this priority**: Without this guard, bot commits would set release branch chart versions to a version anchored to main (e.g., `0.4.0-rc.helm.1` on a `release/0.3.0` branch), breaking the release line.

**Independent Test**: Open a PR targeting `release/0.3.0` with a chart file change. Confirm the auto-bump workflow is not triggered and no bot commits appear on the PR branch.

**Acceptance Scenarios**:

1. **Given** a PR targets `release/0.3.0` with chart changes, **When** the PR is opened or synchronized, **Then** the chart auto-bump workflow does not run for that PR.
2. **Given** a PR targets `main` with chart changes, **When** the PR is opened or synchronized, **Then** the chart auto-bump workflow runs normally (existing behavior unchanged).
3. **Given** a PR targets any `release/**` branch, **When** the PR is created, **Then** no bot commits are added and the chart versions in the PR remain as the developer set them.

---

### Edge Cases

- **Push with no relevant file changes**: Only code paths that match the pipeline's path filters produce RC tags or Helm RCs. Pushes that change only documentation or unrelated config produce nothing.
- **Concurrent pushes to the same release branch**: Each push creates an independent RC tag. Tag numbers are determined atomically from existing tags at the time of the run; if two pushes race, they will produce consecutive numbers rather than conflicting ones.
- **New release branch with no prior RC tags**: The first push produces tag number 1 (e.g., `0.3.0-rc.1`).
- **Bot-commit re-entrancy**: The chart RC workflow does not commit back to the branch, eliminating the risk of infinite re-trigger loops.

---

## Functional Requirements

### RC Tag Creation

- **FR-001**: On every push to a branch matching `release/**` that modifies source code paths (`ai_platform_engineering/**`, `build/**`, `pyproject.toml`, `uv.lock`), the pipeline MUST create a new annotated git tag and push it to the remote.
- **FR-002**: For a regular release branch `release/X.Y.Z`, the tag format MUST be `X.Y.Z-rc.N` where N is one greater than the highest existing tag matching `X.Y.Z-rc.*`.
- **FR-003**: For a hotfix branch `release/X.Y.Z-hotfix`, the tag format MUST be `X.Y.Z-hotfix.N` where N is one greater than the highest existing tag matching `X.Y.Z-hotfix.*`.
- **FR-004**: The pipeline MUST NOT read the version from `pyproject.toml` or any file on the `main` branch. The version MUST be derived exclusively from the release branch name.
- **FR-005**: Tag creation MUST be idempotent in numbering — no two pushes may produce the same tag number for the same release version.

### Helm RC Publishing

- **FR-006**: On every push to a branch matching `release/**` that modifies `charts/**` (excluding `Chart.lock`-only changes), the pipeline MUST package and publish Helm chart RCs to the pre-release GHCR registry.
- **FR-007**: Helm RC versions MUST use the same format as image RC tags — `X.Y.Z-rc.N` for regular releases and `X.Y.Z-hotfix.N` for hotfix releases. There is no separate `.helm.` infix. Both image and Helm artifact versions share the same counter namespace so that any RC number refers to the same release state across all artifact types.
- **FR-008**: Chart versions MUST be set in-memory during packaging. The pipeline MUST NOT commit any version changes back to the release branch.
- **FR-009**: When both `rag-stack` and `ai-platform-engineering` charts change in the same push, both MUST be packaged, and the parent chart's dependency reference to `rag-stack` MUST be updated to the same RC version before packaging.
- **FR-010**: The pipeline MUST verify that required sub-chart dependencies (neo4j, milvus) are present in the packaged archive before publishing. A missing dependency MUST fail the pipeline.

### Auto-bump Suppression

- **FR-011**: The chart auto-bump workflow MUST NOT execute for pull requests whose base branch matches `release/**`.
- **FR-012**: The chart auto-bump workflow MUST continue to execute normally for pull requests targeting `main` (no regression).

---

## Success Criteria

1. **Time to artifact**: A push to a release branch produces a pullable container image within 15 minutes of the push completing.
2. **Time to Helm RC**: A chart change pushed to a release branch results in a publishable Helm RC within 5 minutes.
3. **Zero version collisions**: Over 30 days of operation, no two RC tags share the same version number on the same release branch.
4. **No branch corruption**: Over 30 days of operation, zero bot commits appear on release branches from auto-bump or chart-version workflows.
5. **Full backward compatibility**: The existing main-branch prebuild pipeline and chart auto-bump continue to operate with no change in behavior, as measured by zero regressions in existing tests and workflow runs.
6. **Hotfix traceability**: Operators can identify whether a running image originated from a hotfix branch or a regular release branch solely by inspecting its image tag, without consulting the git log.

---

## Dependencies

- Existing image-build CI workflows (`ci-a2a-sub-agent.yml`, `ci-mcp-sub-agent.yml`, `ci-a2a-rag.yml`, `ci-supervisor-agent.yml`, `ci-caipe-ui.yml`, `ci-slack-bot.yml`) that respond to any git tag — these provide the container image builds and require no modification.
- GHCR Helm registry (`oci://ghcr.io/.../charts`) — must be writable with the existing `GITHUB_TOKEN`.
- `.github/agents.json` — agent list config consumed by the RC tag workflow.
- GitHub Actions `GH_PAT` / `GITHUB_TOKEN` secrets — must have `contents: write` and `packages: write`.

## Assumptions

- Release branches are always named `release/X.Y.Z` or `release/X.Y.Z-hotfix`. Other patterns (e.g., `release/feature-xyz`) are out of scope and will produce malformed tags that may be ignored.
- The existing Helm charts (`rag-stack`, `ai-platform-engineering`) are the only charts requiring RC publication. New charts added under `charts/` will be picked up automatically by the change-detection logic.
- Container image builds for release branch RC tags are handled by the existing CI workflows without modification, relying on their `tags: '**'` trigger.
- The pre-release Helm registry is not cleaned up automatically for release branch artifacts (unlike prebuild PRs where cleanup happens on PR close). Cleanup is a manual or scheduled operation.
