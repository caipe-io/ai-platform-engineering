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
 * assisted-by Claude:claude-sonnet-4-6
 * assisted-by Codex Codex-sonnet-4-6
 */

import React, { useCallback, useEffect, useState } from "react";
import { Bot, Loader2, Lock, Plus, Shield, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { SearchablePicker } from "@/components/ui/searchable-picker";
import { Select } from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import type { ScopeRef, UnlinkedScope } from "@/lib/service-account-scopes";
// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

// QUAL-10: sa_sub dropped — the BFF only returns id/name/scopes (not needed on UI).
interface UnlinkedSaData {
  id: string;
  name: string;
  scopes: UnlinkedScope[];
}

interface GrantableItem {
  ref: string;
  name: string;
}

interface GrantableData {
  agents: GrantableItem[];
  tools: GrantableItem[];
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
  const [addType, setAddType] = useState<"agent" | "tool">("agent");
  const [addRef, setAddRef] = useState("");

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

  // Load data when the dialog opens.
  useEffect(() => {
    if (open) {
      setAddRef("");
      setAddType("agent");
      setPendingRemove(null);
      void refresh();
    }
  }, [open, refresh]);

  // Scopes available to add (caller-grantable minus already-granted).
  const held = addType === "agent" ? (grantable?.agents ?? []) : (grantable?.tools ?? []);
  const existingRefs = new Set((sa?.scopes ?? []).map((s) => `${s.type}:${s.ref}`));
  const addableOptions = held.filter((item) => !existingRefs.has(`${addType}:${item.ref}`));

  const addScope = useCallback(async () => {
    if (!sa || !addRef) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(
        `/api/admin/service-accounts/${encodeURIComponent(sa.id)}/scopes`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ type: addType, ref: addRef }),
        },
      );
      const body = await res.json();
      if (!res.ok || !body.success) {
        setError(body.error || "Failed to add scope");
        return;
      }
      setAddRef("");
      await refresh();
    } finally {
      setBusy(false);
    }
  }, [sa, addType, addRef, refresh]);

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
                {/* Current scopes */}
                <div className="space-y-2">
                  <span className="text-sm font-medium">Current scopes</span>
                  {sa.scopes.length === 0 ? (
                    <p className="text-sm text-muted-foreground">
                      No access has been granted to unlinked callers yet.
                    </p>
                  ) : (
                    <ul className="space-y-1">
                      {sa.scopes.map((scope) => {
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
                  )}
                </div>

                {/* Add scope — only for admins */}
                {isAdmin && (
                  <div className="space-y-2 rounded-md border border-dashed border-input p-3">
                    <span className="text-sm font-medium">Add a scope</span>
                    <p className="text-xs text-muted-foreground">
                      Platform catalog scopes are shown for unlinked callers.
                    </p>
                    {/* TEST-11/UX-5: show an empty catalog note when grantable loaded
                        successfully but returned zero items for the selected type. */}
                    {!grantableError && grantable !== null && held.length === 0 && (
                      <p
                        className="text-xs text-amber-700 dark:text-amber-400"
                        data-testid="unlinked-modal-grantable-empty-note"
                      >
                        No {addType}s available to grant. Check that platform {addType} resources
                        are enabled.
                      </p>
                    )}
                    <div
                      className="flex min-w-0 flex-col gap-2 sm:flex-row"
                      data-testid="unlinked-add-scope-controls"
                    >
                      <Select
                        aria-label="Scope type"
                        value={addType}
                        onChange={(e) => {
                          setAddType(e.target.value as "agent" | "tool");
                          setAddRef("");
                        }}
                        className="h-9 min-w-0 rounded-md border border-input bg-background px-2 text-sm sm:w-24"
                      >
                        <option value="agent">Agent</option>
                        <option value="tool">Tool</option>
                      </Select>
                      <SearchablePicker
                        options={addableOptions}
                        selected={addableOptions.find((item) => item.ref === addRef)}
                        onSelect={(item) => setAddRef(item.ref)}
                        getOptionKey={(item) => item.ref}
                        getOptionLabel={(item) => item.name}
                        getSearchText={(item) => [item.ref, item.name]}
                        placeholder={
                          addableOptions.length === 0
                            ? `No more ${addType}s available`
                            : `Select a ${addType}...`
                        }
                        searchPlaceholder={`Search ${addType}s...`}
                        emptyLabel={`No ${addType}s match`}
                        ariaLabel="Scope ref"
                        disabled={addableOptions.length === 0}
                        onClear={() => setAddRef("")}
                        clearLabel="Clear scope ref"
                        triggerClassName="h-9 min-w-0 flex-1 text-sm"
                      />
                      <Button
                        onClick={addScope}
                        disabled={busy || !addRef}
                        className="w-full gap-1.5 sm:w-auto"
                      >
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
