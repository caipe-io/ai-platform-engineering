"use client";

import { Button } from "@/components/ui/button";
import { SearchablePicker } from "@/components/ui/searchable-picker";
import { Select } from "@/components/ui/select";
import {
Card,
CardContent,
CardDescription,
CardHeader,
CardTitle,
} from "@/components/ui/card";
import {
Dialog,
DialogContent,
DialogDescription,
DialogHeader,
DialogTitle,
} from "@/components/ui/dialog";
import {
AlertCircle,
Check,
CheckCircle2,
ChevronRight,
Copy,
Eye,
EyeOff,
Loader2,
Search,
Terminal,
Zap,
} from "lucide-react";
import { useCallback,useEffect,useState } from "react";

const DEFAULT_SKILL_COMMAND_NAME = "caipe-skills";

/**
 * Single-quote a value for safe inclusion in a bash snippet shown to the
 * user. Mirrors the server-side `shq()` in install.sh/route.ts. We do NOT
 * try to be clever with `"…"`: single quotes are safer for arbitrary user
 * input (including API keys with `$`, `&`, or backticks).
 */
function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function maskSecret(value: string): string {
  if (value.length <= 10) {
    return "*".repeat(Math.max(value.length, 4));
  }

  const prefixLength = Math.min(6, Math.floor(value.length / 2));
  const suffixLength = Math.min(4, value.length - prefixLength);
  const maskedLength = Math.max(8, value.length - prefixLength - suffixLength);
  return `${value.slice(0, prefixLength)}${"*".repeat(maskedLength)}${value.slice(-suffixLength)}`;
}

