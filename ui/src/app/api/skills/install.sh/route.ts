/**
 * GET /api/skills/install.sh
 *
 * Returns a portable bash installer that fetches and writes CAIPE skill
 * artifacts to a user's machine. The script is intended for `curl … | bash`
 * or "download & inspect first" workflows surfaced from the Skills
 * Gateway UI.
 *
 * Skills-only layout
 * ------------------
 * Every supported coding agent (Claude Code, Cursor, Codex CLI, Gemini
 * CLI, opencode) consumes the open `agentskills.io` standard
 * `SKILL.md` format. Most agents discover skills from the shared
 * `.agents/skills` tree; Claude Code's `/skills` command discovers from
 * `.claude/skills`, so Claude installs write both native and shared copies:
 *
 *   Claude user scope    → `~/.claude/skills/<name>/SKILL.md`
 *                         + `~/.agents/skills/<name>/SKILL.md`
 *   Claude project scope → `./.claude/skills/<name>/SKILL.md`
 *                         + `./.agents/skills/<name>/SKILL.md`
 *   Other agents         → `~/.agents/skills/<name>/SKILL.md`
 *                         or `./.agents/skills/<name>/SKILL.md`
 *
 * The agent picker only affects:
 *   - which launch-guide footer the success card prints (every agent
 *     receives the same `$ARGUMENTS` token in the rendered SKILL.md
 *     body — only Claude actually substitutes it; the other four
 *     read SKILL.md verbatim and surface the token as instructional
 *     text the model interprets).
 *
 * Modes
 * -----
 * 1. `bulk-with-helpers` (DEFAULT, when no `catalog_url` and no
 *    `mode=live-only`): bulk-install every catalog skill, drop the two
 *    helper skills (`/caipe-skills` live-fetch + `/update-caipe-skills`
 *    user-driven refresh by default), install the Python catalog helper at
 *    ~/.config/caipe/caipe-skills.py, and (Claude only) register the
 *    SessionStart hook at ~/.claude/hooks/caipe-catalog.sh that injects
 *    the live catalog index into Claude's `additionalContext`. The hook
 *    path is registered in ~/.claude/settings.json after taking a
 *    timestamped backup of the existing settings file. Auto-seeds
 *    ~/.config/caipe/config.json with the gateway base_url (never the
 *    api_key — user supplies that). Cleans up legacy install artifacts
 *    when `--upgrade` is passed.
 *
 * 2. `live-only` (`?mode=live-only`): the legacy default, demoted to an
 *    Advanced toggle in the UI. Installs ONLY the single `/caipe-skills`
 *    live-skills slash command. No helpers, no hook, no auto-config.
 *
 * 3. `catalog-query bulk` (`?catalog_url=…`): unchanged. Materializes
 *    one file per skill returned by the gateway query the user built in
 *    the "Pick your skills" panel. No helpers, no hook.
 *
 * 4. `uninstall` (`?mode=uninstall`): the reverse flow. Reads the sidecar
 *    manifest at `~/.config/caipe/installed.json` (or
 *    `./.caipe/installed.json` for project scope) and walks the user
 *    through removing every CAIPE-owned file with per-item confirmation.
 *    When no `?scope=` is set, walks BOTH manifests in deterministic
 *    order (user, then project) with independent y/N/a/q loops.
 *    Surgically reverses the Claude `~/.claude/settings.json`
 *    SessionStart hook patch when a hook entry is removed. Preserves
 *    `config.json` unless `--purge` is passed.
 *
 * Backward compatibility
 * ----------------------
 * - `?layout=…` is silently accepted and ignored. (Pre-overhaul one-liners
 *   still work.)
 *
 * Query params:
 *   - agent:        agent id (claude | cursor | codex | gemini | opencode).
 *                   Required for non-uninstall modes (we don't pick a
 *                   default for an installer; ambiguity here would write
 *                   to the wrong path). For `mode=uninstall` agent
 *                   defaults to `claude` since uninstall is manifest-
 *                   driven and only consults the agent for the launch
 *                   label in the success card.
 *   - scope:        install scope ("user" | "project"). Required for
 *                   non-uninstall modes. For `mode=uninstall` the scope
 *                   is OPTIONAL — when omitted the script walks BOTH
 *                   manifests with independent prompt loops.
 *   - command_name: slash command name. Defaults to "caipe-skills" (sanitized).
 *   - description:  optional description; defaults to the canonical
 *                   template's frontmatter description.
 *   - base_url:     gateway base URL the script should call back into
 *                   when fetching the rendered template at install time.
 *                   Defaults to the request origin.
 *
 * Security notes:
 *   - The script NEVER prints or logs the API key. Resolution order:
 *       1. `--api-key=<value>` flag (warns: visible in `ps`)
 *       2. `$CAIPE_CATALOG_KEY` env var
 *       3. `~/.config/caipe/config.json` { "api_key": "..." }
 *       4. `~/.config/grid/config.json`  { "api_key": "..." } (fallback)
 *   - The rendered template body is NOT baked into the script. Instead
 *     the script does a fresh GET to /api/skills/live-skills?... at
 *     install time, so users always get the latest canonical template
 *     and the script stays small and easy to audit.
 *   - We refuse to overwrite an existing target file unless `--upgrade`
 *     (for a previously-installed CAIPE skill) or `--force` (escape
 *     hatch) is passed.
 *   - Ownership of installed files is tracked in a sidecar manifest at
 *     `~/.config/caipe/installed.json`. `--upgrade` consults the manifest
 *     to decide whether it's safe to overwrite a file. The manifest entry
 *     shape is `{ name, kind, paths: [<list>], installed_at }`. Legacy
 *     entries with a single `path` field are read transparently.
 *
 * Response:
 *   - Content-Type: text/x-shellscript; charset=utf-8
 *   - Content-Disposition: attachment; filename=install-skills-<agent>-<scope>.sh
 *   - Cache-Control: no-store
 */

import { NextResponse } from "next/server";
import { getRequestOrigin } from "../_lib/request-origin";
import {
AGENTS,
DEFAULT_AGENT_ID,
DEFAULT_LIVE_SKILLS_COMMAND,
deriveUpdateCommandName,
scopesAvailableFor,
type AgentSpec,
} from "../live-skills/agents";

/* ---------- input sanitizers ---------- */

function sanitizeCommandName(raw: string | null): string {
  const trimmed = (raw ?? "").trim();
  if (!trimmed) return DEFAULT_LIVE_SKILLS_COMMAND;
  if (trimmed.length > 64) return DEFAULT_LIVE_SKILLS_COMMAND;
  if (!/^[A-Za-z0-9._-]+$/.test(trimmed)) return DEFAULT_LIVE_SKILLS_COMMAND;
  return trimmed;
}

