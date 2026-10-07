"use client";

import { useEffect, useState } from "react";
import { AlertTriangle } from "lucide-react";

import { PERMISSIONS_PENDING_MESSAGE, type PermissionSyncStatus } from "@/lib/authz/permission-sync-contract";

/** Reads progress only; durable server recovery continues after navigation. */
export function PermissionSyncNotice({ status, onApplied, onMissing }: {
  status?: PermissionSyncStatus;
  onApplied?: (status: PermissionSyncStatus) => void;
  onMissing?: () => void;
}) {
  const [unavailable, setUnavailable] = useState(false);
  useEffect(() => {
    if (status?.state !== "pending") return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    const controller = new AbortController();
    const poll = async () => {
      try {
        const response = await fetch(`/api/access/operations/${encodeURIComponent(status.id)}`, {
          cache: "no-store", signal: AbortSignal.any([controller.signal, AbortSignal.timeout(10_000)]),
        });
        // Deletion removes the resource journal. Refresh the owning resource
        // list, but never interpret a missing journal as confirmed success.
        if (response.status === 404 && !cancelled) onMissing?.();
        if (!response.ok) throw new Error("Status unavailable");
        const body = await response.json();
        if (!cancelled) {
          setUnavailable(false);
          if (body.data?.id === status.id && body.data?.state === "applied") {
            onApplied?.(body.data);
            return;
          }
        }
      } catch {
        if (!cancelled) setUnavailable(true);
      }
      if (!cancelled) timer = setTimeout(poll, 5000);
    };
    timer = setTimeout(poll, 5000);
    return () => { cancelled = true; controller.abort(); clearTimeout(timer); };
  }, [status?.id, status?.state, onApplied, onMissing]);
  if (status?.state !== "pending") return null;
  return <div role="status" className="flex gap-2 rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-sm text-amber-800 dark:text-amber-200">
    <AlertTriangle aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0" />
    <div><p>{PERMISSIONS_PENDING_MESSAGE}</p>
      <p className="mt-1 text-xs">You can leave this page. Reference: {status.id}</p>
      {unavailable && <p className="mt-1">Status is temporarily unavailable. Completion has not been confirmed.</p>}
    </div>
  </div>;
}
