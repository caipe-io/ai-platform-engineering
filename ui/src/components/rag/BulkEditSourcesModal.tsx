"use client";

/**
 * Self-service bulk edit: apply an Owner and/or Search Access change across
 * every datasource the caller selected on the Ingest page.
 *
 * This is not an admin bypass - it's a thin client over
 * `POST /api/rag/sources/bulk-update`, which applies each source through
 * exactly the same authorization and publication-approval logic a single
 * `PATCH /api/rag/sources/[sourceId]` edit would trigger. A source the
 * caller doesn't manage, or one whose owner change needs interactive
 * confirmation, simply comes back as a per-source skip in the results -
 * nothing here bypasses those checks.
 */

import { AlertTriangle, Loader2 } from "lucide-react";
import { useEffect, useState } from "react";

import {
  AccessSubjectMultiPicker,
  AccessSubjectPicker,
  type AccessSubjectRef,
} from "@/components/ui/access-subject-picker";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import type { TeamPickerOption } from "@/components/ui/team-picker";

type SearchMode = "replace" | "additive";

interface BulkEditSourcesModalProps {
  open: boolean;
  sourceIds: string[];
  onClose: () => void;
  onApplied: () => void | Promise<void>;
}

interface SourceResult {
  source_id: string;
  status: "updated" | "pending_approval" | "skipped";
  reason?: string;
}

const SKIP_REASON_LABEL: Record<string, string> = {
  not_found: "not found",
  FORBIDDEN_MANAGE: "you do not manage this source",
  CONFIG_DRIVEN_IMMUTABLE: "loaded from config, cannot be edited",
  TRANSFER_CONFIRMATION_REQUIRED: "owner transfer needs interactive confirmation",
};

