import { apiClient } from "@/lib/api-client";
import { findLatestAppConversation } from "../assistant-conversations";

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
