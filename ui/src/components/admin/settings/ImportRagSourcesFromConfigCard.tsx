"use client";

/**
 * Admin control for adopting application-config RAG sources into MongoDB as
 * the editable source of truth. It mirrors config-driven agent adoption while
 * assigning the adopted sources to a collection with an established Owner.
 */

import { AlertTriangle, FileUp, Loader2 } from "lucide-react";
import { useEffect, useState } from "react";

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
import { SearchablePicker } from "@/components/ui/searchable-picker";
import {
  PLATFORM_RAG_COLLECTION_ID,
  type RagCollectionWithPermissions,
} from "@/types/rag-collection";

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

interface TeamRow {
  slug?: string;
  name?: string;
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
  const [collections, setCollections] = useState<
    RagCollectionWithPermissions[]
  >([]);
  const [teams, setTeams] = useState<TeamRow[]>([]);
  const [destinationCollectionId, setDestinationCollectionId] = useState(
    PLATFORM_RAG_COLLECTION_ID,
  );
  const [result, setResult] = useState<{
    adopted: string[];
    skipped: AdoptSkip[];
    destinationName: string;
    destinationSourceCount: number;
  } | null>(null);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    setResult(null);
    setDestinationCollectionId(PLATFORM_RAG_COLLECTION_ID);
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
        const [collectionRes, teamRes] = await Promise.all([
          fetch("/api/rag/collections").then((response) => response.json()),
          fetch("/api/dynamic-agents/teams").then((response) => response.json()),
        ]);
        if (cancelled) return;
        if (!collectionRes?.success) {
          throw new Error(collectionRes?.error || "Could not load collections");
        }
        const availableCollections = (
          (collectionRes.data?.collections ?? []) as RagCollectionWithPermissions[]
        ).filter(
          (collection) =>
            collection._permissions.can_publish || collection._permissions.can_manage,
        );
        if (availableCollections.length === 0) {
          throw new Error("No collection is available for this import");
        }
        const defaultDestination =
          availableCollections.find(
            (collection) => collection._id === PLATFORM_RAG_COLLECTION_ID,
          ) ?? availableCollections[0];
        const sources = (previewRes.data?.sources ?? []) as PreviewSource[];
        setConfiguredSourceCount(
          previewRes.data?.configured_source_count ?? sources.length,
        );
        setPreviewSources(sources);
        setCollections(availableCollections);
        setTeams(
          teamRes?.success && Array.isArray(teamRes.data) ? teamRes.data : [],
        );
        setDestinationCollectionId(defaultDestination._id);
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
    if (readOnly) return;
    setApplying(true);
    setError(null);
    try {
      const res = await fetch("/api/admin/rag/sources/migrate-from-config", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          dry_run: false,
          source_ids: Array.from(selectedIds),
          destination_collection_id: destinationCollectionId,
        }),
      });
      const data = await res.json();
      if (!data.success) {
        setError(data.error || "Import failed");
        return;
      }
      setResult({
        adopted: data.data.adopted ?? [],
        skipped: data.data.skipped ?? [],
        destinationName:
          collections.find(
            (collection) => collection._id === destinationCollectionId,
          )?.name ?? "the selected collection",
        destinationSourceCount:
          data.data.destination_collection?.source_count ?? 0,
      });
      setPreviewSources((prev) =>
        prev.map((s) =>
          data.data.adopted?.includes(s.source_id)
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

  const destinationCollection = collections.find(
    (collection) => collection._id === destinationCollectionId,
  );
  const teamName = (slug: string): string =>
    teams.find((team) => team.slug === slug)?.name ??
    slug
      .split("-")
      .filter(Boolean)
      .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
      .join(" ");
  const ownerLabel = destinationCollection?.maintainer_team_slugs.length
    ? destinationCollection.maintainer_team_slugs.map(teamName).join(", ")
    : "Personal owner";
  const searchLabel = destinationCollection?.global_read
    ? "Everyone"
    : destinationCollection?.reader_team_slugs.length
      ? destinationCollection.reader_team_slugs.map(teamName).join(", ")
      : "Owner only";

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
                Choose which read-only app-config sources to make editable and
                which collection should contain them. Indexed content stays in
                place.
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
                    Adopted {result.adopted.length} source
                    {result.adopted.length === 1 ? "" : "s"} into editable
                    database settings and added them to {result.destinationName}.
                    The collection now contains {result.destinationSourceCount}{" "}
                    source{result.destinationSourceCount === 1 ? "" : "s"}.
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

                <div className="space-y-2 rounded-md border p-3">
                  <Label htmlFor="rag-import-destination" className="block">
                    Destination collection
                  </Label>
                  <SearchablePicker
                    id="rag-import-destination"
                    options={collections}
                    selected={collections.find(
                      (collection) => collection._id === destinationCollectionId,
                    )}
                    onSelect={(collection) =>
                      setDestinationCollectionId(collection._id)
                    }
                    getOptionKey={(collection) => collection._id}
                    getOptionLabel={(collection) =>
                      `${collection.name}${collection.is_platform ? " (recommended)" : ""}`
                    }
                    getSearchText={(collection) => [
                      collection._id,
                      collection.name,
                    ]}
                    placeholder="Select a destination collection"
                    searchPlaceholder="Search collections..."
                    emptyLabel="No collections available"
                    ariaLabel="Destination collection"
                    required
                    disabled={applying || collections.length === 0}
                    triggerClassName="h-10 text-sm"
                  />
                  {destinationCollection && (
                    <div className="space-y-1 text-xs leading-relaxed text-muted-foreground">
                      <p>
                        Adopted sources use this collection&apos;s current
                        access.
                        {destinationCollection.is_platform
                          ? " Platform RAG is recommended because it keeps the shared access used before Knowledge Bases were managed here."
                          : ""}
                      </p>
                      <p>
                        <span className="font-medium text-foreground">Owner:</span>{" "}
                        {ownerLabel}
                        <span aria-hidden="true"> · </span>
                        <span className="font-medium text-foreground">Search:</span>{" "}
                        {searchLabel}
                      </p>
                    </div>
                  )}
                </div>

                <div className="min-w-0 space-y-1 break-words text-xs text-muted-foreground">
                  <p>
                    Found {configuredSourceCount} source
                    {configuredSourceCount === 1 ? "" : "s"} in app config. The
                    checklist controls which seeded settings become editable
                    and are added to{" "}
                    {destinationCollection?.name ?? "the selected collection"}.
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
                loading || applying || !destinationCollectionId
              }
              className="gap-2"
              data-testid="import-rag-sources-apply-button"
            >
              {applying && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
              Adopt into {destinationCollection?.name ?? "collection"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}

export default ImportRagSourcesFromConfigCard;
