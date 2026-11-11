import { requestFrameFeedbackContext } from "../feedback-handoff";
import type { TicketRequest } from "@/lib/ticket-client";

it("accepts context only from the connected frame and matching submission attempt", async () => {
  Object.defineProperty(crypto, "randomUUID", { configurable: true, value: () => "test-attempt" });
  const frame = document.createElement("iframe"); document.body.append(frame);
  const target = frame.contentWindow!;
  const post = jest.spyOn(target, "postMessage").mockImplementation(() => {});
  try {
    const pending = requestFrameFeedbackContext(target, "example", "test-request", { description: "Broken", issueType: "Bug" } as TicketRequest);
    const context = { feedbackType: "dislike", reason: "Bug", additionalFeedback: "Broken" };
    const data = { type: "caipe.agenticApp.feedback.context.v1", version: "1.0", appId: "example", requestId: "test-request", attemptId: "test-attempt", feedbackContext: context };
    let settled = false; void pending.then(() => { settled = true; });
    window.dispatchEvent(new MessageEvent("message", { origin: "https://other.example.test", source: target, data }));
    window.dispatchEvent(new MessageEvent("message", { origin: window.location.origin, source: window, data }));
    await Promise.resolve(); expect(settled).toBe(false);
    window.dispatchEvent(new MessageEvent("message", { origin: window.location.origin, source: target, data }));
    await expect(pending).resolves.toEqual(context);
    expect(post.mock.calls[0][0].request).toEqual({ description: "Broken", issueType: "Bug" });
  } finally { post.mockRestore(); frame.remove(); }
});
