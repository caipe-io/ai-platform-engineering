import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ChatMessage, Conversation } from "@/types/a2a";
import { ChatPanel } from "../DynamicAgentChatPanel";

let mockConversation: Conversation;
const mockOpenChat = jest.fn();
const mockPush = jest.fn();
jest.mock("next/navigation", () => ({ useRouter: () => ({ push: mockPush }) }));
const mockToast = jest.fn();
const mockStreamMessage = jest.fn().mockResolvedValue(undefined);
const mockInitializeFeatureFlags = jest.fn();
const mockChatState = {
  activeConversationId: "task-chat",
  getActiveConversation: () => mockConversation,
  get conversations() { return [mockConversation]; },
  isConversationStreaming: () => false,
  consumePendingMessage: () => null,
  addMessage: jest.fn(() => "typed-message"),
  updateMessage: jest.fn(),
  appendToMessage: jest.fn(),
  clearStreamEvents: jest.fn(),
  setConversationStreaming: jest.fn(),
  loadMessagesFromServer: jest.fn(),
  contextUsageByConversation: {},
  messageHistory: {},
  setContextUsage: jest.fn(),
  loadOlderMessagesFromServer: jest.fn().mockResolvedValue(undefined),
};

jest.mock("@/store/chat-store", () => ({
  useChatStore: Object.assign(() => mockChatState, { getState: () => mockChatState }),
}));
jest.mock("@/store/feature-flag-store", () => ({
  useFeatureFlagStore: (selector: (state: unknown) => unknown) => selector({
    flags: { autoScroll: false }, initialize: mockInitializeFeatureFlags,
  }),
}));
jest.mock("next-auth/react", () => ({ useSession: () => ({ data: null }) }));
jest.mock("@/components/ui/toast", () => ({ useToast: () => ({ toast: mockToast }) }));
jest.mock("@/lib/config", () => ({ getConfig: (key: string) => key === "appName" ? "Test agent" : false }));
jest.mock("@/components/autonomous/api", () => ({
  autonomousApi: {
    openFollowUpChat: (...args: unknown[]) => mockOpenChat(...args),
    listFollowUpChats: async () => ({}),
  },
}));
jest.mock("@/lib/streaming", () => ({
  createStreamAdapter: () => ({ streamMessage: mockStreamMessage, abort: jest.fn() }),
}));
jest.mock("@/hooks/useDynamicAgentTimeline", () => ({ useAgentTimeline: () => ({ data: {} }) }));
jest.mock("@/components/shared/timeline", () => ({
  MarkdownRenderer: ({ content }: { content: string }) => <div>{content}</div>,
}));
jest.mock("@/components/dynamic-agents/AgentAvatar", () => ({ AgentAvatar: () => null }));
jest.mock("../DynamicAgentTimeline", () => ({ AgentTimeline: () => null }));
jest.mock("../FeedbackButton", () => ({ FeedbackButton: () => null }));
jest.mock("../useSlashCommands", () => ({ useSlashCommands: () => [] }));
jest.mock("../CustomCallButtons", () => ({ DEFAULT_AGENTS: [] }));

function runMessages(runId: string): ChatMessage[] {
  return (["user", "assistant"] as const).map((role) => ({
    id: `${runId}-${role}`,
    role,
    content: `${runId} ${role}`,
    timestamp: new Date("2026-09-01T10:00:00Z"),
    turnId: runId,
    autonomousRunId: runId,
    autonomousExecutionContextId: `${runId}-context`,
    autonomousMessageKind: role === "assistant" ? "run_response" : "run_request",
  }));
}

beforeEach(() => {
  jest.clearAllMocks();
  HTMLElement.prototype.scrollIntoView = jest.fn();
  mockConversation = {
    id: "task-chat",
    title: "Example task",
    source: "autonomous",
    task_id: "example-task",
    messages: [...runMessages("older"), ...runMessages("latest")],
    createdAt: new Date(),
    updatedAt: new Date(),
  } as Conversation;
  mockOpenChat.mockResolvedValue({ conversation_id: "manual-chat" });
});

it.each([{ runId: "older", index: 0 }, { runId: "latest", index: 1 }])(
  "opens an independent chat for the $runId run without a normal composer",
  async ({ runId, index }) => {
    render(<ChatPanel agentId="example-agent" conversationId="task-chat" />);
    const buttons = screen.getAllByRole("button", { name: "Continue this run" });
    expect(buttons).toHaveLength(2);
    expect(screen.queryByPlaceholderText(/Ask anything/)).toBeNull();
    expect(screen.queryByRole("button", { name: "Edit message" })).toBeNull();
    fireEvent.click(buttons[index]);
    await waitFor(() => expect(mockOpenChat).toHaveBeenCalledWith("example-task", runId));
    expect(mockPush).toHaveBeenCalledWith("/chat/manual-chat");
    expect(await screen.findByRole("link", { name: "Open manual follow-up" })).toHaveAttribute("href", "/chat/manual-chat");
    expect(mockStreamMessage).not.toHaveBeenCalled();
  },
);

it("keeps normal streaming available in the independent manual chat", async () => {
  mockConversation = { ...mockConversation, source: "web", task_id: undefined, messages: [] };
  render(<ChatPanel agentId="example-agent" conversationId="task-chat" />);
  fireEvent.change(screen.getByPlaceholderText(/Ask anything/), { target: { value: "Explain this result" } });
  fireEvent.click(screen.getByTitle("Send message"));
  await waitFor(() => expect(mockStreamMessage).toHaveBeenCalledWith(
    expect.objectContaining({ conversationId: "task-chat", message: "Explain this result" }),
    expect.any(Object),
  ));
  expect(mockOpenChat).not.toHaveBeenCalled();
});

it("does not offer continuation in a conversation shared as read-only", () => {
  render(<ChatPanel agentId="example-agent" conversationId="task-chat" readOnly readOnlyReason="shared_readonly" />);
  expect(screen.queryByRole("button", { name: "Continue this run" })).toBeNull();
  expect(screen.queryByPlaceholderText(/Ask anything/)).toBeNull();
});
