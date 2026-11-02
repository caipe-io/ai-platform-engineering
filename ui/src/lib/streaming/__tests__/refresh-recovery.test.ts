/** @jest-environment node */
import { AGUIStreamAdapter } from '../clients/browser-agui-consumer';
import { CustomStreamAdapter } from '../clients/browser-custom-consumer';

describe.each([
  ['agui', AGUIStreamAdapter, 'RUN_FINISHED'],
  ['custom', CustomStreamAdapter, 'done'],
] as const)('%s refresh recovery', (_protocol, Adapter, terminal) => {
  it.each([true, false])('uses server run admission (admitted=%s)', async admitted => {
    const adapter = new Adapter();
    const onRuntime = jest.fn();
    const response = Promise.withResolvers<Response>();
    const received = Promise.withResolvers<void>();
    let controller: ReadableStreamDefaultController<Uint8Array>;
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({ start(value) { controller = value; } });
    const fetchMock = jest.spyOn(global, 'fetch').mockReturnValue(response.promise);
    try {
      const stream = adapter.streamMessage({ conversationId: 'example-chat', agentId: 'example-agent', message: 'Example' }, {
        onRawEvent: () => received.resolve(),
        onRuntime,
      });
      expect(adapter.canRecoverOnRefresh).toBe(false);
      response.resolve(new Response(body, { headers: admitted ? { 'X-Harness-Run-ID': 'example-run', 'X-Harness-ID': 'claude_code_acp' } : {} }));
      controller!.enqueue(encoder.encode('event: heartbeat\ndata: {}\n\n'));
      await received.promise;
      expect(adapter.canRecoverOnRefresh).toBe(admitted);
      if (admitted) expect(onRuntime).toHaveBeenCalledWith("claude_code_acp");
      else expect(onRuntime).not.toHaveBeenCalled();
      controller!.enqueue(encoder.encode(`event: ${terminal}\ndata: {"outcome":"success"}\n\n`));
      controller!.close();
      await stream;

      // A subsequent request must wait for its own admission confirmation.
      const nextResponse = Promise.withResolvers<Response>();
      fetchMock.mockReturnValueOnce(nextResponse.promise);
      const next = adapter.streamMessage({ conversationId: 'example-chat', agentId: 'example-agent', message: 'Next' }, {});
      expect(adapter.canRecoverOnRefresh).toBe(false);
      nextResponse.resolve(new Response(`event: ${terminal}\ndata: {"outcome":"success"}\n\n`));
      await next;
      expect(adapter.canRecoverOnRefresh).toBe(false);
    } finally {
      fetchMock.mockRestore();
    }
  });
});
