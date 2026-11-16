/** @jest-environment node */
import { ASSISTANT_ACTION_CLIENT_TIMEOUT_MS, postAssistantAction } from "../api-client";

const request = { conversationId: "chat-1", agentId: "example-agent", messageId: "a1", actionId: "flag-answer" };

function reply(status: number, body: unknown): jest.SpyInstance {
  return jest.spyOn(global, "fetch").mockClear().mockResolvedValue(new Response(typeof body === "string" ? body : JSON.stringify(body), { status }));
}
afterEach(() => jest.restoreAllMocks());

describe("postAssistantAction", () => {
  it("posts only the declared fields, with text under input", async () => {
    const fetchSpy = reply(200, { success: true, data: {} });
    await postAssistantAction({ ...request, text: "Edited" });
    const [url, init] = fetchSpy.mock.calls[0];
    expect(url).toBe("/api/v1/chat/assistant-actions");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body)).toEqual({
      conversation_id: "chat-1", agent_id: "example-agent", message_id: "a1", action_id: "flag-answer", input: { text: "Edited" },
    });
  });

  it("omits input when there is no text", async () => {
    const fetchSpy = reply(200, { success: true, data: {} });
    await postAssistantAction(request);
    expect(JSON.parse(fetchSpy.mock.calls[0][1].body)).not.toHaveProperty("input");
  });

  it("returns the app's success message when present", async () => {
    reply(200, { success: true, data: { message: "Saved" } });
    expect(await postAssistantAction(request)).toEqual({ ok: true, message: "Saved" });
    reply(200, { success: true, data: { message: 5 } });
    expect(await postAssistantAction(request)).toEqual({ ok: true });
  });

  it("returns the error text and code", async () => {
    reply(422, { success: false, error: "Already recorded", code: "ALREADY_DONE" });
    expect(await postAssistantAction(request)).toEqual({ ok: false, error: "Already recorded", code: "ALREADY_DONE" });
  });

  it("uses a generic message for an unreadable failure", async () => {
    reply(500, "<html>");
    expect(await postAssistantAction(request)).toEqual({ ok: false, error: "The action could not be completed" });
  });

  it("returns an error instead of throwing when the network fails", async () => {
    jest.spyOn(global, "fetch").mockRejectedValue(new TypeError("fetch failed"));
    expect(await postAssistantAction(request)).toMatchObject({ ok: false });
  });

  it("gives up after the client timeout so a hung server ends in an error", async () => {
    const timeout = jest.spyOn(AbortSignal, "timeout").mockImplementation(() => AbortSignal.abort());
    jest.spyOn(global, "fetch").mockImplementation((_url, init) => new Promise((_resolve, reject) => {
      (init?.signal as AbortSignal).addEventListener("abort", () => reject(new DOMException("aborted", "TimeoutError")));
      if ((init?.signal as AbortSignal).aborted) reject(new DOMException("aborted", "TimeoutError"));
    }));
    expect(await postAssistantAction(request)).toMatchObject({ ok: false });
    expect(timeout).toHaveBeenCalledWith(ASSISTANT_ACTION_CLIENT_TIMEOUT_MS);
    expect(ASSISTANT_ACTION_CLIENT_TIMEOUT_MS).toBe(35_000);
  });
});
