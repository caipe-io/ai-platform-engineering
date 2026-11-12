import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { StreamCallbacks } from "@/lib/streaming/callbacks";
import { apiClient, APIClientError } from "@/lib/api-client";
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
      await waitFor(() => expect(mockRecoverRun).toHaveBeenCalledWith("run-example", expect.any(Object), "chat-1"));
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
      await waitFor(() => expect(mockRecoverRun).toHaveBeenCalledWith("run-example", expect.any(Object), "chat-1"));
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

describe("durable turn admission", () => {
  it.each(["resolve", "reject"])("does not dispatch after Stop during a save that will %s", async outcome => {
    let finishSave!: () => void;
    mockChatState.saveMessagesToServer.mockImplementationOnce(() => new Promise<void>((resolve, reject) => {
      finishSave = () => outcome === "resolve" ? resolve() : reject(new Error("Delayed save failed"));
    }));
    const { rerender } = render(<ChatPanel agentId="example-agent" conversationId="chat-1" />);
    fireEvent.click(screen.getAllByRole("button", { name: "Retry this prompt" })[0]);
    await waitFor(() => expect(mockChatState.saveMessagesToServer).toHaveBeenCalled());
    const pending = mockConversation.messages.at(-1)!;
    mockStreaming = true;
    rerender(<ChatPanel agentId="example-agent" conversationId="chat-1" />);
    mockChatState.cancelConversationRequest.mockImplementationOnce(id => {
      mockChatState.streamingConversations.delete(id);
    });
    fireEvent.click(screen.getByRole("button", { name: "Stop generating" }));
    expect(mockChatState.cancelConversationRequest).toHaveBeenCalledWith("chat-1");
    await act(async () => { finishSave(); });
    expect(mockStreamMessage).not.toHaveBeenCalled();
    expect(pending).toMatchObject({ isFinal: true, turnStatus: "cancelled" });
    expect(mockChatState.appendToMessage).not.toHaveBeenCalled();
  });

  it.each(["resolve", "reject"])("preserves a newer turn when an older save will %s", async outcome => {
    let finishSave!: () => void;
    mockChatState.saveMessagesToServer.mockImplementationOnce(() => new Promise<void>((resolve, reject) => {
      finishSave = () => outcome === "resolve" ? resolve() : reject(new Error("Delayed save failed"));
    }));
    render(<ChatPanel agentId="example-agent" conversationId="chat-1" />);
    fireEvent.click(screen.getAllByRole("button", { name: "Retry this prompt" })[0]);
    await waitFor(() => expect(mockChatState.saveMessagesToServer).toHaveBeenCalled());
    const pending = mockConversation.messages.at(-1)!;
    const newer = { messageId: "newer-answer", streamAdapter: {} };
    mockChatState.streamingConversations.set("chat-1", newer);
    await act(async () => { finishSave(); });
    expect(mockStreamMessage).not.toHaveBeenCalled();
    expect(pending).toMatchObject({ isFinal: true, turnStatus: "cancelled" });
    expect(mockChatState.streamingConversations.get("chat-1")).toBe(newer);
    expect(mockChatState.setConversationStreaming).not.toHaveBeenCalledWith("chat-1", null);
  });

  it("does not dispatch while its registration is marked stopping", async () => {
    let finishSave!: () => void;
    mockChatState.saveMessagesToServer.mockImplementationOnce(() => new Promise<void>(resolve => { finishSave = resolve; }));
    render(<ChatPanel agentId="example-agent" conversationId="chat-1" />);
    fireEvent.click(screen.getAllByRole("button", { name: "Retry this prompt" })[0]);
    await waitFor(() => expect(mockChatState.saveMessagesToServer).toHaveBeenCalled());
    mockChatState.streamingConversations.get("chat-1").stopping = true;
    await act(async () => { finishSave(); });
    expect(mockStreamMessage).not.toHaveBeenCalled();
    expect(mockConversation.messages.at(-1)).toMatchObject({ isFinal: true, turnStatus: "cancelled" });
    expect(mockChatState.streamingConversations.has("chat-1")).toBe(false);
  });

  it.each([
    { status: 401, reason: "session_expired", action: "sign_in", title: "Session expired" },
    { status: 403, reason: "missing_role", action: "contact_admin", title: "Access denied" },
    { status: 503, reason: "pdp_unavailable", action: "retry", title: "Authorization service unavailable" },
  ] as const)("uses auth recovery for a $status prompt-save failure", async ({ status, reason, action, title }) => {
    jest.useFakeTimers();
    try {
      mockChatState.saveMessagesToServer.mockRejectedValueOnce(new APIClientError("Save authorization failed", status, "EXAMPLE_AUTH_CODE", reason, action));
      render(<ChatPanel agentId="example-agent" conversationId="chat-1" />);
      fireEvent.click(screen.getAllByRole("button", { name: "Retry this prompt" })[0]);
      await waitFor(() => expect(mockToast).toHaveBeenCalledWith(`${title}\nSave authorization failed`, "error", 8000));
      expect(mockChatState.appendToMessage).not.toHaveBeenCalled();
      expect(mockStreamMessage).not.toHaveBeenCalled();
      expect(mockConversation.messages.at(-1)).toMatchObject({ turnStatus: "interrupted" });
      if (action === "sign_in") expect(mockConversation.messages.at(-1)?.error).toBe(reason);
      act(() => jest.advanceTimersByTime(1500));
      if (action === "sign_in") expect(mockSignIn).toHaveBeenCalledWith(undefined, { callbackUrl: window.location.href });
      else expect(mockSignIn).not.toHaveBeenCalled();
    } finally { jest.useRealTimers(); }
  });

  it("waits for the prompt save before starting detached execution", async () => {
    let finishSave!: () => void;
    mockChatState.saveMessagesToServer.mockImplementationOnce(() => new Promise<void>(resolve => { finishSave = resolve; }));
    render(<ChatPanel agentId="example-agent" conversationId="chat-1" />);
    fireEvent.click(screen.getAllByRole("button", { name: "Retry this prompt" })[0]);
    await waitFor(() => expect(mockChatState.saveMessagesToServer).toHaveBeenCalledWith("chat-1", {
      skipNonFinal: true, requireSuccess: true,
    }));
    expect(mockStreamMessage).not.toHaveBeenCalled();
    await act(async () => { finishSave(); });
    await waitFor(() => expect(mockStreamMessage).toHaveBeenCalledTimes(1));
  });

  it("does not start a detached run when the prompt cannot be saved", async () => {
    mockChatState.saveMessagesToServer.mockRejectedValueOnce(new Error("Durable write failed"));
    render(<ChatPanel agentId="example-agent" conversationId="chat-1" />);
    fireEvent.click(screen.getAllByRole("button", { name: "Retry this prompt" })[0]);
    await waitFor(() => expect(mockChatState.updateMessage).toHaveBeenCalledWith("chat-1", expect.any(String),
      expect.objectContaining({ turnStatus: "interrupted" })));
    expect(mockChatState.appendToMessage).toHaveBeenCalledWith("chat-1", expect.any(String),
      expect.stringContaining("Durable write failed"));
    expect(mockStreamMessage).not.toHaveBeenCalled();
    expect(mockChatState.setConversationStreaming).toHaveBeenLastCalledWith("chat-1", null);
  });
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
