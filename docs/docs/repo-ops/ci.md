---
id: ci
title: CI Workflows
sidebar_label: CI Workflows
sidebar_position: 2
description: Reference for every GitHub Actions workflow in ai-platform-engineering — triggers, purpose, and manual dispatch instructions.
---

# CI Workflows

All workflows live in `.github/workflows/`. The table below is the quick reference; click a workflow name to view the file on GitHub.

## Build & Test

| Workflow | Trigger | What it does |
|---|---|---|
| `ci-rag.yml` | PR / push to `main` | Tests the RAG ingestor and query pipeline |
| `ci-mcp-sub-agent.yml` | PR / push to `main` | Tests packaged MCP servers |
| `ci-dynamic-agents.yml` | PR / push to `main` | Tests the dynamic-agents Helm chart and operator |
| `ci-caipe-ui.yml` | PR / push to `main` | Builds and lints the CAIPE web UI |
| `caipe-ui-tests.yml` | PR / push to `main` | Jest unit tests and mocked RBAC Playwright regression for the UI |
| `ci-helm.yml` | PR / push to `main` | Helm chart lint and template validation |
| `helm-chart-test.yml` | PR / push to `main` | Full Helm chart install test on a Kind cluster |
| `ci-skill-scanner.yml` | PR / push to `main` | Security scan of `.claude/skills/` content |
| `ci-slack-bot.yml` | PR / push to `main` | Tests the Slack Bot integration |
| `ci-webex-bot.yml` | PR / push to `main` | Tests the Webex Bot integration |
| `ci-agentgateway-config-bridge.yml` | PR / push to `main` | Tests the AgentGateway config bridge |
| `ci-audit-service.yml` | PR / push to `main` | Tests the audit service |
| `ci-openfga-authz-bridge.yml` | PR / push to `main` | Tests the OpenFGA authz bridge |
| `ci-keycloak-init.yml` | PR / push to `main` | Tests Keycloak bootstrap tooling |

## Quality Gates

| Workflow | Trigger | What it does |
|---|---|---|
| `conventional_commits.yml` | PR | Enforces Conventional Commits on PR title |
| `check-pinned-deps.yml` | PR / push | Verifies all action dependencies are pinned to a SHA |
| `check-proprietary-content.yml` | PR | Scans for proprietary or sensitive content |
| `coverage-comment.yml` | PR | Posts test coverage delta as a PR comment |

## Release

| Workflow | Trigger | What it does |
|---|---|---|
| `auto-tag.yml` | Push to `main` / `release/*` | Computes and pushes the next semver tag (`x.y.z-dev.N`, `x.y.z-rc.N`) |
| `release-finalize.yml` | Manual dispatch | Promotes an RC tag to a final `x.y.z` release; publishes Helm chart to GHCR |
| `release-manual.yml` | Manual dispatch | Emergency manual release path (hotfixes) |
| `sync-release-branches.yml` | Push to `main` | Keeps `release/x.y.z` branches in sync with `main` cherry-picks |
| `docs-release.yml` | Semver tag push | Generates release blog post via Claude Code CLI, opens docs PR |
| `publish-gh-pages.yml` | Push to `main` | Builds Docusaurus and deploys to GitHub Pages |
| `docs-build-check.yml` | PR touching `docs/` | Verifies `npm run build` passes before merge |

## Tagging convention

See [CI/CD & Releases](../development/ci-cd-and-releases) for the full branch flow and tag shape reference.

## Running a workflow manually

Any workflow with `workflow_dispatch:` can be triggered from the GitHub UI:

1. Go to **Actions** → select the workflow
2. Click **Run workflow** → choose the branch → fill in inputs → **Run**

Or via CLI:

```bash
gh workflow run release-finalize.yml \
  --repo caipe-io/ai-platform-engineering \
  -f version=0.4.9
```
