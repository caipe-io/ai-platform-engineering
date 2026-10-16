/** @jest-environment node */

import { NextRequest } from 'next/server';
import { deleteConversationsPermanently } from '../chat/conversations/delete-permanently';

const mockGetCollection = jest.fn();
const mockAuthenticate = jest.fn();
const mockHeaders = jest.fn();
jest.mock('@/lib/mongodb', () => ({ getCollection: (...args: unknown[]) => mockGetCollection(...args) }));
jest.mock('@/lib/da-proxy', () => ({
  authenticateRequest: (...args: unknown[]) => mockAuthenticate(...args),
  buildBackendHeaders: (...args: unknown[]) => mockHeaders(...args),
  getDynamicAgentsConfig: () => ({ dynamicAgentsUrl: 'https://runtime.example.test' }),
}));
jest.mock('@/app/api/v1/chat/_conversation-authz', () => ({ resolveConversationRuntimeId: async (item: { _id: string }) => item._id }));

const item = { _id: 'example-conversation', participants: [{ type: 'agent' as const, id: 'example-agent' }] };
const request = () => new NextRequest('https://caipe.example.test/api/chat/conversations/example-conversation?permanent=true', {
  method: 'DELETE', headers: { Cookie: 'private-cookie', Authorization: 'Bearer ignored-native-header', 'X-Injected-Target': 'https://other.example.test' },
});
let saved: Array<Record<string, unknown>>;
let active: Array<Record<string, unknown>>;
let leases: Array<Record<string, unknown>>;
let operations: string[];
const originalFetch = global.fetch;

beforeEach(() => {
  jest.clearAllMocks();
  saved = [{ agent_id: 'example-agent', session_id: 'example-conversation', runtime_kind: 'sandbox', sandbox: { allocation: { uid: 'example-generation' } } }];
  active = [];
  leases = [];
  operations = [];
  mockAuthenticate.mockResolvedValue({ subject: 'example-owner', bearerToken: 'verified-caller' });
  mockHeaders.mockReturnValue({ 'Content-Type': 'application/json', Authorization: 'Bearer verified-caller' });
  mockGetCollection.mockImplementation(async (name: string) => ({
    updateOne: async () => { operations.push(`update:${name}`); },
    deleteMany: async () => { operations.push(`delete:${name}`); },
    find: (query: { active?: boolean }) => {
      operations.push(`find:${name}`);
      return { toArray: async () => name === 'native_acp_sessions' ? saved : name === 'native_acp_runs' ? leases :
        name === 'native_acp_execution_runs' && query.active === true ? active : [] };
    },
  }));
  global.fetch = jest.fn(async () => {
    operations.push('cleanup');
    return Response.json({ success: true, data: { session_ids: ['example-conversation'] } });
  });
});

afterAll(() => { global.fetch = originalFetch; });

it('confirms exact authenticated cleanup after the admission fence and before any history purge', async () => {
  await deleteConversationsPermanently([item], request());
  expect(operations[0]).toBe('update:native_acp_deleted_sessions');
  expect(operations.indexOf('cleanup')).toBeLessThan(operations.indexOf('delete:conversations'));
  expect(global.fetch).toHaveBeenCalledWith(new URL('https://runtime.example.test/api/v1/conversations/example-conversation/cleanup'), expect.objectContaining({
    method: 'POST', body: '{}', redirect: 'error',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer verified-caller' },
  }));
  expect(operations).toContain('delete:native_acp_sessions');
});

it.each([403, 409, 503])('keeps all history and bindings when remote cleanup fails with %s', async (status) => {
  global.fetch = jest.fn(async () => new Response('raw-secret-provider-error', { status }));
  await expect(deleteConversationsPermanently([item], request())).rejects.toThrow(/cleanup|cleaned up/);
  expect(operations.some((operation) => operation.startsWith('delete:'))).toBe(false);
});

it('refuses to purge when backend confirmation names a different runtime', async () => {
  global.fetch = jest.fn(async () => Response.json({ success: true, data: { session_ids: ['other-conversation'] } }));
  await expect(deleteConversationsPermanently([item], request())).rejects.toThrow('did not confirm');
  expect(operations.some((operation) => operation.startsWith('delete:'))).toBe(false);
});

it('never sends an unmatched agent binding to the cleanup endpoint', async () => {
  saved[0].agent_id = 'other-agent';
  await expect(deleteConversationsPermanently([item], request())).rejects.toThrow('does not match');
  expect(global.fetch).not.toHaveBeenCalled();
});

it.each(['request', 'lease'])('fences and retains a provisioning sandbox before its binding exists (%s)', async (kind) => {
  saved = [];
  if (kind === 'request') active = [{ active: true, status: 'queued', created_at: new Date() }];
  else leases = [{ lease_id: 'active-lease' }];
  await expect(deleteConversationsPermanently([item], request())).rejects.toMatchObject({ statusCode: 409 });
  expect(operations[0]).toBe('update:native_acp_deleted_sessions');
  expect(global.fetch).not.toHaveBeenCalled();
  expect(operations.some((operation) => operation.startsWith('delete:'))).toBe(false);
});

it.each(['running', 'awaiting_input', 'queued'])('allows explicit cleanup after a %s worker loses its lease', async (status) => {
  active = [{ active: true, status, lease_id: 'expired-lease', created_at: new Date(Date.now() - 120_000) }];
  await deleteConversationsPermanently([item], request());
  expect(global.fetch).toHaveBeenCalledTimes(1);
  expect(operations).toContain('delete:conversations');
});

it('preserves ordinary native permanent deletion without requiring the sandbox service', async () => {
  saved = [];
  await deleteConversationsPermanently([item]);
  expect(mockAuthenticate).not.toHaveBeenCalled();
  expect(global.fetch).not.toHaveBeenCalled();
  expect(operations).toContain('delete:conversations');
});

it('requires an authenticated caller for a pinned sandbox', async () => {
  await expect(deleteConversationsPermanently([item])).rejects.toThrow('Authenticated sandbox cleanup');
  expect(operations.some((operation) => operation.startsWith('delete:'))).toBe(false);
});
