/**
 * GET /api/skills/live-skills
 *
 * Returns the live-skills slash command template (per-agent rendered) used
 * by the Skills Gateway UI to install the `/caipe-skills` "live escape
 * hatch" slash command by default.
 *
 * This is the route the legacy `/api/skills/bootstrap` endpoint was
 * renamed to. The actual handler lives in `_lib/template-route.ts` so
 * `/api/skills/update-skills` can share the same machinery — only the
 * canonical template file and defaults differ.
 *
 * Query params, response shape, and validation are documented on
 * {@link makeTemplateRouteHandler}. Stable across both routes.
 *
 * MongoDB serves the global system skill record by route id.
 * Without MongoDB, template resolution is:
 *   1. SKILLS_LIVE_SKILLS_TEMPLATE env var (raw markdown)
 *   2. File at SKILLS_LIVE_SKILLS_FILE env var
 *   3. <repo>/charts/ai-platform-engineering/data/skills/live-skills.md
 *   4. Built-in fallback string below
 */

import { makeTemplateRouteHandler } from "../_lib/template-route";
import { DEFAULT_LIVE_SKILLS_COMMAND } from "./agents";

const FALLBACK_TEMPLATE = `---
description: Live-fetch a single skill from the CAIPE catalog
---

## User Input

\`\`\`text
{{ARG_REF}}
\`\`\`

## SECURITY — never expose the API key

- NEVER print, echo, or display the API key in any output.
- All API calls MUST go through the python3 helper which keeps the key internal.

## Steps

1. Search: call the gateway at {{BASE_URL}}/api/skills with header X-Caipe-Catalog-Key.
2. Display results as a table.
3. Offer to install or run inline (fetched live).

Slash command: /{{COMMAND_NAME}}
`;

export const GET = makeTemplateRouteHandler({
  routeId: "live-skills",
  envInlineKey: "SKILLS_LIVE_SKILLS_TEMPLATE",
  envFileKey: "SKILLS_LIVE_SKILLS_FILE",
  chartTemplatePath:
    "charts/ai-platform-engineering/data/skills/live-skills.md",
  fallbackTemplate: FALLBACK_TEMPLATE,
  defaultCommandName: DEFAULT_LIVE_SKILLS_COMMAND,
  defaultDescription: "Browse and install skills from the CAIPE skill catalog",
});
