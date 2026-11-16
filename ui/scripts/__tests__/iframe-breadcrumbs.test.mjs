import assert from "node:assert/strict";
import test from "node:test";
import { createAgenticAppBridge } from "../../app-sdk/iframe-bridge.mjs";

test("breadcrumb presentation is sent only to a host that advertises it", () => {
  const original = globalThis.window;
  const listeners = new Map(), sent = [];
  const parent = { postMessage: message => sent.push(message) };
  globalThis.window = { location: { origin: "https://example.test" }, parent,
    addEventListener: (name, fn) => listeners.set(name, fn), removeEventListener: name => listeners.delete(name) };
  const bridge = createAgenticAppBridge({ appId: "example" });
  const items = [{ label: "Example goal", href: "/example/goal", tone: "primary", icon: "target" }];
  const ready = presentation => listeners.get("message")({ source: parent, origin: "https://example.test",
    data: { type: "caipe.agenticApp.bridge.capabilities.v1", version: "1.0", appId: "example",
      capabilities: { breadcrumbs: true, ...(presentation ? { breadcrumbPresentation: true } : {}) } } });
  try {
    ready(false);
    bridge.setBreadcrumbs(items, "/example/goal");
    assert.deepEqual(sent.at(-1).breadcrumbs, [{ label: "Example goal", href: "/example/goal" }]);
    ready(true);
    bridge.setBreadcrumbs(items, "/example/goal");
    assert.deepEqual(sent.at(-1).breadcrumbs, items);
    assert.equal(sent.at(-1).route, "/example/goal");
  } finally { bridge.dispose(); globalThis.window = original; }
});
