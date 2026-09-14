/**
 * Agent registry + per-agent rendering for the live-skills skill.
 *
 * One canonical Markdown template is parsed once, then re-emitted as a
 * single `SKILL.md` per agent — every supported coding agent (Claude Code,
 * Cursor, Codex CLI, Gemini CLI, opencode) consumes the same
 * `agentskills.io` standard format. The agent picker only affects:
 *
 *   - Which `argRef` placeholder is substituted into `{{ARG_REF}}`. Per
 *     the upstream agent docs, ONLY Claude Code does template
 *     substitution in the SKILL.md body (`$ARGUMENTS`, `$N`, `$name`).
 *     Cursor, Codex CLI, Gemini CLI, and opencode all read SKILL.md
 *     verbatim and let the model interpret user input -- no per-agent
 *     argRef token is required for those four. We standardize on
 *     `$ARGUMENTS` for everyone: Claude renders it, the other four
 *     treat it as instructional text the model can reason about.
 *     References:
 *       https://docs.claude.com/en/docs/claude-code/skills (substitution table)
 *       https://cursor.com/docs/skills (frontmatter only; no substitution)
 *       https://developers.openai.com/codex/skills (no substitution mechanism documented)
 *       https://geminicli.com/docs/cli/skills/ (no substitution mechanism documented)
 *       https://opencode.ai/docs/skills/ (only name/description/license/compatibility/metadata recognized)
 *   - Which `launchGuide` text is shown after install.
 *
 * Most agents read the shared agentskills.io location. Claude Code's
 * `/skills` discovery currently reads only `.claude/skills`, so Claude
 * installs write a native Claude copy plus the shared copy:
 *
 *   Claude user scope    → `~/.claude/skills/<name>/SKILL.md`
 *                         + `~/.agents/skills/<name>/SKILL.md`
 *   Claude project scope → `./.claude/skills/<name>/SKILL.md`
 *                         + `./.agents/skills/<name>/SKILL.md`
 *   Other agents         → `~/.agents/skills/<name>/SKILL.md`
 *                         or `./.agents/skills/<name>/SKILL.md`
 *
 * Adding a new agent = one entry in AGENTS.
 *
 * All five target agents consume the agentskills.io `SKILL.md` format. Keep
 * this registry limited to actively tested targets and the shared install
 * paths above.
 */

/**
 * Where on disk the rendered artifact lives.
 *
 * - `user`    — user-global (under `~`), reused across every project
 * - `project` — project-local (under the current repo), version-controllable
 */
export type AgentScope = "user" | "project";

// assisted-by Codex Codex-sonnet-4-6
export const DEFAULT_LIVE_SKILLS_COMMAND = "caipe-skills";
export const DEFAULT_UPDATE_SKILLS_COMMAND = "update-caipe-skills";

export function deriveUpdateCommandName(commandName: string): string {
  if (commandName.startsWith("update-")) return commandName;
  const updateCommandName = `update-${commandName}`;
  return updateCommandName.length <= 64
    ? updateCommandName
    : DEFAULT_UPDATE_SKILLS_COMMAND;
}

/**
 * Shared install paths. `{name}` is replaced with the slash command name. Tilde paths
 * (`~/...`) are expanded at install time by the shell or the generated
 * install.sh. Project paths intentionally use a leading `./` so they're
 * unambiguous in shell snippets.
 *
 * The `~/.agents/skills/` tree is the vendor-neutral discovery path, but
 * Claude Code's native `/skills` command looks in `.claude/skills`.
 *
 * assisted-by Codex Codex-sonnet-4-6
 */
const UNIVERSAL_USER_PATHS: readonly string[] = [
  "~/.agents/skills/{name}/SKILL.md",
];

const UNIVERSAL_PROJECT_PATHS: readonly string[] = [
  "./.agents/skills/{name}/SKILL.md",
];

