"use client";

import {
  Database,
  Layers3,
  Loader2,
  Plus,
  Save,
  Search,
  ShieldCheck,
  Trash2,
  Users,
} from "lucide-react";
import { useRouter, useSearchParams } from "next/navigation";
import React from "react";

import {
  DatasourceOptionRow,
  datasourceKind,
  KnowledgeCardHand,
  knowledgeCardStats,
  startKnowledgeDrag,
  type KnowledgeCardItem,
  type KnowledgeDragCandidate,
} from "@/components/rag/KnowledgeCardSelector";
import { DatasourceAccessFields } from "@/components/rag/DatasourceAccessFields";
import { WorkspacePageActions } from "@/components/layout/WorkspacePageActions";
import { UnsavedChangesDialog } from "@/components/shared/UnsavedChangesDialog";
import { BuiltInResourceHint } from "@/components/ui/built-in-resource-hint";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  TeamMultiPicker,
  type TeamPickerOption,
} from "@/components/ui/team-picker";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/components/ui/toast";
import { cn } from "@/lib/utils";
import { useUnsavedChangesStore } from "@/store/unsaved-changes-store";
import type { RagCollectionWithPermissions } from "@/types/rag-collection";

interface DatasourceOption {
  datasource_id: string;
  name: string;
  source_type?: string;
  document_count?: number;
  chunk_count?: number;
  can_manage?: boolean;
  can_read?: boolean;
}

interface TeamRow {
  _id?: string;
  slug?: string;
  name?: string;
}

interface CollectionDraftSnapshot {
  name: string;
  description: string;
  sourceIds: string[];
  maintainerTeamSlugs: string[];
  readerTeamSlugs: string[];
}

interface CollectionMutationResponse {
  success?: boolean;
  error?: string;
  data?: {
    _id?: unknown;
    _publication_request?: unknown;
  };
}

function collectionDraftSnapshot(input: {
  name?: string;
  description?: string;
  sourceIds?: readonly string[];
  maintainerTeamSlugs?: readonly string[];
  readerTeamSlugs?: readonly string[];
}): CollectionDraftSnapshot {
  return {
    name: input.name ?? "",
    description: input.description ?? "",
    sourceIds: [...(input.sourceIds ?? [])].sort(),
    maintainerTeamSlugs: [...(input.maintainerTeamSlugs ?? [])].sort(),
    readerTeamSlugs: [...(input.readerTeamSlugs ?? [])].sort(),
  };
}

