/** Standalone iframe client. No host stores, tokens, or singleton runtimes are imported. */
export function createAgenticAppBridge({ appId, onNavigate, onStatus, timeoutMs = 5000 }) {
  if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(appId)) throw new Error("Invalid application ID");
  const origin = window.location.origin;
  let capabilities = null;
  let disposed = false;
  function send(type, fields = {}) {
    if (disposed) throw new Error("Application bridge is closed");
    window.parent.postMessage({ ...fields, type, version: "1.0", appId }, origin);
  }
  function receive(event) {
    if (event.origin !== origin || event.source !== window.parent || event.data?.appId !== appId) return;
    const message = event.data;
    if (message.version !== "1.0") { onStatus?.("unsupported_version"); return; }
    if (message.type === "caipe.agenticApp.bridge.capabilities.v1") {
      clearTimeout(timer);
      capabilities = message.capabilities;
      onStatus?.("ready", capabilities);
    } else if (message.type === "caipe.agenticApp.navigation.v1" && typeof message.href === "string") {
      onNavigate?.(message.href);
    } else if (message.type === "caipe.agenticApp.bridge.error.v1") {
      onStatus?.(message.error);
    }
  }
  window.addEventListener("message", receive);
  const timer = setTimeout(() => onStatus?.("unavailable"), timeoutMs);
  send("caipe.agenticApp.bridge.connect.v1");
  return {
    getCapabilities: () => capabilities,
    openAssistant(context) {
      if (!capabilities?.assistant) throw new Error("Host assistant is unavailable or app-owned");
      if (context) send("caipe.agenticApp.context.v1", { context });
      send("caipe.agenticApp.assistant.open.v1");
    },
    setContext(context) { send("caipe.agenticApp.context.v1", { context }); },
    navigate(href) { send("caipe.agenticApp.navigate.v1", { href }); },
    dispose() { clearTimeout(timer); window.removeEventListener("message", receive); disposed = true; },
  };
}
