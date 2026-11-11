"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowRightLeft, Loader2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useToast } from "@/components/ui/toast";
import type { HarnessSessionMigrationStatus } from "@/types/harness-session-migration";

interface Props {
  agentId: string;
  conversationId: string;
  busy: boolean;
}

export function ConversationRuntimeMigration({ agentId, conversationId, busy }: Props) {
  const [status, setStatus] = useState<HarnessSessionMigrationStatus | null>(null);
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const mounted = useRef(false);
  const pendingRef = useRef(false);
  const migrated = useRef(false);
  const { toast } = useToast();
  const statusUrl = `/api/harness-engine/sessions/migrate?${new URLSearchParams({ agent_id: agentId, conversation_id: conversationId })}`;

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    let retry: ReturnType<typeof setTimeout> | undefined;
    const refresh = async () => {
      if (migrated.current || pendingRef.current) return;
      try {
        const response = await fetch(statusUrl, { cache: "no-store", signal: controller.signal });
        const body = await response.json();
        if (!controller.signal.aborted && !migrated.current && !pendingRef.current) {
          const next = response.ok && body.success ? body.data as HarnessSessionMigrationStatus : null;
          setStatus(next);
          clearTimeout(retry);
          if (next?.state === "busy") retry = setTimeout(refresh, 5_000);
        }
      } catch {
        if (!controller.signal.aborted && !migrated.current) setStatus(null);
      }
    };
    void refresh();
    window.addEventListener("focus", refresh);
    return () => { controller.abort(); clearTimeout(retry); window.removeEventListener("focus", refresh); };
  }, [statusUrl, busy]);

  const migrate = useCallback(async () => {
    if (pendingRef.current || busy) return;
    pendingRef.current = true;
    setPending(true);
    setError(null);
    try {
      const response = await fetch("/api/harness-engine/sessions/migrate", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ agent_id: agentId, conversation_id: conversationId, action: "adopt" }),
      });
      const body = await response.json();
      if (!response.ok || !body.success || body.data?.runtime !== "harness_engine") {
        throw new Error(body.error || "Migration could not be confirmed. Retry to check the existing handoff.");
      }
      if (!mounted.current) return;
      migrated.current = true;
      setStatus({ state: "managed" });
      setOpen(false);
      toast("Conversation migrated. Future responses continue running across page refreshes.", "success");
    } catch (error) {
      if (mounted.current) setError(error instanceof Error ? error.message : "Migration could not be confirmed. Retry the existing handoff.");
    } finally {
      pendingRef.current = false;
      if (mounted.current) setPending(false);
    }
  }, [agentId, conversationId, busy, toast]);

  if (!status || !["available", "busy", "recoverable"].includes(status.state)) return null;
  const blocked = busy || status.state === "busy";
  const label = status.state === "recoverable" ? "Resume migration" : "Migrate to Harness Engine";
  return (
    <>
      <div className="flex shrink-0 flex-wrap items-center justify-between gap-3 border-b border-border bg-muted/30 px-4 py-3" role="note" aria-label="Conversation runtime migration">
        <p className="min-w-0 grow basis-64 text-xs text-muted-foreground">
          {blocked ? "Finish or stop the current response before migrating this conversation." : "Keep responses running when you refresh or reconnect. Move this conversation to Harness Engine."}
        </p>
        <Button variant="outline" size="sm" disabled={blocked} onClick={() => { setError(null); setOpen(true); }}>
          <ArrowRightLeft className="h-4 w-4" aria-hidden="true" />{label}
        </Button>
      </div>
      <Dialog open={open} onOpenChange={value => { if (!pending) setOpen(value); }}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>{status.state === "recoverable" ? "Resume conversation migration?" : "Migrate this conversation?"}</DialogTitle>
            <DialogDescription>
              Harness Engine will manage future responses so they can continue across page refreshes. Your messages, agent state, files, and pending approvals are preserved. No message will be sent or tool approval submitted by this action.
            </DialogDescription>
          </DialogHeader>
          {blocked && <p role="status" className="text-sm text-muted-foreground">Finish or stop the current response first.</p>}
          {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
          <DialogFooter>
            <Button variant="outline" disabled={pending} onClick={() => setOpen(false)}>Cancel</Button>
            <Button disabled={pending || blocked} onClick={() => void migrate()}>
              {pending && <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />}
              {pending ? "Migrating…" : error ? "Retry migration" : label}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
