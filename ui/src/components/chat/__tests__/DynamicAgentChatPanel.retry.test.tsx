import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { apiClient } from "@/lib/api-client";
import type { ExternalChatActivity } from "@/store/chat-store";
import type { ChatMessage, Conversation } from "@/types/a2a";
import { ChatPanel } from "../DynamicAgentChatPanel";

let mockConversation: Conversation;
let mockStreaming = false;
const mockPush = jest.fn();
jest.mock("next/navigation", () => ({ useRouter: () => ({ push: mockPush }) }));
const mockToast = jest.fn();
const mockStreamMessage = jest.fn().mockResolvedValue(undefined);
const mockChatState = {
  activeConversationId: "chat-1",
  getActiveConversation: () => mockConversation,
  get conversations() { return [mockConversation]; },
  isConversationStreaming: () => mockStreaming,
  consumePendingMessage: () => null,
  addMessage: jest.fn((_conversationId: string, value: Omit<ChatMessage, "id" | "timestamp">, turnId?: string) => {
    const id = `new-message-${mockConversation.messages.length}`;
    mockConversation.messages.push(message(id, value.role as "user" | "assistant", value.content, { ...value, turnId }));
    return id;
  }),
  updateMessage: jest.fn((_conversationId: string, id: string, updates: Partial<ChatMessage>) => {
    const target = mockConversation.messages.find((item) => item.id === id);
    if (target) Object.assign(target, updates);
  }),
  appendToMessage: jest.fn(),
  clearStreamEvents: jest.fn(),
  setConversationStreaming: jest.fn(),
  loadMessagesFromServer: jest.fn(),
  externalActivity: {} as Record<string, ExternalChatActivity>,
  contextUsageByConversation: {},
  messageHistory: {},
  setContextUsage: jest.fn(),
  loadOlderMessagesFromServer: jest.fn().mockResolvedValue(undefined),
};

