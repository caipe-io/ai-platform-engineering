---
sidebar_position: 1
title: Skills
description: User-facing overview of CAIPE skills, the Gallery, Gateway, hubs, scanning, and install flow.
---

# Skills

A CAIPE skill is a reusable `SKILL.md` file that describes one focused
capability such as reviewing a pull request, preparing a release, or
investigating an incident.

## Where Skills Are Used

| Surface | Purpose |
|---|---|
| Skills Gallery | Browse, author, import, revise, and scan skills |
| Skills Gateway | Mint catalog API keys and install skills into coding agents |
| Dynamic Agents | Attach approved skills to an agent so they are available during chat |

## Concepts

| Concept | What it is | Storage |
|---|---|---|
| `SKILL.md` | Markdown skill body with frontmatter metadata | Filesystem, MongoDB, GitHub, or GitLab |
| Catalog | Merged, deduplicated, scan-gated skill list | Built from configured sources |
| Agent skill | Editable skill created in the UI | MongoDB `agent_skills` |
| Skill hub | External GitHub/GitLab source crawled into CAIPE | MongoDB `skill_hubs`, `hub_skills` |
| Scanner | Optional prompt-injection and unsafe-tool scanner | `SKILL_SCANNER_URL` sidecar |

## Legacy Agentic Workflows URLs

The retired `/agent-builder` page was an older **Agentic Workflows** UI over
the same `AgentSkill` records used by Skills. It was not the supported
**Agents → New Agent** wizard.

| Legacy URL | Canonical destination |
|---|---|
| `/agent-builder` | `/skills` |
| `/agent-builder/history` | `/skills` |

Both legacy URLs redirect to the Skills Gallery so existing bookmarks do not
fail. Persisted `agent_skills`, favorites, workflow run records, APIs, stores,
and authorization rules remain unchanged. Use `/dynamic-agents` to create or
edit an agent, and `/workflows` to author multi-agent workflows.

## Use Skills In CAIPE

Attach skills to a dynamic agent from the UI. The runtime exposes the selected
skills to that agent during chat. Scan-gated skills are excluded before they
reach the model.

## Install Skills Locally

The Skills Gateway renders an installer for supported coding agents:

```bash
curl -fsSL "<gateway>/api/skills/install.sh?agent=claude&scope=user" | bash
```

Installed skills are written to common user-level locations such as:

```text
~/.claude/skills/<name>/SKILL.md
~/.agents/skills/<name>/SKILL.md
```

The generated `/skills` and `/update-skills` helper skills let local coding
agents query the live CAIPE catalog without reinstalling every skill manually.

## Scan Gating

| Gate | Behavior |
|---|---|
| `off` | Do not call the scanner |
| `warn` | Show scanner findings but allow use |
| `strict` | Exclude flagged skills from the runtime catalog |

Use `SKILL_SCANNER_URL` to point CAIPE at the scanner service and
`SKILL_SCANNER_GATE` to choose the gate.
