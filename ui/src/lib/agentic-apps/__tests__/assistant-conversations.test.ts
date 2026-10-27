import { apiClient } from "@/lib/api-client";
import { findLatestAppConversation, mergeAppConversation, matchesAssistantConversation } from "../assistant-conversations";
import type { Conversation } from "@/types/a2a";

jest.mock("@/lib/api-client", () => ({ apiClient: { getConversations: jest.fn() } }));
jest.mock("@/lib/storage-config", () => ({ getStorageMode: () => "mongodb" }));

it("finds an owned app conversation beyond page one without the sidebar filter", async () => {
  const lookup = jest.mocked(apiClient.getConversations);
  lookup.mockResolvedValueOnce({ items: [], has_more: true } as never);
  lookup.mockResolvedValueOnce({ items: [{
    _id: "existing-chat", title: "Example chat", access_level: "owner",
    created_at: new Date(), updated_at: new Date(), participants: [{ type: "agent", id: "example-agent" }],
    metadata: { conversation_surface: "agentic-app", agentic_app_id: "example", agentic_app_agent_id: "example-agent" },
  }], has_more: false } as never);
  expect((await findLatestAppConversation([], "example", "example-agent"))?.id).toBe("existing-chat");
  expect(lookup).toHaveBeenNthCalledWith(2, {
    page: 2, page_size: 100, source: "web", client_type: "webui", archived: false,
  });
});

it("does not infer missing history when the server fails", async () => {
  jest.mocked(apiClient.getConversations).mockRejectedValueOnce(new Error("unavailable"));
  await expect(findLatestAppConversation([], "example", "example-agent")).rejects.toThrow("unavailable");
});

it("refreshes ownership and access for restored chats while preserving live local messages", () => {
  const local: Conversation = { id: "saved-chat", title: "Old title", participants: [],
    createdAt: new Date("2026-01-01"), updatedAt: new Date("2026-01-01"), messages: [], streamEvents: [] };
  const saved = { _id: local.id, title: "Shared chat", participants: [], owner_id: "owner@example.test",
    access_level: "shared_readonly" as const, created_at: "2026-01-01", updated_at: "2026-01-02" };
  for (const previous of [[], [local]]) {
    const [restored] = mergeAppConversation(previous, saved);
    expect(restored).toMatchObject({ owner_id: "owner@example.test", accessLevel: "shared_readonly", title: "Shared chat" });
    expect(restored.updatedAt).toEqual(new Date("2026-01-02"));
    if (previous.length) expect(restored.messages).toBe(local.messages);
  }
});

it("allows unbound legacy history only by explicit opt-in without accepting another app or incomplete bindings", () => {
  const matches = (metadata?: Record<string, unknown>, legacy = false) =>
    matchesAssistantConversation("example-app", "example-agent", "example-agent", metadata, legacy);
  expect(matches()).toBe(false);
  expect(matches(undefined, true)).toBe(true);
  expect(matches({ agentic_app_id: "secondary-app" }, true)).toBe(false);
  expect(matches({ agentic_app_id: "example-app" }, true)).toBe(false);
  expect(matches({ conversation_surface: "agentic-app" }, true)).toBe(false);
});