jest.mock("@/store/chat-store", () => ({
  useChatStore: Object.assign(
    (selector?: (state: typeof mockChatState) => unknown) => selector ? selector(mockChatState) : mockChatState,
    { getState: () => mockChatState },
  ),
}));
jest.mock("@/store/feature-flag-store", () => ({
  useFeatureFlagStore: (selector: (state: unknown) => unknown) => selector({
    flags: { autoScroll: false }, initialize: jest.fn(),
  }),
}));
jest.mock("next-auth/react", () => ({ useSession: () => ({ data: null }) }));
jest.mock("@/components/ui/toast", () => ({ useToast: () => ({ toast: mockToast }) }));
jest.mock("@/lib/config", () => ({ getConfig: (key: string) => key === "appName" ? "Test agent" : false }));
jest.mock("@/components/autonomous/api", () => ({
  autonomousApi: { openFollowUpChat: jest.fn(), listFollowUpChats: async () => ({}) },
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

const message = (id: string, role: "user" | "assistant", content: string, extra: Partial<ChatMessage> = {}): ChatMessage => ({
  id,
  role,
  content,
  timestamp: new Date("2026-09-01T10:00:00Z"),
  turnId: id,
  ...extra,
} as ChatMessage);

function setConversation(messages: ChatMessage[], extra: Partial<Conversation> = {}) {
  mockConversation = {
    id: "chat-1",
    title: "Example",
    source: "web",
    messages,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...extra,
  } as Conversation;
}

const lastRequest = () => mockStreamMessage.mock.calls.at(-1)?.[0];
const mockRewind = jest.spyOn(apiClient, "rewindConversation");
const mockAttachment = { mime_type: "text/plain", name: "example.txt", data: "ZXhhbXBsZQ==", size: 7 };

beforeEach(() => {
  jest.clearAllMocks();
  mockStreaming = false;
  mockChatState.externalActivity = {};
  HTMLElement.prototype.scrollIntoView = jest.fn();
  setConversation([
    message("u1", "user", "first question"),
    message("a1", "assistant", "first answer"),
    message("u2", "user", "second question"),
    message("a2", "assistant", "second answer"),
  ]);
});

describe("retry alongside edit", () => {
  it("offers retry, regenerate and edit together", () => {
    render(<ChatPanel agentId="example-agent" conversationId="chat-1" />);
    expect(screen.getAllByRole("button", { name: "Retry this prompt" })).toHaveLength(2);
    expect(screen.getAllByRole("button", { name: "Regenerate response" })).toHaveLength(2);
    expect(screen.getAllByRole("button", { name: "Edit message" })).toHaveLength(2);
  });

  it("re-sends a user prompt as a new turn without rewinding", async () => {
    const history = mockConversation.messages.map((item) => ({ ...item }));
    render(<ChatPanel agentId="example-agent" conversationId="chat-1" />);
    fireEvent.click(screen.getAllByRole("button", { name: "Retry this prompt" })[0]);
    await waitFor(() => expect(mockStreamMessage).toHaveBeenCalledTimes(1));
    expect(lastRequest()).toEqual(expect.objectContaining({ conversationId: "chat-1", message: "first question" }));
    expect(mockRewind).not.toHaveBeenCalled();
    expect(mockConversation.messages.slice(0, history.length)).toEqual(history);
    expect(mockConversation.messages.slice(history.length)).toEqual([
      expect.objectContaining({ role: "user", content: "first question" }),
      expect.objectContaining({ role: "assistant" }),
    ]);
  });

  it("regenerates an answer from the prompt that preceded it", async () => {
    render(<ChatPanel agentId="example-agent" conversationId="chat-1" />);
    fireEvent.click(screen.getAllByRole("button", { name: "Regenerate response" })[1]);
    await waitFor(() => expect(mockStreamMessage).toHaveBeenCalledTimes(1));
    expect(lastRequest()).toEqual(expect.objectContaining({ message: "second question" }));
  });

  it.each(["Retry this prompt", "Regenerate response"])("preserves attachments with %s", async (action) => {
    setConversation([
      message("u1", "user", "read this", { attachments: [mockAttachment] }),
      message("a1", "assistant", "answer"),
    ]);
    render(<ChatPanel agentId="example-agent" conversationId="chat-1" />);
    fireEvent.click(screen.getByRole("button", { name: action }));
    await waitFor(() => expect(mockStreamMessage).toHaveBeenCalledTimes(1));
    expect(lastRequest()).toEqual(expect.objectContaining({
      message: "read this",
      files: [{ mime_type: mockAttachment.mime_type, name: mockAttachment.name, data: mockAttachment.data }],
    }));
    expect(mockConversation.messages[2].attachments).toEqual([expect.objectContaining({
      mime_type: mockAttachment.mime_type, name: mockAttachment.name, data: mockAttachment.data,
    })]);
    expect(mockRewind).not.toHaveBeenCalled();
  });

  it("retries an attachment-only message", async () => {
    setConversation([message("u1", "user", "", { attachments: [mockAttachment] })]);
    render(<ChatPanel agentId="example-agent" conversationId="chat-1" />);
    fireEvent.click(screen.getByRole("button", { name: "Retry this prompt" }));
    await waitFor(() => expect(mockStreamMessage).toHaveBeenCalledTimes(1));
    expect(lastRequest()).toEqual(expect.objectContaining({ message: "", files: [expect.objectContaining({ data: mockAttachment.data })] }));
  });

  it.each(["Retry this prompt", "Regenerate response"])("explains unavailable attachments with %s without sending a partial prompt", (action) => {
    setConversation([
      message("u1", "user", "read this", { attachments: [{ ...mockAttachment, data: undefined }] }),
      message("a1", "assistant", "answer"),
    ]);
    const history = [...mockConversation.messages];
    render(<ChatPanel agentId="example-agent" conversationId="chat-1" />);
    fireEvent.click(screen.getByRole("button", { name: action }));
    expect(mockToast).toHaveBeenCalledWith(expect.stringContaining("Re-upload"), "error", 8000);
    expect(mockStreamMessage).not.toHaveBeenCalled();
    expect(mockChatState.addMessage).not.toHaveBeenCalled();
    expect(mockConversation.messages).toEqual(history);
    expect(mockRewind).not.toHaveBeenCalled();
  });

  it("regenerates the complete queued batch in order with its attachments", async () => {
    setConversation([
      message("old-user", "user", "unrelated", { turnId: "old-turn" }),
      message("old-answer", "assistant", "older answer", { turnId: "old-turn" }),
      message("u1", "user", "first queued", { turnId: "batch", attachments: [mockAttachment] }),
      message("u2", "user", "second queued", { turnId: "batch" }),
      message("a1", "assistant", "batch answer", { turnId: "batch" }),
    ]);
    const history = mockConversation.messages.map((item) => ({ ...item }));
    render(<ChatPanel agentId="example-agent" conversationId="chat-1" />);
    fireEvent.click(screen.getAllByRole("button", { name: "Regenerate response" })[1]);
    await waitFor(() => expect(mockStreamMessage).toHaveBeenCalledTimes(1));
    expect(lastRequest()).toEqual(expect.objectContaining({
      message: "[Queued message 1]\nfirst queued\n\n[Queued message 2]\nsecond queued",
      files: [expect.objectContaining({ data: mockAttachment.data })],
    }));
    expect(mockConversation.messages.slice(0, history.length)).toEqual(history);
    expect(mockConversation.messages.slice(history.length).map((item) => item.content)).toEqual(["first queued", "second queued", ""]);
    expect(mockRewind).not.toHaveBeenCalled();
  });

  it("does not regenerate a batch when an earlier queued attachment is unavailable", () => {
    setConversation([
      message("u1", "user", "first queued", { turnId: "batch", attachments: [{ ...mockAttachment, data: undefined }] }),
      message("u2", "user", "second queued", { turnId: "batch" }),
      message("a1", "assistant", "batch answer", { turnId: "batch" }),
    ]);
    render(<ChatPanel agentId="example-agent" conversationId="chat-1" />);
    fireEvent.click(screen.getByRole("button", { name: "Regenerate response" }));
    expect(mockToast).toHaveBeenCalledWith(expect.stringContaining("Re-upload"), "error", 8000);
    expect(mockStreamMessage).not.toHaveBeenCalled();
    expect(mockChatState.addMessage).not.toHaveBeenCalled();
    expect(mockRewind).not.toHaveBeenCalled();
  });

  it("regenerates legacy messages without turn IDs", async () => {
    setConversation([
      message("u1", "user", "legacy prompt", { turnId: undefined }),
      message("a1", "assistant", "legacy answer", { turnId: undefined }),
    ]);
    render(<ChatPanel agentId="example-agent" conversationId="chat-1" />);
    fireEvent.click(screen.getByRole("button", { name: "Regenerate response" }));
    await waitFor(() => expect(mockStreamMessage).toHaveBeenCalledTimes(1));
    expect(lastRequest()).toEqual(expect.objectContaining({ message: "legacy prompt" }));
  });

  it("offers retry on an interrupted response", async () => {
    setConversation([
      message("u1", "user", "long task"),
      message("a1", "assistant", "partial", { isInterrupted: true }),
    ]);
    render(<ChatPanel agentId="example-agent" conversationId="chat-1" />);
    expect(screen.getByText("Response was interrupted")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(mockStreamMessage).toHaveBeenCalledTimes(1));
    expect(lastRequest()).toEqual(expect.objectContaining({ message: "long task" }));
  });
});

describe("retry is unavailable when it would be unsafe", () => {
  const expectNoRetry = () => {
    expect(screen.queryByRole("button", { name: "Retry this prompt" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Regenerate response" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
  };

  it("hides retry while a response is streaming", () => {
    mockStreaming = true;
    render(<ChatPanel agentId="example-agent" conversationId="chat-1" />);
    expectNoRetry();
  });

  it("hides retry while another client is streaming the conversation", () => {
    mockChatState.externalActivity["chat-1"] = { agentId: "example-agent", turnId: "external-turn", state: "running" };
    render(<ChatPanel agentId="example-agent" conversationId="chat-1" />);
    expectNoRetry();
  });

  it("hides retry in a read-only shared conversation", () => {
    render(<ChatPanel agentId="example-agent" conversationId="chat-1" readOnly readOnlyReason="shared_readonly" />);
    expectNoRetry();
  });

  it("hides retry in autonomous run history", () => {
    setConversation(
      [
        message("u1", "user", "run request", { autonomousRunId: "r1", autonomousExecutionContextId: "c1", autonomousMessageKind: "run_request" }),
        message("a1", "assistant", "run response", { autonomousRunId: "r1", autonomousExecutionContextId: "c1", autonomousMessageKind: "run_response" }),
      ],
      { source: "autonomous", task_id: "example-task" },
    );
    render(<ChatPanel agentId="example-agent" conversationId="chat-1" />);
    expectNoRetry();
  });
});
