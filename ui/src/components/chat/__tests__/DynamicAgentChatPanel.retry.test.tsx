import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { StreamCallbacks } from "@/lib/streaming/callbacks";
import { apiClient } from "@/lib/api-client";
import type { ExternalChatActivity } from "@/store/chat-store";
import type { ChatMessage, Conversation } from "@/types/a2a";
import { ChatPanel } from "../DynamicAgentChatPanel";
import { updateChatStream } from "@/store/chat-stream-state";
import type { StreamingState } from "@/store/chat-stream-state";

let mockConversation: Conversation;
let mockStreaming = false;
const mockPush = jest.fn();
jest.mock("next/navigation", () => ({ useRouter: () => ({ push: mockPush }) }));
const mockToast = jest.fn();
const mockStreamMessage = jest.fn(async (_params: unknown, callbacks: StreamCallbacks) => { callbacks.onDone?.(); });
const mockResumeStream = jest.fn(async (_params: unknown, callbacks: StreamCallbacks) => { callbacks.onDone?.(); });
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
  clearStreamEvents: jest.fn(),
  addStreamEvent: jest.fn(),
  setConversationStreaming: jest.fn(),
  cancelConversationRequest: jest.fn(),
  loadMessagesFromServer: jest.fn(),
  saveMessagesToServer: jest.fn().mockResolvedValue(undefined),
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
jest.mock("next-auth/react", () => ({ useSession: () => ({ data: null }) }));
jest.mock("@/components/ui/toast", () => ({ useToast: () => ({ toast: mockToast }) }));
jest.mock("@/lib/config", () => ({ getConfig: (key: string) => key === "appName" ? "Test agent" : false }));
jest.mock("@/components/autonomous/api", () => ({
  autonomousApi: { openFollowUpChat: jest.fn(), listFollowUpChats: async () => ({}) },
}));
jest.mock("@/lib/streaming", () => ({
  StreamError: class extends Error { isAuthError() { return false; } },
  createStreamAdapter: () => ({ streamMessage: mockStreamMessage, recoverRun: mockRecoverRun, resumeStream: mockResumeStream, abort: jest.fn() }),
}));
jest.mock("@/hooks/useDynamicAgentTimeline", () => ({ useAgentTimeline: (events: Array<{ content?: string }>) => ({ data: { content: events.map(event => event.content ?? "").join("") } }) }));
jest.mock("@/components/shared/timeline", () => ({
  MarkdownRenderer: ({ content }: { content: string }) => <div>{content}</div>,
}));
jest.mock("@/components/dynamic-agents/AgentAvatar", () => ({ AgentAvatar: () => null }));
jest.mock("../DynamicAgentTimeline", () => ({ AgentTimeline: ({ data }: { data: { content: string } }) => <div>{data.content}</div> }));
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
  mockChatState.streamingConversations.clear();
  mockChatState.externalActivity = {};
  HTMLElement.prototype.scrollIntoView = jest.fn();
  setConversation([
    message("u1", "user", "first question"),
    message("a1", "assistant", "first answer"),
    message("u2", "user", "second question"),
    message("a2", "assistant", "second answer"),
  ]);
});

