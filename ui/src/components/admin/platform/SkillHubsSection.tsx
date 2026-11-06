"use client";

import { getErrorMessage } from "@/lib/error-utils";

import { detectHubProviderFromUrl } from "@/app/api/skill-hubs/_lib/normalize";
import { ScanAllDialog } from "@/components/skills/ScanAllDialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card,CardContent,CardDescription,CardHeader,CardTitle } from "@/components/ui/card";
import { GithubIcon,GitlabIcon } from "@/components/ui/icons";
import { startCrawlStream } from "@/lib/crawl-stream-client";
import { readJson,readJsonOrError } from "@/lib/safe-json";
import { cn } from "@/lib/utils";
import { useCrawlConsoleStore } from "@/store/crawl-console-store";
import { AlertCircle,AlertTriangle,CheckCircle2,Globe,ListFilter,Loader2,Plus,RefreshCcw,Search,ShieldAlert,Trash2,X,Zap } from "lucide-react";
import { useCallback,useEffect,useState } from "react";

type HubType = "github" | "gitlab";

const HUB_TYPE_HINTS: Record<HubType, {
  label: string;
  repoLabel: string;
  repoPlaceholder: string;
  credentialEnv: string;
}> = {
  github: {
    label: "GitHub",
    repoLabel: "GitHub repository",
    repoPlaceholder: "owner/repo or https://github.com/owner/repo",
    credentialEnv: "GITHUB_TOKEN",
  },
  gitlab: {
    label: "GitLab",
    repoLabel: "GitLab project",
    repoPlaceholder: "group/project, group/sub/project, or https://gitlab.com/...",
    credentialEnv: "GITLAB_TOKEN",
  },
};

/**
 * Mirror of `HubLastCrawlTruncation` in `lib/hub-crawl.ts`. Kept as a
 * client-side type so the admin section can render warnings without
 * pulling the server-only crawler module.
 */
type HubLastCrawlTruncation =
  | { kind: "ok"; pages_walked: number }
  | { kind: "platform"; pages_walked: number; reason: string }
  | { kind: "cap"; pages_walked: number; cap: number };

interface SkillHub {
  id: string;
  type: string;
  location: string;
  enabled: boolean;
  credentials_ref: string | null;
  labels?: string[];
  /** Team ids or slugs granted use access to every skill from this hub. */
  shared_with_teams?: string[];
  /** Optional path-prefix allow-list for hub crawl (FR-020). */
  include_paths?: string[];
  revision?: string;
  entry_paths?: string[];
  /** GitLab-only per-hub override of the recursive-tree page cap. */
  max_tree_pages?: number;
  last_success_at: number | null;
  last_failure_at: number | null;
  last_failure_message: string | null;
  /** Truncation summary from the most recent successful crawl. */
  last_truncation?: HubLastCrawlTruncation;
  created_at: string;
  updated_at: string;
  /** Set when skill-scanner runs on hub ingest (backend). */
  last_skill_scan_at?: number | null;
  last_skill_scan_exit_code?: number | null;
  last_skill_scan_max_severity?: string | null;
  last_skill_scan_blocked?: boolean | null;
  /** Per-skill scan-state aggregates from /api/skill-hubs (Option C nudge). */
  skills_count?: number;
  scan_unscanned_count?: number;
  scan_flagged_count?: number;
  scan_passed_count?: number;
}

interface SkillHubsSectionProps {
  isAdmin: boolean;
}

