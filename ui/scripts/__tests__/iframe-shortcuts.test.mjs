import assert from "node:assert/strict";
import test from "node:test";
import { createAgenticAppBridge } from "../../app-sdk/iframe-bridge.mjs";

test("only an advertised search shortcut is forwarded to the verified parent", () => {
  const original = globalThis.window;
  const listeners = new Map(), sent = [];
  const parent = { postMessage: (message, origin) => sent.push({ message, origin }) };
  globalThis.window = { location: { origin: "https://example.test" }, parent,
    addEventListener: (name, fn) => listeners.set(name, fn), removeEventListener: name => listeners.delete(name) };
  const bridge = createAgenticAppBridge({ appId: "example" });
  let prevented = 0;
  const key = changes => listeners.get("keydown")({ key: "k", metaKey: true,
    preventDefault() { prevented++; }, ...changes });
  const capabilities = { type: "caipe.agenticApp.bridge.capabilities.v1", version: "1.0", appId: "example", capabilities: { hostShortcuts: ["search"] } };
  try {
    key(); assert.equal(prevented, 0);
    listeners.get("message")({ origin: "https://other.example.test", source: parent, data: capabilities });
    key(); assert.equal(prevented, 0);
    listeners.get("message")({ origin: "https://example.test", source: {}, data: capabilities });
    key(); assert.equal(prevented, 0);
    listeners.get("message")({ origin: "https://example.test", source: parent, data: capabilities });
    for (const change of [{ key: "p" }, { shiftKey: true }, { altKey: true }, { repeat: true }, { isComposing: true }, { defaultPrevented: true }, { metaKey: false }]) key(change);
    assert.equal(prevented, 0);
    key(); key({ metaKey: false, ctrlKey: true });
    assert.equal(prevented, 2);
    assert.deepEqual(sent.slice(1), [1, 2].map(() => ({ origin: "https://example.test",
      message: { type: "caipe.agenticApp.shortcut.v1", appId: "example", version: "1.0", shortcut: "search" } })));
  } finally { bridge.dispose(); globalThis.window = original; }
  assert.equal(listeners.size, 0);
});
