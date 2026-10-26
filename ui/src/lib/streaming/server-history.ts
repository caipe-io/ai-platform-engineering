/** Durable history ownership is asserted by the admitted run, never its current agent default. */
export interface ServerHistoryAdmission {
  owner: "server";
  runId: string;
  conversationId: string;
  userMessageId: string;
  assistantMessageId: string;
}

export function serverHistoryFromHeaders(headers: Headers): ServerHistoryAdmission | undefined {
  if (headers.get("X-Harness-History-Owner") !== "server") return undefined;
  const runId = headers.get("X-Harness-Run-ID");
  const conversationId = headers.get("X-Harness-Conversation-ID");
  if (!runId || !/^[A-Za-z0-9_-]{1,128}$/.test(runId) || !conversationId ||
      headers.get("X-Harness-User-Message-ID") !== `user-${runId}` ||
      headers.get("X-Harness-Assistant-Message-ID") !== `message-${runId}`) {
    throw new Error("The runtime returned invalid durable history identifiers");
  }
  return { owner: "server", runId, conversationId,
    userMessageId: `user-${runId}`, assistantMessageId: `message-${runId}` };
}
