import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ChatMessage, Conversation } from "@/types/a2a";
import type { StreamCallbacks } from "@/lib/streaming";
import { createStreamEvent } from "@/lib/streaming/types";
import { ChatPanel } from "../DynamicAgentChatPanel";

let mockConversation: Conversation;
const mockOpenChat = jest.fn();
const mockPush = jest.fn();
jest.mock("next/navigation", () => ({ useRouter: () => ({ push: mockPush }) }));
const mockToast = jest.fn();
const mockStreamMessage = jest.fn().mockResolvedValue(undefined);
const mockReattachStream = jest.fn().mockResolvedValue(undefined);
const mockLatestRun = jest.fn().mockResolvedValue(null);
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
  addStreamEvent: jest.fn(),
  setConversationStreaming: jest.fn(),
  saveMessagesToServer: jest.fn().mockResolvedValue(undefined),
  loadMessagesFromServer: jest.fn(),
  externalActivity: {},
  contextUsageByConversation: {},
  messageHistory: {},
  setContextUsage: jest.fn(),
  loadOlderMessagesFromServer: jest.fn().mockResolvedValue(undefined),
};

jest.mock("@/store/chat-store", () => ({
  useChatStore: Object.assign((selector?: (state: typeof mockChatState) => unknown) => selector ? selector(mockChatState) : mockChatState, { getState: () => mockChatState }),
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
  createStreamAdapter: () => ({ streamMessage: mockStreamMessage, reattachStream: mockReattachStream, abort: jest.fn() }),
}));
jest.mock("@/lib/streaming/native-runs", () => ({ getLatestNativeRun: (...args: unknown[]) => mockLatestRun(...args) }));
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
  mockChatState.activeConversationId = "task-chat";
  mockStreamMessage.mockResolvedValue(undefined);
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
  mockLatestRun.mockResolvedValue(null);
  mockReattachStream.mockImplementation(async (_params, callbacks: StreamCallbacks) => {
    callbacks.onContent?.("Recovered response", []);
    callbacks.onDone?.();
    callbacks.onRunStatus?.("completed");
  });
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

it("reattaches a completed detached run after reload into the same partial assistant message", async () => {
  mockConversation = {
    ...mockConversation,
    source: "web",
    messages: [{ id: "user-turn-1", role: "user", content: "Inspect", turnId: "turn-1", timestamp: new Date() }, {
      id: "persisted-assistant", role: "assistant", content: "partial", timestamp: new Date(),
      turnId: "turn-1", isFinal: false,
    }],
  };
  mockLatestRun.mockResolvedValue({ run_id: "run-1", turn_id: "turn-1", protocol: "agui", status: "completed" });
  render(<ChatPanel agentId="example-agent" conversationId="task-chat" />);

  await waitFor(() => expect(mockReattachStream).toHaveBeenCalledWith(
    { conversationId: "task-chat", agentId: "example-agent", runId: "run-1" },
    expect.any(Object),
  ));
  expect(mockChatState.addMessage).not.toHaveBeenCalled();
  expect(mockStreamMessage).not.toHaveBeenCalled();
  expect(mockChatState.updateMessage).toHaveBeenCalledWith(
    "task-chat", "persisted-assistant", expect.objectContaining({ content: "", isFinal: false }),
  );
  expect(mockChatState.updateMessage).toHaveBeenCalledWith(
    "task-chat", "persisted-assistant", expect.objectContaining({ content: "Recovered response", isFinal: true, turnStatus: "done" }),
  );
});

it("marks an authorized read-only replay as observation so it cannot rewrite history", async () => {
  mockConversation = {
    ...mockConversation, source: "web", messages: [
      { id: "user-turn-1", role: "user", content: "Inspect", turnId: "turn-1", timestamp: new Date() },
    ],
  };
  mockLatestRun.mockResolvedValue({ run_id: "run-1", turn_id: "turn-1", protocol: "agui", status: "running" });
  render(<ChatPanel agentId="example-agent" conversationId="task-chat" readOnly readOnlyReason="shared_readonly" />);

  await waitFor(() => expect(mockReattachStream).toHaveBeenCalled());
  expect(mockChatState.setConversationStreaming).toHaveBeenCalledWith(
    "task-chat", expect.objectContaining({ readOnly: true }),
  );
  expect(mockChatState.saveMessagesToServer).not.toHaveBeenCalled();
  expect(mockStreamMessage).not.toHaveBeenCalled();
});

