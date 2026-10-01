# Prebuild Flow

Prebuild branches let CI publish branch-scoped images before a PR is merged.

## Branch Naming

Use the `prebuild/` prefix:

```text
prebuild/feat/example-change
```

## Tag Format

Every prebuild image and chart is tagged `<latest-stable-tag>-<branch>-<N>`, for example:

```text
1.1.0-feat-example-change-3
```

`1.1.0` is the latest stable release tag, `feat-example-change` is the sanitized branch name, and `3` is the commit count on the branch — it increments with every new commit.

## Image Families

| Area | Workflow |
|---|---|
| UI/BFF | `prebuild-caipe-ui.yml` |
| Dynamic Agents | `prebuild-dynamic-agents.yml` |
| MCP servers | `prebuild-mcp-servers.yml` |
| RAG | `prebuild-rag.yml` |
| Slack bot | `prebuild-slack-bot.yml` |
| Audit service | `prebuild-audit-service.yml` |
| Helm chart | `prebuild-helm.yml` |

## Use In Helm

Set `global.image.tag` to the prebuild tag above to consume prebuilt images from a branch.
