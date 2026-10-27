import assert from 'node:assert/strict';
import test from 'node:test';
import { createAgenticAppBridge, parseAssistantDraft } from '../../app-sdk/iframe-bridge.mjs';

test('drafts are bounded plain text with a stable identifier', () => {
  assert.deepEqual(parseAssistantDraft({ id: 'source-1', text: 'Find source\nfor example-worker' }), { id: 'source-1', text: 'Find source\nfor example-worker' });
  for (const value of [null, [], {}, { id: 'x', text: ' ' }, { id: 'x', text: 'x'.repeat(12001) }, { id: 'x', text: 'bad\0text' }, { id: 'bad id', text: 'question' }]) assert.equal(parseAssistantDraft(value), null);
});

test('bridge publishes a draft only on an explicit call and compatible host', () => {
  const previous = globalThis.window;
  const messages = [], listeners = new Map();
  const parent = { postMessage: (message, origin) => messages.push({ message, origin }) };
  globalThis.window = { location: { origin: 'https://example.test' }, parent,
    addEventListener: (name, listener) => listeners.set(name, listener), removeEventListener: (name) => listeners.delete(name) };
  let bridge;
  try {
    bridge = createAgenticAppBridge({ appId: 'example' });
    const receive = (capabilities) => listeners.get('message')({ origin: 'https://example.test', source: parent, data: { type: 'caipe.agenticApp.bridge.capabilities.v1', version: '1.0', appId: 'example', capabilities } });
    receive({ assistant: true });
    assert.throws(() => bridge.openAssistant(undefined, { id: 'source-1', text: 'Find source' }), /unavailable/);
    assert.equal(messages.length, 1);
    receive({ assistant: false, assistantDraft: true });
    assert.throws(() => bridge.openAssistant(undefined, { id: 'source-1', text: 'Find source' }), /unavailable/);
    assert.equal(messages.length, 1);
    receive({ assistant: true, assistantDraft: true });
    assert.equal(messages.length, 1);
    bridge.openAssistant({ route: '/apps/example' }, { id: 'source-1', text: 'Find source' });
    assert.deepEqual(messages.at(-1), { origin: 'https://example.test', message: { type: 'caipe.agenticApp.assistant.open.v1', version: '1.0', appId: 'example', draft: { id: 'source-1', text: 'Find source' } } });
    bridge.openAssistant();
    assert.ok(!('draft' in messages.at(-1).message));
    assert.equal(messages.some(({ message }) => /submit|send|invoke/.test(message.type)), false);
  } finally { bridge?.dispose(); globalThis.window = previous; }
});
