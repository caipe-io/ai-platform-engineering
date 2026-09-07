"use client";

/**
 * Admin -> Settings -> General pane for adopting already-ingested RAG
 * datasources into the DB as source of truth (spec
 * 2026-07-21-rag-source-config-db, US5) — mirrors
 * `ImportAgentsFromConfigCard.tsx`, adapted for `rag_ingestion_sources`
 * where the preview is sourced from the RAG server's `DataSourceInfo`
 * records (the BFF cannot read ingestor-pod env vars) and skips carry a
 * `reason`.
 *
 * Flow: the preview lists sources originating in environment configuration,
 * including disabled rows for prior imports. Applying creates editable
 * settings where supported and adds the sources to the selected collection
 * without changing that collection's Owner or Search access.
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
  unavailable_reason?: "unsupported_legacy_id";
}

type SkipReason =
  | "not_found_in_redis"
  | "missing_identity_fields"
  | "already_in_db"
  | "unsupported_legacy_id";

interface AdoptSkip {
  source_id: string;
  reason: SkipReason;
}

interface TeamRow {
  slug?: string;
  name?: string;
}

const SKIP_REASON_LABEL: Record<SkipReason, string> = {
  not_found_in_redis: "not found",
  missing_identity_fields: "missing required settings",
  already_in_db: "already imported",
  unsupported_legacy_id: "must be re-added before it can be imported",
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
  const [legacySourceCount, setLegacySourceCount] = useState(0);
  const [compatibleSourceCount, setCompatibleSourceCount] = useState(0);
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
    agentsUpdated: number;
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
            previewRes.error || "Could not load sources from deployment settings",
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
        const sources = (
          (previewRes.data?.sources ?? []) as PreviewSource[]
        ).filter(
          (source) =>
            source.importable ||
            source.already_adopted ||
            source.unavailable_reason,
        );
        setLegacySourceCount(previewRes.data?.legacy_source_count ?? sources.length);
        setCompatibleSourceCount(
          previewRes.data?.compatible_source_count ??
            sources.filter((source) => !source.unavailable_reason).length,
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
        agentsUpdated: data.data.destination_collection?.agents_updated ?? 0,
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
          Import Existing RAG Sources
        </CardTitle>
        <CardDescription>
          Bring existing sources into Knowledge Bases without ingesting them
          again.
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
          Review Sources
        </Button>
      </CardContent>

      <Dialog open={open} onOpenChange={(next) => !applying && setOpen(next)}>
        <DialogContent className="flex max-h-[85vh] w-[calc(100vw-2rem)] flex-col overflow-visible sm:max-w-[680px]">
          <DialogHeader>
            <DialogTitle>Import existing RAG sources</DialogTitle>
            <DialogDescription>
              <span className="block">
                Choose where to add sources that were configured when this
                platform was deployed. Their indexed content stays in place.
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
                    Added the sources to {result.destinationName}. The
                    collection now contains {result.destinationSourceCount} source
                    {result.destinationSourceCount === 1 ? "" : "s"}.
                    {result.adopted.length > 0 && (
                      <>
                        {" "}
                        Imported editable settings for {result.adopted.length} source
                        {result.adopted.length === 1 ? "" : "s"}.
                      </>
                    )}
                    {result.agentsUpdated > 0 && (
                      <>
                        {" "}
                        Updated {result.agentsUpdated} existing agent
                        {result.agentsUpdated === 1 ? "" : "s"}.
                      </>
                    )}
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
                        Imported sources use this collection&apos;s current
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
                    Found {legacySourceCount} existing source
                    {legacySourceCount === 1 ? "" : "s"}. {compatibleSourceCount}{" "}
                    will be added to{" "}
                    {destinationCollection?.name ?? "the selected collection"}.
                  </p>
                  {legacySourceCount > compatibleSourceCount && (
                    <p>
                      {legacySourceCount - compatibleSourceCount} older source
                      {legacySourceCount - compatibleSourceCount === 1 ? "" : "s"}{" "}
                      cannot be imported and must be re-added from Data Sources.
                    </p>
                  )}
                  <p>
                    The checklist controls which supported connector settings
                    become editable here. Sources that are not listed or
                    selected are still added to the collection.
                  </p>
                </div>

                {previewSources.length === 0 ? (
                  <p className="text-sm text-muted-foreground">
                    No connector settings can be imported. The sources can
                    still be added to the collection.
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
                          {source.unavailable_reason ===
                            "unsupported_legacy_id" && (
                            <span className="mt-0.5 block text-xs text-muted-foreground">
                              This source uses an older format. Re-add it from
                              Data Sources before importing it.
                            </span>
                          )}
                        </span>
                        {source.unavailable_reason === "unsupported_legacy_id" ? (
                          <Badge variant="destructive" className="shrink-0">
                            Re-add required
                          </Badge>
                        ) : source.already_adopted ? (
                          <Badge variant="secondary" className="shrink-0">
                            Already imported
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
              Import to {destinationCollection?.name ?? "collection"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}

export default ImportRagSourcesFromConfigCard;
