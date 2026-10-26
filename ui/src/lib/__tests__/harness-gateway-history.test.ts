/** @jest-environment node */
import { streamHarnessGatewayRun, statusHarnessGatewayRun, resumeHarnessGatewayRun, encodeHarnessGatewayEvent } from '../harness-gateway';
import type { HarnessRun } from '@/types/harness-engine';
const run = { run_id: 'run-example', owner_subject: 'test-user', agent_id: 'agent-example', conversation_id: 'conversation-example', visible_conversation_id: 'conversation-example', harness_id: 'example-harness', last_sequence: 4, contract_version: 2, status: 'completed' } as HarnessRun;
const history = { owner: 'server', user_message_id: 'user-run-example', assistant_message_id: 'message-run-example' };
const body = { message: 'hello', agent_id: run.agent_id, conversation_id: run.conversation_id, visible_conversation_id: run.conversation_id, expected_harness_id: run.harness_id, turn_id: 'turn-example', protocol: 'agui' };
const auth = { subject: 'test-user' };
const reply = (data: unknown, h?: unknown) => new Response(JSON.stringify({ success: true, data, ...(h && { history: h }) }));
beforeEach(() => { jest.clearAllMocks(); process.env.HARNESS_ENGINE_URL = 'http://engine.example.test'; process.env.HARNESS_ENGINE_INTERNAL_TOKEN = 'test-token'; });
afterEach(() => jest.restoreAllMocks());
it('forwards stable admission identity and returns server history headers to the browser', async () => {
  const fetcher = jest.spyOn(global, 'fetch').mockResolvedValueOnce(reply(run, history)).mockResolvedValueOnce(new Response('id: 4\nevent: run.completed\ndata: {}\n\n'));
  const response = await streamHarnessGatewayRun(body, auth);
  expect(JSON.parse(fetcher.mock.calls[0][1]?.body as string)).toEqual(expect.objectContaining({ client_request_id: 'turn-example', expected_harness_id: run.harness_id, visible_conversation_id: run.conversation_id, protocol: 'agui' }));
  expect(response.headers.get('X-Harness-History-Owner')).toBe('server');
  expect(response.headers.get('X-Harness-User-Message-ID')).toBe(history.user_message_id);
  expect(await response.text()).toContain('RUN_FINISHED');
});
it.each(['agent_id', 'conversation_id', 'harness_id'])('rejects an Engine %s identity mismatch', async field => {
  const fetcher = jest.spyOn(global, 'fetch').mockResolvedValueOnce(reply({ ...run, [field]: 'other' }, history));
  expect((await streamHarnessGatewayRun(body, auth)).status).toBe(502); expect(fetcher).toHaveBeenCalledTimes(1);
});
it('does not infer legacy history ownership from a mutable catalog', async () => {
  jest.spyOn(global, 'fetch').mockResolvedValueOnce(reply(run)).mockResolvedValueOnce(new Response(''));
  expect((await streamHarnessGatewayRun(body, auth)).headers.has('X-Harness-History-Owner')).toBe(false);
});
it('replays the latest durable run without starting another run', async () => {
  const fetcher = jest.spyOn(global, 'fetch').mockResolvedValueOnce(reply(run, history)).mockResolvedValueOnce(new Response('id: 4\nevent: run.completed\ndata: {}\n\n'));
  const response = await statusHarnessGatewayRun({ ...body, replay: true }, auth);
  expect(fetcher.mock.calls.map(x => x[1]?.method)).toEqual(['GET', 'GET']);
  expect(String(fetcher.mock.calls[1][0])).toContain('/run-example/events/stream?after=0');
  expect(await response.text()).toContain('RUN_FINISHED');
});
it('answers an input on the same run and resumes after the committed cursor', async () => {
  const fetcher = jest.spyOn(global, 'fetch').mockResolvedValueOnce(reply({ ...run, status: 'awaiting_input' }, history)).mockResolvedValueOnce(reply({ run: { ...run, status: 'running' }, after_cursor: 5, history })).mockResolvedValueOnce(new Response(''));
  const response = await resumeHarnessGatewayRun({ ...body, resume_data: JSON.stringify({ interrupt_id: 'input-example', type: 'tool_approval', decision: 'approve' }) }, auth);
  expect(response.status).toBe(200);
  expect(String(fetcher.mock.calls[1][0]).endsWith('/run-example/input')).toBe(true);
  expect(JSON.parse(fetcher.mock.calls[1][1]?.body as string)).toEqual({ client_request_id: body.turn_id, decision: { interrupt_id: 'input-example', type: 'tool_approval', decision: 'approve' } });
  expect(String(fetcher.mock.calls[2][0])).toContain('after=5');
});
it('replay skips resolved historical permissions and surfaces only the retained pending input', () => {
  const current = { ...run, status: 'awaiting_input', pending_interrupt_id: 'current-input' } as HarnessRun;
  const state = { messageId: 'message-run-example', messageStarted: false, terminalSent: false, toolNames: new Map<string, string>() };
  expect(encodeHarnessGatewayEvent({ run_id: run.run_id, sequence: 1, event_type: 'interrupt.requested', data: { interrupt_id: 'old-input' } }, current, 'agui', state)).toEqual([]);
  expect(encodeHarnessGatewayEvent({ run_id: run.run_id, sequence: 4, event_type: 'interrupt.requested', data: { interrupt_id: 'current-input' } }, current, 'agui', state).join('')).toContain('current-input');
});
it('stages inline composer bytes as scoped opaque attachments before dispatch', async () => {
  const attachment = { id: 'artifact-example', name: 'example.txt', media_type: 'text/plain', size_bytes: 7, sha256: 'a'.repeat(64) };
  const fetcher = jest.spyOn(global, 'fetch').mockResolvedValueOnce(reply(attachment)).mockResolvedValueOnce(reply(run, history)).mockResolvedValueOnce(new Response(''));
  await streamHarnessGatewayRun({ ...body, files: [{ name: attachment.name, mime_type: attachment.media_type, data: 'ZXhhbXBsZQ==' }] }, auth);
  expect(String(fetcher.mock.calls[0][0])).toBe('http://engine.example.test/api/v1/attachments');
  expect(JSON.parse(fetcher.mock.calls[0][1]?.body as string)).toEqual(expect.objectContaining({ visible_conversation_id: body.visible_conversation_id, expected_harness_id: body.expected_harness_id }));
  const admitted = JSON.parse(fetcher.mock.calls[1][1]?.body as string); expect(admitted.attachments).toEqual([attachment]); expect(admitted).not.toHaveProperty('files');
});
it('does not start a run when the profile rejects the attachment', async () => {
  const fetcher = jest.spyOn(global, 'fetch').mockResolvedValueOnce(new Response(JSON.stringify({ detail: 'Unsupported profile' }), { status: 409 }));
  expect((await streamHarnessGatewayRun({ ...body, files: [{ name: 'example.txt', mime_type: 'text/plain', data: 'ZXhhbXBsZQ==' }] }, auth)).status).toBe(409); expect(fetcher).toHaveBeenCalledTimes(1);
});
it('fails closed for a server-owned admission returned for another owner', async () => {
  const fetcher = jest.spyOn(global, 'fetch').mockResolvedValueOnce(reply({ ...run, owner_subject: 'other-user' }, history));
  expect((await streamHarnessGatewayRun(body, auth)).status).toBe(502); expect(fetcher).toHaveBeenCalledTimes(1);
});

it('stages attachments against the server-resolved visible/runtime mapping before the first run', async () => {
  const aliasRun = { ...run, conversation_id: 'runtime-example', visible_conversation_id: 'visible-example' };
  const attachment = { id: 'artifact-example', name: 'example.txt', media_type: 'text/plain', size_bytes: 7, sha256: 'a'.repeat(64) };
  const fetcher = jest.spyOn(global, 'fetch').mockResolvedValueOnce(reply(attachment)).mockResolvedValueOnce(reply(aliasRun, history)).mockResolvedValueOnce(new Response(''));
  await streamHarnessGatewayRun({ ...body, conversation_id: aliasRun.conversation_id, visible_conversation_id: aliasRun.visible_conversation_id,
    files: [{ name: attachment.name, mime_type: attachment.media_type, data: 'ZXhhbXBsZQ==' }] }, auth);
  expect(JSON.parse(fetcher.mock.calls[0][1]?.body as string)).toEqual(expect.objectContaining({ conversation_id: 'runtime-example', visible_conversation_id: 'visible-example' }));
  expect(JSON.parse(fetcher.mock.calls[1][1]?.body as string).attachments).toEqual([attachment]);
});
