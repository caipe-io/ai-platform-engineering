# Skills live-skills template (chart-side reference)

This page is a chart-operator reference for customizing the **Skills API
Gateway** live-skills skill. The packaged template itself lives at
[`../data/skills/live-skills.md`](../data/skills/live-skills.md); this document
explains how the chart wires it up and which Helm values override it.

`live-skills.md` is the default markdown body of the `/skills` slash command
that the Skills Gateway UI page renders for users to copy into their
coding agent (Claude Code, Cursor, Codex CLI, Gemini CLI, or opencode).

The chart packages it into the `skills-live-skills` ConfigMap, which is mounted
into the `caipe-ui` pod at `/app/data/skills-live-skills/live-skills.md` and read
by the `/api/skills/live-skills` endpoint.

## Placeholders (substituted by the server-side renderer)

| Placeholder         | Replaced with                                                  |
| ------------------- | -------------------------------------------------------------- |
| `{{COMMAND_NAME}}`  | Slash command name from the UI form (default `skills`)         |
| `{{DESCRIPTION}}`   | Description from the UI form                                   |
| `{{BASE_URL}}`      | Gateway base URL (auto-detected from the request origin)       |
| `{{ARG_REF}}`       | User-input reference used in the shared `SKILL.md` template (`$ARGUMENTS`) |

The renderer (`ui/src/app/api/skills/live-skills/agents.ts`) parses this
template once and emits the shared agentskills.io `SKILL.md` format. One
canonical template serves all five agents.

## Override resolution order

The UI server picks the first source that resolves:

1. `SKILLS_LIVE_SKILLS_TEMPLATE` env (raw markdown, highest priority)
2. File at `SKILLS_LIVE_SKILLS_FILE` env (defaults to the mounted ConfigMap)
3. Packaged default at `data/skills/live-skills.md`
4. A minimal built-in fallback string

## Customizing via Helm

```yaml
# Inline override (highest priority Helm path)
skillsLiveSkills: |
  ---
  description: My company's skill catalog
  ---
  ## Steps
  1. Fetch from {{BASE_URL}}/api/skills with X-Caipe-Catalog-Key header.

# Or pre-shipped variant (looks up data/skills/live-skills.<name>.md)
skillsLiveSkillsName: enterprise
```

To ship a pre-baked variant with the chart, drop a file alongside
`live-skills.md`, e.g. `live-skills.enterprise.md`, then set
`skillsLiveSkillsName: enterprise`.

See [`docs/docs/ui/skills-live-skills.md`](../../../docs/docs/ui/skills-live-skills.md)
for the full guide including BYO ConfigMap and env-only overrides.
