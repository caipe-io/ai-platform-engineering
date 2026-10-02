import { render, screen, waitFor } from "@testing-library/react";
import type { Conversation } from "@/types/a2a";
import { ChatContainer } from "../ChatContainer";

const mockGetConversation = jest.fn();
const mockSetActiveConversation = jest.fn();
const mockLoadMessages = jest.fn().mockResolvedValue(undefined);
const mockState = {
  conversations: [] as Conversation[],
  setActiveConversation: mockSetActiveConversation,
  loadMessagesFromServer: mockLoadMessages,
};

jest.mock("@/store/chat-store", () => ({
  useChatStore: Object.assign(
    (selector?: (state: typeof mockState) => unknown) => selector ? selector(mockState) : mockState,
    {
      getState: () => mockState,
      setState: (updater: (state: typeof mockState) => Partial<typeof mockState>) =>
        Object.assign(mockState, updater(mockState)),
    },
  ),
}));
jest.mock("@/lib/api-client", () => ({
  apiClient: { getConversation: (...args: unknown[]) => mockGetConversation(...args) },
}));
jest.mock("@/lib/storage-config", () => ({ getStorageMode: () => "mongodb" }));
jest.mock("next/navigation", () => ({
  useParams: () => ({ uuid: "task-chat" }),
  useRouter: () => ({ push: jest.fn() }),
}));
jest.mock("next-auth/react", () => ({
  useSession: () => ({ data: { user: { email: "owner@example.com" } } }),
}));
jest.mock("@/components/ui/caipe-spinner", () => ({ CAIPESpinner: () => null }));
jest.mock("../DynamicAgentChatView", () => ({
  ChatView: ({ conversationId }: { conversationId: string }) => <div>{conversationId}</div>,
}));

beforeEach(() => {
  jest.clearAllMocks();
  mockState.conversations = [];
  global.fetch = jest.fn().mockResolvedValue({
    ok: true,
    json: async () => ({ data: { _id: "example-agent", name: "Example agent" } }),
  });
});

it("keeps task provenance on a direct-open chat so run follow-ups work without the sidebar list", async () => {
  const metadata = { task_name: "Example task", source: "autonomous" };
  mockGetConversation.mockResolvedValue({
    _id: "task-chat",
    title: "[Autonomous] Example task",
    created_at: "2026-09-01T10:00:00Z",
    updated_at: "2026-09-01T10:00:00Z",
    source: "autonomous",
    task_id: "example-task",
    run_id: "latest-run",
    metadata,
    participants: [{ type: "agent", id: "example-agent" }],
    owner_id: "owner@example.com",
    access_level: "owner",
  });

  render(<ChatContainer />);

  await screen.findByText("task-chat");
  await waitFor(() => expect(mockLoadMessages).toHaveBeenCalledWith("task-chat"));
  expect(mockState.conversations).toEqual([
    expect.objectContaining({
      id: "task-chat",
      source: "autonomous",
      task_id: "example-task",
      run_id: "latest-run",
      metadata,
      accessLevel: "owner",
    }),
  ]);
  expect(mockSetActiveConversation).toHaveBeenCalledWith("task-chat");
});
