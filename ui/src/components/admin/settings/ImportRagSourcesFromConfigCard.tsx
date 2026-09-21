"use client";

/**
 * Admin control for adopting application-config RAG sources into MongoDB as
 * the editable source of truth. Sets management ownership and, optionally,
 * a Search Access grant directly on the adopted sources - a collection is a
 * saved search-time filter and grants no access to its members, so it is
 * never a substitute for setting real access here.
 */

import { AlertTriangle, FileUp, Loader2 } from "lucide-react";
import { useEffect, useState } from "react";

import {
  AccessSubjectMultiPicker,
  AccessSubjectPicker,
  type AccessSubjectRef,
} from "@/components/ui/access-subject-picker";
import { Badge } from "@/components/ui/badge";
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
import type { TeamPickerOption } from "@/components/ui/team-picker";

interface PreviewSource {
  source_id: string;
  name: string;
  source_type: string;
  in_db: boolean;
  already_adopted: boolean;
  importable: boolean;
  unavailable_reason?: "not_seeded" | "not_config_driven";
}

type SkipReason =
  | "not_found"
  | "not_in_config"
  | "not_seeded"
  | "not_config_driven"
  | "already_adopted";

interface AdoptSkip {
  source_id: string;
  reason: SkipReason;
}

const SKIP_REASON_LABEL: Record<SkipReason, string> = {
  not_found: "seeded record not found",
  not_in_config: "not present in app config",
  not_seeded: "not seeded into the database",
  not_config_driven: "not managed by app config",
  already_adopted: "already adopted",
};

interface ImportRagSourcesFromConfigCardProps {
  isAdmin: boolean;
  readOnly?: boolean;
}

