/**
 * GET /api/skills/update-skills
 *
 * Returns the per-agent rendered `/update-caipe-skills` slash command
 * template by default.
 * Companion to `/api/skills/live-skills`: where live-skills is for one-off
 * live fetches, update-skills walks the user's installed.json manifest
 * and prompts before refreshing each on-disk skill from the catalog.
 *
 * This route delegates to the shared template-route factory in
 * `_lib/template-route.ts`. Query params, validation, and response
 * shape match `/api/skills/live-skills` byte-for-byte; only the
 * template file and defaults differ.
 *
 * MongoDB serves the code-owned system_skills record by route id.
 * Database-free development uses the packaged file or the fallback below.
 */

import { makeTemplateRouteHandler } from "../_lib/template-route";
import { DEFAULT_UPDATE_SKILLS_COMMAND } from "../live-skills/agents";

const FALLBACK_TEMPLATE = `---
description: Refresh locally-installed CAIPE skills from the live catalog
---

## User Input

\`\`\`text
{{ARG_REF}}
\`\`\`

## SECURITY — never expose the API key

- NEVER print, echo, or display the API key value in any output.
- All API calls MUST go through ~/.config/caipe/caipe-skills.py.

## Steps

1. Read manifest at ~/.config/caipe/installed.json (or ./.caipe/installed.json).
2. Fetch the latest catalog from {{BASE_URL}}/api/skills?include_content=true.
3. Diff each on-disk skill against the catalog and prompt the user before writing.

Slash command: /{{COMMAND_NAME}}
`;

export const GET = makeTemplateRouteHandler({
  routeId: "update-skills",
  fallbackTemplate: FALLBACK_TEMPLATE,
  defaultCommandName: DEFAULT_UPDATE_SKILLS_COMMAND,
  defaultDescription: "Refresh locally-installed CAIPE skills from the live catalog",
});
