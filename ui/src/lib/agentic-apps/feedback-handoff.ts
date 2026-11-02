import type { FeedbackContext, TicketRequest } from "@/lib/ticket-client";

/** Only the connected app can acknowledge an explicit report submission. */
export function requestFrameFeedbackContext(frame: Window, appId: string, requestId: string, request: TicketRequest): Promise<FeedbackContext> {
  return new Promise((resolve, reject) => {
    const origin = window.location.origin;
    const attemptId = crypto.randomUUID();
    const finish = (error?: string, context?: FeedbackContext) => {
      window.removeEventListener("message", receive);
      clearTimeout(timer);
      if (error) reject(new Error(error));
      else resolve(context!);
    };
    function receive(event: MessageEvent) {
      const data = event.data;
      if (event.origin !== origin || event.source !== frame || data?.appId !== appId || data.version !== "1.0" ||
          data.type !== "caipe.agenticApp.feedback.context.v1" || data.requestId !== requestId || data.attemptId !== attemptId) return;
      if (data.error) { finish("Could not record response feedback. Please retry."); return; }
      const context = data.feedbackContext;
      if (!context || !["like", "dislike"].includes(context.feedbackType) || typeof context.reason !== "string" || context.reason.length > 1000 ||
          context.additionalFeedback !== undefined && (typeof context.additionalFeedback !== "string" || context.additionalFeedback.length > 20000)) {
        finish("Invalid response feedback context"); return;
      }
      finish(undefined, { feedbackType: context.feedbackType, reason: context.reason, additionalFeedback: context.additionalFeedback });
    }
    const timer = setTimeout(() => finish("The app did not confirm response feedback. Please retry."), 15000);
    window.addEventListener("message", receive);
    frame.postMessage({ type: "caipe.agenticApp.feedback.beforeSubmit.v1", version: "1.0", appId, requestId, attemptId,
      request: { description: request.description, issueType: request.issueType } }, origin);
  });
}
