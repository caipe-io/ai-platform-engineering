/**
 * @jest-environment node
 */

import { parseSSEStream } from "../parse-sse";

function responseFromChunks(chunks: string[]): Response {
  const encoder = new TextEncoder();
  const encoded = chunks.map((chunk) => encoder.encode(chunk));
  let index = 0;

  return new Response(
    new ReadableStream<Uint8Array>({
      pull(controller) {
        if (index < encoded.length) {
          controller.enqueue(encoded[index++]);
        } else {
          controller.close();
        }
      },
    }),
  );
}

async function collect(response: Response) {
  const events = [];
  for await (const event of parseSSEStream(response)) {
    events.push(event);
  }
  return events;
}

describe("parseSSEStream", () => {
  it("parses split SSE frames and keeps incomplete chunks buffered", async () => {
    const response = responseFromChunks([
      'event: content\ndata: {"text":"hel',
      'lo"}\n\nevent: done\ndata: {}\n\n',
    ]);

    await expect(collect(response)).resolves.toEqual([
      { event: "content", data: '{"text":"hello"}' },
      { event: "done", data: "{}" },
    ]);
  });

  it("defaults to message events and joins multiline data fields", async () => {
    const response = responseFromChunks([
      "data: first line\ndata: second line\n\n",
      "event: warning\ndata:{\"message\":\"compact\"}\n\n",
      "\n\n",
    ]);

    await expect(collect(response)).resolves.toEqual([
      { event: "message", data: "first line\nsecond line" },
      { event: "warning", data: '{"message":"compact"}' },
    ]);
  });

  it("throws when the response body cannot be read", async () => {
    await expect(collect(new Response(null))).rejects.toThrow(
      "Response body is not readable",
    );
  });

  it("ignores heartbeat-only frames while preserving explicit empty data", async () => {
    const response = responseFromChunks([
      ": keep-",
      "alive\n\nevent: ping\n\n",
      "id: 1\nretry: 1000\n\n",
      "event: empty\ndata:\n\n",
      ": heartbeat\nevent: content\ndata: hello\n\n",
      'event: done\ndata: {}\n\n',
    ]);

    await expect(collect(response)).resolves.toEqual([
      { event: "empty", data: "" },
      { event: "content", data: "hello" },
      { event: "done", data: "{}" },
    ]);
  });
});
