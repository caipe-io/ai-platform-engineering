"use client";

import { lazy, Suspense, useEffect, useState } from "react";
import { useSession } from "next-auth/react";

import { validateAssistantContextMessage } from "@/lib/agentic-apps/assistant-context";
import { resolveUsableChatAgent } from "@/lib/chat-agent-selection";
import { HOST_ASSISTANT_EVENT } from "@/lib/agentic-apps/assistant-events";
import type { AgenticAppAssistantContextRecord, PublicAgenticApp } from "@/types/agentic-app";
import type { NativeExtensionManifest } from "./types";

const AgenticAppAssistantOverlay = lazy(() => import("@/components/agentic-apps/AgenticAppAssistantOverlay")
  .then(module => ({ default: module.AgenticAppAssistantOverlay })));

/** Native and iframe renderers share one host popup and conversation lifecycle. */
export function NativeExtensionAssistant({ extensionId, pathname }: {
  assistant: NonNullable<NativeExtensionManifest["assistant"]>;
  extensionId: string;
  pathname: string;
}): React.ReactElement | null {
  const { data: session, status } = useSession();
  const identity = session?.user?.email
    ? JSON.stringify([session.sub ?? session.user.email, session.org ?? "", session.role ?? ""])
    : undefined;
  const [retry, setRetry] = useState(0);
  const [error, setError] = useState<{ key: string; message: string } | null>(null);
  const [binding, setBinding] = useState<{ key: string; app: PublicAgenticApp } | null>(null);
  const [open, setOpen] = useState(false);
  const [context, setContext] = useState<AgenticAppAssistantContextRecord | null>(null);
  const key = `${identity}:${extensionId}`;
  const app = status === "authenticated" && binding?.key === key ? binding.app : null;
  useEffect(() => {
    if (status !== "authenticated") return;
    const controller = new AbortController();
    fetch(`/api/agentic-apps/${encodeURIComponent(extensionId)}`, { cache: "no-store", signal: controller.signal })
      .then(async response => {
        if (!response.ok) throw new Error("Assistant app is unavailable or access was denied");
        const payload: { item: PublicAgenticApp } = await response.json();
        if (!payload.item?.canLaunch || !payload.item.assistantAgentId) throw new Error("Assistant is unavailable or access was denied");
        await resolveUsableChatAgent({ signal: controller.signal, requestedAgentId: payload.item.assistantAgentId, requireAvailableAgent: true });
        if (!controller.signal.aborted) { setBinding({ key, app: payload.item }); setError(null); }
      }).catch((reason: unknown) => {
        if (!controller.signal.aborted) { setBinding(null); setError({ key, message: reason instanceof Error ? reason.message : "Assistant is unavailable" }); }
      });
    return () => controller.abort();
  }, [key, extensionId, status, retry]);
  useEffect(() => {
    queueMicrotask(() => { setOpen(false); setContext(null); });
  }, [key]);
  useEffect(() => {
    function onRequest(event: Event) {
      const detail = (event as CustomEvent).detail;
      if (detail?.appId !== extensionId) return;
      if (detail.context) {
        const result = validateAssistantContextMessage({ appId: extensionId, message: {
          type: "caipe.agenticApp.context.v1", version: "1.0", appId: extensionId, context: detail.context,
        } });
        if (!result.ok) return;
        setContext(result.record);
      }
      if (detail.open) setOpen(true);
    }
    window.addEventListener(HOST_ASSISTANT_EVENT, onRequest);
    return () => window.removeEventListener(HOST_ASSISTANT_EVENT, onRequest);
  }, [extensionId]);
  if (error?.key === key) return <div role="alert" className="fixed bottom-6 right-6 z-40 rounded-lg border bg-background p-3 text-sm">
    {error.message} <button type="button" onClick={() => setRetry(n => n + 1)} className="underline">Retry assistant</button>
  </div>;
  if (!app?.canLaunch || !app.assistantAgentId || app.assistantOverlay === "app") return null;
  return <Suspense fallback={<p role="status" className="p-3 text-sm">Loading assistant…</p>}><AgenticAppAssistantOverlay key={`${key}:${app.assistantAgentId}`}
    appId={app.appId} appName={app.displayName} assistantLabel={app.assistantLabel}
    assistantAgentName={app.assistantAgentName} assistantIcon={app.icon}
    assistantAgentId={app.assistantAgentId} open={open} onOpenChange={setOpen}
    activeContext={context?.route === pathname ? context : null} onClearContext={() => setContext(null)} /></Suspense>;
}