const CLAUDE_USER_PATHS: readonly string[] = [
  "~/.claude/skills/{name}/SKILL.md",
  ...UNIVERSAL_USER_PATHS,
];

const CLAUDE_PROJECT_PATHS: readonly string[] = [
  "./.claude/skills/{name}/SKILL.md",
  ...UNIVERSAL_PROJECT_PATHS,
];

export interface AgentSpec {
  /** Stable id used in URLs (e.g. `?agent=gemini`). */
  id: string;
  /** Human-readable label for the UI dropdown. */
  label: string;
  /**
   * Install paths per scope. Each scope maps to an array of universal
   * paths. Every entry MUST end in
   * `/{name}/SKILL.md` so callers can derive the parent skill directory
   * by stripping the trailing two segments.
   */
  installPaths: Partial<Record<AgentScope, readonly string[]>>;
  /**
   * Reference syntax for "the user's argument" in the rendered
   * SKILL.md body. Substituted into the template's `{{ARG_REF}}`
   * placeholder.
   *
   * Only Claude Code performs template substitution per its skills
   * docs. Cursor, Codex CLI, Gemini CLI, and opencode read SKILL.md
   * verbatim, so the token surfaces as plain instructional text the
   * model interprets. We standardize on `$ARGUMENTS` (Claude's
   * canonical token) across every agent to keep the rendered file
   * byte-identical in the shared skills tree.
   */
  argRef: "$ARGUMENTS";
  /**
   * Short, copy-pasteable launch + invocation guidance shown in the UI
   * after the install step. Markdown allowed. Use `{name}` for the
   * browse command name and `{updateName}` for its paired refresh command.
   */
  launchGuide: string;
  /** Optional homepage / docs link. */
  docsUrl?: string;
}

