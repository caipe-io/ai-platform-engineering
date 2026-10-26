/** @jest-environment node */
import { AGUIStreamAdapter } from '../clients/browser-agui-consumer';
import { CustomStreamAdapter } from '../clients/browser-custom-consumer';

const headers = () => ({
  'X-Harness-History-Owner': 'server', 'X-Harness-Run-ID': 'run-example',
  'X-Harness-Conversation-ID': 'conversation-example',
  'X-Harness-User-Message-ID': 'user-run-example',
  'X-Harness-Assistant-Message-ID': 'message-run-example',
});
const params = { agentId: 'agent-example', conversationId: 'conversation-example', message: 'hello', turnId: 'turn-example' };
beforeEach(() => jest.clearAllMocks());
afterEach(() => jest.restoreAllMocks());
describe.each([['agui', () => new AGUIStreamAdapter()], ['custom', () => new CustomStreamAdapter()]] as const)('%s durable stream', (protocol, make) => {
  it('adopts server identity before connected content and completion', async () => {
    const wire = protocol === 'agui'
      ? 'event: TEXT_MESSAGE_CONTENT\ndata: {"type":"TEXT_MESSAGE_CONTENT","delta":"answer"}\n\nevent: RUN_FINISHED\ndata: {"type":"RUN_FINISHED"}\n\n'
      : 'event: content\ndata: {"text":"answer"}\n\nevent: done\ndata: {}\n\n';
    jest.spyOn(global, 'fetch').mockResolvedValue(new Response(wire, { headers: headers() }));
    const order: string[] = [];
    await make().streamMessage(params, { onRunAdmission: value => { expect(value.userMessageId).toBe('user-run-example'); order.push('admission'); }, onContent: text => order.push(text), onDone: () => order.push('done') });
    expect(order).toEqual(['admission', 'answer', 'done']);
  });
  it('keeps a server-owned subscription open while cancellation is only requested', async () => {
    const adapter = make();
    const abort = jest.spyOn(adapter, 'abort');
    jest.spyOn(global, 'fetch').mockResolvedValue(new Response('{"success":true,"cancelled":false,"cancellation_requested":true}'));
    expect(await adapter.cancelStream(params.conversationId, params.agentId, { keepSubscription: true })).toBe(false);
    expect(abort).not.toHaveBeenCalled();
  });
  it('delivers an acknowledged cancelled outcome separately from successful completion', async () => {
    const wire = protocol === 'agui' ? 'event: RUN_FINISHED\ndata: {"type":"RUN_FINISHED","outcome":"cancelled"}\n\n'
      : 'event: done\ndata: {"outcome":"cancelled"}\n\n';
    jest.spyOn(global, 'fetch').mockResolvedValue(new Response(wire, { headers: headers() }));
    const done = jest.fn();
    await make().streamMessage(params, { onDone: done });
    expect(done).toHaveBeenCalledWith('cancelled');
  });
  it('reattaches without sending a new prompt or input', async () => {
    const fetcher = jest.spyOn(global, 'fetch').mockResolvedValue(new Response('', { headers: headers() }));
    await make().reconnectStream(params, {});
    expect(fetcher).toHaveBeenCalledWith('/api/v1/chat/stream/status', expect.objectContaining({ method: 'POST', body: JSON.stringify({ conversation_id: params.conversationId, agent_id: params.agentId, protocol, replay: true }) }));
  });
  it('rejects cross-conversation or malformed admissions before content', async () => {
    const admitted = jest.fn();
    jest.spyOn(global, 'fetch').mockResolvedValue(new Response('', { headers: { ...headers(), 'X-Harness-Conversation-ID': 'other-conversation' } }));
    await expect(make().streamMessage(params, { onRunAdmission: admitted })).rejects.toThrow('another conversation');
    expect(admitted).not.toHaveBeenCalled();
  });
  it('retains admitted identity when event subscription fails', async () => {
    const admitted = jest.fn();
    jest.spyOn(global, 'fetch').mockResolvedValue(new Response('{}', { status: 503, headers: headers() }));
    await expect(make().streamMessage(params, { onRunAdmission: admitted })).rejects.toThrow();
    expect(admitted).toHaveBeenCalledTimes(1);
  });
  it('leaves legacy ownership unchanged and forwards input idempotency', async () => {
    const fetcher = jest.spyOn(global, 'fetch').mockResolvedValue(new Response(''));
    const admitted = jest.fn();
    await make().resumeStream({ ...params, resumeData: '{}' }, { onRunAdmission: admitted });
    expect(admitted).not.toHaveBeenCalled();
    expect(JSON.parse(fetcher.mock.calls[0][1]?.body as string).turn_id).toBe(params.turnId);
  });
});
it.each([() => new AGUIStreamAdapter(), () => new CustomStreamAdapter()])('releases a pending writer only after explicit native/legacy confirmation', async make => {
  const fetcher = jest.spyOn(global, 'fetch').mockResolvedValueOnce(new Response('{}', { status: 501, headers: { 'X-Harness-History-Owner': 'client' } })).mockResolvedValueOnce(new Response('{"success":true,"data":null}'));
  const confirmed = jest.fn(); await make().reconnectStream(params, { onClientHistory: confirmed }); expect(confirmed).toHaveBeenCalledTimes(1);
  await make().reconnectStream(params, { onClientHistory: confirmed }); expect(confirmed).toHaveBeenCalledTimes(1); expect(fetcher).toHaveBeenCalledTimes(2);
});
