"use client";

/**
 * Inline cache controls for connector discovery (Slack channels, Webex
 * spaces). Rendered next to the "Find ... with Bot Integration" button on
 * each connector's onboarding wizard.
 *
 * Why inline:
 *   The cache snapshot belongs to the picker the admin is actively using.
 *   Forcing them to navigate to a separate Platform Settings tab just to
 *   drop a stale snapshot is the wrong UX — that's why we moved the
 *   single editing surface here. Each connector has its own TTL and refresh.
 *
 * Persistence:
 *   - GET/PATCH /api/admin/platform-config persist
 *     the provider-specific TTL (range 0..1440; 0 disables caching).
 *   - Force refresh hits `/api/admin/<provider>/available-...` with
 *     `?refresh=1` so the next picker open sees a fresh snapshot.
 *
 * Auth:
 *   Read access mirrors the rest of the integrations wizard (admin_ui:view).
 *   PATCH requires admin_ui:admin; viewers see the popover open in read-
 *   only mode (input + Save are disabled) so they can still see the TTL
 *   that's in effect.
 *
 * assisted-by Cursor claude-opus-4-7
 */

import { CheckCircle2,Loader2,RefreshCw,Save,SlidersHorizontal } from "lucide-react";
import { useEffect,useState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Popover,PopoverContent,PopoverTrigger } from "@/components/ui/popover";

// Bounds mirror ui/src/lib/rbac/discovery-cache-config.ts. Kept as
// constants (not imported from the server helper) so the client bundle
// stays free of the Mongo dependency chain.
const DISCOVERY_TTL_MIN = 0;
const DISCOVERY_TTL_MAX = 1440;
const DISCOVERY_TTL_DEFAULT = 60;

export type DiscoveryCacheProvider = "slack" | "webex";

interface DiscoveryCacheControlsProps {
  /**
   * Which connector this control instance lives next to. Determines which
   * discovery route and TTL field this control manages.
   */
  provider: DiscoveryCacheProvider;
  /**
   * True when the signed-in user can edit platform_config. When false the
   * popover is still openable (so viewers can see the current TTL) but
   * the input and Save button are disabled, and Force refresh is hidden.
   */
  isAdmin: boolean;
  /**
   * Optional callback invoked after a successful Force refresh so the
   * parent wizard can re-run its own discovery query against the now-
   * fresh server-side cache. Slack/Webex panels pass `onDiscover` here.
   */
  onAfterRefresh?: () => void;
  refreshQuery?: Record<string, string>;
}

const ROUTE_BY_PROVIDER: Record<DiscoveryCacheProvider, string> = {
  slack: "/api/admin/slack/available-channels",
  webex: "/api/admin/webex/available-spaces",
};

const LABEL_BY_PROVIDER: Record<DiscoveryCacheProvider, string> = {
  slack: "Slack",
  webex: "Webex",
};

const CONFIG_FIELD_BY_PROVIDER: Record<DiscoveryCacheProvider, string> = {
  slack: "slack_discovery_cache_ttl_minutes",
  webex: "webex_discovery_cache_ttl_minutes",
};