export const AGENTS: Record<string, AgentSpec> = {
  claude: {
    id: "claude",
    label: "Claude Code",
    installPaths: {
      user: CLAUDE_USER_PATHS,
      project: CLAUDE_PROJECT_PATHS,
    },
    argRef: "$ARGUMENTS",
    docsUrl: "https://docs.claude.com/en/docs/claude-code/skills",
    // assisted-by Codex Codex-sonnet-4-6
    launchGuide: [
      "Need Claude Code? See the [Claude Code quickstart](https://code.claude.com/docs/en/quickstart).",
      "",
      "**Launch from your repo root**:",
      "```bash",
      "claude",
      "```",
      "",
      "**Use the skill**:",
      "- `/{name}`: browse the catalog",
      "- `/{name} kubernetes`: search",
      "- `/{name} run create-ci-pipeline`: fetch and execute inline",
      "- `/{updateName}`: install or refresh on-disk skill copies",
      "- `/create-ci-pipeline`: run the locally installed skill directly",
      "",
      "Skills are installed under Claude's native `~/.claude/skills/` (user-global) or `./.claude/skills/` (per-repo) tree, with an additional shared copy under `.agents/skills`. The installer also registers a Claude SessionStart hook so Claude can see the live catalog.",
    ].join("\n"),
  },

  cursor: {
    id: "cursor",
    label: "Cursor",
    installPaths: {
      user: UNIVERSAL_USER_PATHS,
      project: UNIVERSAL_PROJECT_PATHS,
    },
    argRef: "$ARGUMENTS",
    docsUrl: "https://cursor.com/docs/skills",
    launchGuide: [
      "Need Cursor? See [Cursor get started](https://cursor.com/get-started).",
      "",
      "**Open the repo in Cursor**, then open the chat (`Cmd/Ctrl + L`).",
      "",
      "**Use the skill** in the chat:",
      "- `/{name}`: browse the catalog",
      "- `/{name} pipeline`: search",
      "- `/{name} run <skill>`: fetch and execute inline",
      "",
      "Skills are installed under `~/.agents/skills/` (user-global) or `./.agents/skills/` (per-repo). Reload the window if a new skill does not appear in the picker.",
    ].join("\n"),
  },

  codex: {
    id: "codex",
    label: "Codex CLI (OpenAI)",
    installPaths: {
      user: UNIVERSAL_USER_PATHS,
      project: UNIVERSAL_PROJECT_PATHS,
    },
    // Codex CLI reads SKILL.md verbatim with no template substitution
    // (per https://developers.openai.com/codex/skills). The token is
    // surfaced as instructional text the model reasons about.
    argRef: "$ARGUMENTS",
    docsUrl: "https://developers.openai.com/codex/skills",
    launchGuide: [
      "**Install Codex CLI**:",
      "```bash",
      "npm install -g @openai/codex",
      "# or: brew install codex",
      "```",
      "",
      "**Launch**:",
      "```bash",
      "codex",
      "```",
      "",
      "**Use the skill** (e.g. `{name}`):",
      "- Just describe what you want; Codex auto-loads matching skills",
      "  from the catalog when the model decides they're relevant.",
      "- Or invoke explicitly: `Use the {name} skill to <task>`",
      "",
      "Codex CLI auto-discovers skills from the vendor-neutral `~/.agents/skills/` directory (user-global) and `./.agents/skills/` (per-repo). Codex picks them up on next launch.",
    ].join("\n"),
  },

  gemini: {
    id: "gemini",
    label: "Gemini CLI",
    installPaths: {
      user: UNIVERSAL_USER_PATHS,
      project: UNIVERSAL_PROJECT_PATHS,
    },
    // Gemini CLI reads SKILL.md verbatim with no template substitution
    // (per https://geminicli.com/docs/cli/skills/). The token is
    // surfaced as instructional text the model reasons about.
    argRef: "$ARGUMENTS",
    docsUrl: "https://geminicli.com/docs/cli/skills/",
    launchGuide: [
      "**Install Gemini CLI**:",
      "```bash",
      "npm install -g @google/gemini-cli",
      "```",
      "",
      "**Launch from your repo root**:",
      "```bash",
      "gemini",
      "```",
      "",
      "**List & use the skill** (e.g. `{name}`):",
      "- `/skills list`: show every skill Gemini has discovered",
      "- Then describe what you want; Gemini picks the right skill",
      "  automatically based on its description (e.g. `Use the {name} skill to <task>`).",
      "",
      "Skills live in `~/.agents/skills/` (user-global) or `./.agents/skills/` (per-repo). Gemini reloads skills on each invocation.",
    ].join("\n"),
  },

  opencode: {
    id: "opencode",
    label: "opencode",
    installPaths: {
      user: UNIVERSAL_USER_PATHS,
      project: UNIVERSAL_PROJECT_PATHS,
    },
    argRef: "$ARGUMENTS",
    docsUrl: "https://opencode.ai/docs/skills/",
    launchGuide: [
      "**Install opencode**:",
      "```bash",
      "curl -fsSL https://opencode.ai/install | bash",
      "# or: npm install -g opencode-ai",
      "```",
      "",
      "**Launch from your repo root**:",
      "```bash",
      "opencode",
      "```",
      "",
      "**Use the skill**:",
      "- `/{name}`: browse the catalog",
      "- `/{name} run <skill>`: fetch and execute inline",
      "",
      "opencode auto-discovers skills from `~/.agents/skills/` (user-global) and `./.agents/skills/` (per-repo).",
    ].join("\n"),
  },
};

export const DEFAULT_AGENT_ID = "claude";

/* ---------- Markdown parsing & rendering helpers ---------- */

interface ParsedTemplate {
  description: string;
  body: string;
  /**
   * Frontmatter lines we want to forward verbatim into the rendered
   * output (e.g. `disable-model-invocation: true`,
   * `allowed-tools: [...]`). Captured separately from `description` so
   * the renderer can place the canonical `name:` and `description:`
   * lines at known positions.
   */
  preservedFrontmatter: string[];
}

