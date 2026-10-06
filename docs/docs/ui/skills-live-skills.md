---
sidebar_position: 9
title: Live-skills (`/skills` slash command)
---

# Live-skills (`/skills` slash command)

The **Skills Gateway** page (UI → *Skills* → *Skills Gateway*) renders
a copy-pasteable slash command that lets a coding agent (Claude Code, Cursor,
Spec Kit, etc.) browse, search, run, install, and update skills served by the
CAIPE skill catalog.

The platform provides two system instruction templates: **live-skills** for
accessing the catalog and **update-skills** for refreshing installed skills.

## Protected system instructions

- MongoDB stores these templates in `system_skills`, separate from the ordinary `agent_skills` catalog.
- Startup creates or updates both templates from the release's packaged Markdown files on new and existing installations. This runs independently of app-config and the ordinary catalog migration.
- UI skill APIs, template imports, and app-config do not write to `system_skills`. An ordinary skill with the same ID cannot replace the gateway instructions.
- Change system instructions in the repository and ship a new release. They are not editable or deletable through the UI.
- The templates, Python helper, and session hook ship in the UI image at `/app/data/skills`. They do not require skill ConfigMaps.

## Rendering and deployment

- `/api/skills/live-skills` and `/api/skills/update-skills` read only the protected system records. A missing record returns 404; a database failure returns 503.
- The renderer substitutes `{{COMMAND_NAME}}`, `{{DESCRIPTION}}`, `{{BASE_URL}}`, and `{{ARG_REF}}` for the selected coding agent without changing the stored template.
- Without MongoDB, development routes use the packaged files or their code fallback. Inline `SKILLS_*_TEMPLATE` and file `SKILLS_*_FILE` overrides do not control system instructions.
- Use `caipe-ui.appConfig.skills` or `skills` in `app-config.yaml` for ordinary configured skills. Those records follow the agent configuration lifecycle and remain read-only through the UI.
- Remove obsolete `skillsLiveSkills`, `skillsLiveSkillsName`, and skill ConfigMap mounts from Helm overrides. The chart omits mounts referencing `skill-templates` and `skills-live-skills` on upgrade.

## What the user sees

Once the template is in place, the **Skills Gateway** page lets the user:

- Pick a **slash command name** (`skills` by default).
- Pick a **description** (rendered into the artifact's frontmatter / metadata).
- Pick a **coding agent** (Claude Code, Cursor, Spec Kit, Codex CLI, Gemini
  CLI, Continue) &mdash; the install path, file format, and argument syntax
  are derived from this choice.
- Copy the generated install command (`mkdir -p … && cat > … << 'SKILL' …`)
  or, for Continue, the JSON fragment to merge into `~/.continue/config.json`.
- Preview the rendered artifact (Markdown / TOML / JSON).
- Read the per-agent **launch & invocation guide** rendered just below the
  install command.

The system template is rendered server-side for each coding agent,
so one instruction body serves all supported surfaces.

## Multi-agent support

`GET /api/skills/live-skills?agent=<id>&command_name=<name>&description=<desc>`
returns a per-agent rendered artifact plus install/launch metadata. The
agent registry currently ships with six entries:

| Agent ID    | Label                          | Install path                                    | Format                    | Argument syntax |
| ----------- | ------------------------------ | ----------------------------------------------- | ------------------------- | --------------- |
| `claude`    | Claude Code                    | `.claude/commands/{name}.md`                    | Markdown + frontmatter    | `$ARGUMENTS`    |
| `cursor`    | Cursor                         | `.cursor/commands/{name}.md`                    | Markdown + frontmatter    | `$ARGUMENTS`    |
| `specify`   | Spec Kit                       | `.specify/templates/commands/{name}.md`         | Markdown + frontmatter    | `$ARGUMENTS`    |
| `codex`     | Codex CLI (OpenAI)             | `~/.codex/prompts/{name}.md`                    | Plain Markdown            | `$1`            |
| `gemini`    | Gemini CLI                     | `~/.gemini/commands/{name}.toml`                | TOML (`description`, `prompt`) | `$1`       |
| `continue`  | Continue (VS Code / JetBrains) | `~/.continue/config.json` (fragment to merge)   | JSON fragment             | `{{input}}`     |

The renderer parses the canonical Markdown's frontmatter once, substitutes
`{{COMMAND_NAME}}`, `{{DESCRIPTION}}`, `{{BASE_URL}}`, and `{{ARG_REF}}`,
then re-wraps the body as appropriate for each surface (YAML frontmatter,
TOML basic strings, or a JSON object). Adding a new agent is one entry in
[`ui/src/app/api/skills/live-skills/agents.ts`](https://github.com/caipe-io/ai-platform-engineering/tree/main/ui/src/app/api/skills/live-skills/agents.ts)
plus a case in `renderForAgent()`.

### Per-agent launch & invocation guidance

The UI renders a short "Launch &lt;Agent&gt; and use it" panel after the
install command, summarizing how to install and invoke the chosen agent.
The exact text is part of each agent's spec (`launchGuide`) and supports
basic Markdown (bold, inline code, links, fenced code blocks).

#### Quick reference

- **Claude Code** &mdash; `npm install -g @anthropic-ai/claude-code` →
  `claude` from your repo root → `/skills`. Auto-discovers commands in
  `.claude/commands/` (per-repo) and `~/.claude/commands/` (user-global).
- **Cursor** &mdash; install from [cursor.com](https://cursor.com), open the
  repo, then `Cmd/Ctrl + L` → `/skills`. Reload the window if a new command
  doesn't appear in the picker.
- **Spec Kit** &mdash;
  `uvx --from git+https://github.com/github/spec-kit.git specify init`. Spec
  Kit re-syncs commands into the agent-specific directory the next time you
  run `/specify`, `/plan`, `/tasks`, or `/implement`.
- **Codex CLI** &mdash; `npm install -g @openai/codex` → `codex` →
  `/skills`. Prompts live in `~/.codex/prompts/` (user-global). Use
  `$1`-style positional args when invoking the prompt.
- **Gemini CLI** &mdash; `npm install -g @google/gemini-cli` → `gemini`
  from your repo root → `/skills "kubernetes"` (quote multi-word args).
  Commands live in `~/.gemini/commands/` (user-global) or
  `.gemini/commands/` (per-repo).
- **Continue** &mdash; install the VS Code or JetBrains extension, then
  merge the rendered JSON fragment into the top-level `slashCommands` array
  of `~/.continue/config.json`. Continue reloads `config.json` automatically.

## See also

- Chart-side reference: [`charts/ai-platform-engineering/docs/skills-live-skills.md`](https://github.com/caipe-io/ai-platform-engineering/tree/main/charts/ai-platform-engineering/docs/skills-live-skills.md)
- Default template: [`live-skills.md`](https://github.com/caipe-io/ai-platform-engineering/tree/main/charts/ai-platform-engineering/data/skills/live-skills.md)