/** Manage reusable RAG collections without moving or duplicating indexed data. */
export function RagCollectionsView() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { toast } = useToast();
  const [collections, setCollections] = React.useState<
    RagCollectionWithPermissions[]
  >([]);
  const [datasources, setDatasources] = React.useState<DatasourceOption[]>([]);
  const [teams, setTeams] = React.useState<TeamRow[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [saving, setSaving] = React.useState(false);
  const [isCreating, setIsCreating] = React.useState(
    searchParams.get("new") === "1",
  );
  const [sourceSearch, setSourceSearch] = React.useState("");
  const [dragCandidate, setDragCandidate] =
    React.useState<KnowledgeDragCandidate | null>(null);
  const [selectedId, setSelectedId] = React.useState<string | null>(
    searchParams.get("new") === "1"
      ? null
      : searchParams.get("collection"),
  );
  const [draftName, setDraftName] = React.useState("");
  const [draftDescription, setDraftDescription] = React.useState("");
  const [draftSources, setDraftSources] = React.useState<string[]>([]);
  const [draftMaintainers, setDraftMaintainers] = React.useState<string[]>([]);
  const [draftReaders, setDraftReaders] = React.useState<string[]>([]);
  const [draftKey, setDraftKey] = React.useState<string | null>(
    searchParams.get("new") === "1" ? "new" : null,
  );

  const selected = isCreating
    ? null
    : (collections.find((item) => item._id === selectedId) ?? null);
  // User-created collections retain their personal owner as a reader even
  // after team delegation, so additions must not elevate that owner's access.
  const selectedHasPersonalOwner = isCreating || Boolean(selected?.owner_subject);
  const canManageDraft = isCreating || selected?._permissions.can_manage === true;
  const canPublishDraft =
    isCreating || selected?._permissions.can_publish === true;
  const canDelegateDraft = isCreating
    ? collections.some((item) => item._permissions.can_delegate)
    : selected?._permissions.can_delegate === true;
  const currentDraft = collectionDraftSnapshot({
    name: draftName,
    description: draftDescription,
    sourceIds: draftSources,
    maintainerTeamSlugs: draftMaintainers,
    readerTeamSlugs: draftReaders,
  });
  const savedDraft = collectionDraftSnapshot(
    selected
      ? {
          name: selected.name,
          description: selected.description,
          sourceIds: selected.source_ids,
          maintainerTeamSlugs: selected.maintainer_team_slugs,
          readerTeamSlugs: selected.reader_team_slugs,
        }
      : {},
  );
  const dirty = Boolean(
    (isCreating || selected) &&
      (isCreating ? draftKey === "new" : draftKey === selected?._id) &&
      (canManageDraft || canPublishDraft) &&
      JSON.stringify(currentDraft) !== JSON.stringify(savedDraft),
  );
  const {
    setUnsaved,
    pendingNavigationHref,
    pendingDeferredAction,
    requestDeferredAction,
    cancelNavigation,
    confirmNavigation,
    confirmDeferredAction,
  } = useUnsavedChangesStore();

  React.useEffect(() => {
    setUnsaved(dirty);
  }, [dirty, setUnsaved]);

  React.useEffect(() => {
    return () => setUnsaved(false);
  }, [setUnsaved]);

  React.useEffect(() => {
    const handleBeforeUnload = (event: BeforeUnloadEvent): void => {
      if (!dirty) return;
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", handleBeforeUnload);
    return () => window.removeEventListener("beforeunload", handleBeforeUnload);
  }, [dirty]);

  const replaceCollectionUrl = React.useCallback(
    (id: string | null, creating = false): void => {
      const params = new URLSearchParams(searchParams.toString());
      if (id) {
        params.set("collection", id);
        params.delete("new");
      } else {
        params.delete("collection");
        if (creating) params.set("new", "1");
        else params.delete("new");
      }
      const query = params.toString();
      router.replace(
        `/knowledge-bases/collections${query ? `?${query}` : ""}`,
        { scroll: false },
      );
    },
    [router, searchParams],
  );

  const load = React.useCallback(async () => {
    setLoading(true);
    try {
      const [collectionResponse, datasourceResponse, teamResponse] =
        await Promise.all([
          fetch("/api/rag/collections").then((response) => response.json()),
          fetch("/api/dynamic-agents/datasources?purpose=publish").then(
            (response) => response.json(),
          ),
          fetch("/api/dynamic-agents/teams").then((response) =>
            response.json(),
          ),
        ]);
      if (!collectionResponse?.success) {
        throw new Error(
          collectionResponse?.error || "Could not load knowledge bases",
        );
      }
      const nextCollections = (collectionResponse.data?.collections ??
        []) as RagCollectionWithPermissions[];
      setCollections(nextCollections);
      setDatasources(
        datasourceResponse?.success &&
          Array.isArray(datasourceResponse.data?.datasources)
          ? datasourceResponse.data.datasources
          : [],
      );
      setTeams(
        teamResponse?.success && Array.isArray(teamResponse.data)
          ? teamResponse.data
          : [],
      );
      setSelectedId((current) =>
        current && nextCollections.some((item) => item._id === current)
          ? current
          : null,
      );
    } catch (error) {
      toast(
        error instanceof Error
          ? error.message
          : "Could not load knowledge bases",
        "error",
      );
    } finally {
      setLoading(false);
    }
  }, [toast]);

  React.useEffect(() => {
    void load();
  }, [load]);

  React.useEffect(() => {
    if (loading) return;
    const requestedId = searchParams.get("collection");
    if (
      requestedId &&
      !collections.some((collection) => collection._id === requestedId)
    ) {
      replaceCollectionUrl(null, isCreating);
    }
  }, [collections, isCreating, loading, replaceCollectionUrl, searchParams]);

  React.useEffect(() => {
    if (!selected || isCreating) return;
    setDraftName(selected.name);
    setDraftDescription(selected.description ?? "");
    setDraftSources(selected.source_ids ?? []);
    setDraftMaintainers(selected.maintainer_team_slugs ?? []);
    setDraftReaders(selected.reader_team_slugs ?? []);
    setDraftKey(selected._id);
  }, [isCreating, selected]);

  function openCollection(id: string): void {
    setIsCreating(false);
    setDraftKey(null);
    setSelectedId(id);
    replaceCollectionUrl(id);
  }

  function beginCreate(): void {
    setIsCreating(true);
    setSelectedId(null);
    setDraftName("");
    setDraftDescription("");
    setDraftSources([]);
    setDraftMaintainers([]);
    setDraftReaders([]);
    setDraftKey("new");
    setSourceSearch("");
    replaceCollectionUrl(null, true);
  }

  function closeEditor(): void {
    setIsCreating(false);
    setSelectedId(null);
    setDraftName("");
    setDraftDescription("");
    setDraftSources([]);
    setDraftMaintainers([]);
    setDraftReaders([]);
    setDraftKey(null);
    setSourceSearch("");
    replaceCollectionUrl(null);
  }

  function runGuarded(action: () => void): void {
    if (!dirty) {
      action();
      return;
    }
    setUnsaved(true);
    requestDeferredAction(action);
  }

  function cancelDiscard(): void {
    cancelNavigation();
  }

  function confirmDiscard(): void {
    if (pendingDeferredAction) {
      confirmDeferredAction();
      return;
    }
    const href = confirmNavigation();
    if (href) window.location.href = href;
  }

  async function saveCollection(): Promise<void> {
    if (!selected && !isCreating) return;
    setSaving(true);
    let createdId: string | null = null;
    try {
      let result: CollectionMutationResponse;
      if (isCreating) {
        const createResponse = await fetch("/api/rag/collections", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name: draftName.trim(),
            description: draftDescription.trim() || undefined,
          }),
        });
        result = await createResponse.json();
        if (
          !createResponse.ok ||
          !result?.success ||
          typeof result.data?._id !== "string"
        ) {
          throw new Error(result?.error || "Could not create knowledge base");
        }
        createdId = result.data._id;

        const hasAdditionalSettings =
          draftSources.length > 0 ||
          draftReaders.length > 0 ||
          (canDelegateDraft && draftMaintainers.length > 0);
        if (hasAdditionalSettings) {
          const updateBody: Record<string, unknown> = {
            source_ids: draftSources,
            reader_team_slugs: draftReaders,
          };
          if (canDelegateDraft) {
            updateBody.maintainer_team_slugs = draftMaintainers;
          }
          const updateResponse = await fetch(
            `/api/rag/collections/${encodeURIComponent(createdId)}`,
            {
              method: "PATCH",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(updateBody),
            },
          );
          result = await updateResponse.json();
          if (!updateResponse.ok || !result?.success) {
            throw new Error(
              result?.error || "Could not save all collection settings",
            );
          }
        }
      } else {
        const body: Record<string, unknown> = {};
        if (canPublishDraft) body.source_ids = draftSources;
        if (canManageDraft) {
          body.name = draftName;
          body.description = draftDescription;
          body.reader_team_slugs = draftReaders;
        }
        if (canDelegateDraft) {
          body.maintainer_team_slugs = draftMaintainers;
        }
        const response = await fetch(
          `/api/rag/collections/${encodeURIComponent(selected!._id)}`,
          {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
          },
        );
        result = await response.json();
        if (!response.ok || !result?.success) {
          throw new Error(result?.error || "Could not update knowledge base");
        }
      }

      const savedId = createdId ?? selected!._id;
      const wasCreating = isCreating;
      setUnsaved(false);
      setIsCreating(false);
      setDraftKey(null);
      await load();
      openCollection(savedId);
      const pending = result.data?._publication_request;
      toast(
        pending
          ? wasCreating
            ? "Collection created. Sharing changes are waiting for approval."
            : "Collection change submitted for approval."
          : wasCreating
            ? "Knowledge base created"
            : "Knowledge base updated",
        pending ? "warning" : "success",
        pending ? 7000 : undefined,
      );
    } catch (error) {
      if (createdId) {
        setUnsaved(false);
        setIsCreating(false);
        setDraftKey(null);
        await load();
        openCollection(createdId);
        toast(
          `Collection created, but some settings were not saved: ${
            error instanceof Error ? error.message : "Unknown error"
          }`,
          "error",
        );
      } else {
        toast(
          error instanceof Error
            ? error.message
            : isCreating
              ? "Could not create knowledge base"
              : "Could not update knowledge base",
          "error",
        );
      }
    } finally {
      setSaving(false);
    }
  }

  async function deleteCollection(): Promise<void> {
    if (!selected || selected.is_platform) return;
    if (
      !window.confirm(
        `Delete “${selected.name}”? Datasources and indexed data are not deleted.`,
      )
    ) {
      return;
    }
    setSaving(true);
    try {
      const response = await fetch(
        `/api/rag/collections/${encodeURIComponent(selected._id)}`,
        {
          method: "DELETE",
        },
      );
      const result = await response.json();
      if (!response.ok || !result?.success) {
        throw new Error(result?.error || "Could not delete knowledge base");
      }
      setUnsaved(false);
      setDraftKey(null);
      setSelectedId(null);
      replaceCollectionUrl(null);
      await load();
      toast(
        "Collection deleted. Datasources and indexed content remain unchanged.",
        "success",
      );
    } catch (error) {
      toast(
        error instanceof Error
          ? error.message
          : "Could not delete knowledge base",
        "error",
      );
    } finally {
      setSaving(false);
    }
  }

  const teamOptions = teams
    .filter((team): team is TeamRow & { slug: string } => Boolean(team.slug))
    .map<TeamPickerOption>((team) => ({
      slug: team.slug,
      name: team.name ?? team.slug,
      _id: team._id,
    }));
  const datasourceById = new Map(
    datasources.map((item) => [item.datasource_id, item]),
  );
  const selectedSourceCards: KnowledgeCardItem[] = draftSources.map((id) => {
    const datasource = datasourceById.get(id);
    return {
      id,
      name: datasource?.name ?? id,
      kind: "datasource",
      datasourceKind: datasourceKind(datasource?.source_type, id),
      stats: knowledgeCardStats(
        datasource?.document_count,
        datasource?.chunk_count,
      ),
      subtitle: "Collection datasource",
    };
  });
  const filteredDatasources = datasources.filter((datasource) => {
    if (draftSources.includes(datasource.datasource_id)) return false;
    if (datasource.can_manage !== true) return false;
    const query = sourceSearch.trim().toLowerCase();
    if (!query) return true;
    return datasource.name.toLowerCase().includes(query);
  });

  function canAddDatasource(datasource: DatasourceOption | undefined): boolean {
    return Boolean(
      datasource?.can_manage === true &&
        (!selectedHasPersonalOwner || datasource.can_read === true),
    );
  }

  function addDatasourceToDraft(datasourceId: string): void {
    if (
      !canPublishDraft ||
      saving ||
      draftSources.includes(datasourceId) ||
      !canAddDatasource(datasourceById.get(datasourceId))
    ) {
      return;
    }
    setDraftSources((current) => [...current, datasourceId]);
  }

  if (loading && collections.length === 0) {
    return (
      <div className="flex flex-1 items-center justify-center text-muted-foreground">
        <Loader2 className="mr-2 h-5 w-5 animate-spin" />
        Loading knowledge bases...
      </div>
    );
  }

  return (
    <>
      <WorkspacePageActions>
        <Button onClick={() => runGuarded(beginCreate)} className="gap-2">
          <Plus className="h-4 w-4" />
          New Collection
        </Button>
      </WorkspacePageActions>

      <div className="grid h-full min-h-0 grid-cols-[minmax(260px,340px)_1fr] overflow-hidden">
        <div className="space-y-2 overflow-y-auto border-r p-4">
          {isCreating && (
            <div
              className="w-full rounded-xl border border-primary/50 bg-primary/[0.06] p-4 text-left"
              aria-current="true"
              data-testid="new-collection-draft"
            >
              <div className="flex items-start gap-3">
                <div className="rounded-lg bg-primary/15 p-2 text-primary">
                  <Layers3 className="h-5 w-5" />
                </div>
                <div className="min-w-0 flex-1">
                  <p className="truncate font-medium">
                    {draftName.trim() || "New Collection"}
                  </p>
                  <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">
                    {draftDescription.trim() || "Unsaved collection"}
                  </p>
                  <p className="mt-3 text-xs text-muted-foreground">Not saved</p>
                </div>
              </div>
            </div>
          )}
          {collections.map((collection) => (
            <button
              type="button"
              key={collection._id}
              onClick={() => {
                if (!isCreating && selectedId === collection._id) return;
                runGuarded(() => openCollection(collection._id));
              }}
              className={cn(
                "w-full rounded-xl border p-4 text-left transition-colors hover:border-primary/40 hover:bg-primary/[0.03]",
                !isCreating &&
                  selectedId === collection._id &&
                  "border-primary/50 bg-primary/[0.06]",
              )}
            >
              <div className="flex items-start gap-3">
                <div className="rounded-lg bg-primary/15 p-2 text-primary">
                  <Layers3 className="h-5 w-5" />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <p className="truncate font-medium">{collection.name}</p>
                    {collection.is_platform && (
                      <BuiltInResourceHint
                        text="Built-in collection for shared organization knowledge."
                        focusable={false}
                      />
                    )}
                  </div>
                  <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">
                    {collection.description ||
                      "A collection of RAG datasources"}
                  </p>
                  <div className="mt-3 flex gap-3 text-xs text-muted-foreground">
                    <span className="flex items-center gap-1">
                      <Database className="h-3.5 w-3.5" />{" "}
                      {collection.source_ids.length}
                    </span>
                    <span
                      className="flex items-center gap-1"
                      title={`${collection.reader_team_slugs.length} Search team${collection.reader_team_slugs.length === 1 ? "" : "s"}`}
                    >
                      <Users className="h-3.5 w-3.5" />{" "}
                      {collection.reader_team_slugs.length}
                    </span>
                  </div>
                </div>
              </div>
            </button>
          ))}
          {collections.length === 0 && (
            <div className="rounded-xl border border-dashed p-6 text-center text-sm text-muted-foreground">
              Create a personal collection, then add datasources you can manage.
            </div>
          )}
        </div>

        <div className="overflow-y-auto p-6">
          {selected || isCreating ? (
            <div className="w-full animate-in space-y-5 fade-in slide-in-from-right-2 duration-200">
              <Card>
                <CardHeader>
                  <CardTitle className="flex items-center gap-3">
                    <Layers3 className="h-5 w-5 text-primary" />
                    <Label htmlFor="collection-name" className="sr-only">
                      Name
                    </Label>
                    <Input
                      id="collection-name"
                      value={draftName}
                      onChange={(event) => setDraftName(event.target.value)}
                      placeholder="New Collection"
                      disabled={!canManageDraft || saving}
                      className="h-10 max-w-xl text-lg font-semibold"
                    />
                  </CardTitle>
                  {!isCreating && selected && (
                    <p className="pl-8 text-xs text-muted-foreground">
                      id:{" "}
                      <code className="rounded bg-muted px-1 py-0.5">
                        {selected._id}
                      </code>
                    </p>
                  )}
                  <CardDescription>
                    {isCreating
                      ? "Private by default. You are the Owner and the only person who can search this collection until you add teams below."
                      : "Collections group datasources so they can be assigned and managed together."}
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  <div className="space-y-2">
                    <Label htmlFor="collection-description">Description</Label>
                    <Textarea
                      id="collection-description"
                      value={draftDescription}
                      onChange={(event) =>
                        setDraftDescription(event.target.value)
                      }
                      disabled={!canManageDraft || saving}
                    />
                  </div>
                </CardContent>
              </Card>

              <Card>
                <CardHeader>
                  <CardTitle className="flex items-center gap-2">
                    <Database className="h-5 w-5 text-cyan-500" /> Datasources
                  </CardTitle>
                  <CardDescription>
                    You can add datasources you own or are allowed to manage.
                    Personal collections also require existing Search access, so
                    membership never creates access you did not already have.
                    Removing a datasource never deletes indexed data.
                  </CardDescription>
                </CardHeader>
                <CardContent className="space-y-4">
                  <KnowledgeCardHand
                    items={selectedSourceCards}
                    onRemove={(card) =>
                      setDraftSources((current) =>
                        current.filter((id) => id !== card.id),
                      )
                    }
                    disabled={!canPublishDraft || saving}
                    dragCandidate={dragCandidate}
                    onDropCandidate={(candidate) => {
                      if (candidate.kind === "datasource") {
                        addDatasourceToDraft(candidate.id);
                      }
                      setDragCandidate(null);
                    }}
                    ariaLabel="Selected collection datasources"
                    emptyTitle="Drop a datasource here."
                    emptyDescription="This collection does not contain any datasources yet."
                  />
                  <div className="relative">
                    <Search className="absolute left-3 top-2.5 h-4 w-4 text-muted-foreground" />
                    <Input
                      value={sourceSearch}
                      onChange={(event) => setSourceSearch(event.target.value)}
                      placeholder="Search datasources..."
                      className="pl-9"
                    />
                  </div>
                  <div className="max-h-72 space-y-1 overflow-y-auto rounded-xl border p-2">
                    {filteredDatasources.map((datasource) => {
                      const canManage = datasource?.can_manage === true;
                      const canAdd = canAddDatasource(datasource);
                      const disabled =
                        !canPublishDraft || saving || !canAdd;
                      return (
                        <DatasourceOptionRow
                          key={datasource.datasource_id}
                          datasourceId={datasource.datasource_id}
                          name={datasource.name}
                          sourceType={datasource.source_type}
                          disabled={disabled}
                          title={
                            !canAdd
                              ? !canManage
                                ? "You must be able to manage this datasource before adding it"
                                : "A personal collection can only include datasources you can already search"
                              : undefined
                          }
                          onDragStart={(event) => {
                            const candidate: KnowledgeDragCandidate = {
                              kind: "datasource",
                              id: datasource.datasource_id,
                            };
                            setDragCandidate(candidate);
                            startKnowledgeDrag(event, candidate);
                          }}
                          onDragEnd={() => setDragCandidate(null)}
                          onClick={() =>
                            addDatasourceToDraft(datasource.datasource_id)
                          }
                        />
                      );
                    })}
                    {filteredDatasources.length === 0 && (
                      <p className="px-3 py-6 text-center text-sm text-muted-foreground">
                        {sourceSearch.trim()
                          ? "No available datasources match this search."
                          : "All available datasources are already in this collection."}
                      </p>
                    )}
                  </div>
                </CardContent>
              </Card>

              {canManageDraft && (
                <Card>
                  <CardHeader>
                    <CardTitle className="flex items-center gap-2">
                      <ShieldCheck className="h-5 w-5 text-emerald-500" />{" "}
                      Access
                    </CardTitle>
                    <CardDescription>
                      Add teams if other people should manage or search this
                      collection.
                    </CardDescription>
                  </CardHeader>
                  <CardContent>
                    <DatasourceAccessFields
                      className="border-0 p-0"
                      ownerControl={(
                        <div className="space-y-2">
                          {selectedHasPersonalOwner && (
                            <div
                              className="flex w-fit items-center gap-2 rounded-md border border-input bg-background px-3 py-2 text-sm"
                              data-testid="personal-collection-owner"
                            >
                              <Users
                                aria-hidden="true"
                                className="h-4 w-4 text-muted-foreground"
                              />
                              {isCreating ? "You (personal)" : "Personal owner"}
                            </div>
                          )}
                          {canDelegateDraft && (
                            <div className="space-y-1.5">
                              <Label className="text-xs text-muted-foreground">
                                Owner teams
                              </Label>
                              <TeamMultiPicker
                                options={teamOptions}
                                selected={draftMaintainers}
                                onChange={setDraftMaintainers}
                                placeholder="Add Owner teams..."
                                ariaLabel="Owner teams"
                              />
                            </div>
                          )}
                        </div>
                      )}
                      ownerDescription={selectedHasPersonalOwner
                        ? isCreating
                          ? "You can manage this collection and add datasources. Owner teams can help manage it."
                          : "The personal Owner can manage this collection and add datasources. Owner teams can help manage it."
                        : "Owner-team members can add datasources, and their team admins can manage collection settings."}
                      searchControl={(
                        <TeamMultiPicker
                          options={teamOptions}
                          selected={draftReaders}
                          onChange={setDraftReaders}
                          placeholder={selectedHasPersonalOwner
                            ? isCreating
                              ? "Only you can search — add teams"
                              : "Only the personal Owner can search — add teams"
                            : "No Search teams — add teams"}
                          ariaLabel="Search teams"
                        />
                      )}
                      searchDescription={selectedHasPersonalOwner
                        ? isCreating
                          ? "You can search this collection. Members of selected teams can also search it through Search, APIs, and agents."
                          : "The personal Owner can search this collection. Members of selected teams can also search it through Search, APIs, and agents."
                        : "Members of selected teams can search this collection through Search, APIs, and agents."}
                    />
                  </CardContent>
                </Card>
              )}

              <div className="flex items-center justify-between">
                <div>
                  {isCreating ? (
                    <Button
                      variant="ghost"
                      onClick={() => runGuarded(closeEditor)}
                      disabled={saving}
                    >
                      Cancel
                    </Button>
                  ) : (
                    selected &&
                    !selected.is_platform &&
                    selected._permissions.can_manage && (
                      <Button
                        variant="ghost"
                        className="gap-2 text-destructive hover:text-destructive"
                        onClick={deleteCollection}
                        disabled={saving}
                      >
                        <Trash2 className="h-4 w-4" /> Delete collection
                      </Button>
                    )
                  )}
                </div>
                {(canPublishDraft || canManageDraft) && (
                  <Button
                    className="gap-2"
                    onClick={saveCollection}
                    disabled={saving || !dirty || !draftName.trim()}
                  >
                    {saving ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      <Save className="h-4 w-4" />
                    )}
                    {isCreating ? "Create collection" : "Save collection"}
                  </Button>
                )}
              </div>
            </div>
          ) : (
            <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
              Select or create a RAG collection.
            </div>
          )}
        </div>
      </div>

      <UnsavedChangesDialog
        open={
          dirty && Boolean(pendingNavigationHref || pendingDeferredAction)
        }
        onCancel={cancelDiscard}
        onDiscard={confirmDiscard}
        title="Unsaved collection changes"
        description="Save this collection or discard your changes before leaving."
        discardLabel="Discard changes"
      />
    </>
  );
}
