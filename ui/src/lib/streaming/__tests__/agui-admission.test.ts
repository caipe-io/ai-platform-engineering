/** @jest-environment node */
import { AGUIStreamAdapter } from "../clients/browser-agui-consumer";
import { StreamError } from "../stream-error";
import { interruptedAuthReason } from "@/lib/chat-interrupt";
afterEach(() => jest.restoreAllMocks());
it("preserves a rejected admission's code and message without retrying", async () => {
  const fetcher = jest.spyOn(global, "fetch").mockResolvedValue(Response.json({ code: "HARNESS_AGENT_NOT_READY", error: "A selected MCP server is disabled. Nothing was executed." }, { status: 409 }));
  await expect(new AGUIStreamAdapter().streamMessage({ agentId: "example", conversationId: "chat", message: "What is your harness?" }, {}))
    .rejects.toMatchObject({ name: "StreamError", code: "HARNESS_AGENT_NOT_READY", status: 409, message: "A selected MCP server is disabled. Nothing was executed." });
  expect(fetcher).toHaveBeenCalledTimes(1);
});
it("preserves structured sign-in failures through the same error contract", async () => {
  jest.spyOn(global, "fetch").mockResolvedValue(Response.json({ error: "Sign in again", code: "AUTH_REQUIRED", reason: "session_expired", action: "sign_in" }, { status: 401 }));
  try {
    await new AGUIStreamAdapter().streamMessage({ agentId: "example", conversationId: "chat", message: "hello" }, {});
    throw new Error("Expected a rejection");
  } catch (error) {
    expect(error).toBeInstanceOf(StreamError);
    expect((error as StreamError).isAuthError()).toBe(true);
    expect(error).toMatchObject({ reason: "session_expired", action: "sign_in" });
  }
});

it.each([Response.json({ error: "Unauthorized" }, { status: 401 }), new Response("Unauthorized", { status: 401 })])("preserves the sign-in tag for a plain 401 response", async response => {
  jest.spyOn(global, "fetch").mockResolvedValue(response);
  let failure: unknown;
  try {
    await new AGUIStreamAdapter().streamMessage({ agentId: "example", conversationId: "chat", message: "hello" }, {});
  } catch (error) { failure = error; }
  expect(failure).toBeInstanceOf(StreamError);
  expect(interruptedAuthReason(failure)).toBe("session_expired");
});
it("does not turn permission or deployment auth failures into a sign-in hint", () => {
  expect(interruptedAuthReason(new StreamError("Denied", 403))).toBeUndefined();
  expect(interruptedAuthReason(new StreamError("Invalid audience", 401, undefined, "audience_mismatch", "contact_admin"))).toBeUndefined();
});
