import { validateAssistantConfiguration } from "./assistant-options.mjs";

/** Standalone iframe client. No host stores, tokens, or singleton runtimes are imported. */
export function createAgenticAppBridge({ appId, onNavigate, onStatus, onAssistantState, timeoutMs = 5000 }) {
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
    } else if (message.type === "caipe.agenticApp.assistant.state.v1" && typeof message.open === "boolean") {
      onAssistantState?.(message.open);
    } else if (message.type === "caipe.agenticApp.assistant.configured.v1") {
      onStatus?.("configured", capabilities);
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
    configureAssistant(configuration) {
      if (!capabilities?.composerExtensions?.includes("configuration.v1")) throw new Error("Host assistant configuration is unsupported");
      validateAssistantConfiguration(configuration, capabilities.assistantOptions);
      send("caipe.agenticApp.assistant.configure.v1", { configuration });
    },
    openAssistant(context) {
      if (!capabilities?.assistant) throw new Error("Host assistant is unavailable or app-owned");
      if (context) send("caipe.agenticApp.context.v1", { context });
      send("caipe.agenticApp.assistant.open.v1");
    },
    closeAssistant() { send("caipe.agenticApp.assistant.close.v1"); },
    setContext(context) { send("caipe.agenticApp.context.v1", { context }); },
    navigate(href) { send("caipe.agenticApp.navigate.v1", { href }); },
    dispose() { clearTimeout(timer); window.removeEventListener("message", receive); disposed = true; },
  };
}