export function SkillHubsSection({ isAdmin }: SkillHubsSectionProps) {
  const [hubs, setHubs] = useState<SkillHub[]>([]);
  const [loading, setLoading] = useState(true);
  const [showAddForm, setShowAddForm] = useState(false);
  const [formType, setFormType] = useState<HubType>("github");
  const [formLocation, setFormLocation] = useState("");
  // Inline notice shown when the location URL's host clearly
  // identifies a provider that disagrees with the currently-selected
  // source pill — set by `handleLocationChange` and cleared whenever
  // the user manually flips the source or types a non-URL location.
  // Stores the *target* provider so the message can name it.
  const [autoSwitchedTo, setAutoSwitchedTo] = useState<HubType | null>(null);
  const [formCredRef, setFormCredRef] = useState("");
  const [formLabels, setFormLabels] = useState("");
  const [formTeamRefs, setFormTeamRefs] = useState("");
  // One prefix per line; empty lines are dropped before submit. FR-020.
  const [formIncludePaths, setFormIncludePaths] = useState("");
  const [formRevision, setFormRevision] = useState("");
  const [formEntryPaths, setFormEntryPaths] = useState("");
  // Per-hub override of the GitLab tree-listing page cap. Empty string
  // → omit from request → server falls back to GITLAB_MAX_TREE_PAGES.
  // Numeric strings are validated on submit.
  const [formMaxTreePages, setFormMaxTreePages] = useState("");
  // Whether the Add Hub form's "Advanced" panel is expanded. Hidden by
  // default so the form stays simple for the common case.
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [adding, setAdding] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [togglingId, setTogglingId] = useState<string | null>(null);
  const [recrawlingId, setRecrawlingId] = useState<string | null>(null);
  const [recrawlResult, setRecrawlResult] = useState<Record<string, number>>({});
  const [error, setError] = useState<string | null>(null);
  const [crawlLoading, setCrawlLoading] = useState(false);
  const [crawlPaths, setCrawlPaths] = useState<string[]>([]);
  const [crawlPreview, setCrawlPreview] = useState<{ path: string; name: string; description: string }[]>([]);
  // Bulk-scan dialog scoped to a single hub via the per-hub "Scan now"
  // nudge. `null` means the dialog is closed.
  const [scanHubId, setScanHubId] = useState<string | null>(null);

  const loadHubs = useCallback(async () => {
    try {
      const res = await fetch("/api/skill-hubs");
      if (!res.ok) {
        if (res.status === 403) {
          setError("Admin access required to manage skill hubs.");
          return;
        }
        throw new Error(`Failed to load skill hubs (HTTP ${res.status})`);
      }
      // ``readJson`` surfaces a useful error if the response is HTML
      // (e.g. an upstream proxy 504) instead of the opaque
      // ``Unexpected token '<', "<!DOCTYPE "...`` parse failure.
      const data = await readJson<{ hubs?: SkillHub[] }>(res);
      setHubs(data.hubs || []);
      setError(null);
    } catch (err) {
      setError(getErrorMessage(err, "") || "Failed to load skill hubs");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadHubs();
  }, [loadHubs]);

  const parseIncludePaths = (raw: string): string[] =>
    raw
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);

  const parseCommaList = (raw: string): string[] =>
    Array.from(
      new Set(
        raw
          .split(",")
          .map((value) => value.trim())
          .filter(Boolean),
      ),
    );

  /**
   * Parse the "Max tree pages (advanced)" input into a number for the
   * POST body, returning `undefined` when empty (so the server falls
   * back to its env-var default). Surfaces a validation error inline
   * instead of letting the server reject the whole form — friendlier
   * UX for an "advanced" knob most admins will never touch.
   */
  const parseMaxTreePages = (raw: string): number | undefined | "invalid" => {
    const trimmed = raw.trim();
    if (trimmed === "") return undefined;
    const n = Number(trimmed);
    if (!Number.isFinite(n) || n <= 0 || Math.floor(n) !== n) return "invalid";
    return n;
  };

  const handleAdd = async () => {
    if (!formLocation.trim()) return;
    setAdding(true);
    setError(null);
    try {
      const labels = formLabels.split(",").map((l) => l.trim().toLowerCase()).filter(Boolean);
      const includePaths = parseIncludePaths(formIncludePaths);
      const teamRefs = parseCommaList(formTeamRefs);
      let maxTreePages: number | undefined;
      if (formType === "gitlab") {
        const parsed = parseMaxTreePages(formMaxTreePages);
        if (parsed === "invalid") {
          throw new Error(
            "Max tree pages must be a positive integer (or empty for the default).",
          );
        }
        maxTreePages = parsed;
      }
      const res = await fetch("/api/skill-hubs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          type: formType,
          location: formLocation.trim(),
          credentials_ref: formCredRef.trim() || null,
          labels: labels.length > 0 ? labels : undefined,
          shared_with_teams: teamRefs.length > 0 ? teamRefs : undefined,
          include_paths: includePaths.length > 0 ? includePaths : undefined,
          max_tree_pages: maxTreePages,
          ...(formType === "github" ? { revision: formRevision.trim() || undefined, entry_paths: formEntryPaths.split("\n").map(p => p.trim()).filter(Boolean) } : {}),
          enabled: true,
        }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || data.message || `Failed to register hub (${res.status})`);
      }
      setFormType("github");
      setFormLocation("");
      setFormCredRef("");
      setFormLabels("");
      setFormTeamRefs("");
      setFormIncludePaths("");
      setFormRevision(""); setFormEntryPaths("");
      setFormMaxTreePages("");
      setShowAdvanced(false);
      setShowAddForm(false);
      await loadHubs();
    } catch (err) {
      setError(getErrorMessage(err, ""));
    } finally {
      setAdding(false);
    }
  };

  const handleDelete = async (hubId: string) => {
    if (!confirm("Are you sure you want to remove this skill hub?")) return;
    setDeletingId(hubId);
    try {
      const res = await fetch(`/api/skill-hubs/${hubId}`, { method: "DELETE" });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || "Failed to delete hub");
      }
      setHubs(hubs.filter((h) => h.id !== hubId));
    } catch (err) {
      setError(getErrorMessage(err, ""));
    } finally {
      setDeletingId(null);
    }
  };

  const handleToggle = async (hub: SkillHub) => {
    setTogglingId(hub.id);
    try {
      const res = await fetch(`/api/skill-hubs/${hub.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: !hub.enabled }),
      });
      if (!res.ok) throw new Error("Failed to update hub");
      await loadHubs();
    } catch (err) {
      setError(getErrorMessage(err, ""));
    } finally {
      setTogglingId(null);
    }
  };

  /**
   * Inline-PATCH the per-hub `max_tree_pages` cap from the row warning's
   * "Edit cap" CTA. We use a plain `prompt()` to keep the surface tiny —
   * a full inline editor on the row would dwarf the rest of the
   * Skill Hubs admin section.
   */
  const handleEditMaxTreePages = async (hub: SkillHub) => {
    const current = hub.max_tree_pages ? String(hub.max_tree_pages) : "";
    const next = window.prompt(
      `Max tree pages for ${hub.location}\n\n` +
        `Each page is up to 100 entries. Default is 50 (~5,000 entries). ` +
        `Hard ceiling: 500.\n\nLeave empty to clear the override.`,
      current,
    );
    if (next === null) return; // user cancelled

    const trimmed = next.trim();
    let body: Record<string, unknown>;
    if (trimmed === "") {
      body = { max_tree_pages: null };
    } else {
      const n = Number(trimmed);
      if (!Number.isFinite(n) || n <= 0 || Math.floor(n) !== n) {
        setError("Max tree pages must be a positive integer.");
        return;
      }
      body = { max_tree_pages: n };
    }
    try {
      const res = await fetch(`/api/skill-hubs/${hub.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || data.message || "Failed to update hub");
      }
      await loadHubs();
    } catch (err) {
      setError(err instanceof Error ? getErrorMessage(err, "") : "Failed to update hub");
    }
  };

  /**
   * Inline-PATCH the hub's `include_paths` from the truncation row's
   * CTA. The form-mode editor is the canonical way to edit paths; this
   * is the one-tap shortcut for the truncation case.
   */
  const handleEditIncludePaths = async (hub: SkillHub) => {
    const current = (hub.include_paths ?? []).join("\n");
    const next = window.prompt(
      `Include paths for ${hub.location}\n\n` +
        `One prefix per line. Trailing slashes are added automatically. ` +
        `Leave empty to clear and crawl the entire repo.`,
      current,
    );
    if (next === null) return;
    const paths = next
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter(Boolean);
    try {
      const res = await fetch(`/api/skill-hubs/${hub.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ include_paths: paths }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || data.message || "Failed to update hub");
      }
      await loadHubs();
    } catch (err) {
      setError(err instanceof Error ? getErrorMessage(err, "") : "Failed to update hub");
    }
  };

  const handleEditTeams = async (hub: SkillHub) => {
    const current = (hub.shared_with_teams ?? []).join(", ");
    const next = window.prompt(
      `Team access for ${hub.location}\n\n` +
        `Comma-separated team slugs or IDs. Leave empty to clear automatic grants.`,
      current,
    );
    if (next === null) return;
    const teamRefs = parseCommaList(next);
    try {
      const res = await fetch(`/api/skill-hubs/${hub.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ shared_with_teams: teamRefs }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || data.message || `Failed to update teams (${res.status})`);
      }
      await loadHubs();
    } catch (err) {
      setError(getErrorMessage(err, "") || "Failed to update hub teams");
    }
  };

  const handleRecrawl = async (hubId: string) => {
    setRecrawlingId(hubId);
    try {
      // Use the streaming branch so the live console dialog
      // tracks the run automatically. We also derive the
      // skills_count from the terminal `done` event so the
      // existing per-row "Refreshed: N skills" badge stays
      // accurate. Operators who don't open the dialog still see
      // the same UI they're used to; operators who DO get a full
      // network trace + scope hints inline.
      const hub = hubs.find((h) => h.id === hubId);
      const label = hub
        ? `Refresh — ${hub.location}`
        : `Refresh — ${hubId}`;
      const { runId } = startCrawlStream({
        url: `/api/skill-hubs/${hubId}/refresh`,
        label,
        kind: "refresh",
      });
      // Poll the store until the run terminates, then read the
      // skills count from the `done` event. This is intentionally
      // simple polling -- subscribing to the store would couple
      // SkillHubsSection to zustand internals for marginal value.
      // Cap the wait so a runaway crawl can't pin the UI forever
      // (the underlying stream keeps running regardless).
      const deadline = Date.now() + 5 * 60_000; // 5 minutes
       
      while (true) {
        const run = useCrawlConsoleStore
          .getState()
          .runs.find((r) => r.id === runId);
        if (!run || run.status !== "running") break;
        if (Date.now() > deadline) {
          throw new Error(
            "Recrawl is still running after 5 minutes — check the Crawl Console for live progress.",
          );
        }
        await new Promise((res) => setTimeout(res, 200));
      }
      const finalRun = useCrawlConsoleStore
        .getState()
        .runs.find((r) => r.id === runId);
      if (!finalRun) return;
      if (finalRun.status === "succeeded") {
        const done = finalRun.events.find((e) => e.type === "done");
        if (done?.type === "done") {
          setRecrawlResult((prev) => ({ ...prev, [hubId]: done.skills }));
        }
      } else {
        const errEvent = finalRun.events.find((e) => e.type === "error");
        const errMsg =
          errEvent?.type === "error"
            ? errEvent.message
            : `Recrawl failed (${finalRun.status})`;
        throw new Error(errMsg);
      }
    } catch (err) {
      setError(getErrorMessage(err, ""));
    } finally {
      setRecrawlingId(null);
    }
  };

  const handleRefresh = async () => {
    try {
      await fetch("/api/skills?include_content=false");
    } catch {}
    await loadHubs();
  };

  // Surface preview-time truncation so the operator sees "you'll need
  // a higher cap / include_paths" before persisting the hub. Cleared on
  // every preview attempt so a follow-up preview that fits doesn't keep
  // a stale warning visible.
  const [crawlTruncation, setCrawlTruncation] = useState<HubLastCrawlTruncation | null>(null);

  const handleCrawlPreview = async () => {
    if (!formLocation.trim()) return;
    setCrawlLoading(true);
    setError(null);
    setCrawlPaths([]);
    setCrawlPreview([]);
    setCrawlTruncation(null);
    try {
      let maxTreePages: number | undefined;
      if (formType === "gitlab") {
        const parsed = parseMaxTreePages(formMaxTreePages);
        if (parsed === "invalid") {
          throw new Error(
            "Max tree pages must be a positive integer (or empty for the default).",
          );
        }
        maxTreePages = parsed;
      }
      // Fire a streaming run in parallel so the global Crawl
      // Console dialog can render live progress with full network
      // detail. The console run is purely observational --
      // ``handleCrawlPreview`` stays the source of truth for the
      // inline "Discovered SKILL.md paths" list because the form
      // already renders its results from the JSON-shape response.
      // We accept the second request -- preview is an explicit
      // admin action, not a hot path -- in exchange for not having
      // to re-derive the preview list from streamed events. If
      // this becomes a perf concern, switch the form to consume
      // the stream's skill_found events instead.
      startCrawlStream({
        url: "/api/skill-hubs/crawl",
        body: {
          type: formType,
          location: formLocation.trim(),
          credentials_ref: formCredRef.trim() || null,
          max_tree_pages: maxTreePages,
          ...(formType === "github" ? { revision: formRevision.trim() || undefined, entry_paths: formEntryPaths.split("\n").map(p => p.trim()).filter(Boolean) } : {}),
        },
        label: `Preview — ${formLocation.trim()}`,
        kind: "preview",
      });
      const res = await fetch("/api/skill-hubs/crawl", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          type: formType,
          location: formLocation.trim(),
          credentials_ref: formCredRef.trim() || null,
          max_tree_pages: maxTreePages,
          ...(formType === "github" ? { revision: formRevision.trim() || undefined, entry_paths: formEntryPaths.split("\n").map(p => p.trim()).filter(Boolean) } : {}),
        }),
      });
      const parsed = await readJsonOrError<{
        message?: string;
        detail?: { message?: string };
        error?: string;
        paths?: string[];
        skills_preview?: { path: string; name: string; description: string }[];
        truncation?: HubLastCrawlTruncation;
      }>(res);
      if (!res.ok) {
        if (parsed.ok === true) {
          const d = parsed.data;
          throw new Error(d.message || d.detail?.message || d.error || `Crawl failed (HTTP ${res.status})`);
        }
        // parsed.ok === false here, so .preview/.status/.error are present.
        const detail = parsed.preview ? ` Body starts with: ${parsed.preview.slice(0, 120)}` : "";
        throw new Error(`Crawl failed (HTTP ${parsed.status}): ${parsed.error}${detail}`);
      }
      if (parsed.ok === false) {
        throw new Error(`Crawl returned non-JSON response: ${parsed.error}`);
      }
      const data = parsed.data;
      setCrawlPaths(data.paths || []);
      setCrawlPreview(data.skills_preview || []);
      if (data.truncation && data.truncation.kind && data.truncation.kind !== "ok") {
        setCrawlTruncation(data.truncation as HubLastCrawlTruncation);
      }
    } catch (err: unknown) {
      setError(err instanceof Error ? getErrorMessage(err, "") : "Crawl preview failed");
    } finally {
      setCrawlLoading(false);
    }
  };

  if (loading) {
    return (
      <Card>
        <CardContent className="flex items-center justify-center py-8">
          <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between">
        <div>
          <CardTitle className="flex items-center gap-2">
            <Globe className="h-5 w-5" />
            Skill Hubs
          </CardTitle>
          <CardDescription>
            Register external GitHub or GitLab repositories as skill sources. Skills from hubs are merged into the catalog.
          </CardDescription>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={handleRefresh} className="gap-1">
            <RefreshCcw className="h-3.5 w-3.5" />
            Refresh
          </Button>
          {isAdmin && (
            <Button size="sm" onClick={() => setShowAddForm(!showAddForm)} className="gap-1">
              <Plus className="h-3.5 w-3.5" />
              Add Hub
            </Button>
          )}
        </div>
      </CardHeader>
      <CardContent>
        {error && (
          <div className="mb-4 p-3 rounded-lg bg-destructive/10 border border-destructive/20 text-sm text-destructive flex items-center gap-2">
            <AlertCircle className="h-4 w-4 shrink-0" />
            {error}
            <Button variant="ghost" size="sm" className="ml-auto h-6 w-6 p-0" onClick={() => setError(null)}>
              <X className="h-3 w-3" />
            </Button>
          </div>
        )}

        {showAddForm && isAdmin && (
          <div className="mb-4 p-4 border border-border rounded-lg bg-muted/30 space-y-3">
            <div>
              <label className="text-xs font-medium text-muted-foreground block mb-1">
                Source
              </label>
              <div
                role="radiogroup"
                aria-label="Hub source"
                className="inline-flex items-center rounded-md border border-border bg-background p-0.5 text-xs"
              >
                {(Object.keys(HUB_TYPE_HINTS) as HubType[]).map((t) => (
                  <button
                    key={t}
                    type="button"
                    role="radio"
                    aria-checked={formType === t}
                    onClick={() => {
                      setFormType(t);
                      setAutoSwitchedTo(null);
                    }}
                    className={cn(
                      "inline-flex items-center gap-1.5 px-3 py-1.5 rounded font-medium transition-colors",
                      formType === t
                        ? "bg-primary/10 text-primary"
                        : "text-muted-foreground hover:text-foreground",
                    )}
                  >
                    {t === "github" ? (
                      <GithubIcon className="h-3.5 w-3.5" />
                    ) : (
                      <GitlabIcon className="h-3.5 w-3.5" />
                    )}
                    {HUB_TYPE_HINTS[t].label}
                  </button>
                ))}
              </div>
            </div>
            <div>
              <label className="text-xs font-medium text-muted-foreground">
                {HUB_TYPE_HINTS[formType].repoLabel}
              </label>
              <input
                type="text"
                value={formLocation}
                onChange={(e) => {
                  const next = e.target.value;
                  setFormLocation(next);
                  // Auto-switch the source pill when the typed/pasted
                  // value is a URL whose host clearly identifies the
                  // *other* provider. This stops the
                  // "GitHub selected + gitlab.com URL pasted" pitfall
                  // from silently producing a misleading
                  // `api.github.com/repos/<gitlab-group>/<sub>` 404
                  // (GitHub URL parsing in the legacy preview path
                  // truncates to the first two path segments without
                  // checking the host). `detectHubProviderFromUrl`
                  // returns null for non-URLs / unknown hosts, so
                  // typing `owner/repo` directly never triggers a
                  // switch and the user keeps full manual control via
                  // the source pill.
                  const detected = detectHubProviderFromUrl(next);
                  if (detected && detected !== formType) {
                    setFormType(detected);
                    setAutoSwitchedTo(detected);
                  } else if (!detected) {
                    // User cleared / typed something that's no longer
                    // a recognizable URL — drop the stale notice.
                    setAutoSwitchedTo(null);
                  }
                }}
                placeholder={HUB_TYPE_HINTS[formType].repoPlaceholder}
                className="mt-1 w-full px-3 py-2 text-sm bg-background border border-border rounded-md focus:outline-none focus:ring-2 focus:ring-primary/50"
              />
              {autoSwitchedTo && (
                <p
                  role="status"
                  aria-live="polite"
                  className="text-xs text-amber-600 dark:text-amber-400 mt-1 flex items-center gap-1.5"
                >
                  <AlertCircle className="h-3 w-3 shrink-0" />
                  Detected {HUB_TYPE_HINTS[autoSwitchedTo].label} URL — switched
                  source to {HUB_TYPE_HINTS[autoSwitchedTo].label}.
                </p>
              )}
              {formType === "gitlab" && (
                <p className="text-xs text-muted-foreground mt-1">
                  Subgroup nesting is preserved (e.g. <code className="font-mono">gitlab-org/ai/skills</code>).
                  Self-hosted GitLab via <code className="font-mono">GITLAB_API_URL</code>.
                </p>
              )}
            </div>
            <div>
              <label className="text-xs font-medium text-muted-foreground">Credentials Env Var (optional)</label>
              <input
                type="text"
                value={formCredRef}
                onChange={(e) => setFormCredRef(e.target.value)}
                placeholder={
                  formType === "github"
                    ? "e.g. GITHUB_TOKEN_PRIVATE (env var name holding token)"
                    : "e.g. GITLAB_TOKEN_PRIVATE (env var name holding token)"
                }
                className="mt-1 w-full px-3 py-2 text-sm bg-background border border-border rounded-md focus:outline-none focus:ring-2 focus:ring-primary/50"
              />
              <p className="text-xs text-muted-foreground mt-1">
                Name of the environment variable holding a {HUB_TYPE_HINTS[formType].label} token. Falls back to{" "}
                <code className="font-mono">{HUB_TYPE_HINTS[formType].credentialEnv}</code> if empty.
                {formType === "gitlab"
                  ? " Public projects work without a token."
                  : ""}
              </p>
            </div>
            <div>
              <label className="text-xs font-medium text-muted-foreground">Labels (optional, comma-separated)</label>
              <input
                type="text"
                value={formLabels}
                onChange={(e) => setFormLabels(e.target.value)}
                placeholder="e.g. security, platform, networking"
                className="mt-1 w-full px-3 py-2 text-sm bg-background border border-border rounded-md focus:outline-none focus:ring-2 focus:ring-primary/50"
              />
              <p className="text-xs text-muted-foreground mt-1">
                Labels are merged into every skill&apos;s tags from this hub.
              </p>
            </div>
            <div>
              <label className="text-xs font-medium text-muted-foreground">
                Team access (optional, comma-separated team slugs or IDs)
              </label>
              <input
                type="text"
                value={formTeamRefs}
                onChange={(e) => setFormTeamRefs(e.target.value)}
                placeholder="e.g. platform, sre"
                className="mt-1 w-full px-3 py-2 text-sm bg-background border border-border rounded-md focus:outline-none focus:ring-2 focus:ring-primary/50"
              />
              <p className="text-xs text-muted-foreground mt-1">
                Every skill crawled from this hub is granted to these teams on refresh and migration backfill.
              </p>
            </div>
            <div>
              <label
                htmlFor="hub-include-paths"
                className="text-xs font-medium text-muted-foreground"
              >
                Include paths (optional)
              </label>
              <textarea
                id="hub-include-paths"
                value={formIncludePaths}
                onChange={(e) => setFormIncludePaths(e.target.value)}
                placeholder={"skills/\nagents/observability/skills/"}
                rows={3}
                className="mt-1 w-full px-3 py-2 text-sm font-mono bg-background border border-border rounded-md focus:outline-none focus:ring-2 focus:ring-primary/50"
              />
              <p className="text-xs text-muted-foreground mt-1">
                One prefix per line. Leave empty to crawl the entire repo.
                Trailing slashes are added automatically.
              </p>
            </div>
            {formType === "github" && <div className="space-y-2">
              <label className="block text-xs font-medium text-muted-foreground" htmlFor="hub-github-revision">Pinned commit (optional, full SHA)</label>
              <input id="hub-github-revision" value={formRevision} onChange={e => setFormRevision(e.target.value)} className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm" />
              <label className="block text-xs font-medium text-muted-foreground" htmlFor="hub-entry-paths">Additional original Markdown entry files (one per line)</label>
              <textarea id="hub-entry-paths" value={formEntryPaths} onChange={e => setFormEntryPaths(e.target.value)} className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm" placeholder="plugins/review/commands/review.md" />
              <p className="text-xs text-muted-foreground">Original files stay unchanged. SKILL.md entries are discovered automatically; list command Markdown here. A pinned commit applies to entry files and their supporting files.</p>
            </div>}
            {/* Advanced disclosure — currently hosts the GitLab tree-page
                cap, which most admins will never touch. Hidden by default
                so the form stays simple; revealed on click and persists
                inside this single Add Hub session. */}
            {formType === "gitlab" && (
              <div>
                <button
                  type="button"
                  onClick={() => setShowAdvanced((v) => !v)}
                  aria-expanded={showAdvanced}
                  className="text-xs font-medium text-muted-foreground hover:text-foreground transition-colors inline-flex items-center gap-1"
                >
                  {showAdvanced ? "▾" : "▸"} Advanced
                </button>
                {showAdvanced && (
                  <div className="mt-2 space-y-1">
                    <label
                      htmlFor="hub-max-tree-pages"
                      className="text-xs font-medium text-muted-foreground"
                    >
                      Max tree pages (GitLab only)
                    </label>
                    <input
                      id="hub-max-tree-pages"
                      type="number"
                      inputMode="numeric"
                      min={1}
                      max={500}
                      value={formMaxTreePages}
                      onChange={(e) => setFormMaxTreePages(e.target.value)}
                      placeholder="50"
                      className="mt-1 w-full px-3 py-2 text-sm bg-background border border-border rounded-md focus:outline-none focus:ring-2 focus:ring-primary/50"
                    />
                    <p className="text-xs text-muted-foreground">
                      GitLab returns up to 100 entries per page. Default is{" "}
                      <code className="font-mono">50</code> ({"~"}5,000 entries).
                      Raise this if your repo has more files than the cap and
                      <code className="font-mono"> include_paths</code>{" "}
                      isn&apos;t a fit. Hard ceiling: 500 pages.
                    </p>
                  </div>
                )}
              </div>
            )}
            <div className="flex flex-wrap gap-2 pt-1">
              <Button variant="outline" size="sm" onClick={() => setShowAddForm(false)}>
                Cancel
              </Button>
              <Button
                variant="secondary"
                size="sm"
                onClick={handleCrawlPreview}
                disabled={!formLocation.trim() || crawlLoading}
                className="gap-1"
              >
                {crawlLoading ? <Loader2 className="h-3 w-3 animate-spin" /> : <Search className="h-3 w-3" />}
                Preview skills (crawl)
              </Button>
              <Button size="sm" onClick={handleAdd} disabled={!formLocation.trim() || adding} className="gap-1">
                {adding && <Loader2 className="h-3 w-3 animate-spin" />}
                Register Hub
              </Button>
            </div>
            {(crawlPaths.length > 0 || crawlPreview.length > 0) && (
              <div className="mt-3 rounded-md border border-border bg-muted/20 p-3 max-h-48 overflow-y-auto">
                <p className="text-xs font-medium text-muted-foreground mb-2">
                  Discovered SKILL.md paths ({crawlPaths.length || crawlPreview.length})
                </p>
                <ul className="text-xs font-mono space-y-1">
                  {(crawlPaths.length ? crawlPaths : crawlPreview.map((p) => p.path)).map((p) => (
                    <li key={p}>{p}</li>
                  ))}
                </ul>
              </div>
            )}
            {crawlTruncation && (
              <div
                role="status"
                aria-live="polite"
                className="mt-3 rounded-md border border-amber-500/30 bg-amber-500/10 p-3 text-xs text-amber-700 dark:text-amber-400 flex items-start gap-2"
              >
                <AlertTriangle className="h-4 w-4 shrink-0 mt-0.5" />
                <div className="space-y-1">
                  {crawlTruncation.kind === "cap" ? (
                    <>
                      <p className="font-medium">
                        Hit the {crawlTruncation.cap}-page cap after{" "}
                        {crawlTruncation.pages_walked} page
                        {crawlTruncation.pages_walked === 1 ? "" : "s"}.
                      </p>
                      <p>
                        Skills past page {crawlTruncation.pages_walked} were not
                        scanned. Raise &quot;Max tree pages&quot; or add
                        <code className="font-mono"> include_paths</code> to
                        scope the crawl.
                      </p>
                    </>
                  ) : crawlTruncation.kind === "platform" ? (
                    <>
                      <p className="font-medium">
                        GitHub truncated the tree response.
                      </p>
                      <p>
                        The repo exceeded GitHub&apos;s API limits (~100k
                        entries / 7MB). Add <code className="font-mono">include_paths</code> to
                        scope the crawl to a subdirectory.
                      </p>
                    </>
                  ) : null}
                </div>
              </div>
            )}
          </div>
        )}

        {hubs.length === 0 ? (
          <div className="text-center py-8">
            <Globe className="h-10 w-10 text-muted-foreground mx-auto mb-3" />
            <h3 className="text-sm font-medium mb-1">No Skill Hubs</h3>
            <p className="text-xs text-muted-foreground">
              {isAdmin
                ? 'Register a GitHub or GitLab repository to import its skills into the catalog.'
                : 'No external skill hubs have been configured yet.'}
            </p>
          </div>
        ) : (
          <div className="space-y-2">
            <div className="grid grid-cols-6 gap-4 pb-2 border-b text-xs font-medium text-muted-foreground">
              <div className="col-span-2">Repository</div>
              <div>Status</div>
              <div>Last Sync</div>
              <div>Added</div>
              {isAdmin && <div className="text-right">Actions</div>}
            </div>
            {hubs.map((hub) => (
              <div key={hub.id} className="space-y-0.5">
              <div className="grid grid-cols-6 gap-4 py-2 text-sm hover:bg-muted/50 rounded px-2 items-center">
                <div className="col-span-2 flex items-center gap-2">
                  {hub.type === "gitlab" ? (
                    <GitlabIcon className="h-4 w-4 text-muted-foreground shrink-0" />
                  ) : hub.type === "github" ? (
                    <GithubIcon className="h-4 w-4 text-muted-foreground shrink-0" />
                  ) : (
                    <Globe className="h-4 w-4 text-muted-foreground shrink-0" />
                  )}
                  <span className="font-medium truncate" title={`${hub.type}: ${hub.location}`}>
                    {hub.location}
                  </span>
                  {hub.labels && hub.labels.length > 0 && hub.labels.map((label) => (
                    <Badge key={label} variant="secondary" className="text-[10px] px-1.5 py-0">
                      {label}
                    </Badge>
                  ))}
                </div>
                <div>
                  {hub.enabled ? (
                    hub.last_failure_at && (!hub.last_success_at || hub.last_failure_at > hub.last_success_at) ? (
                      <Badge variant="outline" className="text-xs text-orange-500 border-orange-500/30 gap-1">
                        <AlertCircle className="h-3 w-3" />
                        Error
                      </Badge>
                    ) : (
                      <Badge variant="outline" className="text-xs text-green-500 border-green-500/30 gap-1">
                        <CheckCircle2 className="h-3 w-3" />
                        Active
                      </Badge>
                    )
                  ) : (
                    <Badge variant="secondary" className="text-xs">Disabled</Badge>
                  )}
                </div>
                <div className="text-xs text-muted-foreground">
                  {hub.last_success_at
                    ? new Date(hub.last_success_at * 1000).toLocaleDateString()
                    : hub.last_failure_at
                    ? `Failed ${new Date(hub.last_failure_at * 1000).toLocaleDateString()}`
                    : 'Never'}
                </div>
                <div className="text-xs text-muted-foreground">
                  {new Date(hub.created_at).toLocaleDateString()}
                </div>
                {isAdmin && (
                  <div className="flex justify-end gap-1">
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-7 text-xs"
                      onClick={() => handleToggle(hub)}
                      disabled={togglingId === hub.id}
                    >
                      {togglingId === hub.id ? (
                        <Loader2 className="h-3 w-3 animate-spin" />
                      ) : hub.enabled ? (
                        "Disable"
                      ) : (
                        "Enable"
                      )}
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-7 w-7 p-0"
                      title="Force-recrawl this hub, bypassing the cache"
                      onClick={() => handleRecrawl(hub.id)}
                      disabled={recrawlingId === hub.id}
                    >
                      {recrawlingId === hub.id ? (
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      ) : (
                        <RefreshCcw className="h-3.5 w-3.5" />
                      )}
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-7 text-xs"
                      title="Edit automatic team grants for this hub"
                      onClick={() => handleEditTeams(hub)}
                    >
                      Teams
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-7 w-7 p-0 text-red-400 hover:text-red-500"
                      onClick={() => handleDelete(hub.id)}
                      disabled={deletingId === hub.id}
                    >
                      {deletingId === hub.id ? (
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      ) : (
                        <Trash2 className="h-3.5 w-3.5" />
                      )}
                    </Button>
                  </div>
                )}
              </div>
              {hub.revision && <p className="text-xs text-muted-foreground">Pinned commit: <code>{hub.revision}</code></p>}
              {hub.include_paths && hub.include_paths.length > 0 ? (
                <div className="px-2 pl-10 flex flex-wrap items-center gap-1 text-[11px] text-muted-foreground">
                  <span className="opacity-70">Paths:</span>
                  {hub.include_paths.map((p) => (
                    <Badge
                      key={p}
                      variant="outline"
                      className="font-mono text-[10px] py-0 px-1.5"
                    >
                      {p}
                    </Badge>
                  ))}
                </div>
              ) : null}
              {hub.shared_with_teams && hub.shared_with_teams.length > 0 ? (
                <div className="px-2 pl-10 flex flex-wrap items-center gap-1 text-[11px] text-muted-foreground">
                  <span className="opacity-70">Teams:</span>
                  {hub.shared_with_teams.map((teamRef) => (
                    <Badge
                      key={teamRef}
                      variant="outline"
                      className="font-mono text-[10px] py-0 px-1.5"
                    >
                      {teamRef}
                    </Badge>
                  ))}
                </div>
              ) : null}
              {hub.type === "gitlab" && hub.max_tree_pages ? (
                <div className="px-2 pl-10 text-[11px] text-muted-foreground">
                  <span className="opacity-70">Max tree pages:</span>{" "}
                  <code className="font-mono">{hub.max_tree_pages}</code>
                </div>
              ) : null}
              {hub.last_truncation && hub.last_truncation.kind !== "ok" ? (
                <div
                  role="status"
                  aria-live="polite"
                  className="px-2 pl-10 mt-1 flex items-start gap-2 rounded-md border border-amber-500/30 bg-amber-500/10 px-2 py-1.5 text-[11px] text-amber-700 dark:text-amber-400"
                >
                  <AlertTriangle className="h-3.5 w-3.5 shrink-0 mt-0.5" />
                  <div className="flex-1 space-y-1">
                    {hub.last_truncation.kind === "cap" ? (
                      <p>
                        <strong>Skills may be missing.</strong>{" "}
                        Crawl stopped at the {hub.last_truncation.cap}-page cap
                        after walking {hub.last_truncation.pages_walked} pages.
                      </p>
                    ) : hub.last_truncation.kind === "platform" ? (
                      <p>
                        <strong>Skills may be missing.</strong>{" "}
                        GitHub truncated the tree response (&gt;100k entries
                        or &gt;7MB).
                      </p>
                    ) : null}
                    {isAdmin && (
                      <div className="flex flex-wrap gap-1.5 pt-0.5">
                        {hub.type === "gitlab" && hub.last_truncation.kind === "cap" && (
                          <Button
                            variant="outline"
                            size="sm"
                            className="h-6 px-2 text-[11px] gap-1"
                            onClick={() => handleEditMaxTreePages(hub)}
                          >
                            <RefreshCcw className="h-3 w-3" />
                            Edit cap
                          </Button>
                        )}
                        <Button
                          variant="outline"
                          size="sm"
                          className="h-6 px-2 text-[11px] gap-1"
                          onClick={() => handleEditIncludePaths(hub)}
                          title="Scope this hub to specific subdirectories"
                        >
                          <ListFilter className="h-3 w-3" />
                          {hub.include_paths && hub.include_paths.length > 0
                            ? "Edit include_paths"
                            : "Add include_paths"}
                        </Button>
                      </div>
                    )}
                  </div>
                </div>
              ) : null}
              {hub.last_skill_scan_at != null && hub.last_skill_scan_at > 0 ? (
                <div className="px-2 pl-10 text-[11px] text-muted-foreground">
                  Skill Scanner:{" "}
                  {new Date(hub.last_skill_scan_at * 1000).toLocaleString()}
                  {hub.last_skill_scan_max_severity
                    ? ` · max severity ${hub.last_skill_scan_max_severity}`
                    : ""}
                  {hub.last_skill_scan_blocked ? " · hub merge blocked (strict gate)" : ""}
                  {hub.last_skill_scan_exit_code != null && hub.last_skill_scan_exit_code !== 0
                    ? ` · exit ${hub.last_skill_scan_exit_code}`
                    : ""}
                </div>
              ) : null}
              {recrawlResult[hub.id] != null ? (
                <div className="px-2 pl-10 text-[11px] text-green-600 dark:text-green-400">
                  Recrawled — {recrawlResult[hub.id]} skill{recrawlResult[hub.id] !== 1 ? "s" : ""} found
                </div>
              ) : null}
              {/* Option C nudge: surface unscanned / flagged skills per
                  hub with a one-click retry that opens the bulk dialog
                  scoped to this hub. When everything passed we still
                  show a tiny green confirmation so admins see at a
                  glance that scans actually ran. */}
              {isAdmin && (hub.skills_count ?? 0) > 0 && (
                ((hub.scan_unscanned_count ?? 0) > 0 || (hub.scan_flagged_count ?? 0) > 0) ? (
                  <div className="px-2 pl-10 flex items-center gap-2 text-[11px]">
                    {(hub.scan_unscanned_count ?? 0) > 0 && (
                      <Badge variant="outline" className="text-[10px] py-0 px-1.5 text-amber-600 border-amber-500/30 gap-1">
                        <ShieldAlert className="h-3 w-3" />
                        {hub.scan_unscanned_count} unscanned
                      </Badge>
                    )}
                    {(hub.scan_flagged_count ?? 0) > 0 && (
                      <Badge variant="outline" className="text-[10px] py-0 px-1.5 text-red-500 border-red-500/30 gap-1">
                        <AlertCircle className="h-3 w-3" />
                        {hub.scan_flagged_count} flagged
                      </Badge>
                    )}
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-6 px-2 text-[11px] gap-1"
                      onClick={() => setScanHubId(hub.id)}
                      title="Open bulk scan dialog scoped to this hub"
                    >
                      <Zap className="h-3 w-3" />
                      Scan now
                    </Button>
                  </div>
                ) : (hub.scan_passed_count ?? 0) > 0 ? (
                  <div className="px-2 pl-10 flex items-center gap-1.5 text-[11px] text-green-600 dark:text-green-400">
                    <CheckCircle2 className="h-3 w-3" />
                    All {hub.scan_passed_count} skill{hub.scan_passed_count === 1 ? "" : "s"} passed scan
                  </div>
                ) : null
              )}
              </div>
            ))}
          </div>
        )}

        {/* Show last failure message if any hub has one */}
        {hubs.some((h) => h.last_failure_message) && (
          <div className="mt-4 space-y-2">
            {hubs.filter((h) => h.last_failure_message).map((h) => (
              <div key={h.id} className="p-2 rounded bg-orange-500/10 text-xs text-orange-600 dark:text-orange-400">
                <strong>{h.location}:</strong> {h.last_failure_message}
              </div>
            ))}
          </div>
        )}

        <p className="text-xs text-muted-foreground mt-6 border-t border-border pt-4 leading-relaxed">
          Hub ingest uses{" "}
          <a
            href="https://github.com/cisco-ai-defense/skill-scanner"
            target="_blank"
            rel="noopener noreferrer"
            className="text-primary font-medium hover:underline"
          >
            Skill Scanner
          </a>
          , provided by <strong>Cisco AI Defense</strong>. Scanner results are best-effort and do not
          guarantee security; a clean scan does not imply safety.
        </p>
      </CardContent>

      {/* Per-hub bulk-scan dialog. Pre-scoped to the hub the operator
          clicked so they don't have to reselect anything. */}
      <ScanAllDialog
        open={scanHubId !== null}
        onOpenChange={(next) => {
          if (!next) setScanHubId(null);
        }}
        initialScope="hub"
        initialHubIds={scanHubId ? [scanHubId] : undefined}
        onComplete={() => {
          // Refresh per-hub aggregates so the nudge clears immediately.
          loadHubs();
        }}
      />
    </Card>
  );
}