function sanitizeDescription(raw: string | null): string {
  const trimmed = (raw ?? "").trim();
  if (!trimmed) return "";
  return trimmed.slice(0, 500);
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

/**
 * Sanitize an optional ?catalog_url=… coming from the Skills Gateway
 * UI Query Builder. Same constraints as before the overhaul:
 *   - http:// or https:// only
 *   - no userinfo
 *   - same origin as `base_url` (or the request origin)
 *   - path must be exactly `/api/skills`
 */
function sanitizeCatalogUrl(
  raw: string | null,
  baseOrigin: string,
): string | null {
  if (!raw) return null;
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return null;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
  if (parsed.username || parsed.password) return null;
  if (parsed.origin !== baseOrigin) return null;
  if (parsed.pathname.replace(/\/+$/, "") !== "/api/skills") return null;
  parsed.searchParams.set("include_content", "true");
  return parsed.toString();
}

/* ---------- shell quoting ---------- */

/**
 * Single-quote a value for safe inclusion in a bash script. Replaces
 * any `'` with `'\''` (close, escaped quote, reopen).
 */
function shq(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

/**
 * Compute the parent skill directory from a `.../skills/{name}/SKILL.md`
 * template. We strip the trailing `/{name}/SKILL.md` to recover the
 * `<root>/skills` portion (the directory the bulk install loop creates
 * `<safe_name>/SKILL.md` underneath).
 */
function skillsRootDirFor(installPathTemplate: string): string {
  const stripped = installPathTemplate.replace(/\/\{name\}\/[^/]+$/, "");
  if (stripped !== installPathTemplate) return stripped;
  // Defensive fallback: if the template doesn't match, drop the last
  // segment and hope the caller knows what they're doing. Today every
  // entry in AGENTS.installPaths follows the canonical shape.
  const idx = installPathTemplate.lastIndexOf("/");
  return idx < 0 ? "." : installPathTemplate.slice(0, idx);
}

/* ---------- error responses (plain text) ---------- */

function plainTextError(message: string, status: number): NextResponse {
  return new NextResponse(`# install-skills error: ${message}\nexit 64\n`, {
    status,
    headers: {
      "Content-Type": "text/x-shellscript; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}

/* ---------- script generator ---------- */

/**
 * Which install flow the generated script implements. See the route
 * docstring for the user-visible behavior of each.
 */
type InstallMode =
  | "bulk-with-helpers"
  | "live-only"
  | "catalog-query"
  | "uninstall";

interface ScriptInputs {
  agent: AgentSpec;
  scope: "user" | "project";
  /**
   * Only meaningful for `mode === "uninstall"`. When `true` the
   * generated script walks BOTH the user manifest and the project
   * manifest (in that order) with independent y/N/a/q prompt loops.
   * When `false` only the explicitly-requested scope's manifest is
   * walked.
   */
  walkBothManifests: boolean;
  commandName: string;
  description: string;
  baseUrl: string;
  mode: InstallMode;
  /**
   * Only set when `mode === "catalog-query"`. URL of a
   * `<baseUrl>/api/skills?...` listing to iterate; the script writes
   * one SKILL.md per returned skill into both universal skill roots.
   */
  catalogUrl: string | null;
}

function buildScript(inputs: ScriptInputs): string {
  if (inputs.mode === "uninstall") return buildUninstallScript(inputs);
  return buildInstallScript(inputs);
}

/* ===========================================================================
 *
 * INSTALL SCRIPT
 *
 * Handles bulk-with-helpers (default), live-only (legacy single-skill),
 * and catalog-query (user-built ?catalog_url query) in one generator.
 * Mode-specific steps are gated by environment variables baked into the
 * script header, so the generated bash is uniform regardless of mode.
 *
 * ========================================================================= */

function buildInstallScript(inputs: ScriptInputs): string {
  const {
    agent,
    scope,
    commandName,
    description,
    baseUrl,
    mode,
    catalogUrl,
  } = inputs;

  // Resolve the install paths for the requested scope. Claude has an
  // extra native `.claude/skills` target because its `/skills` command
  // does not read the shared `.agents/skills` tree.
  const scopePaths = agent.installPaths[scope] ?? [];
  if (scopePaths.length === 0) {
    // The handler should have caught this already, but be defensive.
    throw new Error(
      `agent ${agent.id} has no install paths for scope=${scope}`,
    );
  }

  // Where the SKILL.md files for any given <name> land.
  // We pre-compute the parent skill-root directory for each target so
  // the bash side can `mkdir -p` them once.
  const skillRootDirs = scopePaths.map(skillsRootDirFor);
  const updateCommandName = deriveUpdateCommandName(commandName);

  // The two helper-template URLs. We always render against THIS agent
  // so $ARGUMENTS-vs-$1 substitution lands correctly.
  const liveSkillsParams = new URLSearchParams({
    agent: agent.id,
    scope,
    command_name: commandName,
    base_url: baseUrl,
  }).toString();
  const updateSkillsParams = new URLSearchParams({
    agent: agent.id,
    scope,
    command_name: updateCommandName,
    base_url: baseUrl,
  }).toString();
  const liveSkillsUrl = `${baseUrl}/api/skills/live-skills?${liveSkillsParams}`;
  const updateSkillsUrl = `${baseUrl}/api/skills/update-skills?${updateSkillsParams}`;
  const helperPyUrl = `${baseUrl}/api/skills/helpers/caipe-skills.py?base_url=${encodeURIComponent(baseUrl)}`;
  const hookShUrl = `${baseUrl}/api/skills/hooks/caipe-catalog.sh?${new URLSearchParams(
    {
      base_url: baseUrl,
      command_name: commandName,
      update_command_name: updateCommandName,
    },
  ).toString()}`;

  // Bulk catalog query (used by both bulk-with-helpers and catalog-query
  // modes). page_size=200 covers any realistic single-org catalog.
  const bulkCatalogUrl =
    catalogUrl ??
    `${baseUrl}/api/skills?page=1&page_size=200&include_content=true`;

  // For the live-only mode we render the single browse slash command
  // for THIS agent and write it into the skill-root dirs
  // as <root>/<commandName>/SKILL.md (same place the helpers go).
  const singleSkillUrl = `${baseUrl}/api/skills/live-skills?${new URLSearchParams(
    {
      agent: agent.id,
      scope,
      command_name: commandName,
      base_url: baseUrl,
      ...(description ? { description } : {}),
    },
  ).toString()}`;

  // Whether THIS agent is Claude Code. Only Claude has documented
  // SessionStart hook support today.
  const isClaude = agent.id === "claude";

  // Pre-quote everything.
  const Q_AGENT_ID = shq(agent.id);
  const Q_AGENT_LABEL = shq(agent.label);
  const Q_SCOPE = shq(scope);
  const Q_COMMAND = shq(commandName);
  const Q_UPDATE_COMMAND = shq(updateCommandName);
  const Q_BASE_URL = shq(baseUrl);
  const Q_LIVE_URL = shq(liveSkillsUrl);
  const Q_UPDATE_URL = shq(updateSkillsUrl);
  const Q_HELPER_PY_URL = shq(helperPyUrl);
  const Q_HOOK_SH_URL = shq(hookShUrl);
  const Q_BULK_URL = shq(bulkCatalogUrl);
  const Q_SINGLE_URL = shq(singleSkillUrl);

  // Mode flags baked into the script header.
  const DO_BULK = mode === "bulk-with-helpers" || mode === "catalog-query"
    ? "1"
    : "0";
  const DO_HELPERS = mode === "bulk-with-helpers" ? "1" : "0";
  const DO_HOOK = mode === "bulk-with-helpers" && isClaude ? "1" : "0";
  const DO_LIVE_ONLY = mode === "live-only" ? "1" : "0";

  // Paths: emit each as a quoted bash array element, one per line for
  // readability.
  const pathArrayLines = scopePaths.map((p) => `  ${shq(p)}`).join("\n");
  const skillRootArrayLines = skillRootDirs
    .map((p) => `  ${shq(p)}`)
    .join("\n");

  // Modes for the script banner.
  const modeBanner =
    mode === "bulk-with-helpers"
      ? "bulk-with-helpers (everything for native discovery)"
      : mode === "catalog-query"
        ? "bulk install from custom ?catalog_url"
        : "live-only (single /" + commandName + " slash command)";

  return `#!/usr/bin/env bash
# install-skills.sh — CAIPE skills installer
#
# Generated by ${baseUrl}/api/skills/install.sh
# Agent : ${agent.label} (${agent.id})
# Scope : ${scope} (${scope === "user" ? "user-global" : "project-local"})
# Mode  : ${modeBanner}
#
# This installer writes SKILL.md files to the configured skills paths for
# ${agent.label}. Claude Code gets a native .claude/skills copy because
# its /skills command does not read .agents/skills:
#
${scopePaths.map((p) => `#   - ${p}`).join("\n")}
#
# Mode-gated steps:
#   - bulk catalog materialization     (${DO_BULK === "1" ? "enabled" : "skipped"})
#   - /${commandName} + /${updateCommandName} helpers (${DO_HELPERS === "1" ? "enabled" : "skipped"})
${isClaude ? `#   - Claude SessionStart hook         (${DO_HOOK === "1" ? "enabled" : "skipped"})\n` : `#   (no SessionStart hook — only Claude Code supports them today)\n`}#   - python helper at ~/.config/caipe/caipe-skills.py
#   - ~/.config/caipe/config.json (base_url only, never api_key)
#
# Usage:
#   CAIPE_CATALOG_KEY=<your-key> bash <(curl -fsSL <this-url>)
#   ./install-skills.sh --upgrade   # refresh existing CAIPE-owned files
#   ./install-skills.sh --no-bulk   # just helpers + hook + helper.py
#
# Security: this script NEVER prints, logs, or echoes the API key.

set -euo pipefail

AGENT_ID=${Q_AGENT_ID}
AGENT_LABEL=${Q_AGENT_LABEL}
SCOPE=${Q_SCOPE}
COMMAND_NAME=${Q_COMMAND}
UPDATE_COMMAND_NAME=${Q_UPDATE_COMMAND}
BASE_URL=${Q_BASE_URL}
LIVE_SKILLS_URL=${Q_LIVE_URL}
UPDATE_SKILLS_URL=${Q_UPDATE_URL}
HELPER_PY_URL=${Q_HELPER_PY_URL}
HOOK_SH_URL=${Q_HOOK_SH_URL}
BULK_CATALOG_URL=${Q_BULK_URL}
SINGLE_SKILL_URL=${Q_SINGLE_URL}
IS_CLAUDE=${isClaude ? "1" : "0"}
DO_BULK=${DO_BULK}
DO_HELPERS=${DO_HELPERS}
DO_HOOK=${DO_HOOK}
DO_LIVE_ONLY=${DO_LIVE_ONLY}

# Install paths (templates with {name} placeholders).
# These are the per-skill SKILL.md files; the helpers and live-only
# install use the same {name} substitution.
SKILL_PATH_TEMPLATES=(
${pathArrayLines}
)
# Pre-stripped parent skill-root directories. SKILL_PATH_TEMPLATES[i]
# corresponds to "\${SKILL_ROOT_DIRS[i]}/<name>/SKILL.md".
SKILL_ROOT_DIRS=(
${skillRootArrayLines}
)

API_KEY="\${CAIPE_CATALOG_KEY:-}"
FORCE=0
UPGRADE=0
NO_BULK=0
NO_HELPERS=0
NO_HOOK=0

# Sidecar manifest of files we wrote. Lives next to config.json; one file
# per workstation in user scope, per project in project scope so worktrees
# don't bleed into each other.
case "\$SCOPE" in
  user)    MANIFEST_PATH="\${HOME:-.}/.config/caipe/installed.json" ;;
  project) MANIFEST_PATH="./.caipe/installed.json" ;;
esac
MANIFEST_PATH="\${CAIPE_INSTALL_MANIFEST:-\$MANIFEST_PATH}"

# Dotfiles for auto-seeding the user-side config.
CAIPE_CONFIG_DIR="\${HOME:-.}/.config/caipe"
CAIPE_CONFIG_FILE="\$CAIPE_CONFIG_DIR/config.json"
CAIPE_HELPER_PY="\$CAIPE_CONFIG_DIR/caipe-skills.py"

# Claude-specific paths for the SessionStart hook. Only used when
# IS_CLAUDE=1.
case "\$SCOPE" in
  user)    CLAUDE_DIR="\${HOME:-.}/.claude" ;;
  project) CLAUDE_DIR="./.claude" ;;
esac
CLAUDE_HOOK_DIR="\$CLAUDE_DIR/hooks"
CLAUDE_HOOK_FILE="\$CLAUDE_HOOK_DIR/caipe-catalog.sh"
CLAUDE_SETTINGS_FILE="\$CLAUDE_DIR/settings.json"

usage() {
  cat <<USAGE
install-skills.sh — installer for \$AGENT_LABEL.

Usage:
  $0 [flags]

Flags:
  --upgrade        Refresh existing CAIPE-owned files and clean up
                   legacy install artifacts from previous versions.
  --force          Overwrite ANY existing target file (escape hatch).
  --no-bulk        Skip the bulk catalog install. Only the helpers,
                   the python helper, and (Claude) the hook are written.
  --no-helpers     Skip writing the /\$COMMAND_NAME and /\$UPDATE_COMMAND_NAME helper
                   skill commands.
  --no-hook        Skip the Claude SessionStart hook.
                   No-op when AGENT is not "claude".
  --api-key=<key>  Pass the catalog key on the command line.
                   WARNING: visible in 'ps' AND shell history.
  --help           Show this message.

Environment:
  CAIPE_CATALOG_KEY        Catalog API key. Never echoed by this script.
  CAIPE_INSTALL_MANIFEST   Override path of the install manifest
                           (default: \$MANIFEST_PATH).
USAGE
}

while [ "\$#" -gt 0 ]; do
  case "\$1" in
    --api-key=*)
      API_KEY="\${1#--api-key=}"
      echo "warning: --api-key passes the secret on the process command line." >&2
      ;;
    --api-key)
      shift
      API_KEY="\${1:-}"
      echo "warning: --api-key passes the secret on the process command line." >&2
      ;;
    --force) FORCE=1 ;;
    --upgrade) UPGRADE=1 ;;
    --no-bulk) NO_BULK=1 ;;
    --no-helpers) NO_HELPERS=1 ;;
    --no-hook) NO_HOOK=1 ;;
    --help|-h) usage; exit 0 ;;
    *)
      echo "error: unknown argument: \$1" >&2
      usage >&2
      exit 64
      ;;
  esac
  shift || true