export function ImportRagSourcesFromConfigCard({
  isAdmin,
  readOnly = false,
}: ImportRagSourcesFromConfigCardProps) {
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [applying, setApplying] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [previewSources, setPreviewSources] = useState<PreviewSource[]>([]);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [configuredSourceCount, setConfiguredSourceCount] = useState(0);
  const [teams, setTeams] = useState<TeamPickerOption[]>([]);
  const [owner, setOwner] = useState<AccessSubjectRef | null>(null);
  const [searchAccess, setSearchAccess] = useState<AccessSubjectRef[]>([]);
  const [result, setResult] = useState<{
    adoptedCount: number;
    skipped: AdoptSkip[];
  } | null>(null);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    setResult(null);
    setOwner(null);
    setSearchAccess([]);
    (async () => {
      try {
        const previewRes = await fetch(
          "/api/admin/rag/sources/migrate-from-config",
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ dry_run: true }),
          },
        ).then((response) => response.json());
        if (!previewRes.success) {
          throw new Error(
            previewRes.error || "Could not load sources from app config",
          );
        }
        const teamRes = await fetch("/api/dynamic-agents/teams").then(
          (response) => response.json(),
        );
        if (cancelled) return;
        const sources = (previewRes.data?.sources ?? []) as PreviewSource[];
        setConfiguredSourceCount(
          previewRes.data?.configured_source_count ?? sources.length,
        );
        setPreviewSources(sources);
        setTeams(
          teamRes?.success && Array.isArray(teamRes.data) ? teamRes.data : [],
        );
        setSelectedIds(
          new Set(
            sources.filter((s) => s.importable).map((s) => s.source_id),
          ),
        );
      } catch (loadError) {
        if (!cancelled) {
          setError(
            loadError instanceof Error
              ? loadError.message
              : "Could not load the source preview",
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

  function toggleSelected(id: string) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function handleApply() {
    if (readOnly || !owner) return;
    setApplying(true);
    setError(null);
    try {
      const res = await fetch("/api/admin/rag/sources/migrate-from-config", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          dry_run: false,
          source_ids: Array.from(selectedIds),
          owner_team_slug: owner.kind === "team" ? owner.id : undefined,
          owner_subject: owner.kind === "user" ? owner.id : undefined,
          search_team_slugs: searchAccess
            .filter((ref) => ref.kind === "team")
            .map((ref) => ref.id),
          search_user_subjects: searchAccess
            .filter((ref) => ref.kind === "user")
            .map((ref) => ref.id),
        }),
      });
      const data = await res.json();
      if (!data.success) {
        setError(data.error || "Import failed");
        return;
      }
      const adopted = (data.data.adopted ?? []) as string[];
      setResult({
        adoptedCount: adopted.length,
        skipped: data.data.skipped ?? [],
      });
      setPreviewSources((prev) =>
        prev.map((s) =>
          adopted.includes(s.source_id)
            ? {
                ...s,
                in_db: true,
                already_adopted: true,
                importable: false,
              }
            : s,
        ),
      );
      setSelectedIds(new Set());
    } catch {
      setError("Could not import the selected sources");
    } finally {
      setApplying(false);
    }
  }

  if (!isAdmin) return null;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          Adopt App-Config RAG Sources
        </CardTitle>
        <CardDescription>
          Move seeded source settings into the database so they can be edited
          in the Web UI.
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
          data-testid="import-rag-sources-from-config-button"
        >
          <FileUp className="h-4 w-4" />
          Review App-Config Sources
        </Button>
      </CardContent>

      <Dialog open={open} onOpenChange={(next) => !applying && setOpen(next)}>
        <DialogContent className="flex max-h-[85vh] w-[calc(100vw-2rem)] flex-col overflow-visible sm:max-w-[680px]">
          <DialogHeader>
            <DialogTitle>Adopt app-config RAG sources</DialogTitle>
            <DialogDescription>
              <span className="block">
                Choose which read-only app-config sources to make editable,
                and set their Owner and Search Access directly. Indexed
                content stays in place.
              </span>
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
                    data-testid="import-rag-sources-error"
                  >
                    <AlertTriangle className="h-4 w-4 shrink-0 mt-0.5" />
                    {error}
                  </div>
                )}

                {result && (
                  <div
                    className="rounded-md border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-sm text-emerald-700 dark:text-emerald-300"
                    data-testid="import-rag-sources-result"
                  >
                    Adopted {result.adoptedCount} source
                    {result.adoptedCount === 1 ? "" : "s"} into editable
                    database settings.
                    {result.skipped.length > 0 && (
                      <ul className="mt-1 list-disc pl-5">
                        {result.skipped.map((skip) => (
                          <li key={skip.source_id}>
                            {skip.source_id}: {SKIP_REASON_LABEL[skip.reason]}
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                )}

                <div className="space-y-3 rounded-md border p-3">
                  <div>
                    <Label htmlFor="rag-import-owner" className="block">
                      Owner
                    </Label>
                    <p className="mb-1.5 text-xs text-muted-foreground">
                      Manages connector settings, reloads, and deletion for
                      every source adopted below.
                    </p>
                    <AccessSubjectPicker
                      id="rag-import-owner"
                      teams={teams}
                      knownUsers={[]}
                      value={owner}
                      onChange={setOwner}
                      placeholder="Select a person or team"
                      searchPlaceholder="Search people or teams..."
                      ariaLabel="Owner"
                      disabled={applying}
                    />
                  </div>
                  <div>
                    <Label htmlFor="rag-import-search" className="block">
                      Search Access (optional)
                    </Label>
                    <p className="mb-1.5 text-xs text-muted-foreground">
                      Lets selected people and teams query these sources
                      through Search, APIs, and agents. Leave empty to grant
                      no Search Access on adoption - add it later per source.
                    </p>
                    <AccessSubjectMultiPicker
                      id="rag-import-search"
                      teams={teams}
                      knownUsers={[]}
                      selected={searchAccess}
                      onChange={setSearchAccess}
                      placeholder="No Search Access — add people or teams"
                      searchPlaceholder="Search people or teams..."
                      ariaLabel="Search Access"
                      disabled={applying}
                      maxSelections={100}
                      maxSelectionsByKind={{ team: 50, user: 200 }}
                    />
                  </div>
                </div>

                <div className="min-w-0 space-y-1 break-words text-xs text-muted-foreground">
                  <p>
                    Found {configuredSourceCount} source
                    {configuredSourceCount === 1 ? "" : "s"} in app config. The
                    checklist controls which seeded settings become editable.
                  </p>
                </div>

                {previewSources.length === 0 ? (
                  <p className="text-sm text-muted-foreground">
                    No RAG sources are available in app config.
                  </p>
                ) : (
                  <div
                    className="max-h-56 space-y-1 overflow-y-auto rounded-md border p-2"
                    data-testid="import-rag-sources-checklist"
                  >
                    {previewSources.map((source) => (
                      <label
                        key={source.source_id}
                        className="flex items-start gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-muted/50"
                      >
                        <input
                          type="checkbox"
                          checked={selectedIds.has(source.source_id)}
                          disabled={!source.importable}
                          onChange={() => toggleSelected(source.source_id)}
                          data-testid={`import-rag-source-checkbox-${source.source_id}`}
                        />
                        <span className="min-w-0 flex-1">
                          <span className="block truncate">{source.name}</span>
                          {source.unavailable_reason === "not_seeded" && (
                            <span className="mt-0.5 block text-xs text-muted-foreground">
                              This config entry has not been seeded into the
                              database. Check the UI startup logs for validation
                              errors.
                            </span>
                          )}
                          {source.unavailable_reason === "not_config_driven" && (
                            <span className="mt-0.5 block text-xs text-muted-foreground">
                              A UI-managed source already uses this identity.
                            </span>
                          )}
                        </span>
                        {source.unavailable_reason ? (
                          <Badge variant="secondary" className="shrink-0">
                            Unavailable
                          </Badge>
                        ) : source.already_adopted ? (
                          <Badge variant="secondary" className="shrink-0">
                            Already adopted
                          </Badge>
                        ) : null}
                      </label>
                    ))}
                  </div>
                )}

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
              disabled={
                loading || applying || !owner || selectedIds.size === 0
              }
              className="gap-2"
              data-testid="import-rag-sources-apply-button"
            >
              {applying && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
              Adopt {selectedIds.size > 0 ? selectedIds.size : ""} source
              {selectedIds.size === 1 ? "" : "s"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}

export default ImportRagSourcesFromConfigCard;
