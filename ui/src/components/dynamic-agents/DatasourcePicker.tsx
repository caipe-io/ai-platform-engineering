"use client";

import {
  AlertCircle,
  GripVertical,
  Layers3,
  Loader2,
  Search,
} from "lucide-react";
import React from "react";

import {
  DatasourceOptionRow,
  datasourceKind,
  KnowledgeCardHand,
  knowledgeCardStats,
  startKnowledgeDrag,
  type KnowledgeCardItem,
  type KnowledgeCardStats,
  type KnowledgeDragCandidate,
} from "@/components/rag/KnowledgeCardSelector";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";

interface AvailableDatasource {
  datasource_id: string;
  name: string;
  source_type?: string;
  document_count?: number;
  chunk_count?: number;
}

interface AvailableCollection {
  _id: string;
  name: string;
  description?: string;
  is_platform?: boolean;
  source_ids?: string[];
  _permissions?: { can_read?: boolean };
}

interface DatasourcePickerProps {
  /** Optional owning team slug; global agents use caller-readable sources. */
  ownerTeamSlug: string;
  value: string[];
  onChange: (datasourceIds: string[]) => void;
  collectionValue: string[];
  onCollectionChange: (collectionIds: string[]) => void;
  /** Select Platform RAG once, but only when it actually exists. */
  defaultToPlatform?: boolean;
  disabled?: boolean;
}

/**
 * Select reusable knowledge-base collections and optional individual sources.
 * This is always a pin, never a grant: the RAG server independently
 * intersects the expanded source ids with the caller's OpenFGA access.
 */