export function BulkEditSourcesModal({
  open,
  sourceIds,
  onClose,
  onApplied,
}: BulkEditSourcesModalProps) {
  const [teams, setTeams] = useState<TeamPickerOption[]>([]);
  const [applying, setApplying] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [applyOwner, setApplyOwner] = useState(false);
  const [owner, setOwner] = useState<AccessSubjectRef | null>(null);
  const [applySearch, setApplySearch] = useState(false);
  const [searchMode, setSearchMode] = useState<SearchMode>("additive");
  const [searchAccess, setSearchAccess] = useState<AccessSubjectRef[]>([]);
  const [results, setResults] = useState<SourceResult[] | null>(null);

  useEffect(() => {
    if (!open) return;
    setError(null);
    setResults(null);
    setApplyOwner(false);
    setOwner(null);
    setApplySearch(false);
    setSearchMode("additive");
    setSearchAccess([]);
    fetch("/api/dynamic-agents/teams")
      .then((response) => response.json())
      .then((data) => {
        if (data?.success && Array.isArray(data.data)) setTeams(data.data);
      })
      .catch(() => undefined);
  }, [open]);

  // Additive with nothing picked is a harmless no-op. Replace with nothing
  // picked is not — it wipes Search Access from every selected source with
  // one click, so (unlike the single-source editor, and unlike this same
  // choice made deliberately one source at a time) require an explicit
  // non-empty list before a bulk Replace is allowed to apply at all.
  const canApply =
    sourceIds.length > 0 &&
    (applyOwner || applySearch) &&
    (!applyOwner || owner !== null) &&
    (!applySearch || searchMode !== "replace" || searchAccess.length > 0);

  async function handleApply() {
    if (!canApply) return;
    setApplying(true);
    setError(null);
    try {
      const res = await fetch("/api/rag/sources/bulk-update", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          source_ids: sourceIds,
          ...(applyOwner
            ? {
                owner: {
                  team_slug: owner?.kind === "team" ? owner.id : undefined,
                  subject: owner?.kind === "user" ? owner.id : undefined,
                },
              }
            : {}),
          ...(applySearch
            ? {
                search: {
                  mode: searchMode,
                  team_slugs: searchAccess
                    .filter((ref) => ref.kind === "team")
                    .map((ref) => ref.id),
                  user_subjects: searchAccess
                    .filter((ref) => ref.kind === "user")
                    .map((ref) => ref.id),
                },
              }
            : {}),
        }),
      });
      const data = await res.json();
      if (!data.success) {
        setError(data.error || "Bulk edit failed");
        return;
      }
      setResults(data.data.results);
      await onApplied();
    } catch {
      setError("Bulk edit failed");
    } finally {
      setApplying(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(next) => !applying && !next && onClose()}>
      <DialogContent className="flex max-h-[85vh] w-[calc(100vw-2rem)] flex-col overflow-visible sm:max-w-[640px]">
        <DialogHeader>
          <DialogTitle>
            Bulk edit {sourceIds.length} datasource{sourceIds.length === 1 ? "" : "s"}
          </DialogTitle>
          <DialogDescription>
            Applies to every datasource you selected. Each one goes through the
            same approval rules a single edit would - a source that needs
            approval shows up as pending below instead of applying immediately.
          </DialogDescription>
        </DialogHeader>

        <div className="min-h-0 min-w-0 overflow-x-hidden overflow-y-auto pr-1">
          <div className="min-w-0 space-y-4">
            {error && (
              <div
                className="flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive"
                data-testid="bulk-edit-error"
              >
                <AlertTriangle className="h-4 w-4 shrink-0 mt-0.5" />
                {error}
              </div>
            )}

            {results && (
              <div
                className="rounded-md border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-sm text-emerald-700 dark:text-emerald-300"
                data-testid="bulk-edit-result"
              >
                Updated {results.filter((r) => r.status === "updated").length},
                pending approval{" "}
                {results.filter((r) => r.status === "pending_approval").length},
                skipped {results.filter((r) => r.status === "skipped").length}.
                {results.some((r) => r.status === "skipped") && (
                  <ul className="mt-1 list-disc pl-5">
                    {results
                      .filter((r) => r.status === "skipped")
                      .map((r) => (
                        <li key={r.source_id}>
                          {r.source_id}:{" "}
                          {SKIP_REASON_LABEL[r.reason ?? ""] ?? r.reason ?? "skipped"}
                        </li>
                      ))}
                  </ul>
                )}
              </div>
            )}

            <div className="space-y-2 rounded-md border p-3">
              <label className="flex items-center gap-2 text-sm font-medium">
                <input
                  type="checkbox"
                  checked={applyOwner}
                  onChange={(event) => setApplyOwner(event.target.checked)}
                  disabled={applying}
                />
                Set Owner
              </label>
              <p className="text-xs text-muted-foreground">
                Overwrites the management Owner on every selected datasource.
              </p>
              {applyOwner && (
                <AccessSubjectPicker
                  id="bulk-edit-owner"
                  teams={teams}
                  knownUsers={[]}
                  value={owner}
                  onChange={setOwner}
                  placeholder="Select a person or team"
                  searchPlaceholder="Search people or teams..."
                  ariaLabel="Owner"
                  disabled={applying}
                />
              )}
            </div>

            <div className="space-y-2 rounded-md border p-3">
              <label className="flex items-center gap-2 text-sm font-medium">
                <input
                  type="checkbox"
                  checked={applySearch}
                  onChange={(event) => setApplySearch(event.target.checked)}
                  disabled={applying}
                />
                Set Search Access
              </label>
              {applySearch && (
                <>
                  <div
                    role="radiogroup"
                    aria-label="Search Access apply mode"
                    className="flex flex-col gap-2 text-sm"
                  >
                    <label className="flex items-center gap-2">
                      <input
                        type="radio"
                        name="bulk-edit-search-mode"
                        value="additive"
                        checked={searchMode === "additive"}
                        onChange={() => setSearchMode("additive")}
                        disabled={applying}
                      />
                      <span>
                        <span className="font-medium">Additive</span> - add
                        these to each datasource&apos;s existing Search Access
                      </span>
                    </label>
                    <label className="flex items-center gap-2">
                      <input
                        type="radio"
                        name="bulk-edit-search-mode"
                        value="replace"
                        checked={searchMode === "replace"}
                        onChange={() => setSearchMode("replace")}
                        disabled={applying}
                      />
                      <span>
                        <span className="font-medium">Replace</span> -
                        overwrite each datasource&apos;s Search Access with
                        exactly this list
                      </span>
                    </label>
                  </div>
                  <AccessSubjectMultiPicker
                    id="bulk-edit-search"
                    teams={teams}
                    knownUsers={[]}
                    selected={searchAccess}
                    onChange={setSearchAccess}
                    placeholder="Add people or teams..."
                    searchPlaceholder="Search people or teams..."
                    ariaLabel="Search Access"
                    disabled={applying}
                    maxSelections={100}
                    maxSelectionsByKind={{ team: 50, user: 200 }}
                  />
                </>
              )}
            </div>
          </div>
        </div>

        <DialogFooter className="min-w-0 flex-wrap gap-2 sm:space-x-0">
          <Button type="button" variant="outline" onClick={onClose} disabled={applying}>
            Close
          </Button>
          <Button
            type="button"
            onClick={() => void handleApply()}
            disabled={applying || !canApply}
            className="gap-2"
            data-testid="bulk-edit-submit"
          >
            {applying && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
            Apply
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export default BulkEditSourcesModal;