done

# ---------- API key resolution (config > env > flag) ----------
read_api_key_from_config() {
  local cfg_path="\$1"
  [ -r "\$cfg_path" ] || return 1
  command -v python3 >/dev/null 2>&1 || return 1
  python3 -c '
import json, sys
try:
  data = json.load(open(sys.argv[1]))
except Exception:
  sys.exit(1)
key = (data.get("api_key") or "").strip()
if not key:
  sys.exit(1)
sys.stdout.write(key)
' "\$cfg_path" 2>/dev/null && return 0
  return 1
}

if [ -z "\$API_KEY" ]; then
  for cfg in "\$CAIPE_CONFIG_FILE" "\${HOME:-.}/.config/grid/config.json"; do
    if k="\$(read_api_key_from_config "\$cfg")" && [ -n "\$k" ]; then
      API_KEY="\$k"
      echo "==> using API key from \$cfg" >&2
      break
    fi
  done
fi

if [ -z "\$API_KEY" ]; then
  echo "error: catalog API key is required." >&2
  echo "       Easiest fix: create \$CAIPE_CONFIG_FILE with:" >&2
  echo "           { \\"api_key\\": \\"<your-key>\\" }" >&2
  echo "       Or pass --api-key=<key> / set CAIPE_CATALOG_KEY=<key>." >&2
  exit 64
fi

# Required tooling.
if ! command -v curl >/dev/null 2>&1; then
  echo "error: curl is required but was not found in PATH." >&2
  exit 69
fi
if ! command -v python3 >/dev/null 2>&1; then
  echo "error: python3 is required (the helper scripts and manifest" >&2
  echo "       writer both use it). Install python3 and re-run." >&2
  exit 69
fi

# ---------- Resolve install paths for this scope ----------
# Expand ~ in user scope; project paths stay relative.
RESOLVED_SKILL_PATHS=()
RESOLVED_SKILL_ROOTS=()
case "\$SCOPE" in
  user)
    if [ -z "\${HOME:-}" ]; then
      echo "error: \\$HOME is not set; cannot resolve user-global install path." >&2
      exit 78
    fi
    for tpl in "\${SKILL_PATH_TEMPLATES[@]}"; do
      RESOLVED_SKILL_PATHS+=( "\${tpl/#~\\//\$HOME/}" )
    done
    for d in "\${SKILL_ROOT_DIRS[@]}"; do
      RESOLVED_SKILL_ROOTS+=( "\${d/#~\\//\$HOME/}" )
    done
    ;;
  project)
    for tpl in "\${SKILL_PATH_TEMPLATES[@]}"; do
      RESOLVED_SKILL_PATHS+=( "\$tpl" )
    done
    for d in "\${SKILL_ROOT_DIRS[@]}"; do
      RESOLVED_SKILL_ROOTS+=( "\$d" )
    done
    ;;
esac

# ---------- Install manifest helpers ----------
# Manifest entries use the new shape: { name, kind, paths: [...], ... }.
# A legacy entry with a single "path" field is read transparently
# (treated as a one-element paths array) but never written back.

manifest_register_paths() {
  # manifest_register_paths <name> <kind> <path1> [<path2> ...]
  # kind: skill | helper | catalog | hook | config | helper-py
  local name="\$1" kind="\$2"; shift 2
  local cfg_dir; cfg_dir="\$(dirname "\$MANIFEST_PATH")"
  mkdir -p "\$cfg_dir" 2>/dev/null || return 0
  # IMPORTANT: heredoc + pipe-to-stdin do NOT compose -- the
  # heredoc redirects stdin to the script source, silently
  # discarding anything we pipe in. Pass paths as trailing
  # positional args instead.
  python3 - "\$MANIFEST_PATH" "\$AGENT_ID" "\$SCOPE" "\$name" "\$kind" "\$@" <<'PY' 2>/dev/null || true
import datetime, json, os, sys, tempfile
manifest_path, agent, scope, name, kind, *paths = sys.argv[1:]
data = {"version": 2, "installed": []}
if os.path.isfile(manifest_path):
    try:
        data = json.load(open(manifest_path))
        if not isinstance(data, dict):
            data = {"version": 2, "installed": []}
        data.setdefault("version", 2)
        data.setdefault("installed", [])
    except Exception:
        data = {"version": 2, "installed": []}
now = datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds")
entry = {
    "agent": agent, "scope": scope, "name": name, "kind": kind,
    "paths": paths, "installed_at": now,
}
# De-dupe: replace any existing entry for the same (agent, scope, name, kind).
def is_dup(e):
    return (
        e.get("agent") == agent and e.get("scope") == scope
        and (e.get("name") or "").lower() == name.lower()
        and (e.get("kind") or "skill") == kind
    )
data["installed"] = [e for e in data["installed"] if not is_dup(e)] + [entry]
fd, tmp = tempfile.mkstemp(prefix=".caipe-manifest-", dir=os.path.dirname(manifest_path) or ".")
try:
    with os.fdopen(fd, "w") as f:
        json.dump(data, f, indent=2)
        f.write("\\n")
    os.replace(tmp, manifest_path)
    os.chmod(manifest_path, 0o600)
except Exception:
    try: os.unlink(tmp)
    except OSError: pass
PY
}

manifest_owns() {
  # manifest_owns <abs-path>  →  exit 0 if the manifest records this path,
  # exit 1 otherwise. Handles both the new "paths" array shape and the
  # legacy single-"path" shape.
  local target="\$1"
  [ -r "\$MANIFEST_PATH" ] || return 1
  python3 -c '
import json, sys
try: data = json.load(open(sys.argv[1]))
except Exception: sys.exit(1)
target = sys.argv[2]
for e in (data or {}).get("installed", []) or []:
    paths = e.get("paths") or ([e["path"]] if isinstance(e.get("path"), str) else [])
    if target in paths: sys.exit(0)
sys.exit(1)
' "\$MANIFEST_PATH" "\$target" 2>/dev/null
}

# Centralized "may we write to this path?" gate.
may_write() {
  local target="\$1"
  if [ ! -e "\$target" ]; then
    return 0
  fi
  if [ "\$FORCE" -eq 1 ]; then
    return 0
  fi
  if [ "\$UPGRADE" -eq 1 ] && manifest_owns "\$target"; then
    return 0
  fi
  return 1
}

# ---------- Atomic curl-to-file ----------
fetch_to() {
  local url="\$1" target="\$2"
  local parent; parent="\$(dirname "\$target")"
  mkdir -p "\$parent"
  local tmp; tmp="\$(mktemp "\$parent/.caipe-fetch-XXXXXX")"
  local status
  status="\$(curl -sS -o "\$tmp" -w '%{http_code}' \\
    -H "X-Caipe-Catalog-Key: \$API_KEY" \\
    -H 'Accept: */*' \\
    "\$url")" || { rm -f "\$tmp"; echo "error: curl failed for \$url" >&2; return 69; }
  if [ "\$status" != "200" ]; then
    echo "error: HTTP \$status for \$url" >&2
    if [ -s "\$tmp" ]; then echo "       body: \$(head -c 500 "\$tmp")" >&2; fi
    rm -f "\$tmp"
    return 76
  fi
  mv -f "\$tmp" "\$target"
  return 0
}

# Pull the rendered "template" field out of a /api/skills/{live,update}-skills
# response and write the unwrapped markdown to \$target.
fetch_template_to() {
  local url="\$1" target="\$2"
  local parent; parent="\$(dirname "\$target")"
  mkdir -p "\$parent"
  local tmp_json; tmp_json="\$(mktemp "\$parent/.caipe-tpl-XXXXXX")"
  local status
  status="\$(curl -sS -o "\$tmp_json" -w '%{http_code}' \\
    -H "X-Caipe-Catalog-Key: \$API_KEY" \\
    -H 'Accept: application/json' \\
    "\$url")" || { rm -f "\$tmp_json"; return 69; }
  if [ "\$status" != "200" ]; then
    echo "error: HTTP \$status for \$url" >&2
    rm -f "\$tmp_json"
    return 76
  fi
  python3 - "\$tmp_json" "\$target" <<'PY' || { rm -f "\$tmp_json"; return 76; }
import json, os, sys, tempfile
src, dst = sys.argv[1:]
data = json.load(open(src))
body = data.get("template") or ""
if not body:
    sys.stderr.write("template field missing or empty in response\\n")
    sys.exit(1)
parent = os.path.dirname(dst) or "."
os.makedirs(parent, exist_ok=True)
fd, tmp = tempfile.mkstemp(prefix=".caipe-tpl-", dir=parent)
with os.fdopen(fd, "w", encoding="utf-8") as f:
    f.write(body)
os.replace(tmp, dst)
os.chmod(dst, 0o644)
PY
  rm -f "\$tmp_json"
  return 0
}

