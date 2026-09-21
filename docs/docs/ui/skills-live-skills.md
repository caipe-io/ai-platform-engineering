---
sidebar_position: 9
title: Live-skills (`/skills` slash command)
---

# Live-skills (`/skills` slash command)

The **Skills Gateway** page (UI → *Skills* → *Skills Gateway*) renders
a copy-pasteable slash command that lets a coding agent (Claude Code, Cursor,
Spec Kit, etc.) browse, search, run, install, and update skills served by the
CAIPE skill catalog.

The body of that slash command is rendered from a single Markdown template
called the **live-skills skill**. This page describes how operators can
customize it for their deployment without forking the chart or rebuilding the
image.

## Where the template lives

| Layer            | Location                                                         |
| ---------------- | ---------------------------------------------------------------- |
| Packaged default | [`charts/ai-platform-engineering/data/skills/live-skills.md`](https://github.com/caipe-io/ai-platform-engineering/tree/main/charts/ai-platform-engineering/data/skills/live-skills.md) |
| Helm ConfigMap   | `skills-live-skills` (key `live-skills.md`)                          |
| Mounted in pod   | `/app/data/skills-live-skills/live-skills.md` on the `caipe-ui` pod  |
| Served at        | `GET /api/skills/live-skills` (returns `{ template, source, … }`)  |
| Rendered in      | `Skills Gateway` UI → "Create the live-skills skill" card      |

The UI substitutes three placeholders client-side based on the form fields
on the page:

| Placeholder         | Replaced with                                                  |
| ------------------- | -------------------------------------------------------------- |
| `{{COMMAND_NAME}}`  | Slash command name (default `skills`)                          |
| `{{DESCRIPTION}}`   | Description shown in the slash-command picker                  |
| `{{BASE_URL}}`      | Gateway base URL (auto-detected from the request origin)       |
| `{{ARG_REF}}`       | Per-agent argument syntax (`$ARGUMENTS`, `$1`, or `{{input}}`) |

`{{ARG_REF}}` is substituted **per agent** by the renderer (see
[Multi-agent support](#multi-agent-support) below) so the same canonical
template produces the right `$ARGUMENTS` (Claude/Cursor/Spec Kit), `$1`
(Codex/Gemini), or `{{input}}` (Continue) reference for each surface.

## Override resolution order

The UI server (`/api/skills/live-skills`) picks the **first** source that
resolves:

1. `SKILLS_LIVE_SKILLS_TEMPLATE` env var (raw markdown) &mdash; highest priority
2. File at `SKILLS_LIVE_SKILLS_FILE` env var
   (default: `/app/data/skills-live-skills/live-skills.md`, mounted by the chart)
3. Packaged default at `data/skills/live-skills.md` (chart-relative, dev only)
4. A minimal built-in fallback string

The currently active source is shown in the UI under
*"Template source: …"* so operators can verify which override is in effect.

## Override option 1 &mdash; inline Helm value (simplest)

Drop a multi-line string into your Helm values:

~~~yaml
skillsLiveSkills: |
  ---
  description: My company's skill catalog
  ---

  ## User Input

  ```text
  $ARGUMENTS
  ```

  ## SECURITY — never expose the API key
  - NEVER print, echo, or display the API key in any output.

  ## Steps

  1. Fetch from {{BASE_URL}}/api/skills with the X-Caipe-Catalog-Key header.
  2. Render results as a table.
  3. Use `/{{COMMAND_NAME}} <query>` to search, `/{{COMMAND_NAME}} run <name>`
     to execute inline, or `/{{COMMAND_NAME}} install <name>` to save locally.
~~~

The chart writes that string verbatim into the `skills-live-skills`
ConfigMap. No image rebuild required.

## Override option 2 &mdash; named variant shipped with the chart

If you want to ship a small set of opinionated variants with your fork of
the chart (e.g. one per business unit):

1. Drop additional files alongside `live-skills.md`, named
   `live-skills.<variant>.md` &mdash; for example `live-skills.enterprise.md`.
2. Select the variant via Helm:

   ```yaml
   skillsLiveSkillsName: enterprise
   ```

The template resolves
`data/skills/live-skills.<variant>.md` and falls back to `live-skills.md` if
that file isn't found.

## Override option 3 &mdash; bring-your-own ConfigMap or env

For deployments that consume the published chart unchanged:

### Mount your own ConfigMap

```yaml
caipe-ui:
  volumes:
    - name: my-live-skills
      configMap:
        name: my-custom-skills-live-skills
  volumeMounts:
    - name: my-live-skills
      mountPath: /app/data/skills-live-skills
      readOnly: true
```

The default `SKILLS_LIVE_SKILLS_FILE` (already set by the chart) keeps pointing
at `/app/data/skills-live-skills/live-skills.md`, so the new ConfigMap content
takes effect immediately.

### Or stuff the markdown into an env var

```yaml
caipe-ui:
  env:
    SKILLS_LIVE_SKILLS_TEMPLATE: |
      ---
      description: Inline override via env
      ---
      ## Steps
      1. Fetch from {{BASE_URL}}/api/skills.
```

This wins over any file-based source and is handy for quick experiments.

### Or point at a different file

```yaml
caipe-ui:
  env:
    SKILLS_LIVE_SKILLS_FILE: "/etc/caipe/my-live-skills.md"
```

Useful when mounting a Secret or a sidecar-managed file at a non-default
path.

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

The canonical template is rendered server-side per agent, so a single
ConfigMap serves every surface without operators maintaining N copies.

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
- ConfigMap template: [`templates/skills-live-skills-config.yaml`](https://github.com/caipe-io/ai-platform-engineering/tree/main/charts/ai-platform-engineering/templates/skills-live-skills-config.yaml)
