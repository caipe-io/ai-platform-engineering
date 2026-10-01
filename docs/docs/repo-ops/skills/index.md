---
id: index
title: Coding-Agent Skills
sidebar_label: Overview
sidebar_position: 1
description: All Claude Code skills in .claude/skills/ — what each one does, when to use it, and how to invoke it.
---

# Coding-Agent Skills

Skills are plain Markdown playbooks that live in `.claude/skills/`. Any team member can invoke them with a `/skill-name` slash command in Claude Code, and the agent follows the same steps every time — consistent, reviewable, no ad-hoc prompting required.

---

## Available skills

### 📝 `/release-docs`

Generate a combined release blog post for a new version.

**Use when:** cutting a release or when someone asks "what changed in 0.4.x"

**Produces:** `docs/releases/YYYY-MM-DD-release-X-Y-0.md`, one post per minor series,
slugged `release-X.Y.0`, containing the narrative and upgrade guide, picked up by the
Docusaurus releases plugin. Each post covers the cumulative diff since the previous
minor's `.0`. An `X.Y.0` tag starts a new post; patch releases fold into the existing post
rather than getting one of their own.

**Inputs:** to-version, from-version (auto-detected from git tags if omitted), optional `values.yaml` for personal impact analysis.

→ [View skill source](https://github.com/caipe-io/ai-platform-engineering/blob/main/.claude/skills/release-docs/SKILL.md)

---

### 🔄 `/update-docs`

Audit and sync all documentation surfaces after a release or feature addition.

**Use when:** after cutting a release, adding a new agent, or updating platform features.

**Checks:**

| # | Surface | Stale when… |
|---|---|---|
| 1 | Release notes | An `X.Y.0` tag has no `docs/releases/` series post, or a series post omits later patches |
| 2 | Homepage version string | Helm `--version` in `index.tsx` is behind latest tag |
| 3 | Published versions | A released tag is missing from `docs/published-versions.json` |
| 4 | Features page tiles | New feature docs without a tile in `features.tsx` |
| 5 | MCP docs | Packaged MCP integration without current docs |
| 6 | Sidebar | Doc directory not in `sidebars.ts` |
| 7 | Navbar label | Version label behind latest tag |

→ [View skill source](https://github.com/caipe-io/ai-platform-engineering/blob/main/.claude/skills/update-docs/SKILL.md)

---

### 🧪 `/integration-testing`

Run the full end-to-end integration test suite against a running Docker Compose stack.

**Use when:** validating a feature branch before raising a PR, or after a major refactor.

→ [View skill source](https://github.com/caipe-io/ai-platform-engineering/blob/main/.claude/skills/integration-testing/SKILL.md)

---

### 🚦 `/quality-gates`

Run all pre-commit quality gates — lint, Python tests, UI tests — in one command.

**Use when:** before raising a PR or after resolving merge conflicts.

```bash
# Run all gates
./skills/quality-gates/run_all.sh

# Auto-fix lint first, then validate
./skills/quality-gates/run_all.sh --fix
```

→ [View skill source](https://github.com/caipe-io/ai-platform-engineering/blob/main/.claude/skills/quality-gates/)

---

## Adding a new skill

See [Create a Skill](./create-skill) for the full guide. The short version:

1. Create `.claude/skills/<your-skill-name>/SKILL.md`
2. Add an entry to `.claude/skills/README.md`
3. Add a row to the table above

The skill is immediately available as `/your-skill-name` to anyone using Claude Code in this repo.
