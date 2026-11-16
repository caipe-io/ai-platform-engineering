import { render, screen } from "@testing-library/react";
import type { StreamCallbacks } from "@/lib/streaming/callbacks";
import type { useChatStore } from "@/store/chat-store";
import type { ExternalChatActivity } from "@/store/chat-store";
import type { ChatMessage, Conversation } from "@/types/a2a";
import { ChatPanel } from "../DynamicAgentChatPanel";

let mockConversation: Conversation;
let mockStreaming = false;
type StreamRegistration = Parameters<ReturnType<typeof useChatStore.getState>["setConversationStreaming"]>[1];
const mockPush = jest.fn();
jest.mock("next/navigation", () => ({ useRouter: () => ({ push: mockPush }) }));
const mockToast = jest.fn();
const mockSignIn = jest.fn();
const mockStreamMessage = jest.fn(async (_params: unknown, callbacks: StreamCallbacks) => { callbacks.onDone?.(); });
const mockRecoverRun = jest.fn(async (_run: string, callbacks: StreamCallbacks) => { callbacks.onContent?.("Recovered final answer", []); callbacks.onDone?.(); });
const mockChatState = {
  activeConversationId: "chat-1",
  getActiveConversation: () => mockConversation,
  get conversations() { return [mockConversation]; },
  isConversationStreaming: () => mockStreaming,
  streamingConversations: new Map(),
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
  addStreamEvent: jest.fn(),
  clearStreamEvents: jest.fn(),
  setConversationStreaming: jest.fn((id: string, registration: StreamRegistration): void => {
    if (registration) mockChatState.streamingConversations.set(id, registration);
    else mockChatState.streamingConversations.delete(id);
  }),
  saveMessagesToServer: jest.fn().mockResolvedValue(undefined),
  cancelConversationRequest: jest.fn(),
  loadMessagesFromServer: jest.fn(),
  externalActivity: {} as Record<string, ExternalChatActivity>,
  contextUsageByConversation: {},
  messageHistory: {},
  setContextUsage: jest.fn(),
  loadOlderMessagesFromServer: jest.fn().mockResolvedValue(undefined),
  createConversation: jest.fn().mockResolvedValue("new-chat"),
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
jest.mock("next-auth/react", () => ({ useSession: () => ({ data: null }), signIn: (...args: unknown[]) => mockSignIn(...args) }));
jest.mock("@/components/ui/toast", () => ({ useToast: () => ({ toast: mockToast }) }));
jest.mock("@/lib/config", () => ({ getConfig: (key: string) => key === "appName" ? "Test agent" : false }));
jest.mock("@/components/autonomous/api", () => ({
  autonomousApi: { openFollowUpChat: jest.fn(), listFollowUpChats: async () => ({}) },
}));
jest.mock("@/lib/streaming", () => ({
  StreamError: jest.requireActual("@/lib/streaming/stream-error").StreamError,
  createStreamAdapter: () => ({ streamMessage: mockStreamMessage, recoverRun: mockRecoverRun, abort: jest.fn() }),
}));
const mockUseAgentTimeline = jest.fn<{ data: object }, [unknown, boolean, unknown]>(() => ({ data: {} }));
jest.mock("@/hooks/useDynamicAgentTimeline", () => ({ useAgentTimeline: (...args: [unknown, boolean, unknown]) => mockUseAgentTimeline(...args) }));
jest.mock("@/components/shared/timeline", () => ({
  MarkdownRenderer: ({ content }: { content: string }) => <div>{content}</div>,
}));
jest.mock("@/components/dynamic-agents/AgentAvatar", () => ({ AgentAvatar: () => null }));
jest.mock("../DynamicAgentTimeline", () => ({ AgentTimeline: () => null }));
jest.mock("../FeedbackButton", () => ({ FeedbackButton: () => null }));
jest.mock("../MessageActionButtons", () => ({
  MessageActionButtons: (props: { actions: Array<{ id: string }>; messageId: string; agentId: string; conversationId: string; messageContent: string }) => (
    <div data-testid="message-actions" data-message={props.messageId} data-agent={props.agentId}
      data-conversation={props.conversationId} data-content={props.messageContent}>{props.actions.map(a => a.id).join(",")}</div>
  ),
}));
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


beforeEach(() => {
  jest.clearAllMocks();
  mockStreaming = false;
  mockChatState.streamingConversations.clear();
  mockChatState.externalActivity = {};
  mockChatState.loadMessagesFromServer.mockReset().mockResolvedValue(undefined);
  HTMLElement.prototype.scrollIntoView = jest.fn();
  setConversation([
    message("u1", "user", "first question"),
    message("a1", "assistant", "first answer"),
    message("u2", "user", "second question"),
    message("a2", "assistant", "second answer"),
  ]);
});

const actions = [{ id: "flag-answer", label: "Flag answer", icon: "flag" as const, path: "/api/example/actions/flag" }];

describe("app message actions on assistant answers", () => {
  it("shows enabled actions on finished assistant answers only", () => {
    render(<ChatPanel agentId="example-agent" conversationId="chat-1" messageActions={actions} />);
    const shown = screen.getAllByTestId("message-actions");
    expect(shown.map(el => el.getAttribute("data-message"))).toEqual(["a1", "a2"]);
    expect(shown[0]).toHaveAttribute("data-content", "first answer");
    expect(shown[0]).toHaveAttribute("data-agent", "example-agent");
    expect(shown[0]).toHaveAttribute("data-conversation", "chat-1");
  });

  it("shows nothing when no action is enabled", () => {
    const { rerender } = render(<ChatPanel agentId="example-agent" conversationId="chat-1" messageActions={[]} />);
    expect(screen.queryByTestId("message-actions")).toBeNull();
    rerender(<ChatPanel agentId="example-agent" conversationId="chat-1" />);
    expect(screen.queryByTestId("message-actions")).toBeNull();
  });

  it("hides actions on an answer that is still streaming", () => {
    mockStreaming = true;
    mockChatState.streamingConversations.set("chat-1", {});
    render(<ChatPanel agentId="example-agent" conversationId="chat-1" messageActions={actions} />);
    // The earlier, finished answer keeps its actions; the streaming one does not.
    expect(screen.getAllByTestId("message-actions").map(el => el.getAttribute("data-message"))).toEqual(["a1"]);
  });

  it.each([
    ["unfinished", { isFinal: false }],
    ["interrupted", { turnStatus: "interrupted" as const }],
    ["waiting for input", { turnStatus: "waiting_for_input" as const }],
    ["cancelled", { turnStatus: "cancelled" as const }],
  ])("hides actions on an %s answer", (_name, extra) => {
    setConversation([message("u1", "user", "question"), message("a1", "assistant", "partial answer", extra)]);
    render(<ChatPanel agentId="example-agent" conversationId="chat-1" messageActions={actions} />);
    expect(screen.queryByTestId("message-actions")).toBeNull();
  });

  it("shows actions on an answer completed in a finished turn", () => {
    setConversation([message("u1", "user", "question"), message("a1", "assistant", "answer", { turnStatus: "done" })]);
    render(<ChatPanel agentId="example-agent" conversationId="chat-1" messageActions={actions} />);
    expect(screen.getAllByTestId("message-actions")).toHaveLength(1);
  });
});
