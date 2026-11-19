import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPair, SignJWT, createLocalJWKSet, exportJWK } from 'jose';
import { createAuthenticator } from '../src/auth.mjs';
const { privateKey, publicKey } = await generateKeyPair('RS256');
const keys = createLocalJWKSet({ keys: [{ ...await exportJWK(publicKey), kid: 'example-key', alg: 'RS256' }] });
const config = { issuer: 'https://identity.example.test', audience: 'https://example.test/apps/presentations/mcp', hostOrigin: 'https://example.test' };
export async function token(overrides = {}) {
  return new SignJWT({ sub: 'example-user', ...overrides }).setProtectedHeader({ alg: 'RS256', kid: 'example-key' })
    .setIssuer(config.issuer).setAudience(config.audience).setExpirationTime('5m').sign(privateKey);
}
const memberships = () => new Response(JSON.stringify({ success: true, data: [{ slug: 'example-team', name: 'Example', user_role: 'member' }] }));
test('validates signature, expiry, issuer, audience and stable subject before membership lookup', async () => {
  let calls = 0;
  const auth = createAuthenticator(config, { keys, fetchImpl: async () => { calls++; return memberships(); } });
  for (const invalid of ['', 'invalid', await token({ sub: '' })]) await assert.rejects(auth({ headers: { authorization: `Bearer ${invalid}`, 'x-caipe-user': 'forged-admin' } }));
  const wrongAudience = await new SignJWT({ sub: 'example-user' }).setProtectedHeader({ alg: 'RS256', kid: 'example-key' }).setIssuer(config.issuer).setAudience('other').setExpirationTime('5m').sign(privateKey);
  await assert.rejects(auth({ headers: { authorization: `Bearer ${wrongAudience}` } }));
  assert.equal(calls, 0);
  const signed = await token();
  const identity = await auth({ headers: { authorization: `Bearer ${signed}` } });
  assert.equal(identity.subject, 'example-user'); assert.equal(identity.teams.get('example-team').role, 'member');
});
test('uses the canonical membership API on every request and fails closed on outages or malformed results', async () => {
  const signed = await token({ groups: ['forged-admin-team'] });
  let calls = 0;
  const auth = createAuthenticator(config, { keys, fetchImpl: async (url, options) => {
    calls++; assert.equal(url, 'https://example.test/api/dynamic-agents/teams'); assert.equal(options.redirect, 'error');
    assert.equal(options.headers.authorization, `Bearer ${signed}`);
    return calls === 1 ? memberships() : new Response(JSON.stringify({ success: true, data: [] }));
  } });
  assert.equal((await auth({ headers: { authorization: `Bearer ${signed}` } })).teams.size, 1);
  assert.equal((await auth({ headers: { authorization: `Bearer ${signed}` } })).teams.size, 0);
  for (const response of [new Response('{}'), new Response('', { status: 503 })]) {
    await assert.rejects(createAuthenticator(config, { keys, fetchImpl: async () => response })({ headers: { authorization: `Bearer ${signed}` } }));
  }
});
export { config, keys, memberships };
