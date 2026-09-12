"use client";

/**
 * Superadmin bulk-remediation tool: apply an Owner and/or Search Access to
 * every datasource currently in a collection.
 *
 * A collection is a saved search-time filter, not an access grant - adding a
 * source to one never extends who can read it. This exists to backfill
 * direct grants for datasources that used to be searchable only because
 * they were a member of a broadly-read collection before that propagation
 * was removed. It bypasses the publication-approval workflow a normal
 * single-source edit goes through, so use it deliberately.
 */

import { AlertTriangle, Loader2, ShieldCheck } from "lucide-react";
import { useEffect, useState } from "react";

import {
  AccessSubjectMultiPicker,
  AccessSubjectPicker,
  type AccessSubjectRef,
} from "@/components/ui/access-subject-picker";
import { Button } from "@/components/ui/button";
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
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { SearchablePicker } from "@/components/ui/searchable-picker";
import type { TeamPickerOption } from "@/components/ui/team-picker";
import type { RagCollectionWithPermissions } from "@/types/rag-collection";

type SearchMode = "replace" | "additive";

interface ApplyCollectionPermissionsCardProps {
  isAdmin: boolean;
  readOnly?: boolean;
}

export function ApplyCollectionPermissionsCard({
  isAdmin,
  readOnly = false,
}: ApplyCollectionPermissionsCardProps) {
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [applying, setApplying] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [collections, setCollections] = useState<RagCollectionWithPermissions[]>([]);
  const [teams, setTeams] = useState<TeamPickerOption[]>([]);
  const [collectionId, setCollectionId] = useState<string | null>(null);
  const [applyOwner, setApplyOwner] = useState(false);
  const [owner, setOwner] = useState<AccessSubjectRef | null>(null);
  const [applySearch, setApplySearch] = useState(false);
  const [searchMode, setSearchMode] = useState<SearchMode>("additive");
  const [searchAccess, setSearchAccess] = useState<AccessSubjectRef[]>([]);
  const [result, setResult] = useState<{
    updatedCount: number;
    skippedCount: number;
  } | null>(null);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    setResult(null);
    // Reset every field on each open - this tool writes tuples directly
    // and bypasses publication approval, so a stale Owner/Search selection
    // left over from a previous collection must never carry into the next
    // one unreviewed.
    setCollectionId(null);
    setApplyOwner(false);
    setOwner(null);
    setApplySearch(false);
    setSearchMode("additive");
    setSearchAccess([]);
    (async () => {
      try {
        const [collectionRes, teamRes] = await Promise.all([
          fetch("/api/rag/collections").then((response) => response.json()),
          fetch("/api/dynamic-agents/teams").then((response) => response.json()),
        ]);
        if (cancelled) return;
        if (!collectionRes?.success) {
          throw new Error(collectionRes?.error || "Could not load collections");
        }
        setCollections(
          (collectionRes.data?.collections ?? []) as RagCollectionWithPermissions[],
        );
        setTeams(
          teamRes?.success && Array.isArray(teamRes.data) ? teamRes.data : [],
        );
      } catch (loadError) {
        if (!cancelled) {
          setError(
            loadError instanceof Error
              ? loadError.message
              : "Could not load collections",
          );
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open]);

  const selectedCollection = collections.find(
    (collection) => collection._id === collectionId,
  );
  // An empty Search Access list is a valid, deliberate choice for either
  // mode (Replace with nothing revokes everyone; Additive with nothing is a
  // no-op) - only require a person/team to be picked when applying Owner.
  const canApply =
    !readOnly &&
    Boolean(collectionId) &&
    (applyOwner || applySearch) &&
    (!applyOwner || owner !== null);

  async function handleApply() {
    if (readOnly || !collectionId || !canApply) return;
    setApplying(true);
    setError(null);
    try {
      const res = await fetch(
        `/api/admin/rag/collections/${encodeURIComponent(collectionId)}/apply-permissions`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            ...(applyOwner
              ? {
                  owner_team_slug: owner?.kind === "team" ? owner.id : undefined,
                  owner_subject: owner?.kind === "user" ? owner.id : undefined,
                }
              : {}),
            ...(applySearch
              ? {
                  search_mode: searchMode,
                  search_team_slugs: searchAccess
                    .filter((ref) => ref.kind === "team")
                    .map((ref) => ref.id),
                  search_user_subjects: searchAccess
                    .filter((ref) => ref.kind === "user")
                    .map((ref) => ref.id),
                }
              : {}),
          }),
        },
      );
      const data = await res.json();
      if (!data.success) {
        setError(data.error || "Failed to apply permissions");
        return;
      }
      setResult({
        updatedCount: data.data?.updated_count ?? 0,
        skippedCount: data.data?.skipped_count ?? 0,
      });
    } catch {
      setError("Failed to apply permissions");
    } finally {
      setApplying(false);
    }
  }

  if (!isAdmin) return null;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          Apply Permissions to a Collection
        </CardTitle>
        <CardDescription>
          Bulk-set an Owner and/or Search Access on every datasource
          currently in a collection. A collection itself grants no access -
          this writes real grants directly to its member datasources.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <Button
          type="button"
          variant="outline"
          className="gap-2"
          onClick={() => {
            if (!readOnly) setOpen(true);
          }}
          disabled={readOnly}
          data-testid="apply-collection-permissions-button"
        >
          <ShieldCheck className="h-4 w-4" />
          Apply Permissions
        </Button>
      </CardContent>

      <Dialog open={open} onOpenChange={(next) => !applying && setOpen(next)}>
        <DialogContent className="flex max-h-[85vh] w-[calc(100vw-2rem)] flex-col overflow-visible sm:max-w-[640px]">
          <DialogHeader>
            <DialogTitle>Apply permissions to a collection</DialogTitle>
            <DialogDescription>
              Choose a collection, then an Owner and/or Search Access to
              apply to every datasource currently in it. Takes effect
              immediately.
            </DialogDescription>
          </DialogHeader>

          <div className="min-h-0 min-w-0 overflow-x-hidden overflow-y-auto pr-1">
            {loading ? (
              <div className="flex items-center justify-center py-8">
                <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
              </div>
            ) : (
              <div className="min-w-0 space-y-4">
                {error && (
                  <div
                    className="flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive"
                    data-testid="apply-collection-permissions-error"
                  >
                    <AlertTriangle className="h-4 w-4 shrink-0 mt-0.5" />
                    {error}
                  </div>
                )}

                {result && (
                  <div
                    className="rounded-md border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-sm text-emerald-700 dark:text-emerald-300"
                    data-testid="apply-collection-permissions-result"
                  >
                    Updated {result.updatedCount} datasource
                    {result.updatedCount === 1 ? "" : "s"}.
                    {result.skippedCount > 0 &&
                      ` Skipped ${result.skippedCount} not managed in the database.`}
                  </div>
                )}

                <div className="space-y-2">
                  <Label htmlFor="apply-permissions-collection" className="block">
                    Collection
                  </Label>
                  <SearchablePicker
                    id="apply-permissions-collection"
                    options={collections}
                    selected={selectedCollection}
                    onSelect={(collection) => setCollectionId(collection._id)}
                    getOptionKey={(collection) => collection._id}
                    getOptionLabel={(collection) =>
                      `${collection.name} (${collection.source_ids.length} datasource${collection.source_ids.length === 1 ? "" : "s"})`
                    }
                    getSearchText={(collection) => [collection._id, collection.name]}
                    placeholder="Select a collection"
                    searchPlaceholder="Search collections..."
                    emptyLabel="No collections available"
                    ariaLabel="Collection"
                    required
                    disabled={applying || collections.length === 0}
                    triggerClassName="h-10 text-sm"
                  />
                </div>

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
                    Overwrites the management Owner on every datasource in
                    the collection.
                  </p>
                  {applyOwner && (
                    <AccessSubjectPicker
                      id="apply-permissions-owner"
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
                            name="apply-permissions-search-mode"
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
                            name="apply-permissions-search-mode"
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
                        id="apply-permissions-search"
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
            )}
          </div>

          <DialogFooter className="min-w-0 flex-wrap gap-2 sm:space-x-0">
            <Button
              type="button"
              variant="outline"
              onClick={() => setOpen(false)}
              disabled={applying}
            >
              Close
            </Button>
            <Button
              type="button"
              onClick={handleApply}
              disabled={loading || applying || !canApply}
              className="gap-2"
              data-testid="apply-collection-permissions-submit"
            >
              {applying && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
              Apply
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}

export default ApplyCollectionPermissionsCard;