export function DatasourcePicker({
  ownerTeamSlug,
  value,
  onChange,
  collectionValue,
  onCollectionChange,
  defaultToPlatform = false,
  disabled,
}: DatasourcePickerProps) {
  const [available, setAvailable] = React.useState<AvailableDatasource[]>([]);
  const [collections, setCollections] = React.useState<AvailableCollection[]>(
    [],
  );
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [search, setSearch] = React.useState("");
  const [dragCandidate, setDragCandidate] =
    React.useState<KnowledgeDragCandidate | null>(null);
  const appliedPlatformDefault = React.useRef(false);

  React.useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      setError(null);
      const datasourceUrl = ownerTeamSlug
        ? `/api/dynamic-agents/datasources?team_slug=${encodeURIComponent(ownerTeamSlug)}`
        : "/api/dynamic-agents/datasources";
      const [datasourceResult, collectionResult] = await Promise.allSettled([
        fetch(datasourceUrl).then((response) => response.json()),
        fetch("/api/rag/collections").then((response) => response.json()),
      ]);
      if (cancelled) return;

      if (
        datasourceResult.status === "fulfilled" &&
        datasourceResult.value?.success &&
        Array.isArray(datasourceResult.value.data?.datasources)
      ) {
        setAvailable(datasourceResult.value.data.datasources);
      } else {
        setError("Failed to load available datasources");
      }
      if (
        collectionResult.status === "fulfilled" &&
        collectionResult.value?.success &&
        Array.isArray(collectionResult.value.data?.collections)
      ) {
        setCollections(
          collectionResult.value.data.collections.filter(
            (collection: AvailableCollection) =>
              collection._permissions?.can_read === true,
          ),
        );
      }
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [ownerTeamSlug]);

  React.useEffect(() => {
    if (!defaultToPlatform || appliedPlatformDefault.current) return;
    const platform = collections.find((item) => item.is_platform === true);
    if (!platform) return;
    appliedPlatformDefault.current = true;
    if (collectionValue.length === 0 && value.length === 0) {
      onCollectionChange([platform._id]);
    }
  }, [
    collections,
    collectionValue.length,
    defaultToPlatform,
    onCollectionChange,
    value.length,
  ]);

  const datasource = (id: string): AvailableDatasource | undefined =>
    available.find((item) => item.datasource_id === id);
  const datasourceName = (id: string): string => datasource(id)?.name || id;
  const collectionName = (id: string): string =>
    collections.find((item) => item._id === id)?.name || id;
  const selectedCollectionNamesBySource = new Map<string, string[]>();
  for (const collectionId of collectionValue) {
    const collection = collections.find((item) => item._id === collectionId);
    if (!collection) continue;
    for (const sourceId of collection.source_ids ?? []) {
      const names = selectedCollectionNamesBySource.get(sourceId) ?? [];
      names.push(collection.name);
      selectedCollectionNamesBySource.set(sourceId, names);
    }
  }
  const collectionCoverageLabel = (
    datasourceId: string,
    prefix = "Included via",
  ): string | undefined => {
    const names = selectedCollectionNamesBySource.get(datasourceId);
    if (!names?.length) return undefined;
    return names.length === 1
      ? `${prefix} ${names[0]}`
      : `${prefix} ${names[0]} +${names.length - 1} more`;
  };
  const collectionStats = (
    datasourceIds: string[] | undefined,
  ): KnowledgeCardStats | undefined => {
    const uniqueIds = [...new Set(datasourceIds ?? [])];
    if (uniqueIds.length === 0) return undefined;
    const memberStats = uniqueIds.map((id) => {
      const option = datasource(id);
      return knowledgeCardStats(option?.document_count, option?.chunk_count);
    });
    if (memberStats.some((stats) => !stats)) return undefined;
    return memberStats.reduce<KnowledgeCardStats>(
      (total, stats) => ({
        documentCount: total.documentCount + (stats?.documentCount ?? 0),
        chunkCount: total.chunkCount + (stats?.chunkCount ?? 0),
      }),
      { documentCount: 0, chunkCount: 0 },
    );
  };

  const selectedCards: KnowledgeCardItem[] = [
    ...collectionValue.map((id) => {
      const collection = collections.find((item) => item._id === id);
      const count = collection?.source_ids?.length;
      return {
        id,
        name: collectionName(id),
        kind: "collection" as const,
        stats: collectionStats(collection?.source_ids),
        subtitle:
          typeof count === "number"
            ? `${count} source${count === 1 ? "" : "s"} · stays in sync`
            : "Knowledge collection · stays in sync",
      };
    }),
    ...value.map((id) => {
      const option = datasource(id);
      return {
        id,
        name: datasourceName(id),
        kind: "datasource" as const,
        datasourceKind: datasourceKind(option?.source_type, id),
        stats: knowledgeCardStats(option?.document_count, option?.chunk_count),
        muted: Boolean(collectionCoverageLabel(id)),
        subtitle:
          collectionCoverageLabel(id, "Also included via") ??
          "Individual datasource",
      };
    }),
  ];

  const normalizedSearch = search.trim().toLowerCase();
  const selectableCollections = collections.filter(
    (item) =>
      !collectionValue.includes(item._id) &&
      (!normalizedSearch ||
        item.name.toLowerCase().includes(normalizedSearch) ||
        item.description?.toLowerCase().includes(normalizedSearch)),
  );
  const selectableDatasources = available.filter(
    (item) =>
      !value.includes(item.datasource_id) &&
      (!normalizedSearch || item.name.toLowerCase().includes(normalizedSearch)),
  );

  function removeCard(card: KnowledgeCardItem): void {
    if (card.kind === "collection") {
      onCollectionChange(collectionValue.filter((id) => id !== card.id));
    } else {
      onChange(value.filter((id) => id !== card.id));
    }
  }

  function addCandidate(candidate: KnowledgeDragCandidate): void {
    if (disabled) return;
    if (candidate.kind === "collection") {
      if (!collectionValue.includes(candidate.id)) {
        onCollectionChange([...collectionValue, candidate.id]);
      }
    } else if (!value.includes(candidate.id)) {
      onChange([...value, candidate.id]);
    }
  }

  function startCandidateDrag(
    event: React.DragEvent,
    candidate: KnowledgeDragCandidate,
  ): void {
    if (disabled) return;
    setDragCandidate(candidate);
    startKnowledgeDrag(event, candidate);
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center p-8 text-muted-foreground">
        <Loader2 className="mr-2 h-5 w-5 animate-spin" />
        Loading knowledge bases...
      </div>
    );
  }

  return (
    <div className="space-y-6 rounded-xl border bg-gradient-to-br from-primary/[0.04] via-background to-background p-5">
      <div>
        <h3 className="text-base font-semibold">Agent knowledge</h3>
        <p className="mt-1 text-sm text-muted-foreground">
          Collections are the easiest way to keep an agent current as their
          Owners add or remove datasources. Add individual datasources when you
          need a precise pin. Every query still respects the caller&apos;s Search
          access.
        </p>
      </div>

      {error && (
        <div className="flex items-center gap-2 rounded-lg bg-destructive/10 p-3 text-sm text-destructive">
          <AlertCircle className="h-4 w-4" />
          {error}
        </div>
      )}

      <KnowledgeCardHand
        items={selectedCards}
        onRemove={removeCard}
        disabled={disabled}
        dragCandidate={dragCandidate}
        onDropCandidate={(candidate) => {
          addCandidate(candidate);
          setDragCandidate(null);
        }}
        ariaLabel="Selected agent knowledge"
        emptyTitle="Drop a collection or datasource here."
        emptyDescription="With an empty hand, this agent's RAG tools return no source results."
      />

      <div className="relative">
        <Search className="absolute left-3 top-2.5 h-4 w-4 text-muted-foreground" />
        <Input
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          placeholder="Search collections and datasources..."
          className="pl-9"
          disabled={disabled}
        />
      </div>

      {selectableCollections.length > 0 && (
        <div className="space-y-3">
          <div>
            <p className="text-sm font-semibold">Collections</p>
            <p className="text-xs text-muted-foreground">
              Drag one into the hand or click it. Membership changes propagate
              to this agent automatically.
            </p>
          </div>
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {selectableCollections.map((collection) => (
              <button
                key={collection._id}
                type="button"
                draggable={!disabled}
                disabled={disabled}
                onDragStart={(event) =>
                  startCandidateDrag(event, {
                    kind: "collection",
                    id: collection._id,
                  })
                }
                onDragEnd={() => setDragCandidate(null)}
                onClick={() =>
                  onCollectionChange([...collectionValue, collection._id])
                }
                className="group flex min-w-0 items-center gap-3 rounded-xl border border-violet-400/25 bg-violet-500/5 p-3 text-left transition-all hover:-translate-y-0.5 hover:border-violet-400/60 hover:bg-violet-500/10 hover:shadow-md disabled:opacity-50"
              >
                <GripVertical className="h-4 w-4 shrink-0 text-muted-foreground/45 group-hover:text-violet-300" />
                <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-violet-500/15 text-violet-300">
                  <Layers3 className="h-5 w-5" />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-2 text-sm font-medium">
                    <span className="truncate">{collection.name}</span>
                    {collection.is_platform && (
                      <Badge variant="secondary">Default</Badge>
                    )}
                  </span>
                  <span className="mt-0.5 block truncate text-xs text-muted-foreground">
                    {collection.description ||
                      `${collection.source_ids?.length ?? 0} grouped datasources`}
                  </span>
                </span>
              </button>
            ))}
          </div>
        </div>
      )}

      {selectableDatasources.length > 0 && (
        <div className="space-y-3">
          <div>
            <p className="text-sm font-semibold">Individual datasources</p>
            <p className="text-xs text-muted-foreground">
              Use these when this agent needs specific sources. Note that it may
              already be a part of a collection.
            </p>
          </div>
          <div className="max-h-72 space-y-1 overflow-y-auto rounded-xl border p-2">
            {selectableDatasources.map((option) => {
              const coverage = collectionCoverageLabel(option.datasource_id);
              return (
                <DatasourceOptionRow
                  key={option.datasource_id}
                  datasourceId={option.datasource_id}
                  name={option.name}
                  sourceType={option.source_type}
                  annotation={coverage}
                  muted={Boolean(coverage)}
                  title={
                    coverage
                      ? `${coverage}. Selecting it directly keeps an explicit pin even if collection membership changes.`
                      : undefined
                  }
                  disabled={disabled}
                  onDragStart={(event) =>
                    startCandidateDrag(event, {
                      kind: "datasource",
                      id: option.datasource_id,
                    })
                  }
                  onDragEnd={() => setDragCandidate(null)}
                  onClick={() => onChange([...value, option.datasource_id])}
                />
              );
            })}
          </div>
        </div>
      )}

      {selectableCollections.length === 0 &&
        selectableDatasources.length === 0 &&
        normalizedSearch && (
          <p className="py-3 text-center text-sm text-muted-foreground">
            No available knowledge matches &ldquo;{search}&rdquo;.
          </p>
        )}
    </div>
  );
}
