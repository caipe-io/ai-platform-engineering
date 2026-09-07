---
id: create-skill
title: Create a Repo Operational Skill
sidebar_label: Create a Skill
description: How to write a SKILL.md for Claude Code so coding agents can automate repo operations consistently.
---

# Create a Repo Operational Skill

Skills are plain Markdown files that give coding agents (Claude Code, Cursor) a repeatable playbook for a common repo task — things like running the audit checker, generating a release post, or keeping docs in sync. Once a skill is in `.claude/skills/`, any team member can invoke it with `/skill-name` and the agent follows the same steps every time.

---

## When to write a skill

Write a skill when you find yourself:

- Explaining the same multi-step process to an agent repeatedly
- Wanting a consistent, reviewable procedure for a repo task
- Building an automation that should be reusable across team members

Good candidates: release workflows, doc audits, test scaffolding, deployment checks, code-review checklists.

---

## File layout

```
.claude/
└── skills/
    └── your-skill-name/
        └── SKILL.md        ← the skill definition
```

The directory name becomes the slash command: `.claude/skills/update-docs/` → `/update-docs`.

---

## SKILL.md format

Every skill file starts with a YAML frontmatter block followed by the skill body:

```markdown
---
name: your-skill-name
description: >
  One or two sentences explaining what the skill does and when to use it.
  This description is shown in skill listings and used by the agent to decide
  when to invoke the skill automatically.
---

# Skill Title

Brief explanation of the skill's purpose.

---

## Step 1 — ...

## Step 2 — ...
```

### Frontmatter fields

| Field | Required | Description |
|---|---|---|
| `name` | Yes | Matches the directory name; becomes the `/command` |
| `description` | Yes | Used for skill discovery and auto-invocation decisions |

---

## Writing the skill body

Skills are instructions for an AI agent, not shell scripts. Write them as you would brief a capable engineer who just joined the team.

### Be explicit about inputs

```markdown
## Step 1 — Gather inputs

Ask the user for:
| Input | Example | Required |
|-------|---------|----------|
| **Version** | `0.4.9` | Yes |
| **Environment** | `dev` / `prod` | No |
```

### Run commands in parallel where possible

```markdown
Run all of the following in parallel:

```bash
git tag --sort=-version:refname | head -5
ls docs/releases/
grep 'lastVersion' docs/docusaurus.config.ts
```
```

### Distinguish coding-agent vs chat-only mode

Some skills run shell commands; others just produce output:

```markdown
## Execution context

- **Coding agent** (Claude Code) — run commands directly and write files to disk.
- **Chat-only** (CAIPE chat, Slack) — render output as a fenced block for the user to copy.

Detect by whether a `Bash`/shell tool is available.
```

### Always end with a report

```markdown
## Step N — Report

Produce a summary table:

| Check | Status | Action |
|-------|--------|--------|
| Release notes | ✅ | Up to date |
| Version string | ⚠️ | Updated 0.4.8 → 0.4.9 |
```

---

## Registering the skill

After creating `SKILL.md`, add an entry to `.claude/skills/README.md`:

```markdown
### 🔧 [your-skill-name](./your-skill-name/)
One-line description of what it does.

**Quick Start:**
```
/your-skill-name
```
```

---

## Example: minimal skill

```markdown
---
name: check-helm-version
description: >
  Verify the Helm chart version in docusaurus.config.ts and index.tsx
  matches the latest git tag. Run after cutting a release.
---

# check-helm-version

Checks that all version strings in the docs match the latest semver tag.

## Step 1 — Get latest tag

```bash
git tag --sort=-version:refname | grep -E '^[0-9]+\.[0-9]+\.[0-9]+$' | head -1
```

## Step 2 — Check docs references

```bash
grep -n "version" docs/src/pages/index.tsx | grep helm
grep 'lastVersion' docs/docusaurus.config.ts
```

## Step 3 — Report

If all strings match the tag: **✅ Version strings are consistent.**
If any are behind: list each file and line that needs updating.
```

---

## Skills in this repo

| Skill | What it does |
|---|---|
| [`/release-docs`](../../../.claude/skills/release-docs/SKILL.md) | Generate a combined release blog post (notes + upgrade guide) |
| [`/update-docs`](/docs/repo-ops/skills/update-docs) | Audit all docs surfaces after a release or feature addition |

---

## See also

- [`.claude/skills/README.md`](https://github.com/caipe-io/ai-platform-engineering/blob/main/.claude/skills/README.md) — full skill index
- [Claude Code documentation](https://docs.anthropic.com/en/docs/claude-code) — slash commands and skill discovery