it("does not recreate a removed turn from an older execution journal after clear or rewind", async () => {
  mockConversation = { ...mockConversation, source: "web", messages: [] };
  mockLatestRun.mockResolvedValue({ run_id: "removed-run", turn_id: "removed-turn", protocol: "agui", status: "completed" });
  render(<ChatPanel agentId="example-agent" conversationId="task-chat" />);
  await waitFor(() => expect(mockLatestRun).toHaveBeenCalled());
  expect(mockReattachStream).not.toHaveBeenCalled();
  expect(mockChatState.addMessage).not.toHaveBeenCalled();
});

it("retains parent task context while replaying a HITL resume after reload", async () => {
  const seed = {
    ...createStreamEvent("tool_start", { tool_name: "task", tool_call_id: "parent-task", args: { subagent_type: "example-child" }, namespace: [] }),
    isResumeSeed: true,
  };
  mockConversation = {
    ...mockConversation, source: "web", messages: [
      { id: "resume-user", role: "user", content: "Approved", turnId: "resume-turn", timestamp: new Date() },
      { id: "resume-assistant", role: "assistant", content: "", turnId: "resume-turn", timestamp: new Date(), streamEvents: [seed], isFinal: false },
    ],
  };
  mockLatestRun.mockResolvedValue({ run_id: "resume-run", turn_id: "resume-turn", protocol: "agui", status: "running" });
  render(<ChatPanel agentId="example-agent" conversationId="task-chat" />);
  await waitFor(() => expect(mockReattachStream).toHaveBeenCalled());
  expect(mockChatState.addStreamEvent).toHaveBeenNthCalledWith(1, seed, "task-chat");
  expect(mockStreamMessage).not.toHaveBeenCalled();
});


it("shows the retained execution harness even when the agent default has changed", async () => {
  mockConversation = { ...mockConversation, source: "web", messages: [] };
  mockLatestRun.mockResolvedValue({
    run_id: "run-1", turn_id: "turn-1", protocol: "agui", status: "completed",
    harness_id: "claude_agent_sdk",
  });
  render(<ChatPanel agentId="example-agent" conversationId="task-chat" />);
  expect(await screen.findByLabelText("Execution harness: Claude Agent SDK")).toBeInTheDocument();
  expect(mockReattachStream).not.toHaveBeenCalled();
});


it.each(["completed", "failed", "input", "approval"] as const)(
  "does not display a background conversation's %s status or input controls", async (event) => {
    mockConversation = { ...mockConversation, source: "web", messages: [] };
    let finish!: () => void;
    mockStreamMessage.mockImplementationOnce(() => new Promise<void>((resolve) => { finish = resolve; }));
    const panel = render(<ChatPanel agentId="example-agent" conversationId="task-chat" />);
    fireEvent.change(screen.getByPlaceholderText(/Ask anything/), { target: { value: "Inspect" } });
    fireEvent.click(screen.getByTitle("Send message"));
    await waitFor(() => expect(mockStreamMessage).toHaveBeenCalled());
    const callbacks = mockStreamMessage.mock.calls[0][1] as StreamCallbacks;
    mockChatState.activeConversationId = "other-chat";
    mockConversation = { ...mockConversation, id: "other-chat", title: "Other conversation", messages: [] };
    panel.rerender(<ChatPanel agentId="example-agent" conversationId="other-chat" />);
    await act(async () => {
      if (event === "completed") callbacks.onDone?.();
      if (event === "failed") callbacks.onError?.("Example failure");
      if (event === "input") callbacks.onInputRequired?.("interrupt-example", "Background input", [], undefined);
      if (event === "approval") callbacks.onToolApprovalRequired?.("interrupt-example", "inspect", {}, ["approve", "reject"], undefined);
    });
    expect(screen.queryByText("Run completed.")).not.toBeInTheDocument();
    expect(screen.queryByText("Run failed. Saved progress is retained.")).not.toBeInTheDocument();
    expect(screen.queryByText("Waiting for input or approval.")).not.toBeInTheDocument();
    expect(screen.queryByText("Background input")).not.toBeInTheDocument();
    if (event === "input" || event === "approval") expect(mockChatState.addStreamEvent).toHaveBeenCalledWith(
      expect.objectContaining({ type: "input_required" }), "task-chat",
    );
    await act(async () => finish());
  },
);
