import { teamActivityEntries } from "../team-activity";
import type { ChatMessage } from "@/types/a2a";

const reply = (id: string, fields: Partial<ChatMessage> = {}): ChatMessage => ({
  id, role: "assistant", content: id, timestamp: new Date(), agentId: "secondary", ...fields,
});

it("keeps the primary synthesis outside work groups and preserves separate chains", () => {
  const messages = [reply("intro", { agentId: "primary" }),
    reply("work", { coordinationRootId: "chain", coordinationKind: "assignment", isFinal: true, turnStatus: "done" }),
    reply("summary", { agentId: "primary", coordinationRootId: "chain", coordinationKind: "summary" }),
    reply("other", { parallelGroupId: "direct", isFinal: false })];
  const entries = teamActivityEntries(messages, "primary");
  expect(entries.map(entry => entry.kind)).toEqual(["message", "activity", "message", "activity"]);
  expect(entries[1]).toMatchObject({ id: "chain", complete: true });
  expect(entries[3]).toMatchObject({ id: "direct", complete: false });
});

it.each(["waiting_for_input", "interrupted", "cancelled"] as const)("keeps %s work visible instead of auto-collapsing it", status => {
  expect(teamActivityEntries([reply("waiting", { parallelGroupId: "turn", isFinal: true, turnStatus: status })], "primary")[0])
    .toMatchObject({ complete: false });
});

it("leaves legacy messages untouched without team metadata", () => {
  const message = reply("legacy", { agentId: undefined });
  expect(teamActivityEntries([message], "primary")).toEqual([{ kind: "message", message }]);
});