# Write a single SKILL.md to all configured paths under <root>/<name>/.
# Used by the live-only flow + by the helpers (which need the SAME
# rendered body in every target). Returns 0 if at least one target was
# written; 1 if every target was skipped.
write_to_all_targets() {
  local name="\$1" tmp_body="\$2" kind="\$3"
  local wrote=0
  local written_paths=()
  local i=0
  while [ \$i -lt \${#RESOLVED_SKILL_ROOTS[@]} ]; do
    local root="\${RESOLVED_SKILL_ROOTS[\$i]}"
    local target="\$root/\$name/SKILL.md"
    if may_write "\$target"; then
      mkdir -p "\$(dirname "\$target")"
      local tmp; tmp="\$(mktemp "\$(dirname "\$target")/.caipe-install-XXXXXX")"
      cp "\$tmp_body" "\$tmp"
      mv -f "\$tmp" "\$target"
      chmod 0644 "\$target"
      written_paths+=( "\$target" )
      echo "==> installed \$target"
      wrote=\$((wrote + 1))
    else
      echo "skip: \$target exists (re-run with --upgrade or --force to replace)" >&2
    fi
    i=\$((i + 1))
  done
  if [ \$wrote -gt 0 ]; then
    manifest_register_paths "\$name" "\$kind" "\${written_paths[@]}"
    return 0
  fi
  return 1
}

# ---------- Step: legacy cleanup (--upgrade only) ----------
# Removes commands-layout artifacts from prior CAIPE versions for ALL
# five supported agents at both user + project scope. We only delete
# files whose presence is unambiguously a CAIPE leftover (canonical
# slash-command paths the install side previously wrote).
do_legacy_cleanup() {
  [ "\$UPGRADE" -eq 1 ] || return 0
  local removed=0

  # Legacy commands-layout paths for every supported agent. Fixed legacy
  # helper names and the current branded/custom helper names are cleaned up.
  local home="\${HOME:-.}"
  local legacy_paths=(
    # Claude Code
    "\$home/.claude/commands/skills.md"
    "\$home/.claude/commands/update-skills.md"
    "\$home/.claude/commands/\$COMMAND_NAME.md"
    "\$home/.claude/commands/\$UPDATE_COMMAND_NAME.md"
    "./.claude/commands/skills.md"
    "./.claude/commands/update-skills.md"
    "./.claude/commands/\$COMMAND_NAME.md"
    "./.claude/commands/\$UPDATE_COMMAND_NAME.md"
    # Cursor
    "\$home/.cursor/commands/skills.md"
    "\$home/.cursor/commands/update-skills.md"
    "\$home/.cursor/commands/\$COMMAND_NAME.md"
    "\$home/.cursor/commands/\$UPDATE_COMMAND_NAME.md"
    "./.cursor/commands/skills.md"
    "./.cursor/commands/update-skills.md"
    "./.cursor/commands/\$COMMAND_NAME.md"
    "./.cursor/commands/\$UPDATE_COMMAND_NAME.md"
    # Codex CLI
    "\$home/.codex/prompts/skills.md"
    "\$home/.codex/prompts/update-skills.md"
    "\$home/.codex/prompts/\$COMMAND_NAME.md"
    "\$home/.codex/prompts/\$UPDATE_COMMAND_NAME.md"
    "./.codex/prompts/skills.md"
    "./.codex/prompts/update-skills.md"
    "./.codex/prompts/\$COMMAND_NAME.md"
    "./.codex/prompts/\$UPDATE_COMMAND_NAME.md"
    # Gemini CLI (TOML)
    "\$home/.gemini/commands/skills.toml"
    "\$home/.gemini/commands/update-skills.toml"
    "\$home/.gemini/commands/\$COMMAND_NAME.toml"
    "\$home/.gemini/commands/\$UPDATE_COMMAND_NAME.toml"
    "./.gemini/commands/skills.toml"
    "./.gemini/commands/update-skills.toml"
    "./.gemini/commands/\$COMMAND_NAME.toml"
    "./.gemini/commands/\$UPDATE_COMMAND_NAME.toml"
    # opencode
    "\$home/.config/opencode/command/skills.md"
    "\$home/.config/opencode/command/update-skills.md"
    "\$home/.config/opencode/command/\$COMMAND_NAME.md"
    "\$home/.config/opencode/command/\$UPDATE_COMMAND_NAME.md"
    "./.opencode/command/skills.md"
    "./.opencode/command/update-skills.md"
    "./.opencode/command/\$COMMAND_NAME.md"
    "./.opencode/command/\$UPDATE_COMMAND_NAME.md"
  )
  for legacy in "\${legacy_paths[@]}"; do
    if [ -f "\$legacy" ]; then
      rm -f "\$legacy" && echo "==> removed legacy \$legacy" && removed=\$((removed+1))
    fi
  done

  # Pre-overhaul ~/.claude/skills/skills/SKILL.md dual-install artifact.
  if [ "\$IS_CLAUDE" = "1" ]; then
    local dual="\$CLAUDE_DIR/skills/skills"
    if [ -d "\$dual" ]; then
      local count
      count="\$(find "\$dual" -mindepth 1 -maxdepth 1 \\( -name SKILL.md -o -name 'metadata.json' \\) 2>/dev/null | wc -l | tr -d ' ')"
      local total
      total="\$(find "\$dual" -mindepth 1 -maxdepth 1 2>/dev/null | wc -l | tr -d ' ')"
      if [ "\$count" -gt 0 ] && [ "\$total" -le 2 ]; then
        rm -rf "\$dual" && echo "==> removed legacy \$dual" && removed=\$((removed+1))
      fi
    fi
  fi

  # Strip the two legacy allowlist entries from ~/.claude/settings.json
  # (the SessionStart hook entry is preserved untouched).
  if [ "\$IS_CLAUDE" = "1" ] && [ -f "\$CLAUDE_SETTINGS_FILE" ]; then
    python3 - "\$CLAUDE_SETTINGS_FILE" <<'PY' || true
import datetime, json, os, shutil, sys, tempfile
settings_path = sys.argv[1]
WANTED = {
    "Bash(uv run ~/.config/caipe/caipe-skills.py*)",
    "Bash(python3 ~/.config/caipe/caipe-skills.py*)",
}
try:
    data = json.load(open(settings_path))
except Exception:
    sys.exit(0)
if not isinstance(data, dict):
    sys.exit(0)
permissions = data.get("permissions")
if not isinstance(permissions, dict):
    sys.exit(0)
allow = permissions.get("allow")
if not isinstance(allow, list):
    sys.exit(0)
kept = [r for r in allow if r not in WANTED]
if len(kept) == len(allow):
    sys.exit(0)
if kept:
    permissions["allow"] = kept
else:
    permissions.pop("allow", None)
if not permissions:
    data.pop("permissions", None)
parent = os.path.dirname(settings_path) or "."
ts = datetime.datetime.now(datetime.timezone.utc).strftime("%Y%m%dT%H%M%SZ")
backup_path = f"{settings_path}.caipe-backup-{ts}"
counter = 1
while os.path.exists(backup_path):
    backup_path = f"{settings_path}.caipe-backup-{ts}-{counter}"
    counter += 1
shutil.copy2(settings_path, backup_path)
os.chmod(backup_path, 0o600)
fd, tmp = tempfile.mkstemp(prefix=".caipe-settings-", dir=parent, suffix=".json")
try:
    with os.fdopen(fd, "w") as f:
        json.dump(data, f, indent=2)
        f.write("\\n")
    os.replace(tmp, settings_path)
    os.chmod(settings_path, 0o600)
    print(f"==> stripped legacy allowlist entries from {settings_path}")
except Exception:
    try: os.unlink(tmp)
    except OSError: pass
PY
  fi

  if [ "\$removed" -gt 0 ]; then
    echo "==> legacy cleanup: removed \$removed item(s)"
  fi
}

# ---------- Step: install python helper at ~/.config/caipe/caipe-skills.py ----------
do_install_helper_py() {
  if may_write "\$CAIPE_HELPER_PY"; then
    if fetch_to "\$HELPER_PY_URL" "\$CAIPE_HELPER_PY"; then
      chmod 0755 "\$CAIPE_HELPER_PY"
      manifest_register_paths "caipe-skills.py" "helper-py" "\$CAIPE_HELPER_PY"
      echo "==> installed \$CAIPE_HELPER_PY"
    else
      echo "warn: failed to install \$CAIPE_HELPER_PY (helper skills will not work without it)" >&2
      return 1
    fi
  else
    echo "skip: \$CAIPE_HELPER_PY exists (re-run with --upgrade or --force to replace)" >&2
  fi
}

# ---------- Step: auto-seed ~/.config/caipe/config.json ----------
do_seed_config() {
  if [ -f "\$CAIPE_CONFIG_FILE" ]; then
    return 0
  fi
  python3 - "\$CAIPE_CONFIG_FILE" "\$BASE_URL" <<'PY'
import json, os, sys, tempfile
path, base_url = sys.argv[1:]
parent = os.path.dirname(path) or "."
os.makedirs(parent, exist_ok=True)
data = {"base_url": base_url, "_comment": "Set api_key here to avoid passing --api-key on the command line."}
fd, tmp = tempfile.mkstemp(prefix=".caipe-config-", dir=parent)
with os.fdopen(fd, "w") as f:
    json.dump(data, f, indent=2)
    f.write("\\n")
os.replace(tmp, path)
os.chmod(path, 0o600)
PY
  echo "==> seeded \$CAIPE_CONFIG_FILE (base_url only — add api_key yourself)"
  manifest_register_paths "config" "config" "\$CAIPE_CONFIG_FILE"
}

# ---------- Step: install catalog helper skills ----------
# Each helper is rendered ONCE for this agent then copied to every
# universal target path. The helper's frontmatter declares
# disable-model-invocation: true and allowed-tools so Claude Code
# does not nag for permission on every catalog invocation.
do_install_helpers() {
  [ "\$DO_HELPERS" -eq 1 ] || return 0
  [ "\$NO_HELPERS" -eq 1 ] && return 0

  # Helper 1: browse/search command.
  local tmp_live; tmp_live="\$(mktemp -t caipe-live-XXXXXX)"
  if fetch_template_to "\$LIVE_SKILLS_URL" "\$tmp_live"; then
    write_to_all_targets "\$COMMAND_NAME" "\$tmp_live" "helper" || true
  fi
  rm -f "\$tmp_live"

  # Helper 2: paired refresh command.
  local tmp_upd; tmp_upd="\$(mktemp -t caipe-upd-XXXXXX)"
  if fetch_template_to "\$UPDATE_SKILLS_URL" "\$tmp_upd"; then
    write_to_all_targets "\$UPDATE_COMMAND_NAME" "\$tmp_upd" "helper" || true
  fi
  rm -f "\$tmp_upd"
}

# ---------- Step: bulk catalog materialization ----------
# Same algorithm as before the overhaul, but writes each skill to ALL
# universal target paths instead of one. We never overwrite the helper
# command names.
do_install_bulk() {
  [ "\$DO_BULK" -eq 1 ] || return 0
  [ "\$NO_BULK" -eq 1 ] && return 0

  local catalog_tmp; catalog_tmp="\$(mktemp -t caipe-catalog-XXXXXX)"
  trap 'rm -f "\$catalog_tmp"' RETURN
  local status
  status="\$(curl -sS -o "\$catalog_tmp" -w '%{http_code}' \\
    -H "X-Caipe-Catalog-Key: \$API_KEY" \\
    -H 'Accept: application/json' \\
    "\$BULK_CATALOG_URL")" || {
      echo "warn: failed to reach catalog at \$BASE_URL — skipping bulk install" >&2
      return 0
    }
  if [ "\$status" != "200" ]; then
    echo "warn: catalog returned HTTP \$status — skipping bulk install" >&2
    return 0
  fi

  # The python helper does the heavy lifting: parses the catalog, filters
  # flagged skills, and writes each skill's SKILL.md (+ any ancillary
  # files) to every target root.
  #
  # IMPORTANT: bash heredoc + pipe-to-stdin do NOT compose. The
  # heredoc redirects Python's stdin to the script source, so any
  # data we tried to pipe in (via printf | python3) would be
  # silently discarded. We pass the resolved skill-root directories
  # as trailing positional arguments instead.
  python3 - "\$catalog_tmp" "\$MANIFEST_PATH" "\$AGENT_ID" "\$SCOPE" "\$FORCE" "\$UPGRADE" "\$COMMAND_NAME" "\$UPDATE_COMMAND_NAME" "\${RESOLVED_SKILL_ROOTS[@]}" <<'PY'
import base64, datetime, json, os, re, sys, tempfile

src, manifest_path, agent, scope, force_s, upgrade_s, command_name, update_command_name, *roots = sys.argv[1:]
force = force_s == "1"; upgrade = upgrade_s == "1"
NAME_RE = re.compile(r"[^A-Za-z0-9._-]")
PART_RE = re.compile(r"[^A-Za-z0-9._-]")
RESERVED = {command_name, update_command_name, "skills", "update-skills"}

def is_flagged(skill):
    """Mirror of the runtime scan_gate: a skill the security
    scanner has marked unsafe MUST NOT be materialized to disk, since
    the agent's native discovery would pick it up regardless of UI
    state."""
    return (
        skill.get("scan_status") == "flagged"
        or skill.get("runnable") is False
        or skill.get("blocked_reason") == "scan_flagged"
    )

# Load existing manifest for ownership checks. Handle both new (paths[])
# and legacy (path) shapes transparently.
owned = set()
if os.path.isfile(manifest_path):
    try:
        m = json.load(open(manifest_path))
        for e in (m or {}).get("installed", []) or []:
            paths = e.get("paths")
            if isinstance(paths, list):
                for p in paths:
                    if isinstance(p, str): owned.add(p)
            elif isinstance(e.get("path"), str):
                owned.add(e["path"])
    except Exception:
        pass

def safe_path(rel):
    rel = rel.replace("\\\\", "/").lstrip("/")
    parts = []
    for p in rel.split("/"):
        if not p or p == "." or p == "..":
            return None
        parts.append(PART_RE.sub("_", p))
    return "/".join(parts) if parts else None

def may_write(path):
    if not os.path.exists(path):
        return True
    if force:
        return True
    if upgrade and path in owned:
        return True
    return False

data = json.load(open(src))
skills = data.get("skills", []) or []
new_entries = []  # one entry per (skill name) — paths is multi-target
seen_names = set()  # Only the first eligible entry may claim an install path.
# Counters for the trailing summary line. "skipped" is the legacy name
# used by the summary print and the test fixtures; it counts file
# targets that already exist and were refused by may_write (no
# --upgrade / --force). "skills_installed" / "skills_up_to_date" track
# skill-granularity outcomes for the per-skill log lines we now emit.
wrote = 0; skipped = 0; reserved = 0; total = 0; flagged_count = 0
skills_installed = 0; skills_up_to_date = 0
now = datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds")

for s in skills:
    name = (s.get("name") or "").strip()
    if not name:
        continue
    total += 1
    if is_flagged(s):
        # Existing per-skill print kept verbatim — log scrapers already
        # rely on the "(flagged by security scanner)" suffix.
        print(f"==> skipped {name} (flagged by security scanner)")
        flagged_count += 1
        continue
    if name in RESERVED:
        # Reserved names collide with the catalog helper commands
        # commands the helper installs; we never overwrite those.
        print(f"==> skipped {name} (reserved name)")
        reserved += 1
        continue
    safe_name = NAME_RE.sub("_", name)
    if safe_name in seen_names:
        print(f"==> skipped {name} (duplicate install name)")
        continue
    seen_names.add(safe_name)
    body = s.get("content") or ""

    # Build the per-root file map. SKILL.md goes at root/<name>/SKILL.md;
    # ancillary files preserve their relative paths under root/<name>/.
    # We also track per-skill targets/skips so we can print one line
    # per skill at the end of its loop ("installed N files" vs
    # "up-to-date" vs "would overwrite — pass --upgrade or --force").
    written_paths_for_skill = []
    targets_for_skill = 0
    skipped_existing_for_skill = 0
    for root in roots:
        # SKILL.md
        targets = [(os.path.join(root, safe_name, "SKILL.md"), body)]
        anc = s.get("ancillary_files") or {}
        if isinstance(anc, dict):
            for rel, content in anc.items():
                if not isinstance(rel, str) or not isinstance(content, str):
                    continue
                sp = safe_path(rel)
                if not sp or sp == "SKILL.md":
                    continue
                targets.append((os.path.join(root, safe_name, sp), content))
        for path, content in targets:
            targets_for_skill += 1
            if not may_write(path):
                skipped += 1
                skipped_existing_for_skill += 1
                continue
            os.makedirs(os.path.dirname(path), exist_ok=True)
            fd, tmp = tempfile.mkstemp(prefix=".caipe-install-", dir=os.path.dirname(path))
            with os.fdopen(fd, "w", encoding="utf-8") as f:
                f.write(content)
            os.replace(tmp, path)
            os.chmod(path, 0o644)
            written_paths_for_skill.append(path)
            wrote += 1
    # Per-skill outcome line. Three cases:
    #   * Wrote >=1 file        → "installed" (counts all written files
    #                              across configured roots, which is what
    #                              the user cares about: "did this skill
    #                              land?").
    #   * Wrote 0, refused some → "up-to-date (pass --upgrade or
    #                              --force to overwrite)" so the user
    #                              knows why nothing changed.
    #   * Wrote 0, no targets   → "no files" (degenerate; should be
    #                              vanishingly rare since SKILL.md is
    #                              always emitted).
    n_written = len(written_paths_for_skill)
    if n_written:
        print(f"==> installed {name} ({n_written} file{'s' if n_written != 1 else ''})")
        skills_installed += 1
    elif skipped_existing_for_skill:
        print(
            f"==> up-to-date {name} "
            f"({skipped_existing_for_skill} existing file{'s' if skipped_existing_for_skill != 1 else ''}; "
            f"pass --upgrade or --force to overwrite)"
        )
        skills_up_to_date += 1
    else:
        print(f"==> {name} produced no files")
    if written_paths_for_skill:
        new_entries.append({
            "agent": agent, "scope": scope, "name": name,
            "kind": "skill", "paths": written_paths_for_skill,
            "installed_at": now,
        })

# Atomic manifest update with the new entries appended (replacing any
# entry for the same (agent, scope, name, kind)).
if new_entries:
    cfg_dir = os.path.dirname(manifest_path) or "."
    os.makedirs(cfg_dir, exist_ok=True)
    existing = {"version": 2, "installed": []}
    if os.path.isfile(manifest_path):
        try:
            existing = json.load(open(manifest_path))
            if not isinstance(existing, dict):
                existing = {"version": 2, "installed": []}
            existing.setdefault("version", 2)
            existing.setdefault("installed", [])
        except Exception:
            existing = {"version": 2, "installed": []}
    new_keys = {(e["agent"], e["scope"], (e.get("name") or "").lower(), e.get("kind") or "skill") for e in new_entries}
    def key_of(e):
        return (
            e.get("agent"), e.get("scope"),
            (e.get("name") or "").lower(),
            e.get("kind") or "skill",
        )
    existing["installed"] = [
        e for e in existing["installed"] if key_of(e) not in new_keys
    ] + new_entries
    fd, tmp = tempfile.mkstemp(prefix=".caipe-manifest-", dir=cfg_dir)
    with os.fdopen(fd, "w") as f:
        json.dump(existing, f, indent=2)
        f.write("\\n")
    os.replace(tmp, manifest_path)
    os.chmod(manifest_path, 0o600)

eligible = total - reserved - flagged_count
# Summary line — kept compatible with the legacy format that operators
# (and any log scrapers) already grep for, but extended with the
# per-skill counts we now also print one-per-line above.
#   wrote / skipped         → file-granularity (existing semantics)
#   installed / up-to-date  → skill-granularity (new, derived from
#                              the per-skill prints above)
print(
    f"==> bulk: wrote {wrote} files for {eligible}/{total} skills "
    f"(installed {skills_installed}, up-to-date {skills_up_to_date}, "
    f"skipped {skipped}, reserved {reserved}, flagged {flagged_count})"
)
PY
}

