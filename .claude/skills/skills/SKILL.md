<!-- Browse and install skills from the Grid catalog -->
---
description: Browse and install skills from the Grid catalog
scripts:
  sh: scripts/bash/outshift-skills.sh "{ARGS}"
---

## User Input

```text
$ARGUMENTS
```

You **MUST** consider the user input before proceeding (if not empty).

## Outline

Browse the [Outshift Grid](https://grid.outshift.io) skill catalog and optionally adopt a skill into this project.

1. **Resolve API key** by running `{SCRIPT}` which checks (in priority order):
   - `~/.config/grid/config.json`: `{"api_key": "<key>"}` (recommended)
   - `.env` file in repo root: `CAIPE_CATALOG_KEY=<key>`
   - `CAIPE_CATALOG_KEY` environment variable (useful in CI)

   If no key is found, stop and tell the user:
   > Set your Grid API key in one of:
   > - Config file (recommended): `~/.config/grid/config.json` → `{"api_key": "<key_id.secret>"}`
   > - Repo `.env` file: `CAIPE_CATALOG_KEY=<key_id.secret>`
   > - Environment variable: `export CAIPE_CATALOG_KEY=<key_id.secret>`

2. **Search the catalog**: The script accepts a search query from `$ARGUMENTS` (pass as-is). Parse the JSON response and display results as a table:

   | # | Name | Description | Version | Source |
   |---|------|-------------|---------|--------|
   | 1 | skill-name | Short description | v1.0 | default |

3. **If no results**: Report "No skills found for query: `<query>`" and suggest broadening the search.

4. **If user wants to install a skill**:
   a. Ask which skill by number (from the table above)
   b. Fetch the skill content from the Grid API skill detail endpoint
   c. Save to `.agents/skills/<skill-name>/SKILL.md`
   d. Also save to `.claude/skills/<skill-name>/SKILL.md` when Claude Code discovery is needed
   e. Confirm the vendor-neutral `.agents/skills/` path and any native copy created

5. **Report**: Total skills found, page info, and next steps.

## Notes

- The Grid API uses pagination: `page` and `page_size` query params (default: page=1, size=20)
- Pass `source=default` to browse the curated catalog
- The API key header is `X-Caipe-Catalog-Key: <key_id.secret>`
- To browse without a query, run `/skills` (lists all skills)
- To search, run `/skills <query>` (e.g., `/skills aws`, `/skills kubernetes`)
