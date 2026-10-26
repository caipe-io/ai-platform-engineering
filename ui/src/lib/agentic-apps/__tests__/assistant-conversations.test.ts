import { apiClient } from "@/lib/api-client";
import { findLatestAppConversation } from "../assistant-conversations";

jest.mock("@/lib/api-client", () => ({ apiClient: { getConversations: jest.fn() } }));
let mockStorageMode = "mongodb";
jest.mock("@/lib/storage-config", () => ({ getStorageMode: () => mockStorageMode }));

beforeEach(() => { jest.clearAllMocks(); mockStorageMode = "mongodb"; });

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

const overlayLabels = { conversation_surface: "agentic-app", agentic_app_id: "example", agentic_app_agent_id: "example-agent" };
const historyRow = {
  _id: "existing-chat", title: "Example chat", access_level: "owner",
  created_at: new Date(), updated_at: new Date(), participants: [{ type: "agent", id: "example-agent" }],
};

it("reopens a Managed or SDK overlay without requiring an app execution binding", async () => {
  jest.mocked(apiClient.getConversations).mockResolvedValueOnce({
    items: [{ ...historyRow, metadata: overlayLabels }], has_more: false,
  } as never);
  expect((await findLatestAppConversation([], "example", "example-agent"))?.id).toBe("existing-chat");
});

it.each([{ participants: [] }, { participants: [{ type: "agent", id: "other-agent" }] }])(
  "does not let overlay labels substitute the canonical agent participant (%j)", async ({ participants }) => {
    jest.mocked(apiClient.getConversations).mockResolvedValueOnce({
      items: [{ ...historyRow, participants, metadata: overlayLabels }], has_more: false,
    } as never);
    expect(await findLatestAppConversation([], "example", "example-agent")).toBeNull();
  },
);

it("uses authoritative app ownership when overlay labels have been edited", async () => {
  jest.mocked(apiClient.getConversations).mockResolvedValueOnce({ items: [{ ...historyRow,
    app_binding: { app_id: "example", agent_id: "example-agent" },
    metadata: { ...overlayLabels, agentic_app_id: "other-app" },
  }], has_more: false } as never);
  expect((await findLatestAppConversation([], "example", "example-agent"))?.id).toBe("existing-chat");
});

it.each([null, { app_id: "other-app", agent_id: "example-agent" }, { app_id: "example", agent_id: "other-agent" }])(
  "does not replace an authoritative app binding with matching surface labels (%j)", async (binding) => {
    jest.mocked(apiClient.getConversations).mockResolvedValueOnce({
      items: [{ ...historyRow, app_binding: binding, metadata: overlayLabels }], has_more: false,
    } as never);
    expect(await findLatestAppConversation([], "example", "example-agent")).toBeNull();
  },
);

it("checks the canonical participant before reopening local overlay history", async () => {
  mockStorageMode = "local";
  const chat = { id: "local-chat", title: "Example", createdAt: new Date(), updatedAt: new Date(),
    participants: [{ type: "agent" as const, id: "example-agent" }], metadata: overlayLabels,
    messages: [], streamEvents: [],
  };
  expect(await findLatestAppConversation([chat], "example", "example-agent")).toBe(chat);
  expect(await findLatestAppConversation([{ ...chat, participants: [{ type: "agent", id: "other-agent" }] }], "example", "example-agent")).toBeNull();
  expect(apiClient.getConversations).not.toHaveBeenCalled();
});