/**
 * Strip a leading YAML-ish frontmatter block (`---\n...\n---`) and capture
 * the `description:` field if present, plus any other frontmatter lines
 * we want to forward unchanged into the rendered SKILL.md (specifically
 * `disable-model-invocation` and `allowed-tools`, which the two CAIPE
 * helper templates declare).
 *
 * Intentionally conservative: only single-line `key: value` pairs and
 * single-line array literals (`key: [a, b]`) are recognized; multi-line/
 * folded scalars are left in the body. The two helper templates use only
 * single-line forms so this is sufficient.
 */
export function parseFrontmatter(template: string): ParsedTemplate {
  const match = template.match(/^---\s*\n([\s\S]*?)\n---\s*\n?/);
  if (!match) {
    return { description: "", body: template, preservedFrontmatter: [] };
  }

  const PRESERVED_KEYS = new Set([
    "disable-model-invocation",
    "allowed-tools",
  ]);
  let description = "";
  const preserved: string[] = [];

  for (const line of match[1].split("\n")) {
    const kv = line.match(/^(\w[\w-]*):\s*(.*)$/);
    if (!kv) continue;
    const key = kv[1];
    if (key === "description") {
      description = kv[2].trim();
    } else if (PRESERVED_KEYS.has(key)) {
      preserved.push(line);
    }
    // `name:` is intentionally dropped — the renderer always emits a
    // canonical `name:` line matching the directory name.
  }

  return {
    description,
    body: template.slice(match[0].length),
    preservedFrontmatter: preserved,
  };
}

/** Substitute the canonical template placeholders. */
export function substitutePlaceholders(
  body: string,
  vars: {
    commandName: string;
    updateCommandName: string;
    description: string;
    baseUrl: string;
    argRef: string;
  },
): string {
  return body
    .replace(/\{\{COMMAND_NAME\}\}/g, vars.commandName)
    .replace(/\{\{UPDATE_COMMAND_NAME\}\}/g, vars.updateCommandName)
    .replace(/\{\{DESCRIPTION\}\}/g, vars.description)
    .replace(/\{\{BASE_URL\}\}/g, vars.baseUrl)
    .replace(/\{\{ARG_REF\}\}/g, vars.argRef);
}

/**
 * Quote a string for safe inclusion in single-line YAML `key: value`. Wraps
 * in double quotes and escapes only `"` and `\`.
 */
