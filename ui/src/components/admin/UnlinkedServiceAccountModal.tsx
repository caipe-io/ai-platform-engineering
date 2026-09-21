"use client";

// assisted-by Codex Codex-sonnet-4-6

/**
 * Unlinked Access Modal
 *
 * Platform-admin-only dialog to view and edit the unlinked service account's
 * scopes — the base access platform grants to callers with no user identity
 * (unlinked Slack users, Slack bots).
 *
 * Auth gate (UI side): rendered only when `isAdmin === true` (org-admin).
 * The BFF routes additionally gate every mutation at the server.
 *
 * Reuses:
 *  - GET /api/admin/service-accounts/unlinked  (our new resolver endpoint)
 *  - POST/DELETE /api/admin/service-accounts/[id]/scopes  (existing scope edit)
 *  - GET /api/admin/service-accounts/grantable?context=unlinked
 *
 * Note on grantable: unlinked access uses the full platform catalog, gated by
 * the BFF to platform admins. Normal service-account pickers still use the
 * caller-held grantable set.
 *
 * The add-scope UI mirrors `ManageServiceAccountDialog` in `ServiceAccountsTab.tsx`
 * (separate Agents/Tools/Datasources/Collections MultiSelects, staged and
 * applied together via one "Add" click) rather than the single-type dropdown
 * this modal used to have, so editing the unlinked SA behaves the same way
 * editing any other service account does.
 *
 * assisted-by Claude:claude-sonnet-4-6
 * assisted-by Codex Codex-sonnet-4-6
 */

