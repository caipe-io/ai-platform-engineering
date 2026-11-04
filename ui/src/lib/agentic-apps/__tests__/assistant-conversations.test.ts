import { apiClient } from "@/lib/api-client";
import { findLatestAppConversation, mergeAppConversation, matchesAssistantConversation } from "../assistant-conversations";
import type { Conversation } from "@/types/a2a";

jest.mock("@/lib/api-client", () => ({ apiClient: { getLatestAppConversation: jest.fn(), getConversations: jest.fn() } }));
jest.mock("@/lib/storage-config", () => ({ getStorageMode: () => "mongodb" }));

it("restores the owned app chat with one lookup instead of scanning general history", async () => {
  const lookup = jest.mocked(apiClient.getLatestAppConversation);
  lookup.mockResolvedValueOnce({ conversation: {
    _id: "existing-chat", title: "Example chat", access_level: "owner",
    created_at: new Date(), updated_at: new Date(), participants: [{ type: "agent", id: "example-agent" }],
    metadata: { conversation_surface: "agentic-app", agentic_app_id: "example", agentic_app_agent_id: "example-agent" },
  } } as never);
  expect((await findLatestAppConversation([], "example", "example-agent"))?.id).toBe("existing-chat");
  expect(lookup).toHaveBeenCalledTimes(1);
  expect(lookup).toHaveBeenCalledWith("example");
  expect(apiClient.getConversations).not.toHaveBeenCalled();
});

it("does not infer missing history when the server fails", async () => {
  jest.mocked(apiClient.getLatestAppConversation).mockRejectedValueOnce(new Error("unavailable"));
  await expect(findLatestAppConversation([], "example", "example-agent")).rejects.toThrow("unavailable");
});

it("returns no chat only when the authorized lookup succeeds with no match", async () => {
  jest.mocked(apiClient.getLatestAppConversation).mockResolvedValueOnce({ conversation: null });
  await expect(findLatestAppConversation([], "example", "example-agent")).resolves.toBeNull();
});

it.each([
  { access_level: "shared", participants: [{ type: "agent", id: "example-agent" }] },
  { access_level: "owner", participants: [{ type: "agent", id: "secondary-agent" }] },
  { access_level: "owner", participants: [{ type: "agent", id: "example-agent" }], metadata: { agentic_app_id: "secondary" } },
])("rejects stale ownership or bindings before restoring a returned chat: %j", async conversation => {
  jest.mocked(apiClient.getLatestAppConversation).mockResolvedValueOnce({ conversation } as never);
  await expect(findLatestAppConversation([], "example", "example-agent")).rejects.toThrow("bound");
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
