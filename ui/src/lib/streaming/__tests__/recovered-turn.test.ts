import { needsNativeRunReplay, recoveredAssistantMessage } from "../recovered-turn";
import type { NativeRun } from "../native-runs";
import type { ChatMessage } from "@/types/a2a";

const run: NativeRun = {
  run_id: "run-1",
  turn_id: "turn-1",
  agent_id: "agent-1",
  session_id: "conversation-1",
  protocol: "agui",
  status: "running",
  last_sequence: 5,
};
const message: ChatMessage = {
  id: "legacy-message-id",
  turnId: "turn-1",
  role: "assistant",
  content: "partial",
  timestamp: new Date(),
  isFinal: false,
};

it("reuses existing assistant identity while recovering a partial persisted reply", () => {
  expect(recoveredAssistantMessage(run, [message])?.id).toBe("legacy-message-id");
  expect(needsNativeRunReplay({ ...run, status: "completed" }, message)).toBe(true);
});

it("does not replay an already complete reply or add another assistant row", () => {
  expect(needsNativeRunReplay({ ...run, status: "completed" }, { ...message, isFinal: true, turnStatus: "done" })).toBe(false);
});

it("repairs a response marked interrupted when the detached worker actually completed", () => {
  expect(needsNativeRunReplay({ ...run, status: "completed" }, { ...message, isFinal: true, turnStatus: "interrupted" })).toBe(true);
});

it("replays a paused run to recover its pending approval when the placeholder lacks it", () => {
  expect(needsNativeRunReplay({ ...run, status: "awaiting_input" }, message)).toBe(true);
});
