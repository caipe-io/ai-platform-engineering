import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { validateAgenticAppManifest, resolveAgenticAppHttpPolicyAction } from '../../../../ui/app-sdk/agentic-app-manifest.mjs';

test('host policies allow actual app requests and reject undeclared writes', async () => {
  const manifest = JSON.parse(await readFile(new URL('../deploy/app.json', import.meta.url), 'utf8'));
  validateAgenticAppManifest(manifest);
  for (const [method, path] of [
    ['GET', '/'], ['GET', '/client.js'], ['GET', '/api/config'], ['GET', '/api/templates'],
    ['GET', '/api/artifacts'], ['GET', '/artifacts/example-id'], ['POST', '/api/templates'],
    ['PUT', '/api/templates/example-id'], ['POST', '/mcp'],
  ]) assert.equal(resolveAgenticAppHttpPolicyAction(manifest, method, path)?.defaultEffect, 'allow', `${method} ${path}`);
  for (const [method, path] of [['POST', '/api/artifacts'], ['DELETE', '/api/templates/example-id'], ['PUT', '/api/templates']]) {
    assert.equal(resolveAgenticAppHttpPolicyAction(manifest, method, path), undefined, `${method} ${path}`);
  }
});