# ---------- Step: install Claude SessionStart hook ----------
# We REGISTER the hook entry but no longer touch permissions.allow —
# the helpers' SKILL.md frontmatter (allowed-tools: ...) handles the
# pre-approval natively, so the legacy allowlist patch is gone.
do_install_hook() {
  [ "\$DO_HOOK" -eq 1 ] || return 0
  [ "\$NO_HOOK" -eq 1 ] && return 0
  [ "\$IS_CLAUDE" = "1" ] || return 0

  if may_write "\$CLAUDE_HOOK_FILE"; then
    if fetch_to "\$HOOK_SH_URL" "\$CLAUDE_HOOK_FILE"; then
      chmod 0755 "\$CLAUDE_HOOK_FILE"
      manifest_register_paths "caipe-catalog-hook" "hook" "\$CLAUDE_HOOK_FILE"
      echo "==> installed \$CLAUDE_HOOK_FILE"
    else
      echo "warn: failed to install \$CLAUDE_HOOK_FILE — skipping settings.json patch" >&2
      return 0
    fi
  else
    echo "skip: \$CLAUDE_HOOK_FILE exists (re-run with --upgrade or --force to replace)" >&2
  fi

  python3 - "\$CLAUDE_SETTINGS_FILE" "\$CLAUDE_HOOK_FILE" <<'PY'
import datetime, json, os, shutil, sys, tempfile

settings_path, hook_path = sys.argv[1:]
parent = os.path.dirname(settings_path) or "."
os.makedirs(parent, exist_ok=True)

def canonical_hook_path(value):
    if not isinstance(value, str):
        return None
    expanded = os.path.expanduser(os.path.expandvars(value))
    return os.path.normcase(os.path.abspath(os.path.normpath(expanded)))

target_hook = canonical_hook_path(hook_path)

data = {}
if os.path.isfile(settings_path):
    try:
        data = json.load(open(settings_path))
        if not isinstance(data, dict):
            data = {}
    except Exception:
        sys.stderr.write(f"warn: {settings_path} is not valid JSON; skipping hook registration\\n")
        sys.stderr.write("      (your existing settings file is untouched)\\n")
        sys.exit(0)

# --- Register SessionStart hook (idempotent) ---
hooks = data.setdefault("hooks", {})
if not isinstance(hooks, dict):
    hooks = {}
    data["hooks"] = hooks

session_start = hooks.setdefault("SessionStart", [])
if not isinstance(session_start, list):
    session_start = []
    hooks["SessionStart"] = session_start

already_registered = False
for entry in session_start:
    if not isinstance(entry, dict): continue
    inner = entry.get("hooks") or []
    if not isinstance(inner, list): continue
    for h in inner:
        if isinstance(h, dict) and canonical_hook_path(h.get("command")) == target_hook:
            already_registered = True
            break
    if already_registered: break

if not already_registered:
    session_start.append({
        "hooks": [{"type": "command", "command": hook_path, "timeout": 5}]
    })
    print(f"==> registered SessionStart hook in {settings_path}")
else:
    print(f"==> SessionStart hook already registered in {settings_path}")

if os.path.isfile(settings_path):
    ts = datetime.datetime.now(datetime.timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    backup_path = f"{settings_path}.caipe-backup-{ts}"
    counter = 1
    while os.path.exists(backup_path):
        backup_path = f"{settings_path}.caipe-backup-{ts}-{counter}"
        counter += 1
    shutil.copy2(settings_path, backup_path)
    os.chmod(backup_path, 0o600)
    print(f"==> backed up existing Claude settings to {backup_path}")

fd, tmp = tempfile.mkstemp(prefix=".caipe-settings-", dir=parent, suffix=".json")
with os.fdopen(fd, "w") as f:
    json.dump(data, f, indent=2)
    f.write("\\n")
os.replace(tmp, settings_path)
os.chmod(settings_path, 0o600)
PY
  manifest_register_paths "claude-settings" "config" "\$CLAUDE_SETTINGS_FILE"
}

# ---------- Step: live-only single skill ----------
do_install_live_only() {
  [ "\$DO_LIVE_ONLY" -eq 1 ] || return 0

  local tmp; tmp="\$(mktemp -t caipe-live-XXXXXX)"
  if fetch_template_to "\$SINGLE_SKILL_URL" "\$tmp"; then
    write_to_all_targets "\$COMMAND_NAME" "\$tmp" "skill" || true
  fi
  rm -f "\$tmp"
}

# ---------- Run the steps in order ----------
do_legacy_cleanup
do_seed_config
do_install_helper_py
do_install_helpers
do_install_bulk
do_install_live_only
do_install_hook

# ---------- Success card ----------
echo
echo "================================================================"
echo "  CAIPE skills installed (\$SCOPE scope)"
echo "================================================================"
echo
echo "  installed to:"
for p in "\${RESOLVED_SKILL_PATHS[@]}"; do
  echo "    \${p%/\\{name\\}/SKILL.md}/<name>/SKILL.md"
done
echo
echo "  Works in: Claude Code, Cursor, Codex CLI, Gemini CLI, opencode"
if [ "\$IS_CLAUDE" = "1" ]; then
  echo "  (Claude skills are written to ~/.claude/skills for /skills discovery,"
  echo "  with a shared copy under ~/.agents/skills; ~/.claude/hooks is only"
  echo "  used for the optional live catalog SessionStart hook)"
else
  echo "  (skills are written to the shared ~/.agents/skills tree)"
fi
echo
if [ "\$DO_HELPERS" -eq 1 ] && [ "\$NO_HELPERS" -eq 0 ]; then
  echo "  next steps:"
  echo "    1. launch any of the agents listed above"
  echo "    2. type /\$COMMAND_NAME <query>          live-fetch a skill from the catalog"
  echo "    3. type /\$UPDATE_COMMAND_NAME           refresh local copies from the catalog"
elif [ "\$DO_LIVE_ONLY" -eq 1 ]; then
  echo "  next steps:"
  echo "    1. launch any of the agents listed above"
  echo "    2. type /\$COMMAND_NAME"
fi
echo
if [ "\$IS_CLAUDE" = "1" ] && [ "\$DO_HOOK" -eq 1 ] && [ "\$NO_HOOK" -eq 0 ]; then
  echo "  Claude SessionStart hook installed — your next Claude Code session"
  echo "  will see the live catalog index in additionalContext."
fi
echo
if [ "\$SCOPE" = "project" ]; then
  echo "  project scope: add this to your .gitignore so manifests, helpers,"
  echo "  and the agent dotfiles don't end up in version control:"
  echo
  echo "    .caipe/"
  echo "    .claude/"
  echo "    .agents/"
  echo
fi
echo "  manifest: \$MANIFEST_PATH"
echo "  config  : \$CAIPE_CONFIG_FILE"
echo "================================================================"
`;
}

/* ===========================================================================
 *
 * UNINSTALL SCRIPT
 *
 * Manifest-driven, never heuristic. Walks ONE manifest (when scope= is
 * explicit) or BOTH manifests in deterministic order user→project (when
 * scope= is omitted). Each manifest gets its own independent y/N/a/q
 * prompt loop — an "all" answer in the first loop does NOT carry across
 * to the next.
 *
 * Manifest entry shape (read):
 *   New: { name, kind, paths: [<list>], ... }
 *   Legacy: { name?, kind, path: <string>, ... }
 *
 * Settings reversal (Claude only):
 *   When a `hook` entry is removed, the matching SessionStart entry is
 *   surgically removed from ~/.claude/settings.json. The two legacy
 *   `Bash(...caipe-skills.py*)` allowlist entries are also stripped if
 *   they are present (older installs added them; new installs do not).
 *
 * ========================================================================= */

function buildUninstallScript(inputs: ScriptInputs): string {
  const { agent, walkBothManifests } = inputs;
  const claudeSettingsPath = `\${HOME:-.}/.claude/settings.json`;
  const allowlistRules = [
    "Bash(uv run ~/.config/caipe/caipe-skills.py*)",
    "Bash(python3 ~/.config/caipe/caipe-skills.py*)",
  ];

  const agentLabel = agent.label;
  const agentId = agent.id;

  // The list of manifests this script will walk, in order. Each entry
  // is the bash expansion of the manifest path. When walkBothManifests
  // is false we honor the requested scope; otherwise we visit user
  // first, then project.
  //
  // CRITICAL: these paths contain ``${HOME:-.}`` which MUST be
  // double-quoted in the rendered script so bash actually expands
  // it. We previously single-quoted via shq(), which made the
  // expansion literal and silently broke uninstall for user-scope
  // (every run printed "==> nothing to do: no manifest at
  // ${HOME:-.}/..." because [ -r '${HOME:-.}/...' ] tested a path
  // that doesn't exist on any filesystem). These values are
  // server-chosen literals — no user input flows in — so dropping
  // shq() here costs no safety; both contain only path characters
  // that are safe inside double quotes.
  const manifestExpansions = walkBothManifests
    ? [
        `\${HOME:-.}/.config/caipe/installed.json`,
        `./.caipe/installed.json`,
      ]
    : inputs.scope === "project"
      ? [`./.caipe/installed.json`]
      : [`\${HOME:-.}/.config/caipe/installed.json`];

  // Double-quoted, intentionally — see comment above.
  const manifestArrayLines = manifestExpansions
    .map((p) => `  "${p}"`)
    .join("\n");

  return `#!/usr/bin/env bash
#
# install-skills.sh --uninstall — CAIPE uninstaller for ${agentLabel}.
#
# Reverses a previous install by walking the sidecar manifest(s).
# Manifest-driven: only files tracked in a manifest are touched.
# Per-item confirmation prompts protect against accidental data loss.
#
# Generated by /api/skills/install.sh?mode=uninstall&agent=${agentId}${walkBothManifests ? "" : `&scope=${inputs.scope}`}.
#
set -euo pipefail

AGENT="${agentId}"
CAIPE_CONFIG_DIR="\${HOME:-.}/.config/caipe"
CAIPE_CONFIG_FILE="\$CAIPE_CONFIG_DIR/config.json"
CLAUDE_SETTINGS_FILE="${claudeSettingsPath}"

# Manifests to walk. Each is processed in order with its OWN independent
# y/N/a/q prompt loop -- an "a" (apply-to-all) answer in the first
# manifest's loop does NOT carry across to the next.
MANIFESTS=(
${manifestArrayLines}
)
# CAIPE_INSTALL_MANIFEST overrides the FIRST manifest only (kept for
# backward compatibility with single-scope invocations).
if [ -n "\${CAIPE_INSTALL_MANIFEST:-}" ]; then
  MANIFESTS=("\$CAIPE_INSTALL_MANIFEST")
fi

DRY_RUN=0
ALL_GLOBAL=0    # --all on the command line forces ALL=1 in every manifest's loop
PURGE=0

usage() {
  cat <<USAGE
Usage:
  $0 [--dry-run] [--all] [--purge]

Removes CAIPE-installed files by walking the sidecar manifest(s).
By default each manifest entry is prompted for individually.

Options:
  --dry-run   Show what would be removed without deleting anything.
              Implies --all (no prompts) for clean output.
  --all       Skip the per-item prompt and remove every manifest entry.
              Equivalent to answering 'a' (yes-to-all) in every loop.
  --purge     Also remove ~/.config/caipe/config.json (gateway base_url
              + api_key). Without --purge the config file is preserved
              so a re-install does not require re-entering credentials.
  -h, --help  Show this help.

Manifests walked (in order):
${manifestExpansions.map((p) => `  ${p}`).join("\n")}
USAGE
}

while [ \$# -gt 0 ]; do
  case "\$1" in
    --dry-run)  DRY_RUN=1 ; ALL_GLOBAL=1 ;;
    --all)      ALL_GLOBAL=1 ;;
    --purge)    PURGE=1 ;;
    -h|--help)  usage ; exit 0 ;;
    *)          echo "error: unknown flag: \$1" >&2 ; usage >&2 ; exit 64 ;;
  esac
  shift
