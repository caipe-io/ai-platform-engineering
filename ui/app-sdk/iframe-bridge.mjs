import { validateAssistantConfiguration } from "./assistant-options.mjs";

// Preserve keyboard focus rings when decorative shadows are disabled.
export const INTERFACE_SHADOWS_CSS = `
html[data-interface-shadows="off"] *,
html[data-interface-shadows="off"] *::before,
html[data-interface-shadows="off"] *::after {
  --tw-shadow: 0 0 #0000 !important;
  --tw-inset-shadow: 0 0 #0000 !important;
  box-shadow: var(--tw-inset-ring-shadow, 0 0 #0000), var(--tw-ring-offset-shadow, 0 0 #0000), var(--tw-ring-shadow, 0 0 #0000) !important;
  text-shadow: none !important;
}`;

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
    if (message.type === "caipe.microfrontend.initialize.v1") {
      const enabled = message.context?.preferences?.shadows_enabled;
      if (typeof enabled === "boolean") {
        document.documentElement.setAttribute("data-interface-shadows", enabled ? "on" : "off");
        if (!document.getElementById("caipe-interface-shadows")) {
          const style = document.createElement("style");
          style.id = "caipe-interface-shadows";
          style.textContent = INTERFACE_SHADOWS_CSS;
          document.head.appendChild(style);
        }
      }
    } else if (message.type === "caipe.agenticApp.bridge.capabilities.v1") {
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
  function forwardShortcut(event) {
    if (!Array.isArray(capabilities?.hostShortcuts) || !capabilities.hostShortcuts.includes("search") || event.defaultPrevented || event.repeat || event.isComposing ||
        event.altKey || event.shiftKey || (!event.metaKey && !event.ctrlKey) || event.key?.toLowerCase() !== "k") return;
    event.preventDefault();
    send("caipe.agenticApp.shortcut.v1", { shortcut: "search" });
  }
  window.addEventListener("message", receive);
  window.addEventListener("keydown", forwardShortcut);
  const timer = setTimeout(() => onStatus?.("unavailable"), timeoutMs);
  send("caipe.agenticApp.bridge.connect.v1");
  return {
    getCapabilities: () => capabilities,
    configureAssistant(configuration) {
      if (!capabilities?.composerExtensions?.includes("configuration.v1")) throw new Error("Host assistant configuration is unsupported");
      validateAssistantConfiguration(configuration, capabilities.assistantOptions);
      send("caipe.agenticApp.assistant.configure.v1", { configuration });
    },
    openAssistant(context, draft) {
      if (!capabilities?.assistant) throw new Error("Host assistant is unavailable or app-owned");
      const valid = draft === undefined ? null : parseAssistantDraft(draft);
      if (draft !== undefined && (!valid || !capabilities.assistantDraft)) throw new Error("Host assistant drafts are unavailable or the draft is invalid");
      if (context) send("caipe.agenticApp.context.v1", { context });
      send("caipe.agenticApp.assistant.open.v1", valid ? { draft: valid } : {});
    },
    closeAssistant() { send("caipe.agenticApp.assistant.close.v1"); },
    setContext(context) { send("caipe.agenticApp.context.v1", { context }); },
    navigate(href, options = {}) { send("caipe.agenticApp.navigate.v1", { href, ...(options.history ? { history: options.history } : {}) }); },
    setBreadcrumbs(breadcrumbs, route) {
      if (!capabilities?.breadcrumbs) throw new Error("Host breadcrumbs are unsupported");
      const items = capabilities.breadcrumbPresentation ? breadcrumbs : breadcrumbs.map(({ label, href }) => ({ label, ...(href !== undefined ? { href } : {}) }));
      send("caipe.agenticApp.breadcrumbs.v1", { breadcrumbs: items, route });
    },
    dispose() { clearTimeout(timer); window.removeEventListener("message", receive); window.removeEventListener("keydown", forwardShortcut); disposed = true; },
  };
}

/** Optional plain-text composer handoff; never an instruction to submit. */
export function parseAssistantDraft(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  if (typeof value.id !== "string" || !/^[a-zA-Z0-9_-]{1,128}$/.test(value.id) ||
      typeof value.text !== "string" || !value.text.trim() || value.text.length > 12000 ||
      /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value.text)) return null;
  return { id: value.id, text: value.text };
}
