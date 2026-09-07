"use client";

import { Switch } from "@/components/ui/switch";
import { AlertCircle,CheckCircle2,Loader2,Search } from "lucide-react";
import { useCallback,useEffect,useState } from "react";

/**
 * Explicit "search" capability toggle for a team
 * (spec 2026-06-03-explicit-search-capability).
 *
 * Reads/writes the org-level `searcher` grant for this team via
 * `/api/admin/teams/[id]/search-capability`. This is the feature-level gate for
 * Knowledge Base search: it controls whether the team's members see the Search
 * tab and may run queries / invoke search tools (built-in and custom). It is
 * deliberately separate from per-tool sharing and per-KB read grants — holding
 * `can_call` on a shared tool does NOT grant search. Granting/revoking is
 * org-admin-only (enforced server-side); a 403 surfaces inline.
 *
 * assisted-by Cursor claude-opus-4.8
 */
interface SearchCapabilityToggleProps {
  teamId: string;
  teamName: string;
  readOnly?: boolean;
}

interface CapabilityState {
  can_search: boolean;
}

export function SearchCapabilityToggle({
  teamId,
  teamName,
  readOnly = false,
}: SearchCapabilityToggleProps) {
  const [enabled, setEnabled] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);
      const res = await fetch(`/api/admin/teams/${teamId}/search-capability`);
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error((err as { error?: string }).error || `HTTP ${res.status}`);
      }
      const data = (await res.json()) as { data: CapabilityState };
      setEnabled(Boolean(data.data?.can_search));
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Failed to load search capability"
      );
    } finally {
      setLoading(false);
    }
  }, [teamId]);

  useEffect(() => {
    load();
  }, [load]);

  const flashSuccess = (msg: string) => {
    setSuccess(msg);
    window.setTimeout(() => setSuccess(null), 3000);
  };

  const handleToggle = async () => {
    if (readOnly) return;
    const next = !enabled;
    try {
      setSaving(true);
      setError(null);
      const res = await fetch(`/api/admin/teams/${teamId}/search-capability`, {
        method: next ? "PUT" : "DELETE",
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error((err as { error?: string }).error || `HTTP ${res.status}`);
      }
      setEnabled(next);
      flashSuccess(
        next
          ? `${teamName} can now search knowledge bases`
          : `${teamName} can no longer search knowledge bases`
      );
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : "Failed to update search capability"
      );
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className="rounded-lg border bg-background">
      <div className="flex items-start justify-between gap-4 p-4">
        <div className="flex items-start gap-3 min-w-0">
          <div className="h-8 w-8 rounded-md bg-sky-500/10 flex items-center justify-center shrink-0">
            <Search className="h-4 w-4 text-sky-600 dark:text-sky-300" />
          </div>
          <div className="min-w-0">
            <h4 className="text-sm font-medium">Search knowledge bases</h4>
            <p className="text-xs text-muted-foreground mt-0.5">
              Allow <strong>{teamName}</strong> members to search datasources
              they can access, including through agents.
            </p>
          </div>
        </div>
        <div className="relative shrink-0">
          <Switch
            checked={enabled}
            aria-label="Allow this team to search knowledge bases"
            disabled={loading || saving || readOnly}
            onCheckedChange={() => void handleToggle()}
            className={enabled ? "bg-sky-500" : undefined}
          />
          {(loading || saving) && (
            <Loader2 className="pointer-events-none absolute left-3.5 top-1.5 h-3 w-3 animate-spin text-foreground" />
          )}
        </div>
      </div>
      {error && (
        <div className="flex items-start gap-2 px-4 pb-3 text-destructive text-xs">
          <AlertCircle className="h-3.5 w-3.5 mt-0.5 flex-shrink-0" />
          <span>{error}</span>
        </div>
      )}
      {success && (
        <div className="flex items-start gap-2 px-4 pb-3 text-emerald-600 dark:text-emerald-300 text-xs">
          <CheckCircle2 className="h-3.5 w-3.5 mt-0.5 flex-shrink-0" />
          <span>{success}</span>
        </div>
      )}
    </section>
  );
}
