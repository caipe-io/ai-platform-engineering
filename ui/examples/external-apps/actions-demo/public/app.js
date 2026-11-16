// SPDX-License-Identifier: Apache-2.0

const basePath = document.documentElement.dataset.basePath;
const status = document.getElementById("status");
const flag = document.getElementById("show-flag");
const mark = document.getElementById("show-mark");
const received = document.getElementById("received");

// The host serves this page same-origin, so the bridge can reach its parent window.
const { createAgenticAppBridge } = await import(`${basePath}/assets/sdk/iframe-bridge.mjs`);

let ready = false;
const bridge = createAgenticAppBridge({
  appId: "actions-demo",
  onStatus(next, capabilities) {
    if (next === "ready") {
      ready = true;
      const supported = capabilities?.composerExtensions?.includes("messageActions.v1");
      status.textContent = supported
        ? "Connected. This host supports message actions."
        : "Connected, but this host does not support message actions.";
      if (supported) apply();
    } else if (next === "configured") {
      status.textContent = "Connected. Action visibility sent to the host.";
    } else {
      status.textContent = `Host bridge: ${next}`;
    }
  },
});

/** Tell the host which declared actions this user may see. */
function apply() {
  if (!ready) return;
  try {
    bridge.configureAssistant({
      version: "1.0",
      visible: true,
      messageActions: { "flag-answer": { visible: flag.checked }, mark: { visible: mark.checked } },
    });
  } catch (error) {
    status.textContent = error instanceof Error ? error.message : "Could not configure the assistant";
  }
}

async function refresh() {
  try {
    const response = await fetch(`${basePath}/api/assistant/actions/received`, { cache: "no-store" });
    const { calls } = await response.json();
    received.textContent = calls.length ? JSON.stringify(calls, null, 2) : "No calls yet.";
  } catch {
    received.textContent = "Could not load the received calls.";
  }
}

flag.addEventListener("change", apply);
mark.addEventListener("change", apply);
document.getElementById("refresh").addEventListener("click", refresh);
window.addEventListener("pagehide", () => bridge.dispose());
refresh();
