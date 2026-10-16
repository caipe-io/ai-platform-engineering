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

  it("preserves durable cursors with CRLF frames and ignores heartbeat comments", async () => {
    const response = responseFromChunks([
      ": heartbeat\r\n\r\n",
      'id: 12\r\nevent:content\r\ndata: {"text":"hello"}\r',
      '\n\r\nid: 13\r\nevent: done\r\ndata:{}\r\n\r\n',
    ]);

    await expect(collect(response)).resolves.toEqual([
      { id: "12", event: "content", data: '{"text":"hello"}' },
      { id: "13", event: "done", data: "{}" },
    ]);
  });
});