done

if ! command -v python3 >/dev/null 2>&1; then
  echo "error: python3 is required to read the manifest" >&2
  exit 69
fi

# Track total removed/skipped across all manifests for the final card.
TOTAL_REMOVED=0
TOTAL_SKIPPED=0

# Walk each manifest with its own independent prompt loop.
for MANIFEST_PATH in "\${MANIFESTS[@]}"; do
  if [ ! -r "\$MANIFEST_PATH" ]; then
    echo "==> nothing to do: no manifest at \$MANIFEST_PATH"
    continue
  fi

  # ---------- Read & validate this manifest ----------
  # Emit one TSV record per file: <kind>\\t<name>\\t<path>
  # A single manifest entry with N paths produces N rows so the prompt
  # loop can ask per-file (not per-skill).
  ENTRIES_TSV="\$(python3 - "\$MANIFEST_PATH" <<'PY'
import json, sys
KIND_ORDER = {"skill": 0, "catalog": 1, "helper": 2, "helper-py": 2, "hook": 3, "config": 4}
try:
    data = json.load(open(sys.argv[1]))
except Exception as e:
    sys.stderr.write(f"error: manifest is not valid JSON: {e}\\n")
    sys.exit(70)
if not isinstance(data, dict):
    sys.stderr.write("error: manifest root is not an object\\n")
    sys.exit(70)
