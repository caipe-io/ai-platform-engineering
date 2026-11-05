import assert from "node:assert/strict";
import test from "node:test";
import { createAgenticAppBridge } from "../../app-sdk/iframe-bridge.mjs";

test("feedback requires the verified host and cannot override the calling component", () => {
  const original = globalThis.window;
  const listeners = new Map(), sent = [];
  const parent = { postMessage: (message, origin) => sent.push({ message, origin }) };
  globalThis.window = { location: { origin: "https://example.test" }, parent,
    addEventListener: (name, fn) => listeners.set(name, fn), removeEventListener: name => listeners.delete(name) };
  const bridge = createAgenticAppBridge({ appId: "example" });
  const capability = { type: "caipe.agenticApp.bridge.capabilities.v1", version: "1.0", appId: "example", capabilities: { feedback: true } };
  try {
    assert.throws(() => bridge.openFeedback(), /unavailable/);
    listeners.get("message")({ origin: "https://other.example.test", source: parent, data: capability });
    assert.throws(() => bridge.openFeedback(), /unavailable/);
    listeners.get("message")({ origin: "https://example.test", source: {}, data: capability });
    assert.throws(() => bridge.openFeedback(), /unavailable/);
    listeners.get("message")({ origin: "https://example.test", source: parent, data: capability });
    assert.throws(() => bridge.openFeedback({ feature: "x".repeat(41) }), /Invalid/);
    bridge.openFeedback({ feature: "Publishing", componentId: "other" });
    assert.deepEqual(sent.at(-1), { origin: "https://example.test", message: {
      type: "caipe.agenticApp.feedback.open.v1", version: "1.0", appId: "example", feature: "Publishing",
    } });
  } finally { bridge.dispose(); globalThis.window = original; }
});
