"use client";

import { ArrowLeft, LoaderCircle } from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useSession } from "next-auth/react";
import { OPEN_APPLICATION_SEARCH_EVENT } from "@/lib/navigation-events";
import { ASSISTANT_EXTENSIONS, validateAssistantConfiguration, type AssistantConfiguration } from "../../../app-sdk/assistant-options.mjs";
import { readAssistantDeepLink } from "@/lib/agentic-apps/assistant-links";
import { rememberAssistantPresentation } from "@/lib/agentic-apps/assistant-presentation";
import { parseFrameBreadcrumbs, type FrameBreadcrumb } from "@/lib/agentic-apps/frame-breadcrumbs";
import { ownsAppPath } from "@/lib/agentic-apps/host-routes";
import { HostedAgenticAppFrame } from "./HostedAgenticAppFrame";

import { AgenticAppAssistantOverlay } from "@/components/agentic-apps/AgenticAppAssistantOverlay";
import { parseAssistantDraft, type AssistantDraft } from "@/lib/agentic-apps/assistant-draft";
import { validateAssistantContextMessage } from "@/lib/agentic-apps/assistant-context";
import { WorkspaceBreadcrumbs } from "@/components/layout/WorkspacePageHeader";
import { buildAgenticAppPublicPath } from "@/lib/agentic-apps/runtime";
import { connectFrameQueryNavigation } from "@/lib/agentic-apps/frame-query-navigation";
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
  const pathname = usePathname();
  const { data: session, status: sessionStatus } = useSession();
  const identity = session?.user?.email
    ? JSON.stringify([session.sub ?? session.user.email, session.org ?? "", session.role ?? ""])
    : undefined;
  const [configuration, setConfiguration] = useState<AssistantConfiguration | null>(null);
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
  const [assistantDraft, setAssistantDraft] = useState<(AssistantDraft & { appId: string }) | null>(null);
  const consumedDrafts = useRef(new Set<string>());
  const [assistantBinding, setAssistantBinding] = useState<{
    bindingKey: string;
    agent: ResolvedChatAgent;
  } | null>(null);
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const initialPublicPath = hostRoute ? `/${path.map(encodeURIComponent).join("/")}` : buildAgenticAppPublicPath(appId, path);
  const roots = [...(state.status === "ready" ? state.app.hostPaths ?? [] : []), `/apps/${appId}`];
  const publicPath = pathname && roots.some(root => ownsAppPath(root, pathname)) ? pathname : initialPublicPath;
  const [managedFrame, setManagedFrame] = useState<{ identity: string; appId: string; src: string } | null>(null);
  const latestPublicPath = useRef(publicPath);
  useLayoutEffect(() => { latestPublicPath.current = publicPath; }, [publicPath]);
  const [frameBreadcrumbs, setFrameBreadcrumbs] = useState<{ route: string; items: FrameBreadcrumb[] } | null>(null);
  const queryBridge = useRef<ReturnType<typeof connectFrameQueryNavigation> | null>(null);
  const latestSearch = useRef(search);
  useEffect(() => { latestSearch.current = search; }, [search]);

  useEffect(() => {
    queueMicrotask(() => {
      setState({ status: "loading" });
      setAssistantContext(null);
      setConfiguration(null);
      setAssistantOpen(false);
      setAssistantDraft(null);
      consumedDrafts.current.clear();
      setAssistantBinding(null);
      setBridgeError(null);
      setFrameBreadcrumbs(null);
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
    const bridge = connectFrameQueryNavigation({
      host: window, appId, publicPath: latestPublicPath.current, getPublicPath: () => latestPublicPath.current, frame: () => iframeRef.current,
      // The shell publishes the complete assistant capabilities. This helper
      // owns only history/state synchronization, so it cannot overwrite them.
      publishCapabilities: false,
      onConnect: () => {
        const src = iframeRef.current?.getAttribute("src");
        if (src) setManagedFrame((previous) => previous?.identity === identity && previous.appId === appId && previous.src === src ? previous : { identity, appId, src });
      },
    });
    queryBridge.current = bridge;
    return () => { bridge.dispose(); queryBridge.current = null; };
  }, [appId, identity]);

  useEffect(() => { queryBridge.current?.sync(); }, [publicPath, search]);

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
            nativeAgenticAppDestination(app, JSON.parse(aliasPath), latestSearch.current) + window.location.hash,
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
  }, [aliasPath, appId, hostRoute, identity, router, sessionStatus]);

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

  useEffect(() => {
    if (assistantAgent && assistantConfigured && readAssistantDeepLink(searchParams.toString(), state.status === "ready" ? state.app.assistantOptions : undefined).requested) queueMicrotask(() => setAssistantOpen(true));
  }, [assistantAgent, assistantConfigured, searchParams, state]);

  function notifyFrame(): void {
    if (state.status !== "ready") return;
    setConfiguration(null);
    setAssistantContext(null);
    setFrameBreadcrumbs(null);
    const target = iframeRef.current?.contentWindow;
    const envelope = { version: "1.0", appId };
    target?.postMessage({ ...envelope, type: "caipe.agenticApp.bridge.capabilities.v1",
      capabilities: { assistant: assistantConfigured && Boolean(assistantAgent), context: assistantConfigured, assistantDraft: assistantConfigured, navigation: true, queryNavigation: true, pathNavigation: true, breadcrumbs: true, breadcrumbPresentation: true, hostShortcuts: ["search"], composerExtensions: [...ASSISTANT_EXTENSIONS], assistantOptions: state.app.assistantOptions } }, window.location.origin);
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
            assistant: assistantConfigured && Boolean(assistantAgent), context: assistantConfigured, assistantDraft: assistantConfigured, navigation: true, queryNavigation: true, pathNavigation: true, breadcrumbs: true, breadcrumbPresentation: true, hostShortcuts: ["search"], composerExtensions: [...ASSISTANT_EXTENSIONS], assistantOptions: app.assistantOptions,
          } }) }, window.location.origin);
      }
      if (message.version !== "1.0") { reply("unsupported_version"); setBridgeError("This app uses an unsupported bridge version."); return; }
      if (message.type === "caipe.agenticApp.bridge.connect.v1") {
        reply();
        expectedSource.postMessage({ type: "caipe.agenticApp.navigation.v1", version: "1.0", appId,
          href: window.location.pathname + window.location.search + window.location.hash }, window.location.origin);
        expectedSource.postMessage({ type: "caipe.agenticApp.assistant.state.v1", version: "1.0", appId,
          open: assistantOpen }, window.location.origin);
        return;
      }
      if (message.type === "caipe.agenticApp.shortcut.v1") {
        if (message.shortcut !== "search") { reply("unsupported_shortcut"); return; }
        window.dispatchEvent(new Event(OPEN_APPLICATION_SEARCH_EVENT));
        return;
      }
      if (message.type === "caipe.agenticApp.navigate.v1") {
        const href = message.href;
        if (typeof href !== "string" || !href.startsWith("/") || href.startsWith("//") || /[\\\u0000-\u0020]/.test(href)) { reply("invalid_route"); return; }
        const url = new URL(href, window.location.origin);
        // The query bridge owns connected same-path history changes. Keep
        // approved host-route navigation on the existing router path.
        if (queryBridge.current?.isConnected() && url.pathname === publicPath) return;
        if (message.history !== undefined && !["push", "replace"].includes(message.history)) { reply("invalid_route"); return; }
        const roots = [...(app.hostPaths ?? []), `/apps/${appId}`];
        if (url.origin !== window.location.origin || !roots.some(root => ownsAppPath(root, url.pathname))) { reply("route_not_owned"); return; }
        if (queryBridge.current?.isConnected()) {
          // Next's native history integration updates the URL without replacing
          // the server page that owns this iframe document.
          if (message.history === "replace") window.history.replaceState(null, "", href);
          else window.history.pushState(null, "", href);
        } else router.push(href, { scroll: false });
        return;
      }
      if (message.type === "caipe.agenticApp.breadcrumbs.v1") {
        const roots = [...(app.hostPaths ?? []), `/apps/${appId}`];
        const items = parseFrameBreadcrumbs(message.breadcrumbs, roots);
        const route = message.route;
        if (!items || typeof route !== "string" || route.length > 2048 || !route.startsWith("/") || /[\\\u0000-\u0020]/.test(route) || !roots.some(root => ownsAppPath(root, route))) { reply("invalid_breadcrumbs"); return; }
        setFrameBreadcrumbs({ route, items });
        return;
      }
      if (!assistantConfigured) { reply("assistant_unavailable_or_app_owned"); return; }
      if (message.type === "caipe.agenticApp.assistant.configure.v1") {
        try {
          validateAssistantConfiguration(message.configuration, app.assistantOptions);
          if (app.assistantAgentId) rememberAssistantPresentation(appId, app.assistantAgentId, session, message.configuration, app.assistantOptions);
          setConfiguration(message.configuration);
          if (!message.configuration.visible) setAssistantOpen(false);
          setBridgeError(null);
          expectedSource.postMessage({ type: "caipe.agenticApp.assistant.configured.v1", version: "1.0", appId }, window.location.origin);
        } catch (reason) {
          reply("invalid_assistant_configuration");
          setBridgeError(reason instanceof Error ? reason.message : "Invalid assistant configuration");
        }
        return;
      }
      if (message.requestOptions || message.composerExtensions) { reply("unsupported_composer_extension"); return; }
      if (message.type === "caipe.agenticApp.assistant.close.v1") { setAssistantOpen(false); return; }
      if (isAssistantOpenMessage(message, appId)) {
        const draft = parseAssistantDraft(message.draft);
        if (draft && !consumedDrafts.current.has(`${appId}:${draft.id}`)) {
          setAssistantDraft({ ...draft, appId });
        }
        setAssistantOpen(true);
        return;
      }
      const result = validateAssistantContextMessage({ message, appId,
        origin: event.origin, expectedOrigin: window.location.origin,
        source: event.source, expectedSource });
      if (result.ok === true) setAssistantContext(result.record);
      else reply(result.reasonCode);
    }
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [appId, assistantConfigured, assistantAgent, assistantOpen, publicPath, router, state, session]);

  useEffect(() => {
    const target = iframeRef.current?.contentWindow;
    if (!target || state.status !== "ready") return;
    target.postMessage({ type: "caipe.agenticApp.bridge.capabilities.v1", version: "1.0", appId,
      capabilities: { assistant: assistantConfigured && Boolean(assistantAgent), context: assistantConfigured, assistantDraft: assistantConfigured,
        navigation: true, queryNavigation: true, pathNavigation: true, breadcrumbs: true, breadcrumbPresentation: true, hostShortcuts: ["search"], composerExtensions: [...ASSISTANT_EXTENSIONS], assistantOptions: state.app.assistantOptions } }, window.location.origin);
  }, [appId, assistantAgent, assistantConfigured, state]);

  useEffect(() => {
    iframeRef.current?.contentWindow?.postMessage({ type: "caipe.agenticApp.assistant.state.v1", version: "1.0", appId, open: assistantOpen }, window.location.origin);
  }, [appId, assistantOpen]);

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

  const runtimeSearch = new URLSearchParams(search);
  for (const key of ["assistant_chat", ...(state.app.assistantOptions?.legacyConversationQueryParams ?? [])]) runtimeSearch.delete(key);
  const query = runtimeSearch.toString();
  const requestedRuntimePath = `${buildAgenticAppPublicPath(appId, path)}${query ? `?${query}` : ""}${hash}`;
  if (hostRoute && !(state.app.hostPaths ?? []).some(root => ownsAppPath(root, publicPath))) return <></>;
  return (
    <div className="flex h-full min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
      <WorkspaceBreadcrumbs
        breadcrumbs={(frameBreadcrumbs?.route === publicPath && frameBreadcrumbs.items.length ? frameBreadcrumbs.items : [
          { label: "Home", href: "/" },
          { label: state.app.displayName },
        ]).map(item => ({ ...item, onClick: event => {
          if (!item.href || !queryBridge.current?.isConnected() || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) return;
          const url = new URL(item.href, window.location.origin);
          if (!roots.some(root => ownsAppPath(root, url.pathname))) return;
          event.preventDefault();
          window.history.pushState(null, "", item.href);
        } }))}
      />
      {assistantConfigured && assistantError ? <p role="alert" className="p-3 text-sm text-destructive">
        {assistantError} <button type="button" onClick={() => setAssistantRetry(n => n + 1)} className="underline">Retry assistant</button>
      </p> : null}
      {bridgeError ? <p role="alert" className="p-3 text-sm text-destructive">{bridgeError}</p> : null}
      <HostedAgenticAppFrame key={identity} appId={appId}
        onLoad={notifyFrame}
        ref={iframeRef}
        className="block h-full min-h-0 w-full flex-1 border-0 bg-background"
        src={managedFrame?.identity === identity && managedFrame.appId === appId ? managedFrame.src : requestedRuntimePath}
        title={state.app.displayName}
        allow="clipboard-read; clipboard-write"
      />
      {assistantConfigured && assistantAgent && (configuration?.visible ?? !state.app.assistantOptions?.requireConfiguration) ? (
        <AgenticAppAssistantOverlay
          assistantAgent={assistantAgent.config}
          key={`${identity}:${appId}:${assistantAgent.id}`}
          options={state.app.assistantOptions} configuration={configuration ?? undefined}
          appId={state.app.appId}
          appName={state.app.displayName}
          assistantIcon={state.app.icon}
          assistantLabel={state.app.assistantLabel}
          assistantAgentName={state.app.assistantAgentName}
          activeContext={assistantContext}
          onClearContext={() => setAssistantContext(null)}
          assistantAgentId={assistantAgent.id}
          composerDraft={assistantDraft?.appId === appId ? assistantDraft : null}
          onComposerDraftApplied={(id) => {
            const key = `${appId}:${id}`;
            consumedDrafts.current.add(key);
            if (consumedDrafts.current.size > 128) {
              const oldest = consumedDrafts.current.values().next().value;
              if (oldest !== undefined) consumedDrafts.current.delete(oldest);
            }
            setAssistantDraft((draft) => draft?.appId === appId && draft.id === id ? null : draft);
          }}
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