entries = data.get("installed") or []
if not isinstance(entries, list):
    sys.stderr.write("error: manifest.installed is not an array\\n")
    sys.exit(70)
rows = []
for e in entries:
    if not isinstance(e, dict): continue
    name = (e.get("name") or "").strip()
    k = (e.get("kind") or "skill").strip().lower()
    paths = e.get("paths")
    if isinstance(paths, list):
        path_list = [p for p in paths if isinstance(p, str) and p]
    elif isinstance(e.get("path"), str) and e["path"]:
        path_list = [e["path"]]
    else:
        path_list = []
    for p in path_list:
        if "\\t" in p or "\\n" in p:
            sys.stderr.write(f"warn: skipping manifest entry with bad path: {p!r}\\n")
            continue
        rows.append((KIND_ORDER.get(k, 99), k, name, p))
rows.sort()
for _, k, n, p in rows:
    sys.stdout.write(f"{k}\\t{n}\\t{p}\\n")
PY
)"

  if [ -z "\$ENTRIES_TSV" ]; then
    echo "==> manifest \$MANIFEST_PATH lists no installed files"
    continue
  fi

  TOTAL="\$(printf '%s\\n' "\$ENTRIES_TSV" | wc -l | tr -d ' ')"
  echo "================================================================"
  echo "  CAIPE uninstall: \$MANIFEST_PATH"
  echo "  \$TOTAL file(s) tracked"
  if [ \$DRY_RUN -eq 1 ]; then
    echo "  mode: DRY RUN (no files will be deleted)"
  elif [ \$ALL_GLOBAL -eq 1 ]; then
    echo "  mode: --all (no prompts; every entry will be removed)"
  else
    echo "  mode: interactive (one prompt per file; a=yes-to-all-IN-THIS-MANIFEST, q=quit-this-manifest)"
  fi
  echo "================================================================"

  # If stdin is not a tty AND --all wasn't passed, refuse rather than
  # silently remove everything (CI hostility guard).
  if [ \$ALL_GLOBAL -eq 0 ] && [ ! -r /dev/tty ]; then
    echo "error: stdin is not a tty and --all was not passed" >&2
    echo "       refusing to remove files non-interactively without --all" >&2
    exit 65
  fi

  # Per-manifest "all" state. An 'a' answer toggles this for THIS
  # manifest only -- the next manifest in the loop starts fresh.
  ALL_LOCAL=\$ALL_GLOBAL
  removed_count=0
  skipped_count=0
  hook_paths_to_unregister=()
  removed_paths=()
  parent_dirs_to_check=()

  while IFS=\$'\\t' read -r kind name path; do
    [ -n "\$path" ] || continue

    if [ ! -e "\$path" ]; then
      echo "  · already gone: \$path (\$kind)"
      skipped_count=\$((skipped_count + 1))
      removed_paths+=("\$path")  # still drop from manifest
      continue
    fi

    if [ -d "\$path" ]; then
      echo "  ! refusing to remove directory: \$path (\$kind)"
      skipped_count=\$((skipped_count + 1))
      continue
    fi

    case "\$path" in
      */.claude/settings.json|.claude/settings.json)
        echo "  · keep Claude settings file: \$path (\$kind)"
        skipped_count=\$((skipped_count + 1))
        removed_paths+=("\$path")  # drop CAIPE ownership from manifest only
        continue
        ;;
    esac

    if [ "\$kind" = "config" ] && [ \$PURGE -eq 0 ]; then
      echo "  · keep (no --purge): \$path (\$kind)"
      skipped_count=\$((skipped_count + 1))
      continue
    fi

    if [ \$ALL_LOCAL -eq 1 ]; then
      answer=y
    else
      printf "  ? remove %s [%s/%s]? [y/N/a/q] " "\$path" "\$kind" "\$name" > /dev/tty
      IFS= read -r answer < /dev/tty || answer=n
      answer="\$(printf '%s' "\$answer" | tr '[:upper:]' '[:lower:]')"
      case "\$answer" in
        a|all)
          ALL_LOCAL=1
          answer=y
          echo "    (remaining entries in THIS manifest will be removed without prompting)"
          ;;
        q|quit)
          echo "    aborted by user; \$removed_count file(s) removed so far in this manifest"
          break
          ;;
      esac
    fi

    if [ "\$answer" != "y" ] && [ "\$answer" != "yes" ]; then
      echo "    skip: \$path"
      skipped_count=\$((skipped_count + 1))
      continue
    fi

    if [ \$DRY_RUN -eq 1 ]; then
      echo "    [dry-run] would remove \$path"
    else
      rm -f "\$path" && echo "    removed \$path"
      # Track the parent directory so we can rmdir it if empty (the
      # universal-paths layout creates per-skill folders we should
      # clean up: <root>/<name>/SKILL.md → rmdir <root>/<name>).
      parent_dirs_to_check+=("\$(dirname "\$path")")
    fi
    removed_count=\$((removed_count + 1))
    removed_paths+=("\$path")

    if [ "\$kind" = "hook" ]; then
      hook_paths_to_unregister+=("\$path")
    fi
  done <<EOF
