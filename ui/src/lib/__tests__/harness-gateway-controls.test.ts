/** @jest-environment node */
import { createHash } from 'node:crypto';
import { proxyHarnessConversationOperation } from '../harness-gateway';
const mockAccess = jest.fn(); const mockAgentPermission = jest.fn(); const mockBinding = jest.fn(); const mockDeleteBinding = jest.fn();
jest.mock('@/app/api/v1/chat/_conversation-authz', () => ({ authorizeConversationReadAccess: (...args: unknown[]) => mockAccess(...args), authorizeConversationWriteAccess: (...args: unknown[]) => mockAccess(...args), resolveConversationRuntimeId: async () => 'conversation-example' }));
jest.mock('@/lib/rbac/openfga-agent-authz', () => ({ requireAgentUsePermission: (...args: unknown[]) => mockAgentPermission(...args) }));
jest.mock('@/lib/mongodb', () => ({ getCollection: async () => ({ findOne: mockBinding, deleteOne: mockDeleteBinding }) }));
const auth = { subject: 'test-user', email: 'user@example.com' };
const run = { run_id: 'run-example', owner_subject: 'test-user', agent_id: 'agent-example', conversation_id: 'conversation-example', visible_conversation_id: 'conversation-example', harness_id: 'example-harness', status: 'awaiting_input', contract_version: 2, capabilities: { 'history.server_owned': { level: 'native' } } };
const history = { owner: 'server', user_message_id: 'user-run-example', assistant_message_id: 'message-run-example' };
const reply = (data: unknown, includeHistory = true) => new Response(JSON.stringify({ success: true, data, ...(includeHistory && { history }) }));
beforeEach(() => {
  jest.clearAllMocks(); process.env.HARNESS_ENGINE_URL = 'http://engine.example.test'; process.env.HARNESS_ENGINE_INTERNAL_TOKEN = 'test-token';
  mockAccess.mockResolvedValue({ denial: null, conversation: { _id: run.conversation_id, participants: [{ type: 'agent', id: run.agent_id }] } });
  mockAgentPermission.mockResolvedValue(undefined);
  mockBinding.mockResolvedValue({ _id: createHash('sha256').update(JSON.stringify([auth.subject, run.agent_id, run.conversation_id])).digest('hex'), owner_subject: auth.subject, agent_id: run.agent_id, conversation_id: run.conversation_id, harness_id: run.harness_id });
});
afterEach(() => jest.restoreAllMocks());
it.each(['files', 'file', 'write-file', 'delete-file', 'restart'] as const)('returns explicit unavailable for %s without querying the native runtime', async operation => {
  const fetcher = jest.spyOn(global, 'fetch').mockResolvedValueOnce(reply(run));
  const response = await proxyHarnessConversationOperation(auth, run.conversation_id, run.agent_id, operation);
  expect(response?.status).toBe(501); expect(fetcher).toHaveBeenCalledTimes(1); expect(String(fetcher.mock.calls[0][0])).toContain('engine.example.test/api/v1/runs/latest');
});
it('restores human input from its exact retained Engine run', async () => {
  const input = { interrupt_id: 'input-example', prompt: 'Approve action', fields: [] };
  const fetcher = jest.spyOn(global, 'fetch').mockResolvedValueOnce(reply(run)).mockResolvedValueOnce(reply(input, false));
  const response = await proxyHarnessConversationOperation(auth, run.conversation_id, run.agent_id, 'interrupt');
  expect(await response?.json()).toEqual({ has_pending_interrupt: true, interrupt_data: input });
  expect(String(fetcher.mock.calls[1][0])).toBe('http://engine.example.test/api/v1/runs/run-example/input');
});
it('clears the retained Engine session before removing its gateway pin', async () => {
  const fetcher = jest.spyOn(global, 'fetch').mockResolvedValueOnce(reply(run)).mockResolvedValueOnce(reply({ cleared: true }, false));
  expect((await proxyHarnessConversationOperation(auth, run.conversation_id, run.agent_id, 'clear'))?.status).toBe(200);
  expect(String(fetcher.mock.calls[1][0])).toBe('http://engine.example.test/api/v1/sessions/clear'); expect(mockDeleteBinding).toHaveBeenCalledTimes(1);
});
it('preserves the default native operation path', async () => {
  mockBinding.mockResolvedValueOnce({ ...(await mockBinding()), harness_id: 'dynamic_agents' });
  const fetcher = jest.spyOn(global, 'fetch');
  expect(await proxyHarnessConversationOperation(auth, run.conversation_id, run.agent_id, 'files')).toBeNull(); expect(fetcher).not.toHaveBeenCalled();
});
it('uses the retained legacy SDK capability snapshot instead of upgrading its history ownership', async () => {
  jest.spyOn(global, 'fetch').mockResolvedValueOnce(reply({ ...run, contract_version: 1, capabilities: {} }, false));
  expect(await proxyHarnessConversationOperation(auth, run.conversation_id, run.agent_id, 'files')).toBeNull();
});
it('fails closed on a crossed runtime identity', async () => {
  const fetcher = jest.spyOn(global, 'fetch').mockResolvedValueOnce(reply({ ...run, conversation_id: 'other-context' }));
  expect((await proxyHarnessConversationOperation(auth, run.conversation_id, run.agent_id, 'files'))?.status).toBe(502); expect(fetcher).toHaveBeenCalledTimes(1);
});
it('serves acknowledged workspace artifacts from the retained Engine context', async () => {
  const fetcher = jest.spyOn(global, 'fetch').mockResolvedValueOnce(reply({ ...run, capabilities: { ...run.capabilities, 'files.list': { level: 'emulated' } } })).mockResolvedValueOnce(reply({ fs_namespace: [run.agent_id, run.conversation_id, 'filesystem'], files: ['/example.txt'], snapshot: 'acknowledged', warnings: ['Bounded view'] }, false));
  const response = await proxyHarnessConversationOperation(auth, run.conversation_id, run.agent_id, 'files');
  expect(await response?.json()).toEqual(expect.objectContaining({ files: ['/example.txt'], snapshot: 'acknowledged', warnings: ['Bounded view'] }));
  expect(String(fetcher.mock.calls[1][0])).toContain('engine.example.test/api/v1/files/list?');
  expect(response?.headers.get('X-Harness-File-Snapshot')).toBe('acknowledged');
});