describe("Engine run recovery after refresh", () => {
  const status = (data: Record<string, unknown>) => jest.spyOn(global, "fetch").mockResolvedValue({
    ok: true, json: async () => ({ data }),
  } as Response);

  it('restores pending Stop after refresh and records a confirmed stop without an error', async () => {
    setConversation([message('assistant-example', 'assistant', 'partial', { turnId: 'turn-example', isFinal: false })]);
    const fetchMock = status({ runtime: 'harness_engine', status: 'running', run_id: 'run-example', turn_id: 'turn-example', cancellation_requested: true });
    mockRecoverRun.mockImplementationOnce(async (_id, callbacks) => { callbacks.onCancelled?.(); });
    try {
      render(<ChatPanel agentId='example-agent' conversationId='chat-1' />);
      await waitFor(() => expect(mockConversation.messages[0]).toMatchObject({ isFinal: true, turnStatus: 'cancelled' }));
      expect(mockChatState.setConversationStreaming).toHaveBeenCalledWith('chat-1', expect.objectContaining({ stopping: true }));
      expect(mockConversation.messages[0].content).not.toContain('Error');
      expect(mockStreamMessage).not.toHaveBeenCalled();
    } finally { fetchMock.mockRestore(); }
  });

  it('blocks Enter and Cmd+Enter while Stop is pending and preserves the draft', async () => {
    mockStreaming = true;
    mockChatState.streamingConversations.set('chat-1', { stopping: true });
    render(<ChatPanel agentId='example-agent' conversationId='chat-1' />);
    expect(screen.getByRole('button', { name: 'Stopping response' })).toBeDisabled();
    const composer = screen.getByRole('textbox', { name: 'Message' });
    fireEvent.change(composer, { target: { value: 'next question' } });
    fireEvent.keyDown(composer, { key: 'Enter', metaKey: true });
    fireEvent.keyDown(composer, { key: 'Enter' });
    await act(async () => {});
    expect(composer).toHaveValue('next question');
    expect(mockStreamMessage).not.toHaveBeenCalled();
    expect(screen.getByText(/Waiting for active work to finish/)).toBeInTheDocument();
  });

  it('queues Cmd+Enter behind confirmed stop instead of sending after a fixed delay', async () => {
    mockStreaming = true;
    mockChatState.streamingConversations.set('chat-1', { streamAdapter: { canRecoverOnRefresh: true } });
    const { rerender } = render(<ChatPanel agentId='example-agent' conversationId='chat-1' />);
    const composer = screen.getByRole('textbox', { name: 'Message' });
    fireEvent.change(composer, { target: { value: 'replacement question' } });
    fireEvent.keyDown(composer, { key: 'Enter', metaKey: true });
    await waitFor(() => expect(mockChatState.cancelConversationRequest).toHaveBeenCalledWith('chat-1'));
    expect(mockStreamMessage).not.toHaveBeenCalled();
    expect(composer).toHaveValue('');
    mockStreaming = false;
    mockChatState.streamingConversations.clear();
    rerender(<ChatPanel agentId='example-agent' conversationId='chat-1' />);
    await waitFor(() => expect(mockStreamMessage).toHaveBeenCalledTimes(1));
    expect(lastRequest()).toMatchObject({ message: 'replacement question' });
  });

  it("replays a shared read-only response without submitting a prompt or enabling controls", async () => {
    setConversation([message("assistant-example", "assistant", "partial", { turnId: "turn-example", isFinal: false })]);
    const fetchMock = status({ runtime: "harness_engine", status: "idle", run_id: "run-example", turn_id: "turn-example" });
    try {
      render(<ChatPanel agentId="example-agent" conversationId="chat-1" readOnly readOnlyReason="agent_unavailable" />);
      await waitFor(() => expect(mockRecoverRun).toHaveBeenCalledWith("run-example", expect.any(Object), "chat-1", "example-agent"));
      expect(mockChatState.setConversationStreaming).toHaveBeenCalledWith("chat-1", expect.objectContaining({ readOnly: true }));
      await waitFor(() => expect(mockConversation.messages[0]).toMatchObject({ isFinal: true, content: "Recovered final answer" }));
      expect(screen.queryByRole("textbox")).toBeNull();
      expect(screen.getByText("Read-only conversation")).toBeInTheDocument();
      expect(screen.getByText(/Sharing this chat does not grant access to its agent/)).toBeInTheDocument();
      expect(screen.getByText(/To reply, ask the owner to share the agent with you/)).toBeInTheDocument();
      expect(mockStreamMessage).not.toHaveBeenCalled();
    } finally { fetchMock.mockRestore(); }
  });

  it.each(["running", "idle"])("rebuilds a missing assistant from a matching %s run without sending the prompt again", async (runStatus) => {
    setConversation([message("user-example", "user", "saved prompt", { turnId: "turn-example" })]);
    const fetchMock = status({ runtime: "harness_engine", status: runStatus, run_id: "run-example", turn_id: "turn-example" });
    try {
      render(<ChatPanel agentId="example-agent" conversationId="chat-1" />);
      await waitFor(() => expect(mockRecoverRun).toHaveBeenCalledWith("run-example", expect.any(Object), "chat-1", "example-agent"));
      await waitFor(() => expect(mockConversation.messages.at(-1)).toMatchObject({ role: "assistant", turnId: "turn-example", content: "Recovered final answer", isFinal: true }));
      expect(mockStreamMessage).not.toHaveBeenCalled();
    } finally { fetchMock.mockRestore(); }
  });

  it.each([undefined, "turn-previous"])("does not attach an unrelated running turn (%s)", async (turnId) => {
    setConversation([message("user-example", "user", "saved prompt", { turnId: "turn-next" })]);
    const fetchMock = status({ runtime: "harness_engine", status: "running", run_id: "run-example", turn_id: turnId });
    try {
      render(<ChatPanel agentId="example-agent" conversationId="chat-1" />);
      await act(async () => {});
      expect(mockRecoverRun).not.toHaveBeenCalled();
      expect(mockChatState.addMessage).not.toHaveBeenCalled();
    } finally { fetchMock.mockRestore(); }
  });

  it("does not attach an earlier completed run to a later saved prompt", async () => {
    setConversation([message("user-example", "user", "unsent prompt", { turnId: "turn-next" })]);
    const fetchMock = status({ runtime: "harness_engine", status: "idle", run_id: "run-example", turn_id: "turn-previous" });
    try {
      render(<ChatPanel agentId="example-agent" conversationId="chat-1" />);
      await waitFor(() => expect(fetchMock).toHaveBeenCalledWith("/api/v1/chat/stream/status", expect.any(Object)));
      await act(async () => {});
      expect(mockRecoverRun).not.toHaveBeenCalled();
      expect(mockChatState.addMessage).not.toHaveBeenCalled();
    } finally { fetchMock.mockRestore(); }
  });

  it.each([undefined, null, "turn-other"])("does not replace an unfinished assistant with an unrelated maintenance run (%s)", async (turnId) => {
    setConversation([message("assistant-example", "assistant", "Unfinished answer", { turnId: "turn-example", isFinal: false })]);
    const fetchMock = status({ runtime: "harness_engine", status: "idle", run_id: "run-maintenance", turn_id: turnId });
    try {
      render(<ChatPanel agentId="example-agent" conversationId="chat-1" />);
      await waitFor(() => expect(fetchMock).toHaveBeenCalled());
      await act(async () => {});
      expect(mockRecoverRun).not.toHaveBeenCalled();
      expect(mockConversation.messages.at(-1)).toMatchObject({ content: "Unfinished answer", isFinal: false });
    } finally { fetchMock.mockRestore(); }
  });

  it("keeps app-owned runs in their application's lifecycle", async () => {
    setConversation([message("user-example", "user", "saved prompt")]);
    const fetchMock = status({ status: "running", run_id: "app-run" });
    try {
      render(<ChatPanel agentId="example-agent" conversationId="chat-1" />);
      await act(async () => {});
      expect(mockRecoverRun).not.toHaveBeenCalled();
      expect(mockChatState.addMessage).not.toHaveBeenCalled();
    } finally { fetchMock.mockRestore(); }
  });
});