export function DiscoveryCacheControls({
  provider,
  isAdmin,
  onAfterRefresh,
  refreshQuery,
}: DiscoveryCacheControlsProps) {
  const providerLabel = LABEL_BY_PROVIDER[provider];
  const configField = CONFIG_FIELD_BY_PROVIDER[provider];
  const [open, setOpen] = useState(false);
  const [loadingConfig, setLoadingConfig] = useState(false);
  const [ttlInput, setTtlInput] = useState<string>(String(DISCOVERY_TTL_DEFAULT));
  const [savedTtl, setSavedTtl] = useState<number>(DISCOVERY_TTL_DEFAULT);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saveResult, setSaveResult] = useState<"success" | "error" | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshResult, setRefreshResult] = useState<"success" | "error" | null>(null);

  // Lazy-load the persisted TTL the first time the popover opens. We
  // don't fetch on mount so a viewer who never opens the popover doesn't
  // pay for an extra platform-config round-trip.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoadingConfig(true);
    fetch("/api/admin/platform-config")
      .then((r) => r.json())
      .catch(() => ({ success: false }))
      .then((body) => {
        if (cancelled) return;
        const live = Number(body?.data?.[configField]);
        if (Number.isFinite(live)) {
          setTtlInput(String(live));
          setSavedTtl(live);
        }
      })
      .finally(() => {
        if (!cancelled) setLoadingConfig(false);
      });
    return () => {
      cancelled = true;
    };
  }, [configField, open]);

  const ttlDirty = String(savedTtl) !== ttlInput.trim();

  const handleSaveTtl = async () => {
    if (!isAdmin) return;
    setSaveError(null);
    setSaveResult(null);
    const trimmed = ttlInput.trim();
    if (trimmed === "") {
      setSaveError("Enter a number of minutes (0 disables caching).");
      return;
    }
    const next = Number(trimmed);
    if (
      !Number.isFinite(next) ||
      !Number.isInteger(next) ||
      next < DISCOVERY_TTL_MIN ||
      next > DISCOVERY_TTL_MAX
    ) {
      setSaveError(
        `Enter an integer between ${DISCOVERY_TTL_MIN} and ${DISCOVERY_TTL_MAX} minutes.`,
      );
      return;
    }
    setSaving(true);
    try {
      const res = await fetch("/api/admin/platform-config", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ [configField]: next }),
      });
      const data = await res.json();
      if (data.success) {
        setSavedTtl(next);
        setSaveResult("success");
        setTimeout(() => setSaveResult(null), 3000);
      } else {
        setSaveResult("error");
        setSaveError(typeof data.error === "string" ? data.error : "Failed to save.");
      }
    } catch {
      setSaveResult("error");
      setSaveError("Failed to save. Try again.");
    } finally {
      setSaving(false);
    }
  };

  const handleForceRefresh = async () => {
    if (!isAdmin) return;
    setRefreshing(true);
    setRefreshResult(null);
    try {
      const route = ROUTE_BY_PROVIDER[provider];
      const params = new URLSearchParams({ refresh: "1", limit: "1", ...refreshQuery });
      const res = await fetch(`${route}?${params.toString()}`);
      // 200 OK = fresh snapshot built. 503 = the connector isn't
      // configured (e.g. no SLACK_BOT_TOKEN), which is "not an error"
      // from the admin's POV — there's just nothing to refresh. We
      // treat both as success so the UI message reads sensibly.
      const okish = res.ok || res.status === 503;
      setRefreshResult(okish ? "success" : "error");
      if (okish) {
        onAfterRefresh?.();
      }
      setTimeout(() => setRefreshResult(null), 3000);
    } catch {
      setRefreshResult("error");
    } finally {
      setRefreshing(false);
    }
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="gap-2"
          aria-label={`${providerLabel} discovery cache settings`}
          data-testid={`discovery-cache-controls-trigger-${provider}`}
        >
          <SlidersHorizontal className="h-3.5 w-3.5" aria-hidden="true" />
          Discovery cache
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-80 space-y-4 p-4" align="end">
        <div className="space-y-1">
          <div className="text-sm font-medium">Discovery cache</div>
          <p className="text-xs text-muted-foreground">
            Stores the {providerLabel} {provider === "slack" ? "channel" : "space"} list briefly
            so discovery is faster and uses fewer API calls.
          </p>
        </div>

        <div className="space-y-2">
          <label
            htmlFor={`discovery-cache-ttl-${provider}`}
            className="text-xs font-medium"
          >
            Cache TTL (minutes)
          </label>
          <div className="flex items-center gap-2">
            <Input
              id={`discovery-cache-ttl-${provider}`}
              data-testid={`discovery-cache-ttl-input-${provider}`}
              type="number"
              inputMode="numeric"
              min={DISCOVERY_TTL_MIN}
              max={DISCOVERY_TTL_MAX}
              step={1}
              value={ttlInput}
              onChange={(e) => setTtlInput(e.target.value)}
              disabled={!isAdmin || saving || loadingConfig}
              aria-describedby={`discovery-cache-ttl-help-${provider}`}
              className="h-8 max-w-[8rem]"
            />
            {isAdmin && (
              <Button
                type="button"
                size="sm"
                onClick={handleSaveTtl}
                disabled={saving || !ttlDirty}
                className="gap-1.5"
                data-testid={`discovery-cache-ttl-save-${provider}`}
              >
                {saving ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Save className="h-3.5 w-3.5" />
                )}
                Save
              </Button>
            )}
            {saveResult === "success" && (
              <span className="flex items-center gap-1 text-xs text-green-600 dark:text-green-400">
                <CheckCircle2 className="h-3.5 w-3.5" /> Saved
              </span>
            )}
          </div>
          <p
            id={`discovery-cache-ttl-help-${provider}`}
            className="text-[11px] leading-snug text-muted-foreground"
          >
            Default <strong>{DISCOVERY_TTL_DEFAULT}</strong>. Range {DISCOVERY_TTL_MIN}&ndash;
            {DISCOVERY_TTL_MAX}. <strong>0</strong> disables caching (every request hits{" "}
            {providerLabel}).
          </p>
          {saveError && (
            <p className="text-xs text-destructive" role="alert">
              {saveError}
            </p>
          )}
        </div>

        {isAdmin && (
          <div className="space-y-2 border-t border-border/40 pt-3">
            <p className="text-xs text-muted-foreground">
              If a new {provider === "slack" ? "channel" : "space"} is missing,
              refresh the list now.
            </p>
            <div className="flex items-center gap-2">
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={handleForceRefresh}
                disabled={refreshing}
                className="gap-1.5"
                data-testid={`discovery-cache-refresh-${provider}`}
              >
                {refreshing ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <RefreshCw className="h-3.5 w-3.5" />
                )}
                Refresh from {providerLabel} now
              </Button>
              {refreshResult === "success" && (
                <span className="flex items-center gap-1 text-xs text-green-600 dark:text-green-400">
                  <CheckCircle2 className="h-3.5 w-3.5" /> Refreshed
                </span>
              )}
              {refreshResult === "error" && (
                <span className="text-xs text-destructive">Refresh failed</span>
              )}
            </div>
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
}
