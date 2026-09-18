/**
 * @jest-environment node
 */

/**
 * The multimodal `files` field must ride the request body of streamMessage for
 * both wire protocols — present when attachments exist, absent otherwise (so a
 * plain text turn is byte-identical to before). Mirrors the backend seam test
 * `test_sse_client.py::TestStreamChatPayload`.
 */

import type { StreamCallbacks, StreamParams } from "../callbacks";
import { AGUIStreamAdapter } from "../clients/browser-agui-consumer";
import { CustomStreamAdapter } from "../clients/browser-custom-consumer";

const mockFetch = jest.fn();

/** A 200 response with an immediately-closed body so _stream resolves fast. */
function emptySSEResponse(): Response {
  return new Response(
    new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.close();
      },
    }),
    { status: 200 },
  );
}

function noopCallbacks(): StreamCallbacks {
  return {};
}

const FILES = [{ mime_type: "image/png", data: "Zm9v", name: "a.png" }];

beforeAll(() => {
  global.fetch = mockFetch;
  jest.spyOn(console, "error").mockImplementation(() => {});
});

beforeEach(() => {
  jest.clearAllMocks();
  mockFetch.mockResolvedValue(emptySSEResponse());
});

afterAll(() => {
  jest.restoreAllMocks();
});

function sentBody(): Record<string, unknown> {
  const [, init] = mockFetch.mock.calls[0];
  return JSON.parse(init.body as string);
}

describe.each([
  ["AG-UI", () => new AGUIStreamAdapter(), "agui"],
  ["custom", () => new CustomStreamAdapter(), "custom"],
])("%s adapter streamMessage files payload", (_label, makeAdapter, protocol) => {
  const base: StreamParams = {
    message: "hi",
    conversationId: "conv-1",
    agentId: "agent-1",
  };

  it("includes files in the body when present", async () => {
    await makeAdapter().streamMessage({ ...base, files: FILES }, noopCallbacks());

    const body = sentBody();
    expect(body.files).toEqual(FILES);
    // Base fields still intact.
    expect(body.message).toBe("hi");
    expect(body.conversation_id).toBe("conv-1");
    expect(body.protocol).toBe(protocol);
  });

  it("omits files when the array is empty", async () => {
    await makeAdapter().streamMessage({ ...base, files: [] }, noopCallbacks());
    expect(sentBody()).not.toHaveProperty("files");
  });

  it("omits files when unset", async () => {
    await makeAdapter().streamMessage(base, noopCallbacks());
    expect(sentBody()).not.toHaveProperty("files");
  });

  it("forwards the UI turn ID for checkpoint correlation", async () => {
    await makeAdapter().streamMessage(
      { ...base, turnId: "turn-1" },
      noopCallbacks(),
    );
    expect(sentBody().turn_id).toBe("turn-1");
  });
});