it("starts a separate chat from the agent picker and leaves the shared source untouched", async () => {
  const original = { ...mockConversation, participants: [{ type: "agent" as const, id: "original-agent" }], sharing: { shared_with: ["viewer@example.test"] } };
  mockConversation = original;
  const fetchMock = jest.spyOn(global, "fetch").mockResolvedValue({ ok: true, json: async () => ({ success: true, data: [
    { _id: "other-agent", name: "Other Agent", enabled: true },
  ] }) } as Response);
  const update = jest.spyOn(apiClient, "updateConversation");
  try {
    render(<ChatPanel agentId="original-agent" conversationId="chat-1" readOnly readOnlyReason="agent_unavailable" />);
    fireEvent.click(screen.getByRole("button", { name: "New chat with another agent" }));
    expect(screen.getByRole("button", { name: "Start new chat" })).toBeDisabled();
    fireEvent.click(screen.getByRole("combobox"));
    fireEvent.click(await screen.findByRole("option", { name: "Other Agent" }));
    fireEvent.click(screen.getByRole("button", { name: "Start new chat" }));
    await waitFor(() => expect(mockPush).toHaveBeenCalledWith("/chat/new-chat"));
    expect(mockChatState.createConversation).toHaveBeenCalledWith("other-agent", { activate: false });
    expect(mockConversation).toBe(original);
    expect(update).not.toHaveBeenCalled();
  } finally { fetchMock.mockRestore(); update.mockRestore(); }
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

describe("authoritative completion", () => {
  it("does not label an unfinished saved response as done", () => {
    setConversation([message("user-example", "user", "example"), message("assistant-example", "assistant", "partial", { isFinal: false, turnStatus: undefined })]);
    render(<ChatPanel agentId="example-agent" conversationId="chat-1" />);
    expect(screen.getByText("Completion has not been confirmed by the server.")).toBeInTheDocument();
    expect(screen.queryByText("Response was interrupted")).not.toBeInTheDocument();
  });

  it("keeps a subscription closure interrupted without a server completion event", async () => {
    setConversation([message("user-example", "user", "example"), message("assistant-example", "assistant", "partial", { isFinal: true, isInterrupted: true })]);
    mockStreamMessage.mockResolvedValueOnce(undefined);
    render(<ChatPanel agentId="example-agent" conversationId="chat-1" />);
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(mockConversation.messages.at(-1)).toMatchObject({ turnStatus: "interrupted" }));
  });
});

describe("retry is unavailable when it would be unsafe", () => {
  it("keeps an app draft pending until the remote response releases the composer", async () => {
    mockChatState.externalActivity["chat-1"] = { agentId: "example-agent", state: "running" };
    const onApplied = jest.fn();
    const props = { agentId: "example-agent", conversationId: "chat-1",
      composerDraft: { id: "source-1", text: "Find the source" }, onComposerDraftApplied: onApplied };
    const { rerender } = render(<ChatPanel {...props} />);
    const textarea = screen.getByRole("textbox");
    expect(textarea).toBeDisabled();
    await act(async () => {});
    expect(textarea).toHaveValue("");
    expect(onApplied).not.toHaveBeenCalled();
    mockChatState.externalActivity = {};
    rerender(<ChatPanel {...props} />);
    await waitFor(() => expect(textarea).toHaveValue("Find the source"));
    expect(textarea).toHaveFocus();
    expect(onApplied).toHaveBeenCalledTimes(1);
    expect(mockStreamMessage).not.toHaveBeenCalled();
  });

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
    expect(screen.getByText("Read-only conversation")).toBeInTheDocument();
    expect(screen.getByText(/ask the owner for Can edit access to this chat/)).toBeInTheDocument();
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

const coordination = {
  agents: [{ agent_id: "helper-agent", name: "Helper agent", handle: "reviewer", added_at: "2026-01-01", added_by: "owner" }],
  primaryAgentId: "example-agent", selectedAgentId: "example-agent", availableAgents: [{ _id: "helper-agent", name: "Helper agent", enabled: true }],
  canManage: true, available: true, loading: false, error: null, selectAgent: jest.fn(), refresh: jest.fn(), addAgent: jest.fn(),
} as unknown as import("@/hooks/use-chat-coordination").ChatCoordination;

it("shows joined agents for @ and routes a pasted mention to that agent in the same chat", async () => {
  setConversation([]);
  render(<ChatPanel agentId="example-agent" conversationId="chat-1" coordination={coordination} />);
  expect(screen.queryByRole("button", { name: "Clear agent selection" })).not.toBeInTheDocument();
  const input = screen.getByRole("textbox", { name: "Message" });
  fireEvent.change(input, { target: { value: "@rev", selectionStart: 4 } });
  expect(screen.getByText("@reviewer")).toBeInTheDocument();
  fireEvent.keyDown(input, { key: "Enter" });
  expect(coordination.selectAgent).toHaveBeenCalledWith("helper-agent");
  fireEvent.change(input, { target: { value: "@reviewer Check this example", selectionStart: 28 } });
  fireEvent.keyDown(input, { key: "Enter" });
  await waitFor(() => expect(mockStreamMessage).toHaveBeenCalledWith(expect.objectContaining({ agentId: "helper-agent", conversationId: "chat-1", message: "Check this example" }), expect.anything()));
  expect(mockConversation.messages.at(-1)).toMatchObject({ agentId: "helper-agent", agentName: "Helper agent" });
  expect(mockChatState.createConversation).not.toHaveBeenCalled();
});

it("recovers the saved participant's run after refresh even when the composer selects primary", async () => {
  mockRecoverRun.mockImplementationOnce(async (_id, callbacks) => { callbacks.onContent?.("Recovered helper", []); callbacks.onDone?.(); });
  setConversation([message("pending-helper", "assistant", "partial", { agentId: "helper-agent", agentName: "Helper agent", isFinal: false, turnId: "helper-turn" })]);
  const fetchMock = jest.spyOn(global, "fetch").mockResolvedValue({ ok: true, json: async () => ({ data: { runtime: "harness_engine", status: "running", run_id: "helper-run", turn_id: "helper-turn" } }) } as Response);
  try {
    render(<ChatPanel agentId="example-agent" conversationId="chat-1" coordination={coordination} />);
    await waitFor(() => expect(mockRecoverRun).toHaveBeenCalledWith("helper-run", expect.anything(), "chat-1", "helper-agent"));
    expect(JSON.parse(fetchMock.mock.calls.find(call => String(call[0]).includes("/stream/status"))?.[1]?.body as string)).toMatchObject({ agent_id: "helper-agent" });
    expect(mockConversation.messages[0]).toMatchObject({ agentId: "helper-agent", agentName: "Helper agent", turnStatus: "done" });
  } finally { fetchMock.mockRestore(); }
});

it("keeps a queued prompt's recipient when the composer switches to another participant", async () => {
  setConversation([]);
  mockStreaming = true;
  const { rerender } = render(<ChatPanel agentId="example-agent" conversationId="chat-1" coordination={coordination} />);
  const input = screen.getByRole("textbox", { name: "Message" });
  fireEvent.change(input, { target: { value: "Queued for primary" } });
  fireEvent.keyDown(input, { key: "Enter" });
  rerender(<ChatPanel agentId="helper-agent" conversationId="chat-1" coordination={{ ...coordination, selectedAgentId: "helper-agent" }} />);
  mockStreaming = false;
  rerender(<ChatPanel agentId="helper-agent" conversationId="chat-1" coordination={{ ...coordination, selectedAgentId: "helper-agent" }} />);
  await waitFor(() => expect(mockStreamMessage).toHaveBeenCalledWith(expect.objectContaining({ agentId: "example-agent", message: "Queued for primary" }), expect.anything()));
});

describe("atomic recipient mentions", () => {
  const text = "@reviewer Keep this message";
  const selected = { ...coordination, selectedAgentId: "helper-agent" };
  it.each([
    ["Backspace", "@reviewer", 9, 9, ""],
    ["Backspace", text, 10, 10, "Keep this message"],
    ["Delete", text, 0, 0, "Keep this message"],
    ["Delete", text, 4, 4, "Keep this message"],
    ["Backspace", text, 3, 7, "Keep this message"],
    ["Delete", text, 0, text.length, ""],
  ])("removes the whole mention with %s at selection %s:%s", (key, value, start, end, expected) => {
    setConversation([]);
    render(<ChatPanel agentId="helper-agent" conversationId="chat-1" coordination={selected} />);
    const field = screen.getByRole("textbox", { name: "Message" }) as HTMLTextAreaElement;
    fireEvent.change(field, { target: { value, selectionStart: String(value).length } });
    field.setSelectionRange(Number(start), Number(end));
    expect(fireEvent.keyDown(field, { key })).toBe(false);
    expect(field).toHaveValue(expected);
    expect(coordination.selectAgent).toHaveBeenCalledWith("example-agent");
    expect(mockStreamMessage).not.toHaveBeenCalled();
  });

  it.each([
    [text, text.length, false],
    ["@outsider Keep this message", 4, false],
    [text, 4, true],
    [text, 0, false],
  ])("preserves native Backspace outside known mentions or during composition", (value, caret, isComposing) => {
    setConversation([]);
    render(<ChatPanel agentId="helper-agent" conversationId="chat-1" coordination={selected} />);
    const field = screen.getByRole("textbox", { name: "Message" }) as HTMLTextAreaElement;
    fireEvent.change(field, { target: { value, selectionStart: String(value).length } });
    field.setSelectionRange(Number(caret), Number(caret));
    expect(fireEvent.keyDown(field, { key: "Backspace", isComposing })).toBe(true);
    expect(coordination.selectAgent).not.toHaveBeenCalled();
  });
});

describe("multiple addressed agents", () => {
  it("completes a second mention at the caret without replacing the first or suffix", () => {
    setConversation([]);
    render(<ChatPanel agentId="example-agent" conversationId="chat-1" coordination={coordination} />);
    const field = screen.getByRole("textbox", { name: "Message" }) as HTMLTextAreaElement;
    fireEvent.change(field, { target: { value: "@primary @rev Check this", selectionStart: 13 } });
    fireEvent.keyDown(field, { key: "Enter" });
    expect(field).toHaveValue("@primary @reviewer  Check this");
    expect(screen.getByLabelText("Message recipients")).toHaveTextContent("@primary@reviewer");
    expect(mockStreamMessage).not.toHaveBeenCalled();
  });

  it("starts both unique recipients before either reply finishes", async () => {
    let finishFirst!: () => void;
    mockStreamMessage.mockImplementationOnce(async (_params, callbacks) => {
      await new Promise<void>(resolve => { finishFirst = resolve; });
      callbacks.onDone?.();
    });
    setConversation([]);
    render(<ChatPanel agentId="example-agent" conversationId="chat-1" coordination={coordination} />);
    const field = screen.getByRole("textbox", { name: "Message" });
    fireEvent.change(field, { target: { value: "@primary @reviewer @primary Check this example" } });
    fireEvent.keyDown(field, { key: "Enter" });
    await waitFor(() => expect(mockStreamMessage).toHaveBeenCalledTimes(2));
    expect(mockStreamMessage.mock.calls[0][0]).toMatchObject({ agentId: "example-agent", message: "Check this example", conversationId: "chat-1" });
    expect(screen.queryByText("Queued message:")).not.toBeInTheDocument();
    await act(async () => finishFirst());
    expect(mockStreamMessage.mock.calls[1][0]).toMatchObject({ agentId: "helper-agent", message: "Check this example", conversationId: "chat-1" });
    expect(mockConversation.messages.filter(message => message.role === "assistant").map(message => message.agentId)).toEqual(["example-agent", "helper-agent"]);
    expect(new Set(mockConversation.messages.filter(message => message.role === "assistant").map(message => message.turnId)).size).toBe(2);
  });

  it.each(["@outsider", "@unavailable"])("retains the draft and sends nobody if %s cannot receive it", async handle => {
    setConversation([]);
    render(<ChatPanel agentId="example-agent" conversationId="chat-1" coordination={{ ...coordination,
      agents: [...coordination.agents, { agent_id: "unavailable-agent", handle: "unavailable", name: "Unavailable", added_at: "2026-01-01", added_by: "owner" }],
    }} />);
    const field = screen.getByRole("textbox", { name: "Message" });
    const draft = `@primary ${handle} Check this example`;
    fireEvent.change(field, { target: { value: draft } });
    fireEvent.keyDown(field, { key: "Enter" });
    await act(async () => {});
    expect(field).toHaveValue(draft);
    expect(mockStreamMessage).not.toHaveBeenCalled();
    expect(mockToast).toHaveBeenCalledWith(expect.stringContaining(handle), "error", 6000);
  });

  it.each(["error", "disconnect", "cancelled"])("keeps a peer's independent reply when the first reports %s", async outcome => {
    setConversation([]);
    mockStreamMessage.mockImplementationOnce(async (_params, callbacks) => {
      if (outcome === "error") callbacks.onError?.("Provider unavailable");
      if (outcome === "cancelled") callbacks.onCancelled?.();
    });
    render(<ChatPanel agentId="example-agent" conversationId="chat-1" coordination={coordination} />);
    const field = screen.getByRole("textbox", { name: "Message" });
    fireEvent.change(field, { target: { value: "@primary @reviewer Check this example" } });
    fireEvent.keyDown(field, { key: "Enter" });
    await waitFor(() => expect(mockStreamMessage).toHaveBeenCalledTimes(2));
    expect(mockConversation.messages.filter(message => message.role === "assistant").find(message => message.agentId === "helper-agent")?.turnStatus).toBe("done");
    expect(screen.queryByText("Queued message:")).not.toBeInTheDocument();
  });

  it("continues the peer while the first agent requests input", async () => {
    setConversation([]);
    mockStreamMessage.mockImplementationOnce(async (_params, callbacks) => {
      callbacks.onInputRequired?.("example-interrupt", "Choose a value before continuing", [], "example-agent");
    });
    render(<ChatPanel agentId="example-agent" conversationId="chat-1" coordination={coordination} />);
    const field = screen.getByRole("textbox", { name: "Message" });
    fireEvent.change(field, { target: { value: "@primary @reviewer Check this example" } });
    fireEvent.keyDown(field, { key: "Enter" });
    await waitFor(() => expect(mockStreamMessage).toHaveBeenCalledTimes(2));
    expect(mockConversation.messages.find(message => message.role === "assistant" && message.agentId === "example-agent")?.turnStatus).toBe("waiting_for_input");
    expect(mockConversation.messages.find(message => message.role === "assistant" && message.agentId === "helper-agent")?.turnStatus).toBe("done");
  });

  it("deletes only the second mention as an object and preserves the first and body", () => {
    setConversation([]);
    render(<ChatPanel agentId="example-agent" conversationId="chat-1" coordination={coordination} />);
    const field = screen.getByRole("textbox", { name: "Message" }) as HTMLTextAreaElement;
    const value = "@primary @reviewer Keep this message";
    fireEvent.change(field, { target: { value, selectionStart: value.length } });
    field.setSelectionRange(14, 14);
    fireEvent.keyDown(field, { key: "Backspace" });
    expect(field).toHaveValue("@primary Keep this message");
    expect(mockStreamMessage).not.toHaveBeenCalled();
  });

  it("keeps body mentions as references rather than additional recipients", async () => {
    setConversation([]);
    render(<ChatPanel agentId="example-agent" conversationId="chat-1" coordination={coordination} />);
    const field = screen.getByRole("textbox", { name: "Message" });
    fireEvent.change(field, { target: { value: "@primary Summarize @reviewer notes" } });
    fireEvent.keyDown(field, { key: "Enter" });
    await waitFor(() => expect(mockStreamMessage).toHaveBeenCalledTimes(1));
    expect(mockStreamMessage.mock.calls[0][0]).toMatchObject({ agentId: "example-agent", message: "Summarize @reviewer notes" });
  });
});


describe("concurrent reply cards", () => {
  beforeEach(() => {
    mockChatState.addStreamEvent.mockImplementation((event, _conversationId, messageId) => {
      mockConversation.streamEvents = [...(mockConversation.streamEvents ?? []), event];
      const message = mockConversation.messages.find(message => message.id === messageId);
      if (message) message.streamEvents = [...(message.streamEvents ?? []), event];
    });
    mockChatState.setConversationStreaming.mockImplementation((id: string, stream: StreamingState | null, agentId?: string) => {
      const next = updateChatStream(mockChatState.streamingConversations.get(id), stream, agentId);
      if (next) mockChatState.streamingConversations.set(id, next);
      else mockChatState.streamingConversations.delete(id);
    });
  });
  afterEach(() => {
    mockChatState.setConversationStreaming.mockImplementation(() => undefined);
    mockChatState.addStreamEvent.mockImplementation(() => undefined);
  });

  it("renders both active cards with isolated text/events and routes Stop to one agent", async () => {
    setConversation([]);
    const finishes: Array<() => void> = [];
    mockStreamMessage.mockImplementation(async (params, callbacks) => {
      const id = (params as { agentId: string }).agentId;
      callbacks.onContent?.(id === "example-agent" ? "First live reply" : "Second live reply", []);
      callbacks.onToolStart?.(`${id}-call`, `${id}-tool`, {}, []);
      await new Promise<void>(resolve => finishes.push(resolve));
      callbacks.onDone?.();
    });
    const { rerender } = render(<ChatPanel agentId="example-agent" conversationId="chat-1" coordination={coordination} />);
    const field = screen.getByRole("textbox", { name: "Message" });
    fireEvent.change(field, { target: { value: "@primary @reviewer Check this example" } });
    fireEvent.keyDown(field, { key: "Enter" });
    await waitFor(() => expect(finishes).toHaveLength(2));
    mockStreaming = true;
    rerender(<ChatPanel agentId="example-agent" conversationId="chat-1" coordination={coordination} />);
    const primary = screen.getByRole("region", { name: "Reply from @primary" });
    const reviewer = screen.getByRole("region", { name: "Reply from @reviewer" });
    expect(within(primary).getByText("First live reply")).toBeInTheDocument();
    expect(within(primary).queryByText("Second live reply")).not.toBeInTheDocument();
    expect(within(reviewer).getByText("Second live reply")).toBeInTheDocument();
    expect(within(primary).getByRole("status")).toHaveTextContent("Responding");
    expect(within(reviewer).getByRole("status")).toHaveTextContent("Responding");
    const assistants = mockConversation.messages.filter(message => message.role === "assistant");
    expect(mockChatState.addStreamEvent).toHaveBeenCalledWith(expect.objectContaining({ type: "tool_start", toolData: expect.objectContaining({ tool_name: "example-agent-tool" }) }), "chat-1", assistants[0].id);
    expect(mockChatState.addStreamEvent).toHaveBeenCalledWith(expect.objectContaining({ type: "tool_start", toolData: expect.objectContaining({ tool_name: "helper-agent-tool" }) }), "chat-1", assistants[1].id);
    fireEvent.click(within(reviewer).getByRole("button", { name: "Stop @reviewer" }));
    expect(mockChatState.cancelConversationRequest).toHaveBeenCalledWith("chat-1", "helper-agent");
    expect(mockChatState.cancelConversationRequest).toHaveBeenCalledTimes(1);
    expect(screen.queryByText("Queued message:")).not.toBeInTheDocument();
    await act(async () => finishes.forEach(finish => finish()));
    expect(mockChatState.streamingConversations.has("chat-1")).toBe(false);
  });

  it("resumes one participant's input without blocking or replacing its streaming peer", async () => {
    setConversation([]);
    let finishPeer!: () => void;
    mockStreamMessage.mockImplementation(async (params, callbacks) => {
      if ((params as { agentId: string }).agentId === "example-agent") {
        callbacks.onInputRequired?.("example-interrupt", "Confirm the scope", [], "example-agent");
        return;
      }
      callbacks.onContent?.("Peer is still working", []);
      await new Promise<void>(resolve => { finishPeer = resolve; });
      callbacks.onDone?.();
    });
    const { rerender } = render(<ChatPanel agentId="example-agent" conversationId="chat-1" coordination={coordination} />);
    const field = screen.getByRole("textbox", { name: "Message" });
    fireEvent.change(field, { target: { value: "@primary @reviewer Check this example" } });
    fireEvent.keyDown(field, { key: "Enter" });
    await waitFor(() => expect(mockStreamMessage).toHaveBeenCalledTimes(2));
    mockStreaming = true;
    rerender(<ChatPanel agentId="example-agent" conversationId="chat-1" coordination={coordination} />);
    expect(within(screen.getByRole("region", { name: "Reply from @primary" })).getByRole("status")).toHaveTextContent("Needs your input");
    expect(screen.getByRole("button", { name: "Submit" })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "Submit" }));
    await waitFor(() => expect(mockResumeStream).toHaveBeenCalledWith(expect.objectContaining({ agentId: "example-agent", turnId: expect.any(String) }), expect.anything()));
    expect(mockChatState.streamingConversations.get("chat-1")?.agentId).toBe("helper-agent");
    await act(async () => finishPeer());
  });

  it("recovers both agent runs after refresh without submitting either prompt again", async () => {
    setConversation([
      message("first-user", "user", "Shared prompt", { agentId: "example-agent", parallelGroupId: "example-group", turnId: "first-turn" }),
      message("first-answer", "assistant", "partial first", { agentId: "example-agent", parallelGroupId: "example-group", turnId: "first-turn", isFinal: false }),
      message("second-user", "user", "Shared prompt", { agentId: "helper-agent", parallelGroupId: "example-group", turnId: "second-turn" }),
      message("second-answer", "assistant", "partial second", { agentId: "helper-agent", parallelGroupId: "example-group", turnId: "second-turn", isFinal: false }),
    ]);
    const finishes: Array<() => void> = [];
    const fetchMock = jest.spyOn(global, "fetch").mockImplementation(async (_url, options) => {
      const id = JSON.parse(String(options?.body)).agent_id;
      return { ok: true, json: async () => ({ data: { runtime: "harness_engine", status: "running", run_id: `${id}-run`, turn_id: id === "example-agent" ? "first-turn" : "second-turn" } }) } as Response;
    });
    mockRecoverRun.mockImplementation(async (id, callbacks) => {
      callbacks.onContent?.(`${id} recovered`, []);
      await new Promise<void>(resolve => finishes.push(resolve));
      callbacks.onDone?.();
    });
    try {
      const { rerender } = render(<ChatPanel agentId="example-agent" conversationId="chat-1" coordination={coordination} />);
      await waitFor(() => expect(finishes).toHaveLength(2));
      mockStreaming = true;
      rerender(<ChatPanel agentId="example-agent" conversationId="chat-1" coordination={coordination} />);
      expect(within(screen.getByRole("region", { name: "Reply from @primary" })).getByText("example-agent-run recovered")).toBeInTheDocument();
      expect(within(screen.getByRole("region", { name: "Reply from @reviewer" })).getByText("helper-agent-run recovered")).toBeInTheDocument();
      expect(mockStreamMessage).not.toHaveBeenCalled();
      expect(mockConversation.messages.filter(message => message.role === "assistant")).toHaveLength(2);
      await act(async () => finishes.forEach(finish => finish()));
    } finally { fetchMock.mockRestore(); }
  });
});

it("renders the primary's completed summary outside participant cards while retaining collaborator cards", () => {
  setConversation([
    message("helper-result", "assistant", "The helper result", { agentId: "helper-agent", parallelGroupId: "helper-group", isFinal: true, turnStatus: "done" }),
    message("primary-summary", "assistant", "The combined summary", { agentId: "example-agent", parallelGroupId: "primary-group", isFinal: true, turnStatus: "done" }),
  ]);
  render(<ChatPanel agentId="helper-agent" conversationId="chat-1" coordination={coordination} />);
  expect(screen.queryByRole("region", { name: "Reply from @primary" })).not.toBeInTheDocument();
  expect(screen.getByText("The combined summary")).toBeInTheDocument();
  expect(within(screen.getByRole("region", { name: "Reply from @reviewer" })).getByText("The helper result")).toBeInTheDocument();
});
