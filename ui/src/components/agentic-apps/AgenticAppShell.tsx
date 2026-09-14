"use client";

import { ArrowLeft, LoaderCircle } from "lucide-react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useEffect, useRef, useState } from "react";

import { AgenticAppAssistantOverlay } from "@/components/agentic-apps/AgenticAppAssistantOverlay";
import { validateAssistantContextMessage } from "@/lib/agentic-apps/assistant-context";
import { buildAgenticAppPublicPath } from "@/lib/agentic-apps/runtime";
import {
  resolveUsableChatAgent,
  type ResolvedChatAgent,
} from "@/lib/chat-agent-selection";
import type {
  AgenticAppAssistantContextRecord,
  PublicAgenticApp,
} from "@/types/agentic-app";

type ShellState =
  | { status: "loading" }
  | { status: "ready"; app: PublicAgenticApp }
  | { status: "error"; title: string; message: string };

export function AgenticAppShell({
  appId,
  path,
}: {
  appId: string;
  path: string[];
}): React.ReactElement {
  const searchParams = useSearchParams();
  const [state, setState] = useState<ShellState>({ status: "loading" });
  const [assistantContext, setAssistantContext] =
    useState<AgenticAppAssistantContextRecord | null>(null);
  const [assistantOpen, setAssistantOpen] = useState(false);
  const [assistantBinding, setAssistantBinding] = useState<{
    bindingKey: string;
    agent: ResolvedChatAgent;
  } | null>(null);
  const iframeRef = useRef<HTMLIFrameElement | null>(null);

  const requestedAgentId = state.status === "ready" ? state.app.assistantAgentId : undefined;
  const assistantBindingKey = `${appId}:${requestedAgentId ?? "default"}`;
  const assistantAgent =
    assistantBinding?.bindingKey === assistantBindingKey ? assistantBinding.agent : null;
  const assistantConfigured =
    state.status === "ready" && state.app.assistantEnabled !== false;

  useEffect(() => {
    let cancelled = false;
    fetch("/api/agentic-apps", { cache: "no-store" })
      .then(async (response) => {
        if (response.status === 401) {
          window.location.assign(
            `/login?callbackUrl=${encodeURIComponent(window.location.pathname + window.location.search)}`,
          );
          return null;
        }
        if (!response.ok) throw new Error(`Apps catalog returned HTTP ${response.status}`);
        return response.json() as Promise<{ items: PublicAgenticApp[] }>;
      })
      .then((payload) => {
        if (cancelled || !payload) return;
        const app = payload.items.find((candidate) => candidate.appId === appId);
        if (!app) {
          setState({ status: "error", title: "App not found", message: "This App is not installed or visible." });
        } else if (!app.canLaunch) {
          setState({ status: "error", title: "Access required", message: `You do not have permission to open ${app.displayName}.` });
        } else {
          setState({ status: "ready", app });
        }
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setState({
            status: "error",
            title: "Could not open App",
            message: error instanceof Error ? error.message : "Unexpected error",
          });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [appId]);

  useEffect(() => {
    let cancelled = false;
    if (!assistantConfigured) return () => undefined;

    resolveUsableChatAgent({
      requestedAgentId,
      requireAvailableAgent: true,
    })
      .then((agent) => {
        if (!cancelled) setAssistantBinding({ bindingKey: assistantBindingKey, agent });
      })
      .catch((error: unknown) => {
        console.warn(
          `[AgenticAppShell] Contextual assistant unavailable for ${appId}:`,
          error instanceof Error ? error.message : String(error),
        );
      });

    return () => {
      cancelled = true;
    };
  }, [appId, assistantBindingKey, assistantConfigured, requestedAgentId]);

  useEffect(() => {
    if (!assistantConfigured) return;

    function onMessage(event: MessageEvent): void {
      const expectedSource = iframeRef.current?.contentWindow ?? null;
      if (event.origin !== window.location.origin || event.source !== expectedSource) return;

      if (isAssistantOpenMessage(event.data, appId)) {
        setAssistantOpen(true);
        return;
      }

      const result = validateAssistantContextMessage({
        message: event.data,
        appId,
        origin: event.origin,
        expectedOrigin: window.location.origin,
        source: event.source,
        expectedSource,
        maxBytes:
          state.status === "ready" ? state.app.assistantMaxContextBytes : undefined,
      });
      if (result.ok) setAssistantContext(result.record);
    }

    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [appId, assistantConfigured, state]);

  if (state.status === "loading") {
    return (
      <div className="flex flex-1 items-center justify-center">
        <LoaderCircle className="h-6 w-6 animate-spin text-muted-foreground" aria-label="Loading App" />
      </div>
    );
  }

  if (state.status === "error") {
    return (
      <div className="flex flex-1 items-center justify-center p-6">
        <div className="max-w-lg rounded-xl border p-8 text-center">
          <h1 className="text-xl font-semibold">{state.title}</h1>
          <p className="mt-2 text-sm text-muted-foreground">{state.message}</p>
          <Link className="mt-5 inline-flex items-center gap-2 text-sm font-medium text-primary" href="/apps">
            <ArrowLeft className="h-4 w-4" aria-hidden /> Back to Apps
          </Link>
        </div>
      </div>
    );
  }

  const query = searchParams.toString();
  const runtimePath = `${buildAgenticAppPublicPath(appId, path)}${query ? `?${query}` : ""}`;
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-3 border-b bg-background px-4 py-2">
        <Link className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground" href="/apps">
          <ArrowLeft className="h-4 w-4" aria-hidden /> Apps
        </Link>
        <span className="text-muted-foreground" aria-hidden>/</span>
        <span className="truncate text-sm font-medium">{state.app.displayName}</span>
      </div>
      <iframe
        ref={iframeRef}
        className="min-h-0 flex-1 border-0 bg-background"
        src={runtimePath}
        title={state.app.displayName}
        allow="clipboard-read; clipboard-write"
      />
      {assistantConfigured && assistantAgent ? (
        <AgenticAppAssistantOverlay
          appId={state.app.appId}
          appName={state.app.displayName}
          assistantLabel={state.app.assistantLabel}
          assistantAgentName={state.app.assistantAgentName}
          activeContext={assistantContext}
          onClearContext={() => setAssistantContext(null)}
          assistantAgentId={assistantAgent.id}
          open={assistantOpen}
          onOpenChange={setAssistantOpen}
        />
      ) : null}
    </div>
  );
}

function isAssistantOpenMessage(message: unknown, appId: string): boolean {
  return (
    typeof message === "object" &&
    message !== null &&
    "type" in message &&
    "version" in message &&
    "appId" in message &&
    message.type === "caipe.agenticApp.assistant.open.v1" &&
    message.version === "1.0" &&
    message.appId === appId
  );
}