export function TrySkillsGateway() {
  const [copiedUrl, setCopiedUrl] = useState(false);
  const [copiedBulkOneLiner, setCopiedBulkOneLiner] = useState(false);
  const [copiedBulkUpgrade, setCopiedBulkUpgrade] = useState(false);
  const [quickInstallOpen, setQuickInstallOpen] = useState(false);
  // Quick-install mode picker: pass nothing (default), `--upgrade`, or
  // `--force` to the install.sh script. Modeled as a single string with
  // three values so the radio-style UI can't end up in an illegal state
  // (both upgrade AND force) — install.sh's flag handling treats those
  // two as mutually exclusive (force always wins) and exposing both as
  // independent checkboxes would surface a footgun the script ignores.
  const [quickInstallMode, setQuickInstallMode] = useState<
    "default" | "upgrade" | "force"
  >("default");
  // When true, the rendered one-liner asks install.sh to also write
  // the /caipe-skills and /update-caipe-skills helper SKILL.md files. Default ON
  // because (a) Quick Install used to silently skip them when
  // ?catalog_url= was set (it forced mode=catalog-query, which has
  // DO_HELPERS=0) and (b) those two helpers are how users actually
  // search/refresh the catalog from inside Claude Code et al.
  const [quickInstallHelpers, setQuickInstallHelpers] = useState(true);
  const [copiedSkill, setCopiedSkill] = useState(false);
  const [copiedInstall, setCopiedInstall] = useState(false);

  // Live-skills skill customization
  const [skillCommandName, setSkillCommandName] = useState(
    DEFAULT_SKILL_COMMAND_NAME,
  );
  const [skillDescription, setSkillDescription] = useState(
    "Browse and install skills from the CAIPE skill catalog",
  );
  // After the skills-only overhaul, every supported agent (Claude Code,
  // Cursor, Codex CLI, Gemini CLI, opencode) reads the same
  // `agentskills.io` SKILL.md format. Claude also needs a native
  // ~/.claude/skills/<name>/SKILL.md copy because its /skills command
  // does not read ~/.agents/skills. We've verified against the upstream agent docs that
  // only Claude does template substitution in the body (`$ARGUMENTS`,
  // `$N`); the other four read SKILL.md verbatim. So the agent picker
  // had no functional effect on what gets installed -- it only changed
  // the launch-guide footer + the success-card label. We pin Claude
  // here as the rendering default (its $ARGUMENTS token is treated as
  // plain text by the other four agents, so it is safe across the
  // board) and drop the picker from both Quick install and Step 3.
  const selectedAgent = "claude";
  // Install scope: "user" (~/...) or "project" (./...). Defaults to
  // "user" (the recommended choice -- per the new UX, project-scope
  // is hidden behind an Advanced disclosure so the common case works
  // without a click). Setting null would force a pre-flight pick.
  type InstallScope = "user" | "project";
  const [selectedScope, setSelectedScope] = useState<InstallScope | null>(
    "user",
  );
  const [copiedOneLiner, setCopiedOneLiner] = useState(false);
  const [copiedUpgrade, setCopiedUpgrade] = useState(false);
  const [copiedDownload, setCopiedDownload] = useState(false);
  // Uninstall flow has two flavors. Both invoke install.sh?mode=uninstall
  // but the --purge variant additionally removes ~/.config/caipe/config.json
  // (the gateway URL + api_key); we separate them so the user picks the
  // semantic they want without having to read the script first.
  const [copiedUninstall, setCopiedUninstall] = useState(false);
  const [copiedUninstallPurge, setCopiedUninstallPurge] = useState(false);
  const [copiedUninstallDryRun, setCopiedUninstallDryRun] = useState(false);

  // Per-agent rendered live-skills (fetched from
  // /api/skills/live-skills?agent=<id>&command_name=...&description=...).
  // The server resolves the canonical template from SKILLS_LIVE_SKILLS_TEMPLATE,
  // SKILLS_LIVE_SKILLS_FILE, the chart default, or a built-in fallback, then
  // renders it for the selected agent (Markdown frontmatter, plain Markdown,
  // Gemini TOML, or Continue JSON fragment).
  interface AgentMeta {
    id: string;
    label: string;
    /**
     * Per-scope install paths. Each scope maps to an array of universal
     * SKILL.md paths the install script writes to. The display path
     * (first entry) is what the UI shows; the rest are mirrors for
     * additional agent discovery paths.
     */
    install_paths: Partial<Record<InstallScope, string[] | readonly string[]>>;
    /** Scopes this agent actually supports. */
    scopes_available: InstallScope[];
    docs_url?: string;
  }
  interface LiveSkillsResponse {
    agent: string;
    label: string;
    template: string;
    /** Resolved first path for the requested scope (display only). */
    install_path: string | null;
    install_paths: Partial<Record<InstallScope, string[] | readonly string[]>>;
    scope: InstallScope | null;
    scope_requested: InstallScope | null;
    scope_fallback: boolean;
    scopes_available: InstallScope[];
    launch_guide: string;
    docs_url?: string;
    agents: AgentMeta[];
    source: string;
  }

  interface PreviewSkill {
    id?: string;
    name?: string;
    description?: string;
    source?: string;
    metadata?: {
      tags?: string[];
    };
  }

  interface PreviewResponse {
    skills: PreviewSkill[];
    meta?: {
      total?: number;
    };
  }
  const [liveSkills, setLiveSkills] = useState<LiveSkillsResponse | null>(null);
  const [liveSkillsTemplateSource, setLiveSkillsTemplateSource] = useState<
    string | null
  >(null);
  const [, setAgents] = useState<AgentMeta[]>([]);

  const [mintedKey, setMintedKey] = useState<string | null>(null);
  const [showMintedKey, setShowMintedKey] = useState(false);
  const [mintBusy, setMintBusy] = useState(false);
  const [mintError, setMintError] = useState<string | null>(null);
  // The "Active / past keys" list was removed per PR #1268 review feedback;
  // revocation/listing lives on the admin page now, so this component no
  // longer needs to fetch /api/catalog-api-keys.

  // Query builder state
  const [queryQ, setQueryQ] = useState("");
  const [querySource, setQuerySource] = useState("");
  const [queryRepo, setQueryRepo] = useState("");
  const [queryTags, setQueryTags] = useState("");
  const [queryVisibility, setQueryVisibility] = useState("");
  const [queryIncludeContent, setQueryIncludeContent] = useState(false);
  const [previewData, setPreviewData] = useState<PreviewResponse | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);

  // Tags autocomplete + search suggestions
  const [availableTags, setAvailableTags] = useState<string[]>([]);
  const [showTagSuggestions, setShowTagSuggestions] = useState(false);
  const [skillNames, setSkillNames] = useState<string[]>([]);
  const [showSearchSuggestions, setShowSearchSuggestions] = useState(false);
  // Hub repos discovered from catalog metadata
  const [availableRepos, setAvailableRepos] = useState<{ location: string; type: string }[]>([]);

  const baseUrl =
    typeof window !== "undefined" ? window.location.origin : "https://your-instance.example.com";

  const buildCatalogUrl = useCallback(() => {
    const params = new URLSearchParams();
    if (queryQ.trim()) params.set("q", queryQ.trim());
    if (querySource) params.set("source", querySource);
    if (queryRepo) params.set("repo", queryRepo);
    if (queryTags.trim()) params.set("tags", queryTags.trim());
    if (queryVisibility) params.set("visibility", queryVisibility);
    if (queryIncludeContent) params.set("include_content", "true");
    const queryString = params.toString();
    return queryString ? `${baseUrl}/api/skills?${queryString}` : `${baseUrl}/api/skills`;
  }, [baseUrl, queryQ, querySource, queryRepo, queryTags, queryVisibility, queryIncludeContent]);

  const catalogUrl = buildCatalogUrl();

  useEffect(() => {
    // Fetch catalog to populate autocomplete tags and search suggestions
    fetch("/api/skills", { credentials: "include" })
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (!data?.skills) return;
        const tags = new Set<string>();
        const names: string[] = [];
        const repoMap = new Map<string, string>();
        for (const s of data.skills) {
          if (s.name) names.push(s.name);
          if (Array.isArray(s.metadata?.tags)) {
            for (const t of s.metadata.tags) {
              if (typeof t === "string" && t.trim()) tags.add(t.trim().toLowerCase());
            }
          }
          const loc = s.metadata?.hub_location;
          const hubType = s.metadata?.hub_type;
          if (typeof loc === "string" && loc && typeof hubType === "string") {
            repoMap.set(loc, hubType);
          }
        }
        setAvailableTags(Array.from(tags).sort());
        setSkillNames(names.sort());
        setAvailableRepos(
          Array.from(repoMap.entries())
            .map(([location, type]) => ({ location, type }))
            .sort((a, b) => a.location.localeCompare(b.location)),
        );
      })
      .catch(() => {});
  }, []);

  // Re-fetch the per-agent rendered live-skills whenever the agent, scope,
  // command name, or description changes. Debounced lightly so typing is
  // smooth. Scope is optional (null = "ask the user first"); if set we
  // forward it so the response carries an `install_path` for the chosen
  // location.
  useEffect(() => {
    const controller = new AbortController();
    const timer = setTimeout(() => {
      const params = new URLSearchParams({
        agent: selectedAgent,
        command_name: skillCommandName.trim() || DEFAULT_SKILL_COMMAND_NAME,
      });
      if (selectedScope) params.set("scope", selectedScope);
      const desc = skillDescription.trim();
      if (desc) params.set("description", desc);
      fetch(`/api/skills/live-skills?${params.toString()}`, {
        credentials: "include",
        signal: controller.signal,
      })
        .then((res) => (res.ok ? res.json() : null))
        .then((data: LiveSkillsResponse | null) => {
          if (!data || typeof data.template !== "string") return;
          setLiveSkills(data);
          if (typeof data.source === "string") {
            setLiveSkillsTemplateSource(data.source);
          }
          if (Array.isArray(data.agents)) setAgents(data.agents);
        })
        .catch((err) => {
          if (err?.name !== "AbortError") {
            // Soft-fail; UI shows a fallback notice.
          }
        });
    }, 200);
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [selectedAgent, selectedScope, skillCommandName, skillDescription]);

  // (Removed: the agent-change scope-reset effect is no longer needed.
  // The agent is pinned to Claude and every supported agent supports
  // both user and project scopes, so there is no per-agent scope
  // narrowing to apply.)

  const handleMint = async () => {
    setMintBusy(true);
    setMintedKey(null);
    setShowMintedKey(false);
    setMintError(null);
    try {
      const res = await fetch("/api/catalog-api-keys", {
        method: "POST",
        credentials: "include",
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setMintedKey(null);
        const message =
          typeof data.message === "string"
            ? data.message
            : typeof data.detail === "string"
              ? data.detail
              : typeof data.error === "string"
                ? data.error
                : `Failed to generate API key (${res.status})`;
        setMintError(message);
        return;
      }
      if (typeof data.key === "string") {
        setMintedKey(data.key);
        setShowMintedKey(false);
        setMintError(null);
      } else {
        setMintError("Server did not return an API key. Check MongoDB configuration.");
      }
    } catch (err) {
      setMintedKey(null);
      setMintError(
        err instanceof Error ? err.message : "Failed to generate API key",
      );
    } finally {
      setMintBusy(false);
    }
  };

  const handlePreview = async () => {
    setPreviewLoading(true);
    setPreviewError(null);
    setPreviewData(null);
    try {
      const res = await fetch(catalogUrl.replace(baseUrl, ""), {
        credentials: "include",
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setPreviewError(data.message || data.detail?.message || `Request failed (${res.status})`);
        return;
      }
      setPreviewData(data);
    } catch (err) {
      setPreviewError(err instanceof Error ? err.message : "Preview request failed");
    } finally {
      setPreviewLoading(false);
    }
  };

  // Sanitize the slash command name for display purposes (the server
  // performs its own sanitization for the rendered artifact).
  const safeCommandName = (skillCommandName.trim() || DEFAULT_SKILL_COMMAND_NAME)
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, "-")
    .replace(/^-+|-+$/g, "") || DEFAULT_SKILL_COMMAND_NAME;
  const updateSkillCommandName = safeCommandName.startsWith("update-")
    ? safeCommandName
    : `update-${safeCommandName}`;

  // Rendered artifact + metadata from the server (per selected agent).
  // Falls back to placeholders while the first fetch is in flight.
  const liveSkillsSkillContent =
    liveSkills?.template ?? "# Loading live-skills skill template…\n";
  const installPath = liveSkills?.install_path ?? null;
  // Fragment-config agents (Continue) are gone in the skills-only
  // overhaul; every supported agent uses the universal SKILL.md format.
  // Kept as a const for any leftover branches that conditionally render
  // fragment-only copy.
  const isFragment = false;
  const agentLabel = liveSkills?.label ?? "Claude Code";
  const scopesAvailable: InstallScope[] =
    liveSkills?.scopes_available ?? ["user", "project"];

  // Build the heredoc-style install command, scoped to the picked location.
  // null when the user hasn't picked a scope yet (UI hides the block in that
  // case so users don't run a half-resolved command).
  const installCommands = (() => {
    if (!installPath) return null;
    if (isFragment) {
      return `# ${agentLabel} stores commands as JSON fragments inside\n# ${installPath}. Merge the fragment shown in "Preview generated skill"\n# below into the top-level "slashCommands" array of that file.`;
    }
    const dir = installPath.replace(/\/[^/]+$/, "") || ".";
    const expandedDir = dir.startsWith("~/")
      ? `"$HOME/${dir.slice(2)}"`
      : dir;
    const expandedPath = installPath.startsWith("~/")
      ? `"$HOME/${installPath.slice(2)}"`
      : installPath;
    return `mkdir -p ${expandedDir}\ncat > ${expandedPath} << 'SKILL'\n${liveSkillsSkillContent}${
      liveSkillsSkillContent.endsWith("\n") ? "" : "\n"
    }SKILL`;
  })();

  // Build the curl|bash one-liner and the "download then run" snippet for
  // the install.sh endpoint. install.sh reads the API key from
  // `~/.config/caipe/config.json` (set up in Step 1), so we deliberately do
  // NOT inject `CAIPE_CATALOG_KEY=…` into the snippets — the recommended
  // path is "Step 1 once, then a clean curl one-liner forever after." Users
  // who haven't completed Step 1 yet get a clear error from install.sh
  // itself telling them to create the config file or pass --api-key=…
  const installerSnippets = (() => {
    if (!selectedScope) return null;
    // Note: ?agent= is intentionally omitted. The install.sh route
    // defaults to Claude so the generated script includes Claude's
    // native .claude/skills discovery path plus the shared .agents copy.
    const installShUrl = `${baseUrl}/api/skills/install.sh?scope=${encodeURIComponent(
      selectedScope,
    )}&command_name=${encodeURIComponent(safeCommandName)}`;
    const oneLiner = `curl -fsSL ${shellQuote(installShUrl)} | bash`;
    // Upgrade variant: forwards `--upgrade` to the script via `bash -s`,
    // which is `bash`'s standard way of passing flags to a piped script.
    const oneLinerUpgrade = `curl -fsSL ${shellQuote(installShUrl)} | bash -s -- --upgrade`;
    const downloadSnippet = `curl -fsSL -o install-skills.sh ${shellQuote(installShUrl)}\nchmod +x ./install-skills.sh\n./install-skills.sh`;
    return { oneLiner, oneLinerUpgrade, downloadSnippet, installShUrl };
  })();

  // Uninstall snippets. Mirror `installerSnippets` exactly (same agent +
  // scope + layout query params) but flip `mode=uninstall`. Three flavors
  // exposed in the UI:
  //   - oneLiner       : interactive per-item prompts; preserves config.json
  //   - oneLinerPurge  : interactive + also removes ~/.config/caipe/config.json
  //                      (true clean wipe; user has to re-enter the gateway
  //                      URL + api_key after a future re-install)
  //   - oneLinerDryRun : preview mode -- prints what would be removed without
  //                      deleting anything. Implies --all so the output is
  //                      flat rather than waiting on N prompts.
  // We keep --all out of the default one-liner: per-item prompts are the
  // safety net the design questionnaire chose, and a destructive default
  // shouldn't be a `curl | bash` away.
  const uninstallSnippets = (() => {
    if (!selectedScope) return null;
    const uninstallShUrl = `${baseUrl}/api/skills/install.sh?scope=${encodeURIComponent(
      selectedScope,
    )}&mode=uninstall`;
    const oneLiner = `curl -fsSL ${shellQuote(uninstallShUrl)} | bash`;
    const oneLinerPurge = `curl -fsSL ${shellQuote(uninstallShUrl)} | bash -s -- --purge`;
    const oneLinerDryRun = `curl -fsSL ${shellQuote(uninstallShUrl)} | bash -s -- --dry-run`;
    return { oneLiner, oneLinerPurge, oneLinerDryRun, uninstallShUrl };
  })();

  // Bulk-install one-liner driven by the "Pick your skills" panel. Reuses
  // the same /api/skills/install.sh endpoint, but adds ?catalog_url=… so the
  // generated script writes one file per catalog skill instead of installing
  // the live-skills skill. Disabled when the agent is fragment-config (Continue)
  // or when no scope has been chosen yet.
  const bulkInstallerSnippet = (() => {
    if (!selectedScope) return null;
    const previewSkillCount =
      previewData?.skills && Array.isArray(previewData.skills)
        ? previewData.skills.length
        : 0;
    if (previewSkillCount === 0) return null;
    const installShUrl = `${baseUrl}/api/skills/install.sh?scope=${encodeURIComponent(
      selectedScope,
    )}&command_name=${encodeURIComponent(
      safeCommandName,
    )}&catalog_url=${encodeURIComponent(catalogUrl)}`;
    // No CAIPE_CATALOG_KEY=… injection — install.sh reads the key from
    // ~/.config/caipe/config.json (Step 1). See installerSnippets above.
    const oneLiner = `curl -fsSL ${shellQuote(installShUrl)} | bash`;
    const oneLinerUpgrade = `curl -fsSL ${shellQuote(installShUrl)} | bash -s -- --upgrade`;
    return { oneLiner, oneLinerUpgrade, installShUrl, count: previewSkillCount };
  })();

  return (
    <div className="mx-auto w-full max-w-[1600px] space-y-6">
      <div className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight text-foreground">
          Skills Gateway
        </h1>
        <p className="text-sm text-muted-foreground">
          Install the catalog once, then use skills from your coding agent.
        </p>
      </div>

      {/* assisted-by Codex Codex-sonnet-4-6 */}
      <Card className="border-primary/40 bg-primary/5">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-xl">
            <Zap className="h-5 w-5 text-primary" />
            Quick install skills
          </CardTitle>
          <CardDescription>
            Install skills into your local coding agent. Claude gets its
            native ~/.claude/skills copy, with shared ~/.agents/skills copies
            for agents that use that convention.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col sm:flex-row sm:items-center gap-3 text-sm">
          <Button
            type="button"
            variant="default"
            size="lg"
            onClick={() => setQuickInstallOpen(true)}
            className="gap-2 self-start"
          >
            <Zap className="h-4 w-4" />
            Quick install skills
          </Button>
        </CardContent>
      </Card>

      <details className="group rounded-lg border border-border/80 bg-card/50">
        <summary className="cursor-pointer select-none px-6 py-4 text-sm font-semibold text-foreground flex items-center gap-2">
          <ChevronRight className="h-4 w-4 transition-transform group-open:rotate-90" />
          Advanced install options
        </summary>
        <div className="space-y-6 p-6 pt-0">
      {/* Catalog Query Builder */}
      <Card className="border-border/80 bg-card/50">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-xl">
            <Search className="h-5 w-5" />
            Choose specific skills or bulk install
          </CardTitle>
          <CardDescription>
            Build a catalog URL and preview the live merged catalog
            (session-authenticated in the browser). Quick install uses the
            full catalog unless you filter and preview specific skills here.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4 text-sm">
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
            <div className="relative">
              <label className="text-xs font-medium text-muted-foreground">Search (q)</label>
              <input
                type="text"
                value={queryQ}
                onChange={(e) => { setQueryQ(e.target.value); setShowSearchSuggestions(true); }}
                onFocus={() => setShowSearchSuggestions(true)}
                onBlur={() => setTimeout(() => setShowSearchSuggestions(false), 150)}
                placeholder="e.g. github, aws, kubernetes"
                className="mt-1 w-full px-3 py-2 text-sm bg-background border border-border rounded-md focus:outline-none focus:ring-2 focus:ring-primary/50"
                autoComplete="off"
              />
              {showSearchSuggestions && queryQ.trim().length > 0 && skillNames.filter(n => n.toLowerCase().includes(queryQ.toLowerCase())).length > 0 && (
                <ul className="absolute z-10 mt-1 w-full max-h-40 overflow-y-auto rounded-md border border-border bg-popover shadow-md text-xs">
                  {skillNames
                    .filter(n => n.toLowerCase().includes(queryQ.toLowerCase()))
                    .slice(0, 8)
                    .map(n => (
                      <li
                        key={n}
                        className="px-3 py-1.5 cursor-pointer hover:bg-accent"
                        onMouseDown={() => { setQueryQ(n); setShowSearchSuggestions(false); }}
                      >
                        {n}
                      </li>
                    ))}
                </ul>
              )}
            </div>
            <div>
              <label className="text-xs font-medium text-muted-foreground">Source</label>
              <Select
                value={querySource}
                onChange={(e) => {
                  setQuerySource(e.target.value);
                  if (!["hub", "github", "gitlab"].includes(e.target.value)) setQueryRepo("");
                }}
                className="mt-1 w-full px-3 py-2 text-sm bg-background border border-border rounded-md focus:outline-none focus:ring-2 focus:ring-primary/50"
              >
                <option value="">All sources</option>
                <option value="default">Built-in</option>
                <option value="agent_skills">Custom Skills</option>
                {availableRepos.some(r => r.type === "github") && (
                  <option value="github">GitHub</option>
                )}
                {availableRepos.some(r => r.type === "gitlab") && (
                  <option value="gitlab">GitLab</option>
                )}
                {availableRepos.length === 0 && <option value="hub">Hub</option>}
              </Select>
            </div>
            <div>
              <label className="text-xs font-medium text-muted-foreground">Repository</label>
              <SearchablePicker
                options={availableRepos}
                selected={availableRepos.find(
                  (repository) => repository.location === queryRepo,
                )}
                onSelect={(repository) => {
                  setQueryRepo(repository.location);
                  setQuerySource(repository.type || "hub");
                }}
                getOptionKey={(repository) => repository.location}
                getOptionLabel={(repository) =>
                  `${repository.location} (${repository.type})`
                }
                getSearchText={(repository) => [
                  repository.location,
                  repository.type,
                ]}
                placeholder="All repos"
                searchPlaceholder="Search repositories..."
                emptyLabel="No repositories match"
                ariaLabel="Repository"
                onClear={() => setQueryRepo("")}
                clearLabel="Clear repository filter"
                triggerClassName="mt-1 text-sm"
              />
            </div>
            <div className="relative">
              <label className="text-xs font-medium text-muted-foreground">Tags (comma-separated)</label>
              <input
                type="text"
                value={queryTags}
                onChange={(e) => { setQueryTags(e.target.value); setShowTagSuggestions(true); }}
                onFocus={() => setShowTagSuggestions(true)}
                onBlur={() => setTimeout(() => setShowTagSuggestions(false), 150)}
                placeholder="e.g. security, networking"
                className="mt-1 w-full px-3 py-2 text-sm bg-background border border-border rounded-md focus:outline-none focus:ring-2 focus:ring-primary/50"
                autoComplete="off"
              />
              {showTagSuggestions && availableTags.length > 0 && (() => {
                const entered = queryTags.split(",").map(t => t.trim().toLowerCase()).filter(Boolean);
                const lastPartial = queryTags.includes(",")
                  ? queryTags.slice(queryTags.lastIndexOf(",") + 1).trim().toLowerCase()
                  : queryTags.trim().toLowerCase();
                const suggestions = availableTags
                  .filter(t => !entered.includes(t))
                  .filter(t => !lastPartial || t.includes(lastPartial))
                  .slice(0, 8);
                if (suggestions.length === 0) return null;
                return (
                  <ul className="absolute z-10 mt-1 w-full max-h-40 overflow-y-auto rounded-md border border-border bg-popover shadow-md text-xs">
                    {suggestions.map(tag => (
                      <li
                        key={tag}
                        className="px-3 py-1.5 cursor-pointer hover:bg-accent"
                        onMouseDown={() => {
                          const parts = queryTags.split(",").map(t => t.trim()).filter(Boolean);
                          if (queryTags.includes(",")) {
                            parts[parts.length - 1] = tag;
                          } else {
                            parts[0] = tag;
                          }
                          setQueryTags(parts.join(", ") + ", ");
                          setShowTagSuggestions(false);
                        }}
                      >
                        {tag}
                      </li>
                    ))}
                  </ul>
                );
              })()}
            </div>
            <div>
              <label className="text-xs font-medium text-muted-foreground">Visibility</label>
              <Select
                value={queryVisibility}
                onChange={(e) => setQueryVisibility(e.target.value)}
                className="mt-1 w-full px-3 py-2 text-sm bg-background border border-border rounded-md focus:outline-none focus:ring-2 focus:ring-primary/50"
              >
                <option value="">All</option>
                <option value="global">global</option>
                <option value="team">team</option>
                <option value="personal">personal</option>
              </Select>
            </div>
            <div className="flex items-end pb-2">
              <label className="flex items-center gap-2 text-xs font-medium text-muted-foreground cursor-pointer">
                <input
                  type="checkbox"
                  checked={queryIncludeContent}
                  onChange={(e) => setQueryIncludeContent(e.target.checked)}
                  className="rounded border-border"
                />
                include_content
              </label>
            </div>
          </div>
          <div>
            <p className="font-medium text-foreground mb-1 text-xs">Live URL</p>
            <div className="relative group">
              <code className="block rounded-md bg-muted px-3 py-2 pr-10 text-xs break-all">{catalogUrl}</code>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="absolute top-1 right-1 h-7 w-7 opacity-0 group-hover:opacity-100 transition-opacity"
                onClick={() => {
                  void navigator.clipboard.writeText(catalogUrl);
                  setCopiedUrl(true);
                  setTimeout(() => setCopiedUrl(false), 2000);
                }}
              >
                {copiedUrl ? <Check className="h-3.5 w-3.5 text-green-500" /> : <Copy className="h-3.5 w-3.5" />}
              </Button>
            </div>
          </div>

          <div className="flex items-center gap-2 flex-wrap">
            <Button
              type="button"
              variant="secondary"
              size="sm"
              disabled={previewLoading}
              onClick={() => void handlePreview()}
              className="gap-1"
            >
              {previewLoading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Search className="h-3.5 w-3.5" />}
              Preview
            </Button>
          </div>
          {previewData?.meta?.total != null && (
            <p className="text-xs text-muted-foreground">
              {previewData.meta.total} skill{previewData.meta.total !== 1 ? "s" : ""} found
            </p>
          )}

          {previewError && (
            <p className="text-destructive text-xs flex items-center gap-1">
              <AlertCircle className="h-3.5 w-3.5" />
              {previewError}
            </p>
          )}

          {previewData?.skills && previewData.skills.length > 0 && (
            <div className="rounded-md border border-border overflow-hidden max-h-64 overflow-y-auto">
              <table className="w-full text-xs">
                <thead className="bg-muted sticky top-0">
                  <tr>
                    <th className="text-left px-3 py-1.5 font-medium">Name</th>
                    <th className="text-left px-3 py-1.5 font-medium">Description</th>
                    <th className="text-left px-3 py-1.5 font-medium">Source</th>
                    <th className="text-left px-3 py-1.5 font-medium">Tags</th>
                  </tr>
                </thead>
                <tbody>
                  {previewData.skills.map((skill, i) => (
                    <tr key={skill.id || i} className="border-t border-border hover:bg-muted/50">
                      <td className="px-3 py-1.5 font-medium">{skill.name}</td>
                      <td className="px-3 py-1.5 text-muted-foreground truncate max-w-[200px] lg:max-w-[420px]">{skill.description}</td>
                      <td className="px-3 py-1.5">{skill.source}</td>
                      <td className="px-3 py-1.5 text-muted-foreground">
                        {((skill.metadata?.tags as string[]) || []).join(", ")}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Advanced — bulk install uses the same preview and selected scope. */}
      {previewData?.skills && previewData.skills.length > 0 && (
        <Card className="border-dashed border-amber-500/40 bg-amber-500/5">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-lg">
              Bulk-install previewed skills
            </CardTitle>
            <CardDescription>
              Optional. Writes one slash-command file per previewed skill using{" "}
              <code className="text-xs">install.sh?catalog_url=…</code>. Use
              this only when you want every previewed skill materialized on
              disk; the default Quick install flow is simpler.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            <div className="flex items-center justify-between gap-2 flex-wrap">
              <div className="text-sm font-medium text-foreground">
                Install these {previewData.skills.length} skill
                {previewData.skills.length === 1 ? "" : "s"}
              </div>
              <div className="text-xs text-muted-foreground">
                <span title="Works in Claude Code, Cursor, Codex CLI, Gemini CLI, and opencode">
                  universal install
                </span>
                {" · "}
                scope:{" "}
                <span className="font-mono">{selectedScope ?? "user"}</span>
              </div>
            </div>
            {bulkInstallerSnippet ? (
              <>
                <div className="relative group">
                  <pre className="rounded-md bg-muted p-3 pr-10 text-xs overflow-x-auto whitespace-pre-wrap leading-relaxed">
                    {bulkInstallerSnippet.oneLiner}
                  </pre>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="absolute top-2 right-2 h-7 w-7 opacity-0 group-hover:opacity-100 transition-opacity"
                    onClick={() => {
                      void navigator.clipboard.writeText(bulkInstallerSnippet.oneLiner);
                      setCopiedBulkOneLiner(true);
                      setTimeout(() => setCopiedBulkOneLiner(false), 2000);
                    }}
                  >
                    {copiedBulkOneLiner ? (
                      <Check className="h-3.5 w-3.5 text-emerald-600" />
                    ) : (
                      <Copy className="h-3.5 w-3.5" />
                    )}
                  </Button>
                </div>
                <details className="text-xs">
                  <summary className="cursor-pointer text-muted-foreground hover:text-foreground">
                    Already installed? Upgrade
                  </summary>
                  <div className="relative group mt-2">
                    <pre className="rounded-md bg-muted p-3 pr-10 text-xs overflow-x-auto whitespace-pre-wrap leading-relaxed">
                      {bulkInstallerSnippet.oneLinerUpgrade}
                    </pre>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="absolute top-2 right-2 h-7 w-7 opacity-0 group-hover:opacity-100 transition-opacity"
                      onClick={() => {
                        void navigator.clipboard.writeText(bulkInstallerSnippet.oneLinerUpgrade);
                        setCopiedBulkUpgrade(true);
                        setTimeout(() => setCopiedBulkUpgrade(false), 2000);
                      }}
                    >
                      {copiedBulkUpgrade ? (
                        <Check className="h-3.5 w-3.5 text-emerald-600" />
                      ) : (
                        <Copy className="h-3.5 w-3.5" />
                      )}
                    </Button>
                  </div>
                </details>
                <p className="text-[11px] text-muted-foreground">
                  Writes Claude-discoverable copies under{" "}
                  <code className="font-mono">~/.claude/skills/</code> and
                  shared copies under{" "}
                  <code className="font-mono">~/.agents/skills/</code> (or the
                  project-local equivalents). Existing files are skipped unless
                  you re-run with{" "}
                  <code className="font-mono">--upgrade</code> or{" "}
                  <code className="font-mono">--force</code>.
                </p>
              </>
            ) : (
              <p className="text-xs text-amber-700 dark:text-amber-300">
                Pick an install scope in the manual install advanced section
                below to enable the bulk install command.
              </p>
            )}
          </CardContent>
        </Card>
      )}

      <Card className="border-border/80 bg-card/50">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-xl">
            <Terminal className="h-5 w-5" />
            Manual and custom install options
          </CardTitle>
          <CardDescription>
            Customize the live-skills command, inspect generated files, use
            manual heredoc installs, or copy upgrade, force, uninstall, and
            launch guide commands.
          </CardDescription>
        </CardHeader>
        <CardContent className="text-sm space-y-8 text-muted-foreground">
          <section className="space-y-5">
            <p className="font-medium text-foreground flex items-center gap-2">
              <span className="inline-flex h-6 w-6 items-center justify-center rounded-full bg-primary text-primary-foreground text-xs font-semibold">
                1
              </span>
              Customize or install manually
            </p>

            <div className="ml-8 rounded-md border border-border bg-background/40 p-4 space-y-5">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 pt-2">
              <div>
                <label className="text-xs font-medium text-muted-foreground">
                  Skill name
                </label>
                <div className="flex items-center mt-1">
                  <span className="px-2 py-2 text-sm bg-muted border border-r-0 border-border rounded-l-md text-muted-foreground">
                    /
                  </span>
                  <input
                    type="text"
                    value={skillCommandName}
                    onChange={(e) => setSkillCommandName(e.target.value)}
                    placeholder={DEFAULT_SKILL_COMMAND_NAME}
                    className="w-full px-3 py-2 text-sm bg-background border border-border rounded-r-md focus:outline-none focus:ring-2 focus:ring-primary/50"
                  />
                </div>
                <p className="text-[11px] text-muted-foreground mt-1">
                  Installs as <code>{safeCommandName}.md</code> in your skills directory.
                </p>
              </div>

              <div>
                <label className="text-xs font-medium text-muted-foreground">Description</label>
                <input
                  type="text"
                  value={skillDescription}
                  onChange={(e) => setSkillDescription(e.target.value)}
                  placeholder="Browse and install skills from the CAIPE skill catalog"
                  className="mt-1 w-full px-3 py-2 text-sm bg-background border border-border rounded-md focus:outline-none focus:ring-2 focus:ring-primary/50"
                />
                <p className="text-[11px] text-muted-foreground mt-1">
                  Shown in the skills picker.
                </p>
              </div>
            </div>

            {/* Coding-agent picker dropped: the install defaults to Claude,
                writing .claude/skills for native discovery plus a shared
                .agents/skills copy. Claude also gets a live-catalog hook
                under ~/.claude/hooks. We
                surface the supported-agents list inline so users
                know which CLIs will pick up the install without
                having to read a docs link. */}
            <div className="pt-4 rounded-md bg-muted/20 px-3 py-2.5">
              <p className="flex items-center gap-2 text-xs font-medium text-muted-foreground mb-1.5">
                <span className="inline-flex h-4 w-4 items-center justify-center rounded-full bg-primary/15 text-primary text-[10px] font-semibold">
                  a
                </span>
                Works in
              </p>
              <p className="text-xs text-foreground leading-relaxed">
                <strong>Claude Code</strong>, <strong>Cursor</strong>,{" "}
                <strong>Codex CLI</strong>, <strong>Gemini CLI</strong>, and{" "}
                <strong>opencode</strong>: Claude reads{" "}
                <code className="font-mono text-[11px]">~/.claude/skills/</code>
                , and the shared copy remains under{" "}
                <code className="font-mono text-[11px]">~/.agents/skills/</code>.
              </p>
            </div>

            {/* Scope chooser. After the skills-only overhaul every agent
                supports BOTH user and project scope, so we default-pick
                "user" and put "project" behind an Advanced disclosure
                with a `.gitignore` reminder for the per-project install
                artifacts. */}
            <div
              className={`mt-2 rounded-md p-3 transition-colors ${
                !selectedScope
                  ? "ring-1 ring-amber-500/50 bg-amber-500/5"
                  : "bg-muted/20"
              }`}
            >
              <p
                className={`flex items-center gap-2 text-xs font-semibold mb-3 ${
                  !selectedScope
                    ? "text-amber-700 dark:text-amber-400"
                    : "text-muted-foreground font-medium"
                }`}
              >
                <span
                  className={`inline-flex h-4 w-4 items-center justify-center rounded-full text-[10px] font-semibold ${
                    !selectedScope
                      ? "bg-amber-500/20 text-amber-700 dark:text-amber-400"
                      : "bg-primary/15 text-primary"
                  }`}
                >
                  b
                </span>
                Where to install?
              </p>
              <div className="flex flex-col gap-2">
                {(() => {
                  // User scope — the default. Render at the top, prominently.
                  // Paths are shown as a list because Claude has a native
                  // target plus the shared .agents target.
                  const userPathsRaw = liveSkills?.install_paths?.user;
                  const userPaths: string[] = Array.isArray(userPathsRaw)
                    ? (userPathsRaw as string[])
                    : userPathsRaw
                      ? [userPathsRaw as unknown as string]
                      : [];
                  const userSelected = selectedScope === "user";
                  const userSupported = scopesAvailable.includes("user");
                  return (
                    <label
                      className={`flex items-start gap-3 text-xs rounded-md border px-3 py-2 transition-colors ${
                        userSupported
                          ? `cursor-pointer hover:bg-background/60 ${
                              userSelected
                                ? "border-primary/60 bg-background"
                                : "border-border/60 bg-background/30"
                            }`
                          : "cursor-not-allowed opacity-50 border-border/40"
                      }`}
                    >
                      <input
                        type="radio"
                        name="install-scope"
                        value="user"
                        checked={userSelected}
                        disabled={!userSupported}
                        onChange={() => userSupported && setSelectedScope("user")}
                        className="mt-0.5"
                      />
                      <span className="flex-1 leading-relaxed">
                        <span className="block font-medium text-foreground">
                          User-wide (reused across all projects)
                          <span className="ml-2 inline-flex items-center rounded-full bg-emerald-500/10 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-emerald-700 dark:text-emerald-400">
                            Recommended
                          </span>
                        </span>
                        {userPaths.length > 0 ? (
                          <span className="block mt-0.5 space-y-0.5">
                            {userPaths.map((p) => (
                              <code
                                key={p}
                                className="block text-[11px] text-muted-foreground font-mono"
                              >
                                {p.replace(
                                  new RegExp(`/${skillCommandName}/SKILL\\.md$`),
                                  "/<skill-name>/SKILL.md",
                                )}
                              </code>
                            ))}
                          </span>
                        ) : null}
                        {!userSupported ? (
                          <span className="block mt-0.5 text-[11px] text-muted-foreground italic">
                            Not supported by {agentLabel}.
                          </span>
                        ) : null}
                      </span>
                    </label>
                  );
                })()}

                {/* Advanced: project-local install. Hidden by default;
                    expanding it shows the radio + a .gitignore reminder
                    so users who pick this know to keep `.caipe/`,
                    `.claude/`, and `.agents/` out of version control. */}
                <details className="rounded-md border border-border/40 bg-background/20 px-3 py-2 group">
                  <summary className="cursor-pointer text-[11px] font-medium text-muted-foreground hover:text-foreground select-none">
                    <span className="inline-block transition-transform group-open:rotate-90 mr-1">›</span>
                    Install per-project instead
                  </summary>
                  <div className="mt-3">
                    {(() => {
                      const projectPathsRaw =
                        liveSkills?.install_paths?.project;
                      const projectPaths: string[] = Array.isArray(
                        projectPathsRaw,
                      )
                        ? (projectPathsRaw as string[])
                        : projectPathsRaw
                          ? [projectPathsRaw as unknown as string]
                          : [];
                      const projectSelected = selectedScope === "project";
                      const projectSupported =
                        scopesAvailable.includes("project");
                      return (
                        <label
                          className={`flex items-start gap-3 text-xs rounded-md border px-3 py-2 transition-colors ${
                            projectSupported
                              ? `cursor-pointer hover:bg-background/60 ${
                                  projectSelected
                                    ? "border-primary/60 bg-background"
                                    : "border-border/60 bg-background/30"
                                }`
                              : "cursor-not-allowed opacity-50 border-border/40"
                          }`}
                        >
                          <input
                            type="radio"
                            name="install-scope"
                            value="project"
                            checked={projectSelected}
                            disabled={!projectSupported}
                            onChange={() =>
                              projectSupported && setSelectedScope("project")
                            }
                            className="mt-0.5"
                          />
                          <span className="flex-1 leading-relaxed">
                            <span className="block font-medium text-foreground">
                              Project-local (committed with this repo)
                            </span>
                            {projectPaths.length > 0 ? (
                              <span className="block mt-0.5 space-y-0.5">
                                {projectPaths.map((p) => (
                                  <code
                                    key={p}
                                    className="block text-[11px] text-muted-foreground font-mono"
                                  >
                                    {p.replace(
                                      new RegExp(
                                        `/${skillCommandName}/SKILL\\.md$`,
                                      ),
                                      "/<skill-name>/SKILL.md",
                                    )}
                                  </code>
                                ))}
                              </span>
                            ) : null}
                            {!projectSupported ? (
                              <span className="block mt-0.5 text-[11px] text-muted-foreground italic">
                                Not supported by {agentLabel}.
                              </span>
                            ) : null}
                          </span>
                        </label>
                      );
                    })()}
                    <p className="mt-2 text-[11px] text-amber-700 dark:text-amber-400">
                      Reminder: add these to your <code className="font-mono">.gitignore</code> so
                      manifests, helpers, and the agent dotfiles do not end up in
                      version control:
                    </p>
                    <pre className="mt-1 rounded bg-muted/40 p-2 text-[11px] font-mono leading-snug text-muted-foreground">
{`.caipe/
.claude/
.agents/`}
                    </pre>
                  </div>
                </details>
              </div>
              {!selectedScope ? (
                <p className="mt-3 inline-flex items-center gap-1.5 rounded-full bg-amber-500/15 px-2.5 py-1 text-[11px] font-medium text-amber-700 dark:text-amber-400">
                  <AlertCircle className="h-3 w-3" />
                  Pick an install scope to reveal the install command
                </p>
              ) : installPath ? (
                <p className="mt-2 inline-flex items-center gap-1.5 rounded-full bg-emerald-500/10 px-2 py-0.5 text-[11px] font-medium text-emerald-600 dark:text-emerald-400">
                  <CheckCircle2 className="h-3 w-3" />
                  Installing to{" "}
                  <code className="font-mono">{installPath}</code>
                </p>
              ) : null}
            </div>

            {selectedScope && installCommands ? (
              <>
                {/*
                 * Visual hierarchy:
                 *   1. The one-line `curl … | bash` installer is the
                 *      happy path for non-fragment agents — show it FIRST.
                 *   2. The manual `mkdir … && cat <<SKILL` block is the
                 *      escape hatch for users who can't / won't run a
                 *      remote shell script — tuck it behind a disclosure.
                 *   3. Fragment agents (Continue) have no installer
                 *      one-liner because the script can't safely merge
                 *      JSON config — for them we surface the merge
                 *      fragment directly with no disclosure.
                 */}
                {installerSnippets && !isFragment ? (
                  <div className="mt-2 rounded-lg border border-primary/40 bg-primary/5 p-4 shadow-sm space-y-4">
                    <p className="flex items-center gap-2 text-sm font-semibold text-foreground">
                      <span className="inline-flex h-4 w-4 items-center justify-center rounded-full bg-primary/15 text-primary text-[10px] font-semibold">
                        c
                      </span>
                      Install with one command
                      <span className="ml-auto rounded-full bg-primary px-2 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-primary-foreground">
                        Recommended
                      </span>
                    </p>

                    <div className="relative group">
                      <pre className="rounded-md bg-background p-4 pr-10 text-xs leading-relaxed overflow-x-auto whitespace-pre-wrap">
                        {installerSnippets.oneLiner}
                      </pre>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        className="absolute top-2 right-2 h-7 w-7 opacity-0 group-hover:opacity-100 transition-opacity"
                        onClick={() => {
                          void navigator.clipboard.writeText(
                            installerSnippets.oneLiner,
                          );
                          setCopiedOneLiner(true);
                          setTimeout(() => setCopiedOneLiner(false), 2000);
                        }}
                      >
                        {copiedOneLiner ? (
                          <Check className="h-3.5 w-3.5 text-green-500" />
                        ) : (
                          <Copy className="h-3.5 w-3.5" />
                        )}
                      </Button>
                    </div>

                    <div className="border-t border-primary/15 pt-3 space-y-2">
                    <details className="text-xs">
                      <summary className="cursor-pointer text-muted-foreground hover:text-foreground py-1">
                        Already installed? Upgrade to the latest version
                      </summary>
                      <div className="mt-3 pl-4 border-l-2 border-primary/20">
                        <div className="relative group">
                          <pre className="rounded-md bg-background p-3 pr-10 text-xs overflow-x-auto whitespace-pre-wrap">
                            {installerSnippets.oneLinerUpgrade}
                          </pre>
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon"
                            className="absolute top-2 right-2 h-7 w-7 opacity-0 group-hover:opacity-100 transition-opacity"
                            onClick={() => {
                              void navigator.clipboard.writeText(
                                installerSnippets.oneLinerUpgrade,
                              );
                              setCopiedUpgrade(true);
                              setTimeout(() => setCopiedUpgrade(false), 2000);
                            }}
                          >
                            {copiedUpgrade ? (
                              <Check className="h-3.5 w-3.5 text-green-500" />
                            ) : (
                              <Copy className="h-3.5 w-3.5" />
                            )}
                          </Button>
                        </div>
                      </div>
                    </details>

                    <details className="text-xs">
                      <summary className="cursor-pointer text-muted-foreground hover:text-foreground py-1">
                        Prefer to inspect the script first?
                      </summary>
                      <div className="mt-3 space-y-3 pl-4 border-l-2 border-primary/20">
                        <p className="text-[11px] text-muted-foreground">
                          Download the installer with{" "}
                          <a
                            className="text-primary underline"
                            href={installerSnippets.installShUrl}
                          >
                            this link
                          </a>
                          , read it, then run it:
                        </p>
                        <div className="relative group">
                          <pre className="rounded-md bg-background p-3 pr-10 text-xs overflow-x-auto whitespace-pre-wrap">
                            {installerSnippets.downloadSnippet}
                          </pre>
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon"
                            className="absolute top-2 right-2 h-7 w-7 opacity-0 group-hover:opacity-100 transition-opacity"
                            onClick={() => {
                              void navigator.clipboard.writeText(
                                installerSnippets.downloadSnippet,
                              );
                              setCopiedDownload(true);
                              setTimeout(() => setCopiedDownload(false), 2000);
                            }}
                          >
                            {copiedDownload ? (
                              <Check className="h-3.5 w-3.5 text-green-500" />
                            ) : (
                              <Copy className="h-3.5 w-3.5" />
                            )}
                          </Button>
                        </div>
                      </div>
                    </details>

                    {uninstallSnippets ? (
                      <details className="text-xs">
                        <summary className="cursor-pointer text-muted-foreground hover:text-foreground py-1">
                          Uninstall (reverse the install)
                        </summary>
                        <div className="mt-3 space-y-3 pl-4 border-l-2 border-destructive/30">
                          <p className="text-[11px] text-muted-foreground leading-relaxed">
                            Walks the sidecar manifest at{" "}
                            <code>~/.config/caipe/installed.json</code> (or{" "}
                            <code>./.caipe/installed.json</code> for project
                            scope) and prompts per item before removing each
                            CAIPE-installed file. Files NOT in the manifest are
                            never touched, so a hand-authored skill at a
                            CAIPE-looking path is always safe. When a Claude
                            <code>SessionStart</code> hook entry is removed,
                            the matching{" "}
                            <code>~/.claude/settings.json</code> patch is
                            reversed surgically — only the entries CAIPE added
                            are removed, everything else is preserved.
                          </p>

                          <div>
                            <p className="text-[11px] font-medium text-foreground mb-1">
                              Interactive uninstall (preserves your gateway
                              URL + api_key)
                            </p>
                            <div className="relative group">
                              <pre className="rounded-md bg-background p-3 pr-10 text-xs overflow-x-auto whitespace-pre-wrap">
                                {uninstallSnippets.oneLiner}
                              </pre>
                              <Button
                                type="button"
                                variant="ghost"
                                size="icon"
                                className="absolute top-2 right-2 h-7 w-7 opacity-0 group-hover:opacity-100 transition-opacity"
                                onClick={() => {
                                  void navigator.clipboard.writeText(
                                    uninstallSnippets.oneLiner,
                                  );
                                  setCopiedUninstall(true);
                                  setTimeout(
                                    () => setCopiedUninstall(false),
                                    2000,
                                  );
                                }}
                              >
                                {copiedUninstall ? (
                                  <Check className="h-3.5 w-3.5 text-green-500" />
                                ) : (
                                  <Copy className="h-3.5 w-3.5" />
                                )}
                              </Button>
                            </div>
                            <p className="text-[10px] text-muted-foreground mt-1">
                              Per-item prompts: <code>y</code> = remove,{" "}
                              <code>N</code> = skip, <code>a</code> = remove
                              all remaining without prompting,{" "}
                              <code>q</code> = quit (manifest stays
                              consistent).
                            </p>
                          </div>

                          <div>
                            <p className="text-[11px] font-medium text-foreground mb-1">
                              Preview only (no files deleted)
                            </p>
                            <div className="relative group">
                              <pre className="rounded-md bg-background p-3 pr-10 text-xs overflow-x-auto whitespace-pre-wrap">
                                {uninstallSnippets.oneLinerDryRun}
                              </pre>
                              <Button
                                type="button"
                                variant="ghost"
                                size="icon"
                                className="absolute top-2 right-2 h-7 w-7 opacity-0 group-hover:opacity-100 transition-opacity"
                                onClick={() => {
                                  void navigator.clipboard.writeText(
                                    uninstallSnippets.oneLinerDryRun,
                                  );
                                  setCopiedUninstallDryRun(true);
                                  setTimeout(
                                    () => setCopiedUninstallDryRun(false),
                                    2000,
                                  );
                                }}
                              >
                                {copiedUninstallDryRun ? (
                                  <Check className="h-3.5 w-3.5 text-green-500" />
                                ) : (
                                  <Copy className="h-3.5 w-3.5" />
                                )}
                              </Button>
                            </div>
                          </div>

                          <div>
                            <p className="text-[11px] font-medium text-foreground mb-1">
                              Full wipe (also removes{" "}
                              <code>~/.config/caipe/config.json</code>)
                            </p>
                            <div className="relative group">
                              <pre className="rounded-md bg-background p-3 pr-10 text-xs overflow-x-auto whitespace-pre-wrap">
                                {uninstallSnippets.oneLinerPurge}
                              </pre>
                              <Button
                                type="button"
                                variant="ghost"
                                size="icon"
                                className="absolute top-2 right-2 h-7 w-7 opacity-0 group-hover:opacity-100 transition-opacity"
                                onClick={() => {
                                  void navigator.clipboard.writeText(
                                    uninstallSnippets.oneLinerPurge,
                                  );
                                  setCopiedUninstallPurge(true);
                                  setTimeout(
                                    () => setCopiedUninstallPurge(false),
                                    2000,
                                  );
                                }}
                              >
                                {copiedUninstallPurge ? (
                                  <Check className="h-3.5 w-3.5 text-green-500" />
                                ) : (
                                  <Copy className="h-3.5 w-3.5" />
                                )}
                              </Button>
                            </div>
                            <p className="text-[10px] text-muted-foreground mt-1">
                              You will need to re-enter the gateway URL +
                              catalog API key on the next install.
                            </p>
                          </div>
                        </div>
                      </details>
                    ) : null}

                    <details className="text-xs">
                      <summary className="cursor-pointer text-muted-foreground hover:text-foreground py-1">
                        Show manual install command (no script)
                      </summary>
                      <div className="mt-3 space-y-3 pl-4 border-l-2 border-primary/20">
                        <p className="text-[11px] text-muted-foreground">
                          Same end result as the one-liner above, but writes
                          the rendered template inline with{" "}
                          <code>cat &lt;&lt;SKILL</code>. Use this if you
                          can&apos;t pipe a remote script into{" "}
                          <code>bash</code>, or if you want to vendor the
                          file into a repo by hand.
                        </p>
                        <div className="relative group">
                          <pre className="rounded-md bg-background p-3 pr-10 text-xs overflow-x-auto whitespace-pre-wrap">
                            {installCommands}
                          </pre>
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon"
                            className="absolute top-2 right-2 h-7 w-7 opacity-0 group-hover:opacity-100 transition-opacity"
                            onClick={() => {
                              void navigator.clipboard.writeText(installCommands);
                              setCopiedInstall(true);
                              setTimeout(() => setCopiedInstall(false), 2000);
                            }}
                          >
                            {copiedInstall ? (
                              <Check className="h-3.5 w-3.5 text-green-500" />
                            ) : (
                              <Copy className="h-3.5 w-3.5" />
                            )}
                          </Button>
                        </div>
                      </div>
                    </details>

                    </div>

                    <p className="text-[11px] text-muted-foreground leading-relaxed border-t border-primary/15 pt-3">
                      <span className="font-medium text-foreground">
                        Security:
                      </span>{" "}
                      the script never echoes your API key. The recommended
                      path is to put the key in{" "}
                      <code>~/.config/caipe/config.json</code> once (Step 1)
                      — install.sh reads it from there.{" "}
                      <code>--api-key=…</code> and{" "}
                      <code>CAIPE_CATALOG_KEY=…</code> still work, but both
                      can leak: <code>--api-key</code> shows up in{" "}
                      <code>ps</code> output to other users on the host, and
                      either form lands in your shell history.
                    </p>
                  </div>
                ) : (
                  /*
                   * Fragment agents (Continue) and any future scope/agent
                   * combo without a one-line installer get the manual
                   * command surfaced directly — there's nothing to hide
                   * behind, since the manual block IS the only path.
                   */
                  <div className="mb-4 rounded-md border border-amber-500/40 bg-amber-500/5 p-3">
                    <p className="flex items-center gap-2 text-xs font-medium text-foreground mb-1">
                      <span className="inline-flex h-4 w-4 items-center justify-center rounded-full bg-primary/15 text-primary text-[10px] font-semibold">
                        c
                      </span>
                      {isFragment
                        ? `Generated config fragment for ${agentLabel}`
                        : `Install command for ${agentLabel} (${selectedScope})`}
                      {isFragment ? (
                        <span className="ml-auto rounded-full bg-amber-500/20 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-amber-700 dark:text-amber-400">
                          Manual merge
                        </span>
                      ) : null}
                    </p>
                    <div className="relative group mb-4">
                      <pre className="rounded-md bg-muted p-3 pr-10 text-xs overflow-x-auto whitespace-pre-wrap">
                        {installCommands}
                      </pre>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        className="absolute top-2 right-2 h-7 w-7 opacity-0 group-hover:opacity-100 transition-opacity"
                        onClick={() => {
                          void navigator.clipboard.writeText(installCommands);
                          setCopiedInstall(true);
                          setTimeout(() => setCopiedInstall(false), 2000);
                        }}
                      >
                        {copiedInstall ? (
                          <Check className="h-3.5 w-3.5 text-green-500" />
                        ) : (
                          <Copy className="h-3.5 w-3.5" />
                        )}
                      </Button>
                    </div>
                  </div>
                )}
              </>
            ) : null}

            <p className="text-[11px] text-muted-foreground mt-4 mb-2 leading-relaxed">
              Template source:{" "}
              <code>{liveSkillsTemplateSource ?? "loading…"}</code>
              {". Override via Helm value "}
              <code>skillsLiveSkills</code>
              {" (inline) or "}
              <code>skillsLiveSkillsName</code>
              {" (selects "}
              <code>data/skills/live-skills.&lt;name&gt;.md</code>
              {"), or container env "}
              <code>SKILLS_LIVE_SKILLS_FILE</code>
              {" / "}
              <code>SKILLS_LIVE_SKILLS_TEMPLATE</code>.
            </p>

            <details className="text-xs">
              <summary className="cursor-pointer text-muted-foreground hover:text-foreground">
                Preview generated skill (md)
              </summary>
              <div className="relative group mt-2">
                <pre className="rounded-md bg-muted p-3 pr-10 text-xs overflow-x-auto whitespace-pre-wrap max-h-96 overflow-y-auto">
                  {liveSkillsSkillContent}
                </pre>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="absolute top-2 right-2 h-7 w-7 opacity-0 group-hover:opacity-100 transition-opacity"
                  onClick={() => {
                    void navigator.clipboard.writeText(liveSkillsSkillContent);
                    setCopiedSkill(true);
                    setTimeout(() => setCopiedSkill(false), 2000);
                  }}
                >
                  {copiedSkill ? (
                    <Check className="h-3.5 w-3.5 text-green-500" />
                  ) : (
                    <Copy className="h-3.5 w-3.5" />
                  )}
                </Button>
              </div>
            </details>
            </div>
          </section>

        </CardContent>
      </Card>
        </div>
      </details>

      <Card className="border-border/80 bg-card/50">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-xl">
            <Terminal className="h-5 w-5" />
            Launch your coding agent and use it
          </CardTitle>
          <CardDescription>
            Restart or reopen your coding agent after install.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3 text-sm">
          <p className="text-foreground">
            Installed Claude-native skills in{" "}
            <code className="font-mono text-[12px]">~/.claude/skills/</code>{" "}
            plus shared copies in{" "}
            <code className="font-mono text-[12px]">~/.agents/skills/</code>{" "}
            or the project-local equivalents.
          </p>
          <p className="text-foreground">
            Open your coding agent (Claude, Cursor, Codex, Gemini, Opencode).
          </p>
          <ul className="text-foreground space-y-2 list-disc pl-5">
            <li>
              <code className="font-mono text-[12px]">/{safeCommandName}</code>{" "}
              to browse/search or run an installed skill directly.
            </li>
            <li>
              <code className="font-mono text-[12px]">
                /{updateSkillCommandName}
              </code>{" "}
              to refresh.
            </li>
            <li>
              Invoke a locally cached skill like for example {" "}
              <code className="font-mono text-[12px]">/create-ci-pipeline</code>.
            </li>
          </ul>
        </CardContent>
      </Card>

      <p className="text-xs text-muted-foreground border border-dashed border-border rounded-md p-3">
        <strong>Skill Scanner</strong> (hub ingest) uses{" "}
        <a
          className="text-primary underline"
          href="https://github.com/cisco-ai-defense/skill-scanner"
          target="_blank"
          rel="noreferrer"
        >
          Skill Scanner
        </a>
        , provided by <strong>Cisco AI Defense</strong>. Scanner results are best-effort and do not
        guarantee security.
      </p>

      {/*
        Quick-install modal: lets the user pick agent + scope and grab a
        single curl-pipe-bash one-liner without scrolling through Steps 2
        and 3. State (selectedAgent, selectedScope) is shared with Step 3,
        so picking here also pre-selects the detailed install card below.

        The same constraints as the inline bulk action bar apply:
        - fragment agents (Continue) cannot use the bulk script
        - the agent must support the chosen scope (radios disable themselves)
        - the API key is taken from `mintedKey` (just-minted on this page)
          and falls back to a placeholder so the user knows where to paste
      */}
      <Dialog open={quickInstallOpen} onOpenChange={setQuickInstallOpen}>
        <DialogContent className="sm:max-w-4xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Zap className="h-5 w-5 text-primary" />
              Quick install
            </DialogTitle>
            <DialogDescription>
              We&rsquo;ll generate a one-line installer that fetches skills
              from your catalog and writes Claude-native plus shared SKILL.md
              copies that work in <strong>Claude Code</strong>, <strong>Cursor</strong>,
              {" "}
              <strong>Codex CLI</strong>, <strong>Gemini CLI</strong>, and
              {" "}
              <strong>opencode</strong>: no per-agent setup
              required.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4 text-sm">
            {/* Agent picker dropped: the install writes Claude-native skills
                plus the shared ~/.agents/skills tree, with Claude hook
                integration kept under ~/.claude/hooks. The picker only used to
                affect the launch-guide footer + success-card label;
                see the new "compatibility" section after install for
                the unified launch instructions. */}

            {/* Scope picker. */}
            <div>
              <label className="text-xs font-medium text-muted-foreground">
                Where to install?
              </label>
              <div className="mt-1 flex flex-col gap-2">
                {(["user", "project"] as InstallScope[]).map((s) => {
                  const supported = scopesAvailable.includes(s);
                  const pathsRaw = liveSkills?.install_paths?.[s];
                  const paths: string[] = Array.isArray(pathsRaw)
                    ? (pathsRaw as string[])
                    : pathsRaw
                      ? [pathsRaw as unknown as string]
                      : [];
                  const isSelected = selectedScope === s;
                  const labelText =
                    s === "user"
                      ? "User-wide (reused across all projects)"
                      : "Project-local (committed with this repo)";
                  return (
                    <label
                      key={s}
                      className={`flex items-start gap-3 text-xs rounded-md border px-3 py-2 transition-colors ${
                        supported
                          ? `cursor-pointer hover:bg-muted/50 ${
                              isSelected
                                ? "border-primary/60 bg-primary/5"
                                : "border-border/60"
                            }`
                          : "cursor-not-allowed opacity-50 border-border/40"
                      }`}
                    >
                      <input
                        type="radio"
                        name="quick-install-scope"
                        value={s}
                        checked={isSelected}
                        disabled={!supported}
                        onChange={() =>
                          supported && setSelectedScope(s)
                        }
                        className="mt-0.5"
                      />
                      <span className="flex-1 leading-relaxed">
                        <span className="block font-medium text-foreground">
                          {labelText}
                        </span>
                        {paths.length > 0 ? (
                          <span className="block mt-0.5 space-y-0.5">
                            {paths.map((p) => (
                              <code
                                key={p}
                                className="block text-[11px] text-muted-foreground font-mono"
                              >
                                {p.replace(
                                  new RegExp(`/${skillCommandName}/SKILL\\.md$`),
                                  "/<skill-name>/SKILL.md",
                                )}
                              </code>
                            ))}
                          </span>
                        ) : null}
                        {!supported ? (
                          <span className="block mt-0.5 text-[11px] text-muted-foreground italic">
                            Not supported by {agentLabel}.
                          </span>
                        ) : null}
                      </span>
                    </label>
                  );
                })}
              </div>
            </div>

            {/* Result snippet (or guidance when blocked). */}
            <div className="border-t border-border pt-4">
              {(() => {
                if (!selectedScope) {
                  return (
                    <p className="text-xs text-muted-foreground inline-flex items-start gap-1.5">
                      <AlertCircle className="h-3.5 w-3.5 mt-0.5 shrink-0" />
                      Pick an install scope above to generate the install
                      command.
                    </p>
                  );
                }
                // ?agent= omitted -- the route defaults to Claude, which
                // writes ~/.claude/skills plus shared ~/.agents/skills copies.
                // The install URL is composed from (in order):
                //   * scope (user/project) — drives ~/.agents vs ./.agents
                //   * command_name= — the branded/custom helper command
                //   * catalog_url= — the user-chosen catalog page from
                //                    the "Pick your skills" preview
                //   * mode=bulk-with-helpers — only when the helpers
                //                    checkbox is on. Without this the
                //                    server routes catalog_url= to
                //                    catalog-query mode which has
                //                    DO_HELPERS=0 (= no helper SKILL.md files).
                const installShUrl =
                  `${baseUrl}/api/skills/install.sh` +
                  `?scope=${encodeURIComponent(selectedScope)}` +
                  `&command_name=${encodeURIComponent(safeCommandName)}` +
                  `&catalog_url=${encodeURIComponent(catalogUrl)}` +
                  (quickInstallHelpers ? `&mode=bulk-with-helpers` : "");
                // Single-line install snippet. install.sh reads the API key
                // from ~/.config/caipe/config.json (Step 1), so we don't
                // bake the key into the curl. This keeps the snippet short,
                // copy-pasteable, and makes the "API key cannot be
                // recovered" message in the key card actually true — we
                // never echo the key into examples after minting it.
                //
                // The optional `--upgrade` / `--force` flag is appended via
                // `bash -s --` (the standard way of forwarding args to a
                // piped script). With no flag, install.sh's safe-default
                // refuses to overwrite existing files; `--upgrade` only
                // overwrites files we previously wrote (manifest-tracked);
                // `--force` clobbers anything in the target paths.
                const installFlag =
                  quickInstallMode === "upgrade"
                    ? "--upgrade"
                    : quickInstallMode === "force"
                      ? "--force"
                      : "";
                const oneLiner = installFlag
                  ? `curl -fsSL ${shellQuote(installShUrl)} | bash -s -- ${installFlag}`
                  : `curl -fsSL ${shellQuote(installShUrl)} | bash`;
                return (
                  <div className="space-y-3">
                    {/* API-key status row: clear gate above the snippet.
                        Green when ready, amber + inline Generate button
                        when missing. */}
                    {mintedKey ? (
                      <div className="rounded-md border border-emerald-500/30 bg-emerald-500/5 px-3 py-2 space-y-2">
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <div className="flex items-center gap-2 text-[11px] font-medium text-emerald-700 dark:text-emerald-400">
                            <CheckCircle2 className="h-3.5 w-3.5" />
                            API key minted.
                          </div>
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            className="h-7 gap-1.5 px-2 text-[11px]"
                            aria-label={
                              showMintedKey ? "Hide API key" : "Show API key"
                            }
                            onClick={() => setShowMintedKey((value) => !value)}
                          >
                            {showMintedKey ? (
                              <EyeOff className="h-3.5 w-3.5" />
                            ) : (
                              <Eye className="h-3.5 w-3.5" />
                            )}
                            {showMintedKey ? "Hide key" : "Show key"}
                          </Button>
                        </div>
                        <div className="text-[11px] text-amber-700 dark:text-amber-400 font-medium">
                          ⚠ Copy this command now — we cannot show this key
                          again.
                        </div>

                        {/* Single-shot bootstrap. Writes
                            ~/.config/caipe/config.json with chmod 600
                            then runs the install one-liner. The key is
                            embedded INSIDE a
                            single-quoted heredoc so bash doesn't try
                            to expand $... or backticks; both values
                            are JSON.stringify'd so any character is
                            safe inside the JSON string literal.
                            chmod 600 lands the key on disk readable
                            only by the owner. */}
                        {(() => {
                          const bootstrapLines = [
                            `mkdir -p ~/.config/caipe && \\`,
                            `cat > ~/.config/caipe/config.json <<'CAIPE_BOOTSTRAP_EOF'`,
                            `{`,
                            `  "base_url": ${JSON.stringify(baseUrl)},`,
                            `  "api_key": ${JSON.stringify(mintedKey)}`,
                            `}`,
                            `CAIPE_BOOTSTRAP_EOF`,
                            `chmod 600 ~/.config/caipe/config.json && \\`,
                            oneLiner,
                          ];
                          const bootstrapSnippet = bootstrapLines.join("\n");
                          const maskedBootstrapSnippet = [
                            ...bootstrapLines.slice(0, 4),
                            `  "api_key": ${JSON.stringify(maskSecret(mintedKey))}`,
                            ...bootstrapLines.slice(5),
                          ].join("\n");
                          return (
                            <div
                              className="space-y-1"
                              data-testid="quick-install-bootstrap-snippet"
                            >
                              <p className="text-[10px] uppercase tracking-wide text-muted-foreground font-semibold">
                                Write config + install in one shot{" "}
                                <span className="normal-case font-normal text-muted-foreground">
                                  (recommended for first-time setup)
                                </span>
                              </p>
                              <CopyableBlock
                                as="pre"
                                text={bootstrapSnippet}
                                displayText={
                                  showMintedKey
                                    ? bootstrapSnippet
                                    : maskedBootstrapSnippet
                                }
                                ariaLabel="Copy bootstrap install snippet"
                                className="break-all"
                              />
                              <p className="text-[10px] text-muted-foreground leading-snug">
                                Writes{" "}
                                <code className="font-mono">
                                  ~/.config/caipe/config.json
                                </code>{" "}
                                with{" "}
                                <code className="font-mono">chmod 600</code>{" "}
                                (owner-readable only), then runs the
                                install. The key lives in the single-
                                quoted heredoc so bash doesn&rsquo;t
                                expand it; the only place it lands on
                                disk is the config file you just
                                created.
                              </p>
                            </div>
                          );
                        })()}
                      </div>
                    ) : (
                      <div
                        className="rounded-md border border-amber-500/30 bg-amber-500/5 px-3 py-2 flex flex-wrap items-center gap-3"
                        data-testid="quick-install-api-key-gate"
                      >
                        <Button
                          type="button"
                          variant="default"
                          size="sm"
                          disabled={mintBusy}
                          onClick={() => void handleMint()}
                          className="gap-1.5 shrink-0"
                        >
                          {mintBusy ? (
                            <Loader2 className="h-3.5 w-3.5 animate-spin" />
                          ) : null}
                          Generate Install Command with API Key
                        </Button>
                        <div className="flex flex-col gap-1 text-[11px] text-amber-700 dark:text-amber-400 flex-1 min-w-[200px]">
                          <div className="flex items-center gap-2">
                            <AlertCircle className="h-3.5 w-3.5 shrink-0" />
                            <span className="font-medium">
                              Generate an API key first to install skills.
                            </span>
                          </div>
                          {mintError ? (
                            <p
                              className="text-destructive font-medium pl-5"
                              data-testid="quick-install-mint-error"
                            >
                              {mintError}
                            </p>
                          ) : null}
                        </div>
                      </div>
                    )}

                    <details
                      className="rounded-md border border-border bg-muted/20 px-3 py-2"
                      data-testid="quick-install-advanced-options"
                    >
                      <summary className="cursor-pointer select-none text-[11px] font-medium text-foreground flex items-center gap-1">
                        <ChevronRight className="h-3 w-3 transition-transform [details[open]_&]:rotate-90" />
                        Advanced install options
                      </summary>
                      <div className="mt-2 space-y-3">
                    {/* Install options. Single checkbox controlling
                        whether the rendered one-liner asks install.sh
                        to also drop the branded browse and refresh
                        helper SKILL.md files (the meta-helpers that
                        let the user search and refresh the catalog
                        from inside Claude Code, Cursor, etc.).

                        Default ON because the previous default URL
                        silently skipped these helpers — ?catalog_url=
                        forced mode=catalog-query on the server, which
                        has DO_HELPERS=0. Users had no UI affordance
                        to discover the gap. */}
                    <div
                      className="rounded-md border border-border bg-muted/30 px-3 py-2 space-y-1.5"
                      data-testid="quick-install-helpers-toggle"
                    >
                      <p className="text-[11px] font-medium text-foreground">
                        Install options
                      </p>
                      <label className="flex items-start gap-2 cursor-pointer">
                        <input
                          type="checkbox"
                          checked={quickInstallHelpers}
                          onChange={(e) =>
                            setQuickInstallHelpers(e.target.checked)
                          }
                          className="rounded border-border mt-0.5"
                          data-testid="quick-install-helpers"
                        />
                        <span className="text-xs">
                          <span className="font-medium">
                            Install{" "}
                            <code className="font-mono">/{safeCommandName}</code>{" "}
                            and{" "}
                            <code className="font-mono">
                              /{updateSkillCommandName}
                            </code>{" "}
                            helpers
                          </span>
                          <span className="block text-[11px] text-muted-foreground mt-0.5">
                            Adds two slash commands to your skill tree:{" "}
                            <code className="font-mono">/{safeCommandName}</code>{" "}
                            (search and run any catalog skill) and{" "}
                            <code className="font-mono">
                              /{updateSkillCommandName}
                            </code>{" "}
                            (refresh on-disk skills from the live
                            catalog). Recommended — leave on unless
                            you only want the bulk skill files.
                          </span>
                        </span>
                      </label>
                    </div>

                    {/* Install-mode toggles. Modeled as two checkboxes
                        (matching the include_content pattern in the Live
                        URL builder above) but mutually exclusive — picking
                        one unchecks the other. install.sh treats
                        --upgrade and --force as a precedence chain (force
                        wins), so two independent toggles would let the UI
                        ask for "upgrade AND force" while the script
                        silently ignored upgrade. The radio-in-checkbox-
                        clothing keeps the visual affordance the user
                        asked for without the footgun. */}
                    <div
                      className="rounded-md border border-border bg-muted/30 px-3 py-2 space-y-1.5"
                      data-testid="quick-install-mode-toggles"
                    >
                      <p className="text-[11px] font-medium text-foreground">
                        Overwrite policy
                      </p>
                      <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 text-xs">
                        <label className="flex items-center gap-2 cursor-pointer">
                          <input
                            type="checkbox"
                            checked={quickInstallMode === "upgrade"}
                            onChange={(e) =>
                              setQuickInstallMode(
                                e.target.checked ? "upgrade" : "default",
                              )
                            }
                            className="rounded border-border"
                            data-testid="quick-install-upgrade"
                          />
                          <span className="font-mono text-[11px]">
                            --upgrade
                          </span>
                          <span className="text-muted-foreground text-[11px]">
                            (refresh files this installer wrote before)
                          </span>
                        </label>
                        <label className="flex items-center gap-2 cursor-pointer">
                          <input
                            type="checkbox"
                            checked={quickInstallMode === "force"}
                            onChange={(e) =>
                              setQuickInstallMode(
                                e.target.checked ? "force" : "default",
                              )
                            }
                            className="rounded border-border"
                            data-testid="quick-install-force"
                          />
                          <span className="font-mono text-[11px]">
                            --force
                          </span>
                          <span className="text-muted-foreground text-[11px]">
                            (clobber any existing files at the target
                            paths)
                          </span>
                        </label>
                      </div>
                      <p className="text-[10px] text-muted-foreground">
                        Mutually exclusive — picking one clears the
                        other. Leave both off for the safe default
                        (existing files untouched).
                      </p>
                    </div>
                      </div>
                    </details>

                  </div>
                );
              })()}
            </div>

          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}

/**
 * Reusable copy-to-clipboard wrapper around a block of text. Renders the
 * content as `<pre>` (default) or `<code>` (`as="code"`) inside a `relative
 * group` div with an absolutely-positioned ghost button that flips between
 * a `Copy` and `Check` icon for ~2s after a successful copy.
 *
 * Each instance owns its own `copied` state so we can have many copyable
 * blocks on the same page (notably one per fenced code block in the
 * launch-guide markdown) without sharing state.
 */
function CopyableBlock({
  text,
  displayText,
  as = "pre",
  className = "",
  ariaLabel = "Copy to clipboard",
}: {
  text: string;
  displayText?: string;
  as?: "pre" | "code";
  className?: string;
  ariaLabel?: string;
}) {
  const [copied, setCopied] = useState(false);
  const handleCopy = () => {
    void navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };
  // Keep visual parity with the existing inline copy blocks: muted bg,
  // rounded-md, small padding, room on the right for the button.
  const baseClasses =
    as === "code"
      ? `block rounded-md bg-muted px-3 py-2 pr-10 text-xs break-all ${className}`
      : `rounded-md bg-muted p-3 pr-10 text-xs leading-relaxed overflow-x-auto whitespace-pre-wrap ${className}`;
  return (
    <div className="relative group">
      {as === "code" ? (
        <code className={baseClasses}>{displayText ?? text}</code>
      ) : (
        <pre className={baseClasses}>{displayText ?? text}</pre>
      )}
      <Button
        type="button"
        variant="ghost"
        size="icon"
        aria-label={ariaLabel}
        className="absolute top-1 right-1 h-7 w-7 opacity-0 group-hover:opacity-100 transition-opacity"
        onClick={handleCopy}
      >
        {copied ? (
          <Check className="h-3.5 w-3.5 text-green-500" />
        ) : (
          <Copy className="h-3.5 w-3.5" />
        )}
      </Button>
    </div>
  );
}
