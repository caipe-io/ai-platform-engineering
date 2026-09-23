"use client";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { SearchablePicker } from "@/components/ui/searchable-picker";
import { getErrorMessage } from "@/lib/error-utils";
import { useChatStore } from "@/store/chat-store";
import { ShieldAlert, UserRoundCog } from "lucide-react";
import { useSession } from "next-auth/react";
import { useRouter } from "next/navigation";
import React from "react";

interface ImpersonationUser {
  id: string;
  name: string;
  email: string;
  username: string;
}

interface UsersResponse {
  users?: ImpersonationUser[];
  hasMore?: boolean;
  error?: string;
}

export function UserImpersonationPanel(): React.ReactElement {
  const { data: session, update } = useSession();
  const router = useRouter();
  const [users, setUsers] = React.useState<ImpersonationUser[]>([]);
  const [selected, setSelected] = React.useState<ImpersonationUser>();
  const [query, setQuery] = React.useState("");
  const [loading, setLoading] = React.useState(true);
  const [submitting, setSubmitting] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [confirming, setConfirming] = React.useState(false);

  const loadUsers = React.useCallback(async (signal?: AbortSignal) => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({ pageSize: "25" });
      if (query.trim()) params.set("search", query.trim());
      const response = await fetch(`/api/admin/impersonation/users?${params}`, {
        credentials: "include",
        signal,
      });
      const payload = (await response.json().catch(() => ({}))) as UsersResponse;
      if (!response.ok) throw new Error(payload.error || "Unable to load users");
      setUsers(payload.users ?? []);
    } catch (loadError) {
      if (loadError instanceof DOMException && loadError.name === "AbortError") return;
      setError(getErrorMessage(loadError, "Unable to load users"));
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  }, [query]);

  React.useEffect(() => {
    const controller = new AbortController();
    const timer = window.setTimeout(() => void loadUsers(controller.signal), 250);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [loadUsers]);

  const startImpersonation = async (): Promise<void> => {
    if (!selected) return;
    setSubmitting(true);
    setError(null);
    try {
      const nextSession = await update({
        impersonation: { action: "start", targetSub: selected.id },
      });
      if (!nextSession?.impersonation) {
        throw new Error(nextSession?.impersonationNotice || "Unable to start impersonation");
      }
      useChatStore.getState().clearAllConversations();
      setConfirming(false);
      router.replace("/");
      router.refresh();
    } catch (startError) {
      setError(getErrorMessage(startError, "Unable to start impersonation"));
      setConfirming(false);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <>
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <UserRoundCog className="h-5 w-5" />
            User impersonation
          </CardTitle>
          <CardDescription>
            Sign in as an enabled, identity-provider-linked user who meets the application sign-in requirements.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-5">
          <div className="rounded-md border border-amber-300 bg-amber-50 p-4 text-sm text-amber-950 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-100">
            <div className="flex gap-3">
              <ShieldAlert className="mt-0.5 h-5 w-5 shrink-0" />
              <div>
                <p className="font-medium">Actions are performed as the selected user.</p>
                <p className="mt-1 text-amber-900/80 dark:text-amber-100/80">
                  Changes, tool calls, and authorization checks use that user&apos;s identity until you exit impersonation.
                </p>
              </div>
            </div>
          </div>

          {session?.impersonation ? (
            <p className="text-sm text-muted-foreground">
              You are currently impersonating {session.impersonation.target.name}. Use the warning bar above to exit.
            </p>
          ) : (
            <div className="max-w-xl space-y-3">
              <SearchablePicker
                options={users}
                selected={selected}
                onSelect={setSelected}
                getOptionKey={(user) => user.id}
                getOptionLabel={(user) => user.name}
                getSearchText={(user) => [user.name, user.email, user.username]}
                renderOption={(user) => (
                  <div className="min-w-0">
                    <div className="truncate font-medium">{user.name}</div>
                    <div className="truncate text-xs text-muted-foreground">{user.email}</div>
                  </div>
                )}
                placeholder="Select a user"
                searchPlaceholder="Search by name, email, or username"
                emptyLabel="No eligible linked users found"
                loading={loading}
                error={error}
                onRetry={() => void loadUsers()}
                searchValue={query}
                onSearchChange={setQuery}
                filterOptions={false}
                onClear={() => setSelected(undefined)}
              />
              <Button
                disabled={!selected || loading}
                onClick={() => setConfirming(true)}
              >
                Impersonate user
              </Button>
            </div>
          )}

          {error ? <p className="text-sm text-destructive">{error}</p> : null}
        </CardContent>
      </Card>

      <Dialog open={confirming} onOpenChange={setConfirming}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Impersonate {selected?.name}?</DialogTitle>
            <DialogDescription>
              You will have the same permissions as {selected?.email}.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirming(false)} disabled={submitting}>
              Cancel
            </Button>
            <Button onClick={() => void startImpersonation()} disabled={submitting}>
              {submitting ? "Starting…" : "Start impersonation"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
