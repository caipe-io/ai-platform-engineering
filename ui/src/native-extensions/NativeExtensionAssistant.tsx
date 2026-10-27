"use client";

import { lazy, Suspense, useCallback, useEffect, useLayoutEffect, useState } from "react";
import { useSession } from "next-auth/react";

import { validateAssistantConfiguration, type AssistantConfiguration } from "../../app-sdk/assistant-options.mjs";
import { readAssistantDeepLink } from "@/lib/agentic-apps/assistant-links";
import { validateAssistantContextMessage } from "@/lib/agentic-apps/assistant-context";
import { resolveUsableChatAgent } from "@/lib/chat-agent-selection";
import { HOST_ASSISTANT_EVENT, HOST_ASSISTANT_STATE_EVENT } from "@/lib/agentic-apps/assistant-events";
import type { AgenticAppAssistantContextRecord, PublicAgenticApp } from "@/types/agentic-app";
import type { NativeExtensionManifest } from "./types";

const AgenticAppAssistantOverlay = lazy(() => import("@/components/agentic-apps/AgenticAppAssistantOverlay")
  .then(module => ({ default: module.AgenticAppAssistantOverlay })));

/** Native and iframe renderers share one host popup and conversation lifecycle. */
function NativeAssistantSession({ assistant, extensionId, pathname, search = "" }: {
  assistant: NonNullable<NativeExtensionManifest["assistant"]>;
  extensionId: string;
  pathname: string;
  search?: string;
}): React.ReactElement | null {
  const { data: session, status } = useSession();
  const key = JSON.stringify([status, session?.sub, session?.user?.email, session?.org, session?.role, extensionId]);
  const [configuration, setConfiguration] = useState<AssistantConfiguration | null>(null);
  const [retry, setRetry] = useState(0);
  const [error, setError] = useState<{ key: string; message: string } | null>(null);
  const [binding, setBinding] = useState<{ key: string; app: PublicAgenticApp } | null>(null);
  const [request, setRequest] = useState<{ key: string; open: boolean; context: AgenticAppAssistantContextRecord | null }>(
    { key, open: false, context: null });
  const open = request.key === key && request.open;
  const context = request.key === key ? request.context : null;
  const setOpen = useCallback((value: boolean) => setRequest(previous => ({ key, open: value,
    context: previous.key === key ? previous.context : null })), [key]);
  const app = status === "authenticated" && binding?.key === key ? binding.app : null;
  const canLaunch = Boolean(app?.canLaunch);
  const requestedLink = readAssistantDeepLink(search, app?.assistantOptions);
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
    if (canLaunch && requestedLink.requested) queueMicrotask(() => setOpen(true));
  }, [canLaunch, requestedLink.requested, requestedLink.id, requestedLink.error, setOpen]);
  // Listen before native mount effects; requests stay inside this binding's component state.
  useLayoutEffect(() => {
    function onRequest(event: Event) {
      const detail = (event as CustomEvent).detail;
      if (status !== "authenticated" || detail?.appId !== extensionId) return;
      let record: AgenticAppAssistantContextRecord | null = null;
      if (detail.configuration) {
        try {
          validateAssistantConfiguration(detail.configuration, assistant.hostOptions);
          setConfiguration(detail.configuration);
          if (!detail.configuration.visible) setOpen(false);
        } catch (reason) {
          setError({ key, message: reason instanceof Error ? reason.message : "Unsupported assistant configuration" });
        }
        return;
      }
      if (detail.context) {
        const result = validateAssistantContextMessage({ appId: extensionId, message: {
          type: "caipe.agenticApp.context.v1", version: "1.0", appId: extensionId, context: detail.context,
        } });
        if (!result.ok) return;
        record = result.record;
      }
      setRequest(previous => ({ key, open: detail.close ? false : Boolean(detail.open) || (previous.key === key && previous.open),
        context: record ?? (previous.key === key ? previous.context : null) }));
    }
    window.addEventListener(HOST_ASSISTANT_EVENT, onRequest);
    return () => window.removeEventListener(HOST_ASSISTANT_EVENT, onRequest);
  }, [extensionId, assistant.hostOptions, key, status, setOpen]);
  useEffect(() => {
    window.dispatchEvent(new CustomEvent(HOST_ASSISTANT_STATE_EVENT, { detail: { appId: extensionId, open } }));
  }, [extensionId, open]);
  if (error?.key === key) return <div role="alert" className="fixed bottom-6 right-6 z-40 rounded-lg border bg-background p-3 text-sm">
    {error.message} <button type="button" onClick={() => setRetry(n => n + 1)} className="underline">Retry assistant</button>
  </div>;
  if (!app?.canLaunch || !app.assistantAgentId || app.assistantOverlay === "app") return null;
  if (!(configuration?.visible ?? !app.assistantOptions?.requireConfiguration)) return null;
  return <Suspense fallback={<p role="status" className="p-3 text-sm">Loading assistant…</p>}><AgenticAppAssistantOverlay key={`${key}:${app.assistantAgentId}`}
    options={app.assistantOptions} configuration={configuration ?? undefined}
    appId={app.appId} appName={app.displayName} assistantLabel={app.assistantLabel}
    assistantAgentName={app.assistantAgentName} assistantIcon={app.icon}
    assistantAgentId={app.assistantAgentId} open={open} onOpenChange={setOpen}
    activeContext={context?.route === pathname ? context : null}
    onClearContext={() => setRequest(previous => previous.key === key ? { ...previous, context: null } : previous)} /></Suspense>;
}

/** Remount the complete controller on account/role changes, including runtime configuration. */
export function NativeExtensionAssistant(props: {
  assistant: NonNullable<NativeExtensionManifest["assistant"]>;
  extensionId: string; pathname: string; search?: string;
}) {
  const { data: session, status } = useSession();
  const key = JSON.stringify([status, session?.sub, session?.user?.email, session?.org, session?.role, props.extensionId]);
  return <NativeAssistantSession key={key} {...props} />;
}
