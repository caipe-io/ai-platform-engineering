import assert from 'node:assert/strict';
import test from 'node:test';
import { createAgenticAppBridge, parseAssistantDraft } from '../../app-sdk/iframe-bridge.mjs';

test('text drafts are bounded and have a stable identifier', () => {
  assert.deepEqual(parseAssistantDraft({ id: 'source-1', text: 'Find source\nfor example-worker' }), { id: 'source-1', text: 'Find source\nfor example-worker' });
  for (const value of [null, [], {}, { id: 'x', text: ' ' }, { id: 'x', text: 'x'.repeat(12001) }, { id: 'x', text: 'bad\0text' }, { id: 'bad id', text: 'question' }]) assert.equal(parseAssistantDraft(value), null);
});

test('drafts can stage a bounded Markdown attachment without submitting', () => {
  const attachment = { name: 'example-digest.md', content: '# Example digest\n\nA source-backed update.', mimeType: 'text/markdown' };
  assert.deepEqual(parseAssistantDraft({ id: 'digest-1', text: '', attachment }), { id: 'digest-1', text: '', attachment });
  for (const invalid of [
    { ...attachment, name: '../digest.md' },
    { ...attachment, name: 'digest.txt' },
    { ...attachment, content: '' },
    { ...attachment, content: 'x'.repeat(128 * 1024 + 1) },
  ]) assert.equal(parseAssistantDraft({ id: 'digest-1', text: '', attachment: invalid }), null);
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

test('host presentation accepts only a boolean shadow preference from the verified parent', () => {
  const previousWindow = globalThis.window, previousDocument = globalThis.document;
  const listeners = new Map(), attributes = new Map(), styles = [];
  const parent = { postMessage() {} };
  globalThis.window = { location: { origin: 'https://example.test' }, parent,
    addEventListener: (name, listener) => listeners.set(name, listener), removeEventListener: name => listeners.delete(name) };
  globalThis.document = { documentElement: { setAttribute: (key,value) => attributes.set(key,value) },
    getElementById: id => styles.find(style => style.id === id), createElement: () => ({}), head: { appendChild: style => styles.push(style) } };
  let bridge;
  try {
    bridge = createAgenticAppBridge({ appId: 'example' });
    const data = { type: 'caipe.microfrontend.initialize.v1', appId: 'example', version: '1.0', context: { preferences: { shadows_enabled: false } } };
    const receive = (overrides = {}) => listeners.get('message')({ origin: 'https://example.test', source: parent, data, ...overrides });
    receive({ origin: 'https://other.example.test' });
    receive({ source: {} });
    receive({ data: { ...data, appId: 'secondary' } });
    receive({ data: { ...data, context: { preferences: { shadows_enabled: 'false' } } } });
    assert.equal(attributes.size, 0);
    receive();
    assert.equal(attributes.get('data-interface-shadows'), 'off');
    assert.match(styles[0].textContent, /var\(--tw-ring-shadow/);
    receive({ data: { ...data, context: { preferences: { shadows_enabled: true } } } });
    assert.equal(attributes.get('data-interface-shadows'), 'on');
    assert.equal(styles.length, 1);
  } finally { bridge?.dispose(); globalThis.window = previousWindow; globalThis.document = previousDocument; }
});
