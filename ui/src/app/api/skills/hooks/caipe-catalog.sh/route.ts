/**
 * GET /api/skills/hooks/caipe-catalog.sh
 *
 * Returns the canonical Claude Code SessionStart hook script. The hook
 * fetches the live skills catalog from the gateway and injects a compact
 * index into Claude's `additionalContext` so the agent is always
 * catalog-aware at session start, even for skills that have not been
 * materialized to disk via `install.sh`.
 *
 * `install.sh` curls this endpoint into:
 *   ~/.claude/hooks/caipe-catalog.sh   (Claude Code, user scope)
 * and patches `~/.claude/settings.json` to register a SessionStart hook
 * pointing at it. Re-running `install.sh --upgrade` fetches a fresh copy.
 *
 * Sibling endpoint to `/api/skills/helpers/caipe-skills.py`:
 *   - helpers/caipe-skills.py serves the Python catalog query helper.
 *   - hooks/caipe-catalog.sh serves the bash session-start hook.
 * Both substitute the literal `{{BASE_URL}}` placeholder so the
 * installed file talks to the deployment that served it without
 * relying on user config (config still wins at runtime — this is just
 * the "no env, no config" fallback).
 *
 * Optional query params:
 *   - base_url: replaces the literal token "{{BASE_URL}}" in the hook
 *               body. Defaults to the request origin via
 *               `getRequestOrigin` (which honors NEXTAUTH_URL +
 *               x-forwarded-* before falling back to the inbound URL,
 *               so the value is correct behind an ingress).
 *   - command_name / update_command_name: replace the helper command
 *               placeholders in the injected SessionStart guidance.
 *
 * Resolution order for the hook source on the gateway side:
 *   1. SKILLS_HOOK_FILE env var (operator override)
 *   2. <repo>/charts/ai-platform-engineering/data/skills/caipe-catalog.sh
 *   3. Built-in minimal fallback (just enough to print a clear error
 *      via the Claude hook protocol)
 *
 * Response:
 *   - Content-Type: text/x-shellscript; charset=utf-8
 *   - Content-Disposition: inline; filename=caipe-catalog.sh
 *   - Cache-Control: no-store
 */

import fs from "fs";
import { NextResponse } from "next/server";
import path from "path";
import { getRequestOrigin } from "../../_lib/request-origin";
import {
DEFAULT_LIVE_SKILLS_COMMAND,
DEFAULT_UPDATE_SKILLS_COMMAND,
deriveUpdateCommandName,
} from "../../live-skills/agents";

const FALLBACK_HOOK = `#!/usr/bin/env bash
# Fallback CAIPE catalog hook — operator misconfiguration on the gateway:
# the chart-shipped caipe-catalog.sh was not found and SKILLS_HOOK_FILE
# was not set. We emit a single Claude-format hook payload so the
# session does not break, but the catalog index will be unavailable.
python3 -c '
import json, sys
print(json.dumps({
    "hookSpecificOutput": {
        "hookEventName": "SessionStart",
        "additionalContext": "[caipe-catalog hook] Hook source not found on the CAIPE gateway. Set SKILLS_HOOK_FILE or restore charts/ai-platform-engineering/data/skills/caipe-catalog.sh."
    }
}))
'
`;

const FILE_SIZE_CAP_BYTES = 256 * 1024;

function safeReadFile(filePath: string): string | null {
  try {
    if (!filePath) return null;
    const resolved = path.resolve(filePath);
    if (!fs.existsSync(resolved)) return null;
    const stat = fs.statSync(resolved);
    if (!stat.isFile()) return null;
    if (stat.size > FILE_SIZE_CAP_BYTES) {
      console.warn(
        `[skills/hooks/caipe-catalog.sh] file too large (${stat.size} bytes): ${resolved}`,
      );
      return null;
    }
    return fs.readFileSync(resolved, "utf-8");
  } catch (err) {
    console.warn(
      `[skills/hooks/caipe-catalog.sh] failed to read ${filePath}:`,
      err,
    );
    return null;
  }
}

function resolveHookSource(): { source: string; origin: string } {
  const envFile = process.env.SKILLS_HOOK_FILE;
  if (envFile) {
    const fromEnv = safeReadFile(envFile);
    if (fromEnv) return { source: fromEnv, origin: `file:${envFile}` };
  }

  const chartPath = path.resolve(
    process.cwd(),
    "..",
    "charts",
    "ai-platform-engineering",
    "data",
    "skills",
    "caipe-catalog.sh",
  );
  const packagedPath = path.resolve(process.cwd(), "data", "skills", "caipe-catalog.sh");
  const packaged = safeReadFile(packagedPath);
  if (packaged) return { source: packaged, origin: `file:${packagedPath}` };
  const fromChart = safeReadFile(chartPath);
  if (fromChart) return { source: fromChart, origin: `file:${chartPath}` };

  return { source: FALLBACK_HOOK, origin: "fallback" };
}

function sanitizeBaseUrl(raw: string | null): string | null {
  if (!raw) return null;
  try {
    const url = new URL(raw);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    if (url.username || url.password) return null;
    return url.origin + url.pathname.replace(/\/+$/, "");
  } catch {
    return null;
  }
}

function sanitizeCommandName(raw: string | null, fallback: string): string {
  const trimmed = (raw ?? "").trim();
  if (!trimmed) return fallback;
  if (trimmed.length > 64) return fallback;
  if (!/^[A-Za-z0-9._-]+$/.test(trimmed)) return fallback;
  return trimmed;
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const baseUrl =
    sanitizeBaseUrl(url.searchParams.get("base_url")) ??
    getRequestOrigin(request);
  const commandName = sanitizeCommandName(
    url.searchParams.get("command_name"),
    DEFAULT_LIVE_SKILLS_COMMAND,
  );
  const updateCommandName = sanitizeCommandName(
    url.searchParams.get("update_command_name"),
    deriveUpdateCommandName(commandName) || DEFAULT_UPDATE_SKILLS_COMMAND,
  );

  const { source } = resolveHookSource();
  const rendered = source
    .replace(/\{\{BASE_URL\}\}/g, baseUrl)
    .replace(/\{\{COMMAND_NAME\}\}/g, commandName)
    .replace(/\{\{UPDATE_COMMAND_NAME\}\}/g, updateCommandName);

  return new NextResponse(rendered, {
    status: 200,
    headers: {
      "Content-Type": "text/x-shellscript; charset=utf-8",
      "Content-Disposition": "inline; filename=caipe-catalog.sh",
      "Cache-Control": "no-store",
    },
  });
}
