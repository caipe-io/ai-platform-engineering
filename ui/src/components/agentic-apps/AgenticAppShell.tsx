"use client";

import { ArrowLeft, LoaderCircle } from "lucide-react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { useSession } from "next-auth/react";
import { ownsAppPath } from "@/lib/agentic-apps/host-routes";

import { AgenticAppAssistantOverlay } from "@/components/agentic-apps/AgenticAppAssistantOverlay";
import { validateAssistantContextMessage } from "@/lib/agentic-apps/assistant-context";
import { buildAgenticAppPublicPath } from "@/lib/agentic-apps/runtime";
import { nativeAgenticAppDestination } from "@/lib/agentic-apps/public-app";
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
  hostRoute = false,
}: {
  appId: string;
  path: string[];
  hostRoute?: boolean;
}): React.ReactElement {
  const router = useRouter();
  const { data: session, status: sessionStatus } = useSession();
  const identity = session?.user?.email
    ? JSON.stringify([session.sub ?? session.user.email, session.org ?? "", session.role ?? ""])
    : undefined;
  const [assistantError, setAssistantError] = useState<string | null>(null);
  const [assistantRetry, setAssistantRetry] = useState(0);
  const [bridgeError, setBridgeError] = useState<string | null>(null);
  const [hash, setHash] = useState("");
  useEffect(() => {
    const update = () => setHash(window.location.hash);
    update();
    window.addEventListener("hashchange", update);
    return () => window.removeEventListener("hashchange", update);
  }, []);
  const searchParams = useSearchParams();
  const [state, setState] = useState<ShellState>({ status: "loading" });
  const aliasPath = JSON.stringify(path);
  const search = searchParams.toString();
  const [assistantContext, setAssistantContext] =
    useState<AgenticAppAssistantContextRecord | null>(null);
  const [assistantOpen, setAssistantOpen] = useState(false);
  const [assistantBinding, setAssistantBinding] = useState<{
    bindingKey: string;
    agent: ResolvedChatAgent;
  } | null>(null);
  const iframeRef = useRef<HTMLIFrameElement | null>(null);

  useEffect(() => {
    queueMicrotask(() => {
      setState({ status: "loading" });
      setAssistantContext(null);
      setAssistantOpen(false);
      setAssistantBinding(null);
      setBridgeError(null);
      setAssistantError(null);
    });
  }, [appId, identity, sessionStatus]);

  const requestedAgentId = state.status === "ready" ? state.app.assistantAgentId : undefined;
  const assistantBindingKey = `${identity}:${appId}:${requestedAgentId ?? "default"}`;
  const assistantAgent =
    assistantBinding?.bindingKey === assistantBindingKey ? assistantBinding.agent : null;
  const assistantConfigured =
    state.status === "ready" && state.app.assistantEnabled === true && state.app.assistantOverlay !== "app";

  useEffect(() => {
    let cancelled = false;
    if (sessionStatus !== "authenticated") return;
    fetch(`/api/agentic-apps/${encodeURIComponent(appId)}`, {
      cache: "no-store",
    })
      .then(async (response) => {
        if (response.status === 401) {
          router.push(
            `/login?callbackUrl=${encodeURIComponent(window.location.pathname + window.location.search)}`,
          );
          return null;
        }
        if (!response.ok)
          throw new Error(`App lookup returned HTTP ${response.status}`);
        return response.json() as Promise<{ item: PublicAgenticApp }>;
      })
      .then((payload) => {
        if (cancelled || !payload) return;
        const app = payload.item;
        if (!app) {
          setState({
            status: "error",
            title: "App not found",
            message: "This App is not installed.",
          });
        } else if (!app.canLaunch) {
          setState({
            status: "error",
            title: "Access required",
            message: `You do not have permission to open ${app.displayName}.`,
          });
        } else if (app.uiMode === "native-package" || (!hostRoute && app.hostPaths?.length)) {
          router.replace(
            nativeAgenticAppDestination(app, JSON.parse(aliasPath), search) + window.location.hash,
          );
        } else {
          setState({ status: "ready", app });
        }
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setState({
            status: "error",
            title: "Could not open App",
            message:
              error instanceof Error ? error.message : "Unexpected error",
          });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [aliasPath, appId, hostRoute, identity, router, search, sessionStatus]);

  useEffect(() => {
    let cancelled = false;
    if (!assistantConfigured) return () => undefined;
    const controller = new AbortController();

    resolveUsableChatAgent({
      signal: controller.signal,
      requestedAgentId,
      requireAvailableAgent: true,
    })
      .then((agent) => {
        if (!cancelled) { setAssistantBinding({ bindingKey: assistantBindingKey, agent }); setAssistantError(null); }
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setAssistantError("Assistant is unavailable or access was denied.");
        console.warn(
          `[AgenticAppShell] Contextual assistant unavailable for ${appId}:`,
          error instanceof Error ? error.message : String(error),
        );
      });

    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [appId, assistantBindingKey, assistantConfigured, requestedAgentId, assistantRetry]);

  function notifyFrame(): void {
    if (state.status !== "ready") return;
    const target = iframeRef.current?.contentWindow;
    const envelope = { version: "1.0", appId };
    target?.postMessage({ ...envelope, type: "caipe.agenticApp.bridge.capabilities.v1",
      capabilities: { assistant: assistantConfigured && Boolean(assistantAgent), context: assistantConfigured, navigation: true, composerExtensions: [] } }, window.location.origin);
    target?.postMessage({ ...envelope, type: "caipe.agenticApp.navigation.v1",
      href: window.location.pathname + window.location.search + window.location.hash }, window.location.origin);
  }

  useEffect(() => {
    if (state.status !== "ready") return;
    const app = state.app;
    function onMessage(event: MessageEvent): void {
      const expectedSource = iframeRef.current?.contentWindow;
      if (!expectedSource || event.origin !== window.location.origin || event.source !== expectedSource ||
          event.data?.appId !== appId || typeof event.data?.type !== "string") return;
      const message = event.data;
      function reply(error?: string) {
        expectedSource.postMessage({ type: error ? "caipe.agenticApp.bridge.error.v1" : "caipe.agenticApp.bridge.capabilities.v1",
          version: "1.0", appId, ...(error ? { error } : { capabilities: {
            assistant: assistantConfigured && Boolean(assistantAgent), context: assistantConfigured, navigation: true, composerExtensions: [],
          } }) }, window.location.origin);
      }
      if (message.version !== "1.0") { reply("unsupported_version"); setBridgeError("This app uses an unsupported bridge version."); return; }
      if (message.type === "caipe.agenticApp.bridge.connect.v1") { reply(); return; }
      if (message.type === "caipe.agenticApp.navigate.v1") {
        const href = message.href;
        if (typeof href !== "string" || !href.startsWith("/") || href.startsWith("//") || /[\\\u0000-\u0020]/.test(href)) { reply("invalid_route"); return; }
        const url = new URL(href, window.location.origin);
        const roots = [...(app.hostPaths ?? []), `/apps/${appId}`];
        if (url.origin !== window.location.origin || !roots.some(root => ownsAppPath(root, url.pathname))) { reply("route_not_owned"); return; }
        if (url.pathname.startsWith("/apps/")) window.location.assign(href);
        else router.push(href, { scroll: false });
        return;
      }
      if (!assistantConfigured) { reply("assistant_unavailable_or_app_owned"); return; }
      if (message.requestOptions || message.composerExtensions) { reply("unsupported_composer_extension"); return; }
      if (isAssistantOpenMessage(message, appId)) { setAssistantOpen(true); return; }
      const result = validateAssistantContextMessage({ message, appId,
        origin: event.origin, expectedOrigin: window.location.origin,
        source: event.source, expectedSource });
      if (result.ok === true) setAssistantContext(result.record);
      else reply(result.reasonCode);
    }
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [appId, assistantConfigured, assistantAgent, router, state]);

  useEffect(() => {
    const target = iframeRef.current?.contentWindow;
    if (!target || state.status !== "ready") return;
    target.postMessage({ type: "caipe.agenticApp.bridge.capabilities.v1", version: "1.0", appId,
      capabilities: { assistant: assistantConfigured && Boolean(assistantAgent), context: assistantConfigured,
        navigation: true, composerExtensions: [] } }, window.location.origin);
  }, [appId, assistantAgent, assistantConfigured, state]);

  if (state.status === "loading") {
    return (
      <div className="flex flex-1 items-center justify-center">
        <LoaderCircle
          className="h-6 w-6 animate-spin text-muted-foreground"
          aria-label="Loading App"
        />
      </div>
    );
  }

  if (state.status === "error") {
    return (
      <div className="flex flex-1 items-center justify-center p-6">
        <div className="max-w-lg rounded-xl border p-8 text-center">
          <h1 className="text-xl font-semibold">{state.title}</h1>
          <p className="mt-2 text-sm text-muted-foreground">{state.message}</p>
          <Link
            className="mt-5 inline-flex items-center gap-2 text-sm font-medium text-primary"
            href="/apps"
          >
            <ArrowLeft className="h-4 w-4" aria-hidden /> Back to Apps
          </Link>
        </div>
      </div>
    );
  }

  const query = searchParams.toString();
  const runtimePath = `${buildAgenticAppPublicPath(appId, path)}${query ? `?${query}` : ""}${hash}`;
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-3 border-b bg-background px-4 py-2">
        <Link
          className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground"
          href="/apps"
        >
          <ArrowLeft className="h-4 w-4" aria-hidden /> Apps
        </Link>
        <span className="text-muted-foreground" aria-hidden>
          /
        </span>
        <span className="truncate text-sm font-medium">
          {state.app.displayName}
        </span>
      </div>
      {assistantConfigured && assistantError ? <p role="alert" className="p-3 text-sm text-destructive">
        {assistantError} <button type="button" onClick={() => setAssistantRetry(n => n + 1)} className="underline">Retry assistant</button>
      </p> : null}
      {bridgeError ? <p role="alert" className="p-3 text-sm text-destructive">{bridgeError}</p> : null}
      <iframe
        onLoad={notifyFrame}
        ref={iframeRef}
        className="min-h-0 flex-1 border-0 bg-background"
        src={runtimePath}
        title={state.app.displayName}
        allow="clipboard-read; clipboard-write"
      />
      {assistantConfigured && assistantAgent ? (
        <AgenticAppAssistantOverlay
          key={`${identity}:${appId}:${assistantAgent.id}`}
          appId={state.app.appId}
          appName={state.app.displayName}
          assistantIcon={state.app.icon}
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
