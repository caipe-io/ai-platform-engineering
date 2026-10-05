/**
 * GET /api/skills/helpers/caipe-skills.py
 *
 * Returns the canonical CAIPE skills helper as a Python source file. This
 * file is the single client-side dependency for both the `/caipe-skills`
 * (live-skills) and `/update-caipe-skills` slash commands: it queries the
 * catalog API and (with `--register PATH`) writes install-manifest
 * entries used by `/update-caipe-skills` to track which on-disk skills CAIPE
 * owns.
 *
 * `install.sh` curls this endpoint exactly once per install scope into
 * `~/.config/caipe/caipe-skills.py` and the slash-command templates then
 * call it via `python3` / `uv run`. Re-running `install.sh --upgrade`
 * fetches a fresh copy.
 *
 * Why a separate endpoint:
 *   - The original inlined `python3 -c "..."` block was 20+ lines of
 *     escaped Python embedded in a Markdown code fence inside a bash
 *     call. It was unreadable, fragile (single-quote escaping), and
 *     impossible to test.
 *   - As a separate file we can import it from tests, type-check args,
 *     and ship config-file resolution + URL validation that would be
 *     hostile to write inline.
 *   - As a separate endpoint the helper is fetched fresh on first run
 *     and re-fetched whenever the user opts to upgrade — same model as
 *     the live-skills template itself.
 *
 * Optional query params:
 *   - base_url: replaces the literal token "{{BASE_URL}}" in the
 *               helper's `DEFAULT_BASE_URL` constant so the installed
 *               file calls back to the deployment that served it (rather
 *               than the unrewritten placeholder, which the helper
 *               treats as "no base_url configured" and errors out on).
 *               Defaults to the request origin via `getRequestOrigin`,
 *               which honors NEXTAUTH_URL / x-forwarded-* before falling
 *               back to the inbound URL — important when running behind
 *               an ingress.
 *
 * Resolution order for the helper SOURCE on the gateway side:
 *   1. SKILLS_HELPER_FILE env var (operator override)
 *   2. <repo>/charts/ai-platform-engineering/data/skills/caipe-skills.py
 *   3. Built-in minimal fallback (just enough for the agent to report
 *      a clear error to the operator)
 *
 * Resolution order for base_url INSIDE the served Python file (after
 * install) is documented in caipe-skills.py's module docstring; the
 * route only sets the baked default. End users can still override via
 * env vars or their config.json without re-fetching the helper.
 *
 * Response:
 *   - Content-Type: text/x-python; charset=utf-8
 *   - Content-Disposition: inline; filename=caipe-skills.py
 *   - Cache-Control: no-store
 */

import fs from "fs";
import { NextResponse } from "next/server";
import path from "path";
import { getRequestOrigin } from "../../_lib/request-origin";

const FALLBACK_HELPER = `#!/usr/bin/env python3
"""Fallback CAIPE skills helper (operator misconfiguration: chart file missing)."""
import json, sys
print(json.dumps({"error": "caipe-skills.py source not found on the gateway. "
                          "Set SKILLS_HELPER_FILE or restore "
                          "charts/ai-platform-engineering/data/skills/caipe-skills.py."}))
sys.exit(0)
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
        `[skills/helpers/caipe-skills.py] file too large (${stat.size} bytes): ${resolved}`,
      );
      return null;
    }
    return fs.readFileSync(resolved, "utf-8");
  } catch (err) {
    console.warn(
      `[skills/helpers/caipe-skills.py] failed to read ${filePath}:`,
      err,
    );
    return null;
  }
}

function resolveHelperSource(): { source: string; origin: string } {
  const envFile = process.env.SKILLS_HELPER_FILE;
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
    "caipe-skills.py",
  );
  const packagedPath = path.resolve(process.cwd(), "data", "skills", "caipe-skills.py");
  const packaged = safeReadFile(packagedPath);
  if (packaged) return { source: packaged, origin: `file:${packagedPath}` };
  const fromChart = safeReadFile(chartPath);
  if (fromChart) return { source: fromChart, origin: `file:${chartPath}` };

  return { source: FALLBACK_HELPER, origin: "fallback" };
}

/**
 * Validate base URL: only http(s), no embedded credentials. Returns null
 * if invalid. Mirrors the validation in `live-skills/route.ts` so the
 * helper file we write is byte-identical to what the live-skills template
 * would have produced.
 */
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

export async function GET(request: Request) {
  const url = new URL(request.url);
  const baseUrl =
    sanitizeBaseUrl(url.searchParams.get("base_url")) ??
    getRequestOrigin(request);

  const { source } = resolveHelperSource();
  // Substitute the {{BASE_URL}} placeholder so the installed file calls
  // back to *this* deployment by default, not to localhost.
  const rendered = source.replace(/\{\{BASE_URL\}\}/g, baseUrl);

  return new NextResponse(rendered, {
    status: 200,
    headers: {
      "Content-Type": "text/x-python; charset=utf-8",
      "Content-Disposition": "inline; filename=caipe-skills.py",
      "Cache-Control": "no-store",
    },
  });
}
