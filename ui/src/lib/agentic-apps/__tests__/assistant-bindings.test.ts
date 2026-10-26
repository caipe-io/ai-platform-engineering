/** @jest-environment node */
import { admitConversationApp, resolveConversationAppAssistant } from "../assistant-stream";
import type { Conversation } from "@/types/mongodb";

const update = jest.fn();
const find = jest.fn();
jest.mock("@/lib/mongodb", () => ({ getCollection: async () => ({ findOneAndUpdate: update, findOne: find }) }));
jest.mock("../config", () => ({ getAgenticAppRoutingSnapshot: () => [{
  installation: { appId: "app-primary", installed: true, enabled: true },
  manifest: { ui: { assistant: { agentId: "agent-primary", streamPath: "/api/stream" } } },
}] }));
const conversation = { _id: "conversation-primary", client_type: "webex",
  participants: [{ type: "agent", id: "agent-primary" }], metadata: {},
} as Conversation;
const target = { appId: "app-primary", path: ["api", "stream"] };
const binding = { app_id: target.appId, agent_id: "agent-primary" };

beforeEach(() => { jest.clearAllMocks(); });

it("records a new app route for a non-app entry point in the existing conversation", async () => {
  update.mockResolvedValue({ ...conversation, app_binding: binding });
  expect(await admitConversationApp(conversation, target)).toBeNull();
  expect(update).toHaveBeenCalledWith(expect.objectContaining({
    _id: conversation._id, app_binding: { $exists: false },
    participants: { $elemMatch: { type: "agent", id: "agent-primary" } },
  }), { $set: { app_binding: binding } }, { returnDocument: "after" });
});

it("treats a matching competing admission as idempotent", async () => {
  update.mockResolvedValue(null);
  find.mockResolvedValue({ ...conversation, app_binding: binding });
  expect(await admitConversationApp(conversation, target)).toBeNull();
});

it.each([null, { ...conversation, app_binding: { app_id: "app-secondary", agent_id: "agent-primary" } }])(
  "does not overwrite a deleted conversation or competing app owner", async (winner) => {
    update.mockResolvedValue(null); find.mockResolvedValue(winner);
    expect((await admitConversationApp(conversation, target))?.status).toBe(409);
    expect(update).toHaveBeenCalledTimes(1);
  },
);

it("checks that an already pinned conversation still exists before forwarding again", async () => {
  update.mockResolvedValue(null); find.mockResolvedValue(null);
  expect((await admitConversationApp({ ...conversation, app_binding: binding }, target))?.status).toBe(409);
  expect(update).toHaveBeenCalledWith(expect.objectContaining({ app_binding: { $eq: binding } }), expect.anything(), expect.anything());
});

it("does not let mutable legacy labels substitute a different authoritative app owner", () => {
  const result = resolveConversationAppAssistant({ ...conversation,
    app_binding: { app_id: "app-secondary", agent_id: "agent-primary" },
    metadata: { conversation_surface: "agentic-app", agentic_app_id: "app-primary", agentic_app_agent_id: "agent-primary" } as Conversation["metadata"],
  }, "agent-primary");
  expect(result).toHaveProperty("status", 409);
});

it("keeps an authoritative app owner when mutable overlay labels change", () => {
  const result = resolveConversationAppAssistant({ ...conversation, app_binding: binding,
    metadata: { conversation_surface: "agentic-app", agentic_app_id: "app-secondary", agentic_app_agent_id: "agent-secondary" } as Conversation["metadata"],
  }, "agent-primary");
  expect(result).toMatchObject(target);
});

it("does not include editable overlay labels in atomic app admission", async () => {
  update.mockResolvedValue({ ...conversation, app_binding: binding });
  expect(await admitConversationApp({ ...conversation,
    metadata: { conversation_surface: "agentic-app", agentic_app_id: "app-secondary" } as Conversation["metadata"],
  }, target)).toBeNull();
  expect(update.mock.calls[0][0]).toEqual({
    _id: conversation._id, app_binding: { $exists: false },
    participants: { $elemMatch: { type: "agent", id: "agent-primary" } },
  });
});

it("reports a database admission failure without forwarding or choosing another backend", async () => {
  update.mockRejectedValue(new Error("Storage unavailable"));
  expect((await admitConversationApp(conversation, target))?.status).toBe(503);
});
