/** The iframe may read app state, while conversation selection stays in the host. */
export function frameVisibleHref(url: URL, hostQueryKeys: readonly string[]): string {
  const visible = new URL(url.href);
  for (const key of hostQueryKeys) visible.searchParams.delete(key);
  return visible.pathname + visible.search + visible.hash;
}

export function retainHostQuery(url: URL, current: URL, hostQueryKeys: readonly string[]): string {
  const destination = new URL(url.href);
  for (const key of hostQueryKeys) {
    destination.searchParams.delete(key);
    for (const value of current.searchParams.getAll(key)) destination.searchParams.append(key, value);
  }
  return destination.pathname + destination.search + destination.hash;
}

type FrameQueryBridgeOptions = {
  host: Window;
  appId: string;
  publicPath: string;
  getPublicPath?: () => string;
  frame: () => HTMLIFrameElement | null;
  capabilities?: () => Record<string, unknown>;
  publishCapabilities?: boolean;
  hostQueryKeys?: () => readonly string[];
  onConnect: () => void;
};

/** Keep query navigation in the host history without allowing the iframe to leave its route. */
export function connectFrameQueryNavigation(options: FrameQueryBridgeOptions): {
  sync: () => void;
  isConnected: () => boolean;
  dispose: () => void;
} {
  const { host, appId, frame } = options;
  const publicPath = () => options.getPublicPath?.() ?? options.publicPath;
  let connected = false;
  const target = () => frame()?.contentWindow ?? null;
  const send = (type: string, extra: Record<string, unknown>) => {
    target()?.postMessage({ type, version: "1.0", appId, ...extra }, host.location.origin);
  };
  const sync = () => {
    if (!connected || host.location.pathname !== publicPath()) return;
    if (options.publishCapabilities !== false) {
      send("caipe.agenticApp.bridge.capabilities.v1", {
        capabilities: { ...options.capabilities?.(), queryNavigation: true },
      });
    }
    send("caipe.agenticApp.navigation.v1", {
      href: frameVisibleHref(new URL(host.location.href), options.hostQueryKeys?.() ?? ["assistant_chat"]),
    });
  };
  const onMessage = (event: MessageEvent) => {
    if (!target() || event.source !== target() || event.origin !== host.location.origin) return;
    const message = event.data;
    if (!message || message.appId !== appId || message.version !== "1.0") return;
    if (message.type === "caipe.agenticApp.bridge.connect.v1") {
      connected = true;
      options.onConnect();
      sync();
      return;
    }
    if (!connected || message.type !== "caipe.agenticApp.navigate.v1") return;
    const href = message.href;
    if (typeof href !== "string" || href.length > 8192 || !href.startsWith("/") || href.startsWith("//") || /[\\\u0000-\u0020]/.test(href)) return;
    let url: URL;
    try { url = new URL(href, host.location.origin); } catch { return; }
    if (url.origin !== host.location.origin || url.pathname !== publicPath() || host.location.pathname !== publicPath()) return;
    if (message.history !== undefined && !["push", "replace"].includes(message.history)) return;
    const current = new URL(host.location.href);
    const keys = options.hostQueryKeys?.() ?? ["assistant_chat"];
    // Host-only parameter ordering must not turn an unchanged view into a history entry.
    if (frameVisibleHref(url, keys) !== frameVisibleHref(current, keys)) {
      const next = retainHostQuery(url, current, keys);
      // Native history integrates with Next's search params while the frame src stays stable.
      if (message.history === "replace") host.history.replaceState(null, "", next);
      else host.history.pushState(null, "", next);
    }
    sync();
  };
  host.addEventListener("message", onMessage);
  host.addEventListener("popstate", sync);
  return {
    sync,
    isConnected: () => connected,
    dispose: () => {
      host.removeEventListener("message", onMessage);
      host.removeEventListener("popstate", sync);
    },
  };
}