import React, { useCallback, useEffect, useState } from "react";
import { Bot, Loader2, Lock, Plus, Shield, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { MultiSelect } from "@/components/ui/multi-select";
import { SearchablePicker } from "@/components/ui/searchable-picker";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import type { ScopeRef, UnlinkedScope } from "@/lib/service-account-scopes";
import { fetchCollectionMemberDatasourceIds } from "@/lib/rag-collections-client";
import { labelledGrantOptions, type GrantableItem } from "@/lib/grantable-options";

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

// QUAL-10: sa_sub dropped — the BFF only returns id/name/scopes (not needed on UI).
interface UnlinkedSaData {
  id: string;
  name: string;
  scopes: UnlinkedScope[];
}

interface GrantableData {
  agents: GrantableItem[];
  tools: GrantableItem[];
  datasources: GrantableItem[];
  collections: GrantableItem[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Main component
// ─────────────────────────────────────────────────────────────────────────────

interface UnlinkedServiceAccountModalProps {
  /** Controls visibility. */
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Must be true for the modal to allow edits; non-admins see read-only view. */
  isAdmin: boolean;
}

export function UnlinkedServiceAccountModal({
  open,
  onOpenChange,
  isAdmin,
}: UnlinkedServiceAccountModalProps) {
  const [sa, setSa] = useState<UnlinkedSaData | null>(null);
  const [grantable, setGrantable] = useState<GrantableData | null>(null);
  const [grantableError, setGrantableError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pendingRemove, setPendingRemove] = useState<ScopeRef | null>(null);
  const [scopeFilter, setScopeFilter] = useState("");
  const [addAgents, setAddAgents] = useState<string[]>([]);
  const [addTools, setAddTools] = useState<string[]>([]);
  const [addDatasources, setAddDatasources] = useState<string[]>([]);
  const [addCollections, setAddCollections] = useState<string[]>([]);
  const [collectionPickNote, setCollectionPickNote] = useState<string | null>(
    null,
  );
  // KEEP IN SYNC with ManageServiceAccountDialog's addScope in
  // ServiceAccountsTab.tsx — adding scopes is one bulk call (server batches
  // the check + writes + a single snapshot refresh — see
  // .../scopes/bulk/route.ts), but a batch of hundreds can still take a
  // couple of seconds. A visible "Adding N scopes..." label makes that wait
  // legible from the very first click — a bare spinner icon is easy to miss
  // at the exact moment Add is clicked.
  const [addCount, setAddCount] = useState<number | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    setGrantableError(null);
    try {
      const [saRes, grantableRes] = await Promise.all([
        fetch("/api/admin/service-accounts/unlinked")
          .then((r) => r.json())
          .catch(() => ({ success: false, error: "Network error loading service account" })),
        fetch("/api/admin/service-accounts/grantable?context=unlinked")
          .then((r) => r.json())
          .catch(() => ({ success: false, error: "Network error loading grantable scopes" })),
      ]);
      if (saRes.success) {
        setSa(saRes.data as UnlinkedSaData);
      } else {
        setError(saRes.error || "Failed to load unlinked service account");
      }
      // TEST-11/UX-5: surface grantable fetch failures as a banner rather than
      // silently falling back to an empty list (which made it look like the admin
      // held no scopes when the endpoint was actually failing).
      if (grantableRes.success) {
        setGrantable(grantableRes.data as GrantableData);
      } else {
        setGrantable(null);
        setGrantableError(
          grantableRes.error || "Failed to load grantable scopes. Scope picker unavailable."
        );
      }
    } finally {
      setLoading(false);
    }
  }, []);

  // Reset + load pickers each time the dialog opens.
  useEffect(() => {
    if (open) {
      setPendingRemove(null);
      setScopeFilter("");
      setAddAgents([]);
      setAddTools([]);
      setAddDatasources([]);
      setAddCollections([]);
      setCollectionPickNote(null);
      void refresh();
    }
  }, [open, refresh]);

  const existingRefs = new Set((sa?.scopes ?? []).map((s) => `${s.type}:${s.ref}`));
  const addableAgents = (grantable?.agents ?? []).filter(
    (item) => !existingRefs.has(`agent:${item.ref}`),
  );
  const addableTools = (grantable?.tools ?? []).filter(
    (item) => !existingRefs.has(`tool:${item.ref}`),
  );
  const addableDatasources = (grantable?.datasources ?? []).filter(
    (item) => !existingRefs.has(`datasource:${item.ref}`),
  );
  const addableCollections = (grantable?.collections ?? []).filter(
    (item) => !existingRefs.has(`collection:${item.ref}`),
  );
  const agentOptions = labelledGrantOptions(addableAgents);
  const agentLabelToRef = new Map(agentOptions.map((o) => [o.label, o.ref]));
  const agentRefToLabel = new Map(agentOptions.map((o) => [o.ref, o.label]));
  const toolOptions = labelledGrantOptions(addableTools);
  const toolLabelToRef = new Map(toolOptions.map((o) => [o.label, o.ref]));
  const toolRefToLabel = new Map(toolOptions.map((o) => [o.ref, o.label]));
  const datasourceOptions = labelledGrantOptions(addableDatasources);
  const datasourceLabelToRef = new Map(datasourceOptions.map((o) => [o.label, o.ref]));
  const datasourceRefToLabel = new Map(datasourceOptions.map((o) => [o.ref, o.label]));
  const collectionOptions = labelledGrantOptions(addableCollections);
  const collectionLabelToRef = new Map(collectionOptions.map((o) => [o.label, o.ref]));
  const collectionRefToLabel = new Map(collectionOptions.map((o) => [o.ref, o.label]));

  const addScopes = useCallback(async () => {
    if (!sa) return;
    const selected: ScopeRef[] = [
      ...addAgents.map((ref) => ({ type: "agent" as const, ref })),
      ...addTools.map((ref) => ({ type: "tool" as const, ref })),
      ...addDatasources.map((ref) => ({ type: "datasource" as const, ref })),
      ...addCollections.map((ref) => ({ type: "collection" as const, ref })),
    ];
    if (selected.length === 0) return;
    setBusy(true);
    setError(null);
    setAddCount(selected.length);
    try {
      // One bulk call, not one POST per scope — see the matching comment on
      // ManageServiceAccountDialog.addScope in ServiceAccountsTab.tsx.
      const res = await fetch(
        `/api/admin/service-accounts/${encodeURIComponent(sa.id)}/scopes/bulk`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ scopes: selected }),
        },
      );
      const body = await res.json();
      if (!res.ok || !body.success) {
        await refresh();
        setError(body.error || "Failed to add scopes");
        return;
      }
      setAddAgents([]);
      setAddTools([]);
      setAddDatasources([]);
      setAddCollections([]);
      await refresh();
    } finally {
      setBusy(false);
      setAddCount(null);
    }
  }, [sa, addAgents, addTools, addDatasources, addCollections, refresh]);

  const addDatasourcesFromCollection = useCallback(
    async (collectionId: string) => {
      if (busy) return;
      setBusy(true);
      setCollectionPickNote(null);
      try {
        const memberIds = await fetchCollectionMemberDatasourceIds(collectionId);
        const addableRefs = new Set(addableDatasources.map((item) => item.ref));
        const alreadyQueued = new Set(addDatasources);
        const addable = memberIds.filter(
          (id) => addableRefs.has(id) && !alreadyQueued.has(id),
        );
        if (addable.length === 0) {
          setCollectionPickNote(
            "No datasources you can grant are in that collection.",
          );
          return;
        }
        setAddDatasources((prev) => [...prev, ...addable]);
        setCollectionPickNote(
          `Queued ${addable.length} datasource${addable.length === 1 ? "" : "s"} from the collection — click Add to apply.`,
        );
      } catch (err) {
        setCollectionPickNote(
          err instanceof Error ? err.message : "Could not load collection",
        );
      } finally {
        setBusy(false);
      }
    },
    [busy, addableDatasources, addDatasources],
  );

  const removeScope = useCallback(
    async (scope: ScopeRef) => {
      if (!sa) return;
      setBusy(true);
      setError(null);
      try {
        const res = await fetch(
          `/api/admin/service-accounts/${encodeURIComponent(sa.id)}/scopes`,
          {
            method: "DELETE",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(scope),
          },
        );
        const body = await res.json();
        if (!res.ok || !body.success) {
          setError(body.error || "Failed to remove scope");
          return;
        }
        setPendingRemove(null);
        await refresh();
      } finally {
        setBusy(false);
      }
    },
    [sa, refresh],
  );

  const filteredScopes = (sa?.scopes ?? []).filter((scope) => {
    const haystack = `${scope.type} ${scope.ref}`.toLowerCase();
    return haystack.includes(scopeFilter.trim().toLowerCase());
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Shield className="h-5 w-5 text-muted-foreground" />
            Unlinked Access
          </DialogTitle>
          <DialogDescription>
            Set the starting access for people who message the platform from Slack or Webex
            before they have signed in to the web UI. Access granted here applies to every
            unlinked caller. Knowledge shared with Everyone appears automatically.
            {!isAdmin && (
              <span className="block mt-1 font-medium text-amber-600 dark:text-amber-400">
                Read-only: platform admin access required to edit.
              </span>
            )}
          </DialogDescription>
        </DialogHeader>

        {loading ? (
          <div className="flex items-center justify-center py-8 text-muted-foreground">
            <Loader2 className="mr-2 h-5 w-5 animate-spin" />
            Loading...
          </div>
        ) : (
          <div className="max-h-[65vh] overflow-y-auto space-y-4 pr-1">
            {error && (
              <div
                className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive"
                data-testid="unlinked-modal-error"
              >
                {error}
              </div>
            )}

            {/* TEST-11/UX-5: surface grantable fetch failure as a distinct banner */}
            {grantableError && !error && (
              <div
                className="rounded-md border border-amber-300/40 bg-amber-50/60 px-3 py-2 text-sm text-amber-700 dark:text-amber-400"
                data-testid="unlinked-modal-grantable-error"
              >
                {grantableError}
              </div>
            )}

            {sa && (
              <>
                {/* Current scopes.
                    KEEP IN SYNC: the filter-input-above-8-items + bounded
                    max-h-56 scroll container mirrors ManageServiceAccountDialog's
                    "Current scopes" list in ServiceAccountsTab.tsx — a
                    service account (unlinked or not) can hold hundreds of
                    datasource scopes, so both lists need their own scroll
                    region and a way to narrow it down independent of the
                    surrounding dialog's scroll. */}
                <div className="space-y-2">
                  <span className="text-sm font-medium">Current scopes</span>
                  {sa.scopes.length === 0 ? (
                    <p className="text-sm text-muted-foreground">
                      No access has been granted to unlinked callers yet.
                    </p>
                  ) : (
                    <>
                      {sa.scopes.length > 8 && (
                        <Input
                          value={scopeFilter}
                          onChange={(e) => setScopeFilter(e.target.value)}
                          placeholder="Filter current scopes..."
                          aria-label="Filter current scopes"
                          className="h-8 text-xs"
                        />
                      )}
                      <ul className="max-h-56 space-y-1 overflow-y-auto pr-1">
                        {filteredScopes.map((scope) => {
                          const isPending =
                            pendingRemove?.type === scope.type && pendingRemove?.ref === scope.ref;
                          const isEveryone = scope.source === "everyone";
                          return (
                            <li
                              key={`${scope.type}:${scope.ref}`}
                              className="flex min-w-0 items-center justify-between gap-2 rounded-md border border-input px-2.5 py-1.5"
                            >
                              <span className="inline-flex min-w-0 items-center gap-1.5 text-sm">
                                <Bot className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                                <code className="truncate text-xs" data-testid={`scope-${scope.type}-${scope.ref}`}>
                                  {scope.type}/{scope.ref}
                                </code>
                              </span>
                              {isEveryone ? (
                                <span
                                  className="inline-flex shrink-0 items-center gap-1 rounded-full border border-input px-2 py-0.5 text-[11px] text-muted-foreground"
                                  data-testid={`scope-source-everyone-${scope.ref}`}
                                  title="Shared with Everyone. Change the resource's sharing settings to revoke."
                                >
                                  <Lock className="h-3 w-3" />
                                  Everyone
                                </span>
                              ) : isAdmin && (
                                isPending ? (
                                  <span className="inline-flex items-center gap-1.5">
                                    <span className="text-xs text-muted-foreground">Remove?</span>
                                    <Button
                                      size="sm"
                                      variant="destructive"
                                      className="h-7 gap-1.5"
                                      disabled={busy}
                                      onClick={() => removeScope(scope)}
                                    >
                                      {busy && <Loader2 className="h-3 w-3 animate-spin" />}
                                      Confirm
                                    </Button>
                                    <Button
                                      size="sm"
                                      variant="ghost"
                                      className="h-7"
                                      disabled={busy}
                                      onClick={() => setPendingRemove(null)}
                                    >
                                      Cancel
                                    </Button>
                                  </span>
                                ) : (
                                  <Button
                                    size="icon"
                                    variant="ghost"
                                    className="h-7 w-7 text-destructive hover:text-destructive"
                                    aria-label={`Remove ${scope.type} ${scope.ref}`}
                                    disabled={busy}
                                    onClick={() => setPendingRemove(scope)}
                                  >
                                    <X className="h-3.5 w-3.5" />
                                  </Button>
                                )
                              )}
                            </li>
                          );
                        })}
                      </ul>
                    </>
                  )}
                </div>

                {/* Add scopes — only for admins.
                    KEEP IN SYNC: this block (4 MultiSelects + staged Add +
                    the "Add datasources from a collection" bulk picker) is
                    intentionally a copy of ManageServiceAccountDialog's "Add
                    scopes" block in ServiceAccountsTab.tsx. If you change the
                    UX/copy/behavior here, change it there too, and vice
                    versa — editing the unlinked SA should look and behave
                    exactly like editing any other service account. */}
                {isAdmin && (
                  <div className="space-y-3 rounded-md border border-dashed border-input p-3">
                    <span className="text-sm font-medium">Add scopes</span>
                    <p className="text-xs text-muted-foreground">
                      Platform catalog scopes are shown for unlinked callers.
                    </p>

                    <div className="space-y-1">
                      <label className="text-xs font-medium text-muted-foreground">
                        Agents
                      </label>
                      <MultiSelect
                        options={agentOptions.map((o) => o.label)}
                        selected={addAgents
                          .map((ref) => agentRefToLabel.get(ref))
                          .filter((v): v is string => Boolean(v))}
                        onChange={(labels) =>
                          setAddAgents(
                            labels
                              .map((l) => agentLabelToRef.get(l))
                              .filter((v): v is string => Boolean(v)),
                          )
                        }
                        placeholder="Add agents..."
                        emptyLabel="No more agents you can grant"
                        badgeLabel="agents"
                        portalled={false}
                      />
                    </div>

                    <div className="space-y-1">
                      <label className="text-xs font-medium text-muted-foreground">
                        Tools
                      </label>
                      <MultiSelect
                        options={toolOptions.map((o) => o.label)}
                        selected={addTools
                          .map((ref) => toolRefToLabel.get(ref))
                          .filter((v): v is string => Boolean(v))}
                        onChange={(labels) =>
                          setAddTools(
                            labels
                              .map((l) => toolLabelToRef.get(l))
                              .filter((v): v is string => Boolean(v)),
                          )
                        }
                        placeholder="Add tools..."
                        emptyLabel="No more tools you can grant"
                        badgeLabel="tools"
                        portalled={false}
                      />
                    </div>

                    <div className="space-y-1">
                      <label className="text-xs font-medium text-muted-foreground">
                        Datasources
                      </label>
                      <MultiSelect
                        options={datasourceOptions.map((o) => o.label)}
                        selected={addDatasources
                          .map((ref) => datasourceRefToLabel.get(ref))
                          .filter((v): v is string => Boolean(v))}
                        onChange={(labels) =>
                          setAddDatasources(
                            labels
                              .map((l) => datasourceLabelToRef.get(l))
                              .filter((v): v is string => Boolean(v)),
                          )
                        }
                        placeholder="Add datasources..."
                        emptyLabel="No more datasources you can grant"
                        badgeLabel="datasources"
                        portalled={false}
                      />
                    </div>

                    <div className="space-y-1">
                      <label className="text-xs font-medium text-muted-foreground">
                        Collections
                      </label>
                      <MultiSelect
                        options={collectionOptions.map((o) => o.label)}
                        selected={addCollections
                          .map((ref) => collectionRefToLabel.get(ref))
                          .filter((v): v is string => Boolean(v))}
                        onChange={(labels) =>
                          setAddCollections(
                            labels
                              .map((l) => collectionLabelToRef.get(l))
                              .filter((v): v is string => Boolean(v)),
                          )
                        }
                        placeholder="Add collections..."
                        emptyLabel="No more collections you can grant"
                        badgeLabel="collections"
                        portalled={false}
                      />
                      <p className="text-xs text-muted-foreground">
                        A collection grant lets unlinked callers search using
                        that collection as a filter; it does not grant access
                        to its member datasources. Add datasources directly,
                        or use &quot;Add datasources from a collection&quot;
                        below, for content access.
                      </p>
                    </div>

                    <div className="space-y-1 border-t border-dashed border-input pt-2">
                      <label className="text-xs font-medium text-muted-foreground">
                        Add datasources from a collection
                      </label>
                      <SearchablePicker
                        options={grantable?.collections ?? []}
                        selected={undefined}
                        onSelect={(item) =>
                          void addDatasourcesFromCollection(item.ref)
                        }
                        getOptionKey={(item) => item.ref}
                        getOptionLabel={(item) => item.name}
                        getSearchText={(item) => [item.ref, item.name]}
                        placeholder="Select a collection to bulk-add its datasources..."
                        searchPlaceholder="Search collections..."
                        emptyLabel="No collections available"
                        ariaLabel="Add datasources from a collection"
                        disabled={busy || (grantable?.collections ?? []).length === 0}
                        triggerClassName="h-9 w-full text-sm"
                      />
                      {collectionPickNote && (
                        <p className="text-xs text-muted-foreground">
                          {collectionPickNote}
                        </p>
                      )}
                      <p className="text-xs text-muted-foreground">
                        Queues every datasource in the collection that you can
                        grant into the Datasources list above — click Add
                        below to apply. This does not add the collection
                        itself.
                      </p>
                    </div>

                    <div className="flex items-center justify-end gap-2">
                      {addCount !== null && (
                        <span className="text-xs text-muted-foreground">
                          Adding {addCount} scope{addCount === 1 ? "" : "s"}...
                        </span>
                      )}
                      <Button
                        onClick={addScopes}
                        disabled={
                          busy ||
                          (addAgents.length === 0 &&
                            addTools.length === 0 &&
                            addDatasources.length === 0 &&
                            addCollections.length === 0)
                        }
                        className="gap-1.5"
                      >
                        {busy && <Loader2 className="h-4 w-4 animate-spin" />}
                        <Plus className="h-4 w-4" />
                        Add
                      </Button>
                    </div>
                  </div>
                )}
              </>
            )}
          </div>
        )}

        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={busy}
            data-testid="unlinked-modal-close"
          >
            Close
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