\$ENTRIES_TSV
EOF

  # ---------- rmdir empty per-skill parent directories ----------
  if [ \$DRY_RUN -eq 0 ] && [ \${#parent_dirs_to_check[@]} -gt 0 ]; then
    # Dedupe; rmdir each (errors are silently ignored — non-empty dirs stay).
    while IFS= read -r d; do
      [ -d "\$d" ] && rmdir "\$d" 2>/dev/null || true
    done < <(printf '%s\\n' "\${parent_dirs_to_check[@]}" | sort -u)
  fi

  # ---------- Reverse ~/.claude/settings.json patch ----------
  # Surgical: remove ONLY SessionStart entries pointing at our hook
  # paths, and the two legacy allowlist rules (if present from older
  # installs). Everything else in the user's settings file is preserved.
  if [ \${#hook_paths_to_unregister[@]} -gt 0 ] && [ -f "\$CLAUDE_SETTINGS_FILE" ]; then
    if [ \$DRY_RUN -eq 1 ]; then
      echo "  [dry-run] would prune \${#hook_paths_to_unregister[@]} hook entry/entries from \$CLAUDE_SETTINGS_FILE"
    else
      HOOK_PATHS_JOINED="\$(printf '%s\\n' "\${hook_paths_to_unregister[@]}")"
      HOOK_PATHS_JOINED="\$HOOK_PATHS_JOINED" ALLOWLIST_RULES=${JSON.stringify(JSON.stringify(allowlistRules))} python3 - "\$CLAUDE_SETTINGS_FILE" <<'PY'
import datetime, json, os, shutil, sys, tempfile
settings_path = sys.argv[1]
hook_paths = set(filter(None, os.environ.get("HOOK_PATHS_JOINED", "").splitlines()))
try:
    allowlist_rules = set(json.loads(os.environ.get("ALLOWLIST_RULES", "[]")))
except Exception:
    allowlist_rules = set()
if not hook_paths: sys.exit(0)
try:
    data = json.load(open(settings_path))
except Exception:
    sys.exit(0)
if not isinstance(data, dict): sys.exit(0)
mutated = False
hooks = data.get("hooks")
if isinstance(hooks, dict):
    session_start = hooks.get("SessionStart")
    if isinstance(session_start, list):
        kept = []
        for entry in session_start:
            if not isinstance(entry, dict):
                kept.append(entry); continue
            inner = entry.get("hooks")
            if not isinstance(inner, list):
                kept.append(entry); continue
            inner_kept = [h for h in inner if not (isinstance(h, dict) and h.get("command") in hook_paths)]
            if not inner_kept:
                mutated = True; continue
            if len(inner_kept) != len(inner):
                entry = dict(entry); entry["hooks"] = inner_kept; mutated = True
            kept.append(entry)
        if len(kept) != len(session_start): mutated = True
        if kept: hooks["SessionStart"] = kept
        else:
            hooks.pop("SessionStart", None); mutated = True
        if not hooks:
            data.pop("hooks", None); mutated = True
permissions = data.get("permissions")
if isinstance(permissions, dict):
    allow = permissions.get("allow")
    if isinstance(allow, list) and allowlist_rules:
        kept_rules = [r for r in allow if r not in allowlist_rules]
        if len(kept_rules) != len(allow):
            mutated = True
            if kept_rules: permissions["allow"] = kept_rules
            else: permissions.pop("allow", None)
        if not permissions:
            data.pop("permissions", None); mutated = True
if not mutated:
    print(f"==> no matching hooks/allowlist entries in {settings_path}"); sys.exit(0)
parent = os.path.dirname(settings_path) or "."
ts = datetime.datetime.now(datetime.timezone.utc).strftime("%Y%m%dT%H%M%SZ")
backup_path = f"{settings_path}.caipe-backup-{ts}"
counter = 1
while os.path.exists(backup_path):
    backup_path = f"{settings_path}.caipe-backup-{ts}-{counter}"
    counter += 1
shutil.copy2(settings_path, backup_path)
os.chmod(backup_path, 0o600)
fd, tmp = tempfile.mkstemp(prefix=".caipe-settings-", dir=parent, suffix=".json")
try:
    with os.fdopen(fd, "w") as f:
        json.dump(data, f, indent=2)
        f.write("\\n")
    os.replace(tmp, settings_path)
    os.chmod(settings_path, 0o600)
    print(f"==> pruned CAIPE entries from {settings_path}")
except Exception as e:
    try: os.unlink(tmp)
    except OSError: pass
    sys.stderr.write(f"warn: could not update {settings_path}: {e}\\n")
PY
    fi
  fi

  # ---------- Manifest finalization ----------
  # Drop any entry whose paths no longer exist on disk. If the resulting
  # manifest has zero entries, delete the file. Always re-emit in the
  # new (paths[]) shape so legacy entries are migrated.
  if [ \$DRY_RUN -eq 0 ]; then
    REMOVED_PATHS_JOINED="\$(printf '%s\\n' "\${removed_paths[@]}")"
    REMOVED_PATHS_JOINED="\$REMOVED_PATHS_JOINED" python3 - "\$MANIFEST_PATH" <<'PY'
import json, os, sys, tempfile
mp = sys.argv[1]
removed_paths = set(filter(None, os.environ.get("REMOVED_PATHS_JOINED", "").splitlines()))
try: data = json.load(open(mp))
except Exception: sys.exit(0)
if not isinstance(data, dict): sys.exit(0)
entries = data.get("installed") or []
if not isinstance(entries, list): sys.exit(0)
remaining = []
for e in entries:
    if not isinstance(e, dict): continue
    paths = e.get("paths")
    if not isinstance(paths, list):
        if isinstance(e.get("path"), str): paths = [e["path"]]
        else: continue
    surviving = [
        p for p in paths
        if isinstance(p, str) and p not in removed_paths and os.path.exists(p)
    ]
    if not surviving: continue
    new_e = dict(e); new_e["paths"] = surviving; new_e.pop("path", None)
    remaining.append(new_e)
if not remaining:
    try:
        os.unlink(mp)
        print(f"==> removed empty manifest {mp}")
    except FileNotFoundError: pass
    sys.exit(0)
data["installed"] = remaining
data["version"] = 2
parent = os.path.dirname(mp) or "."
fd, tmp = tempfile.mkstemp(prefix=".caipe-manifest-", dir=parent)
try:
    with os.fdopen(fd, "w") as f:
        json.dump(data, f, indent=2)
        f.write("\\n")
    os.replace(tmp, mp)
    os.chmod(mp, 0o600)
    print(f"==> kept {len(remaining)} entry/entries in {mp} (still on disk)")
except Exception:
    try: os.unlink(tmp)
    except OSError: pass
PY
  fi

  TOTAL_REMOVED=\$((TOTAL_REMOVED + removed_count))
  TOTAL_SKIPPED=\$((TOTAL_SKIPPED + skipped_count))
done

# ---------- --purge: remove ~/.config/caipe/config.json + parent if empty ----------
if [ \$PURGE -eq 1 ] && [ \$DRY_RUN -eq 0 ]; then
  if [ -f "\$CAIPE_CONFIG_FILE" ]; then
    rm -f "\$CAIPE_CONFIG_FILE" && echo "==> removed \$CAIPE_CONFIG_FILE"
  fi
  if [ -d "\$CAIPE_CONFIG_DIR" ] && [ -z "\$(ls -A "\$CAIPE_CONFIG_DIR" 2>/dev/null)" ]; then
    rmdir "\$CAIPE_CONFIG_DIR" && echo "==> removed empty \$CAIPE_CONFIG_DIR"
  fi
fi

# ---------- Final summary ----------
echo "================================================================"
if [ \$DRY_RUN -eq 1 ]; then
  echo "  dry-run complete: \$TOTAL_REMOVED file(s) would be removed,"
  echo "  \$TOTAL_SKIPPED skipped"
else
  echo "  uninstall complete: \$TOTAL_REMOVED file(s) removed,"
  echo "  \$TOTAL_SKIPPED skipped"
fi
if [ \$PURGE -eq 0 ] && [ -f "\$CAIPE_CONFIG_FILE" ]; then
  echo
  echo "  preserved: \$CAIPE_CONFIG_FILE"
  echo "    (re-run with --purge to remove the gateway URL + api_key)"
fi
echo "================================================================"
`;
}

/* ---------- handler ---------- */

export async function GET(request: Request) {
  const url = new URL(request.url);
  const modeRaw = (url.searchParams.get("mode") ?? "").trim().toLowerCase();
  const isUninstall = modeRaw === "uninstall";

  // Agent: optional in every mode. Defaults to Claude because Claude
  // needs its native `.claude/skills` discovery target in addition to
  // the shared `.agents/skills` copy. An explicit ?agent= still works
  // for back-compat.
  const agentIdRaw = (url.searchParams.get("agent") ?? "").trim().toLowerCase();
  const agentId = agentIdRaw || DEFAULT_AGENT_ID;
  const agent = AGENTS[agentId];
  if (!agent) {
    return plainTextError(`unknown agent: ${agentId}`, 400);
  }

  // Scope: required for non-uninstall modes; optional for uninstall
  // (omitting it walks BOTH manifests).
  const scopeRaw = (url.searchParams.get("scope") ?? "").trim().toLowerCase();
  let scope: "user" | "project";
  let walkBothManifests = false;
  if (scopeRaw === "user" || scopeRaw === "project") {
    scope = scopeRaw;
  } else if (isUninstall) {
    // No scope on an uninstall request → walk both manifests.
    scope = "user"; // arbitrary default for the script's CLAUDE_DIR resolution
    walkBothManifests = true;
  } else {
    return plainTextError(
      "missing or invalid ?scope=<user|project> parameter",
      400,
    );
  }

  // Validate that the agent supports the chosen scope (always true today
  // since every agent in the registry has both scopes).
  const supported = scopesAvailableFor(agent);
  if (!supported.includes(scope)) {
    return plainTextError(
      `agent ${agentId} does not support scope=${scope} (supported: ${supported.join(", ") || "none"})`,
      400,
    );
  }

  const commandName = sanitizeCommandName(url.searchParams.get("command_name"));
  const description = sanitizeDescription(url.searchParams.get("description"));
  const baseUrl =
    sanitizeBaseUrl(url.searchParams.get("base_url")) ??
    getRequestOrigin(request);

  // Optional catalog-query bulk mode driven by the Skills Gateway
  // "Pick your skills" Query Builder. When present this wins over the
  // default mode — the user has explicitly composed a query.
  const catalogUrlRaw = url.searchParams.get("catalog_url");
  const catalogUrl = sanitizeCatalogUrl(catalogUrlRaw, new URL(baseUrl).origin);
  if (catalogUrlRaw && !catalogUrl) {
    return plainTextError(
      "invalid ?catalog_url= parameter (must be a same-origin URL pointing at /api/skills)",
      400,
    );
  }

  // Resolve install mode. Precedence:
  //   1. ?mode=uninstall locks us into uninstall mode.
  //   2. ?catalog_url=... + ?mode=bulk-with-helpers → bulk-with-helpers.
  //      The Quick Install UI relies on this so a user-chosen catalog
  //      page can still trigger the branded browse + refresh helper
  //      install. Without this branch the user would have to choose
  //      between "use my catalog URL" and "install helpers"; today
  //      they get neither because catalog_url silently downgraded
  //      mode to catalog-query and dropped the helpers.
  //   3. ?catalog_url=... (no explicit mode) → catalog-query (legacy
  //      bulk-only behaviour kept for any stray copy-paste).
  //   4. ?mode=live-only opts into the legacy single-skill flow.
  //   5. Otherwise default to bulk-with-helpers.
  let mode: InstallMode;
  if (isUninstall) {
    mode = "uninstall";
  } else if (catalogUrl && modeRaw === "bulk-with-helpers") {
    mode = "bulk-with-helpers";
  } else if (catalogUrl) {
    mode = "catalog-query";
  } else if (modeRaw === "live-only") {
    mode = "live-only";
  } else if (
    modeRaw &&
    modeRaw !== "bulk" &&
    modeRaw !== "bulk-with-helpers"
  ) {
    return plainTextError(
      `invalid ?mode= value: ${modeRaw} (allowed: bulk, bulk-with-helpers, live-only, uninstall)`,
      400,
    );
  } else {
    mode = "bulk-with-helpers";
  }

  // `?layout=...` is intentionally accepted and ignored. Kept for
  // backward compatibility with one-liners users have copy-pasted.

  const script = buildScript({
    agent,
    scope,
    walkBothManifests,
    commandName,
    description,
    baseUrl,
    mode,
    catalogUrl,
  });

  const filenameSuffix =
    mode === "catalog-query"
      ? "-bulk"
      : mode === "bulk-with-helpers"
        ? "-bundle"
        : mode === "uninstall"
          ? walkBothManifests
            ? "-uninstall-all"
            : "-uninstall"
          : "";
  return new NextResponse(script, {
    status: 200,
    headers: {
      "Content-Type": "text/x-shellscript; charset=utf-8",
      "Content-Disposition": `attachment; filename="install-skills-${agent.id}-${scope}${filenameSuffix}.sh"`,
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