function quoteYaml(value: string): string {
  // Plain values are fine if they don't contain YAML-significant characters.
  if (!/[:#\n"'\\&*!|>{}[\],%@`]/.test(value)) return value;
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/* ---------- Per-agent rendering ---------- */

export interface RenderResult {
  /** Final SKILL.md contents (canonical agentskills.io format). */
  template: string;
  /**
   * Resolved install path for the requested scope, with `{name}`
   * substituted. This is the FIRST entry in the resolved scope's path
   * array — useful for display ("install path") in the UI. Use
   * `install_paths[scope]` for the full multi-target list. `null` if
   * no scope was requested.
   */
  install_path: string | null;
  /**
   * All install paths the agent supports for the requested command name,
   * keyed by scope. `{name}` is substituted in every entry. Lets the UI
   * render the scope chooser without a second request.
   */
  install_paths: Partial<Record<AgentScope, readonly string[]>>;
  /** Scopes the agent supports (always `["user", "project"]` in the new layout). */
  scopes_available: AgentScope[];
  /** The scope that was actually rendered (may be `null` if none requested). */
  scope: AgentScope | null;
  /** True if the requested scope was unsupported. (Always false in the new layout.) */
  scope_fallback: boolean;
  /** Launch & invocation guidance, with `{name}` and `{updateName}` substituted. */
  launch_guide: string;
  /** Optional docs link for the agent. */
  docs_url?: string;
  /** Human-readable agent label. */
  label: string;
}

export interface RenderInputs {
  canonicalTemplate: string;
  commandName: string;
  description: string;
  baseUrl: string;
  /**
   * Requested install scope. If `null` / undefined, no `install_path` is
   * resolved (the UI is expected to require a scope before showing
   * install commands).
   */
  scope?: AgentScope | null;
}

/** Helper: list of scopes the agent supports. */
export function scopesAvailableFor(agent: AgentSpec): AgentScope[] {
  const out: AgentScope[] = [];
  if (agent.installPaths.user && agent.installPaths.user.length > 0) {
    out.push("user");
  }
  if (agent.installPaths.project && agent.installPaths.project.length > 0) {
    out.push("project");
  }
  return out;
}

export function renderForAgent(agent: AgentSpec, inputs: RenderInputs): RenderResult {
  const parsed = parseFrontmatter(inputs.canonicalTemplate);

  // The canonical helper templates ship `description: {{DESCRIPTION}}` so
  // the single template can be reused across agents. If we picked that
  // string up verbatim it would land in the rendered frontmatter as
  // `description: "{{DESCRIPTION}}"` (quoteYaml double-quotes anything
  // with curly braces) and the agent would see the literal placeholder.
  // Treat any value that still contains an unsubstituted `{{...}}` token
  // as missing and fall through to the inputs/default. (See PR #1268
  // review feedback.)
  const parsedDesc = parsed.description.trim();
  const parsedDescIsPlaceholder = /\{\{\w+\}\}/.test(parsedDesc);
  const description =
    inputs.description.trim() ||
    (parsedDescIsPlaceholder ? "" : parsedDesc) ||
    "Browse and install skills from the CAIPE skill catalog";

  const body = substitutePlaceholders(parsed.body, {
    commandName: inputs.commandName,
    updateCommandName: deriveUpdateCommandName(inputs.commandName),
    description,
    baseUrl: inputs.baseUrl,
    argRef: agent.argRef,
  }).replace(/^\n+/, ""); // strip leading blank lines from frontmatter strip

  // Canonical agentskills.io frontmatter: `name:` matching directory,
  // `description:` for discovery, plus any preserved keys
  // (`disable-model-invocation`, `allowed-tools`) the source template
  // declared.
  const frontmatterLines = [
    `name: ${quoteYaml(inputs.commandName)}`,
    `description: ${quoteYaml(description)}`,
    ...parsed.preservedFrontmatter,
  ];
  const rendered = `---\n${frontmatterLines.join("\n")}\n---\n\n${body}`;

  const scopesAvail = scopesAvailableFor(agent);

  // Resolve the requested scope. Three cases:
  //  - explicit and supported  → use it
  //  - explicit and unsupported → null, scope_fallback=true
  //  - not provided             → null, scope_fallback=false (UI hasn't picked yet)
  const requested = inputs.scope ?? null;
  let resolvedScope: AgentScope | null = null;
  let scopeFallback = false;
  if (requested) {
    if (agent.installPaths[requested] && agent.installPaths[requested]!.length > 0) {
      resolvedScope = requested;
    } else {
      scopeFallback = true;
    }
  }

  const installPaths: Partial<Record<AgentScope, readonly string[]>> = {};
  for (const s of scopesAvail) {
    installPaths[s] = agent.installPaths[s]!.map((p) =>
      p.replace(/\{name\}/g, inputs.commandName),
    );
  }

  // For display: the first path in the resolved scope's array. The full
  // multi-target list is in `install_paths[scope]`.
  const installPath =
    resolvedScope && installPaths[resolvedScope]
      ? installPaths[resolvedScope]![0] ?? null
      : null;

  return {
    template: rendered,
    install_path: installPath,
    install_paths: installPaths,
    scopes_available: scopesAvail,
    scope: resolvedScope,
    scope_fallback: scopeFallback,
    launch_guide: agent.launchGuide
      .replace(/\{name\}/g, inputs.commandName)
      .replace(/\{updateName\}/g, deriveUpdateCommandName(inputs.commandName)),
    docs_url: agent.docsUrl,
    label: agent.label,
  };
}
