import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ChatMessage, Conversation } from "@/types/a2a";
import type { StreamCallbacks } from "@/lib/streaming";
import { createStreamEvent } from "@/lib/streaming/types";
import { apiClient } from "@/lib/api-client";
import { ChatPanel } from "../DynamicAgentChatPanel";

let mockConversation: Conversation;
let mockStorageMode = "localStorage";
const mockGetConversation = jest.spyOn(apiClient, "getConversation");
const mockRewindConversation = jest.spyOn(apiClient, "rewindConversation");
const mockOpenChat = jest.fn();
const mockPush = jest.fn();
jest.mock("next/navigation", () => ({ useRouter: () => ({ push: mockPush }) }));
const mockToast = jest.fn();
const mockStreamMessage = jest.fn().mockResolvedValue(undefined);
const mockResumeStream = jest.fn().mockResolvedValue(undefined);
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
  clearConversationInputRequired: jest.fn(),
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
jest.mock("@/lib/config", () => ({ getConfig: (key: string) => key === "appName" ? "Test agent" : key === "storageMode" ? mockStorageMode : false }));
jest.mock("@/components/autonomous/api", () => ({
  autonomousApi: {
    openFollowUpChat: (...args: unknown[]) => mockOpenChat(...args),
    listFollowUpChats: async () => ({}),
  },
}));
jest.mock("@/lib/streaming", () => ({
  createStreamAdapter: () => ({ streamMessage: mockStreamMessage, resumeStream: mockResumeStream, reattachStream: mockReattachStream, abort: jest.fn() }),
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

jest.mock("../MetadataInputForm", () => ({ MetadataInputForm: ({ onSubmit, onCancel }: { onSubmit: (data: Record<string, string>) => void; onCancel: () => void }) => <div><button onClick={() => onSubmit({ answer: "example" })}>Submit input</button><button onClick={onCancel}>Dismiss input</button></div> }));
jest.mock("../ToolApprovalCard", () => ({ ToolApprovalCard: ({ onApprove, onReject, onEdit }: { onApprove: () => void; onReject: () => void; onEdit: (args: Record<string, unknown>) => void }) => <div><button onClick={onApprove}>Approve tool</button><button onClick={onReject}>Reject tool</button><button onClick={() => onEdit({ path: "/logical.txt" })}>Edit tool</button></div> }));

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
  mockStorageMode = "localStorage";
  mockGetConversation.mockResolvedValue({} as Awaited<ReturnType<typeof apiClient.getConversation>>);
  mockRewindConversation.mockResolvedValue({ conversation_id: "task-chat", turn_id: "earlier-turn", removed_messages: 2, checkpoint_id: "checkpoint" });
  mockStreamMessage.mockResolvedValue(undefined);
  mockResumeStream.mockResolvedValue(undefined);
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
    { conversationId: "task-chat", agentId: "example-agent", runId: "run-1", firstSequence: undefined },
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

it.each(["Submit input", "Dismiss input"])("correlates %s with the exact pending form interrupt", async (action) => {
  mockConversation = { ...mockConversation, source: "web", task_id: undefined, messages: [] };
  mockStreamMessage.mockImplementationOnce(async (_params, callbacks: StreamCallbacks) => {
    callbacks.onInputRequired?.("input-current", "Provide input", [], "example-agent");
  });
  render(<ChatPanel agentId="example-agent" conversationId="task-chat" />);
  fireEvent.change(screen.getByPlaceholderText(/Ask anything/), { target: { value: "Continue the task" } });
  fireEvent.click(screen.getByTitle("Send message"));
  fireEvent.click(await screen.findByRole("button", { name: action }));
  await waitFor(() => expect(mockResumeStream).toHaveBeenCalledTimes(1));
  const payload = JSON.parse(mockResumeStream.mock.calls[0][0].resumeData);
  expect(payload).toEqual(action === "Submit input" ? { type: "form_input", interrupt_id: "input-current", values: { answer: "example" } } : { type: "form_input", interrupt_id: "input-current", dismissed: true });
});

it.each(["Approve tool", "Reject tool", "Edit tool"])("correlates %s with the exact pending approval", async (action) => {
  mockConversation = { ...mockConversation, source: "web", task_id: undefined, messages: [] };
  mockStreamMessage.mockImplementationOnce(async (_params, callbacks: StreamCallbacks) => {
    callbacks.onToolApprovalRequired?.("approval-current", "read_file", {}, ["approve", "reject", "edit"], "example-agent");
  });
  render(<ChatPanel agentId="example-agent" conversationId="task-chat" />);
  fireEvent.change(screen.getByPlaceholderText(/Ask anything/), { target: { value: "Continue the task" } });
  fireEvent.click(screen.getByTitle("Send message"));
  fireEvent.click(await screen.findByRole("button", { name: action }));
  await waitFor(() => expect(mockResumeStream).toHaveBeenCalledTimes(1));
  const payload = JSON.parse(mockResumeStream.mock.calls[0][0].resumeData);
  expect(payload).toMatchObject({ type: "tool_approval", interrupt_id: "approval-current", decision: action === "Approve tool" ? "approve" : action === "Reject tool" ? "reject" : "edit" });
});

it("binds batched decisions to their pending approval without an early resume", async () => {
  mockConversation = { ...mockConversation, source: "web", task_id: undefined, messages: [] };
  mockStreamMessage.mockImplementationOnce(async (_params, callbacks: StreamCallbacks) => {
    callbacks.onToolApprovalRequired?.("approval-batch", "read_file", {}, ["approve", "reject"], "example-agent", [
      { tool_name: "read_file", tool_args: {}, tool_call_id: "tool-1", allowed_decisions: ["approve", "reject"] },
      { tool_name: "write_file", tool_args: {}, tool_call_id: "tool-2", allowed_decisions: ["approve", "reject"] },
    ]);
  });
  render(<ChatPanel agentId="example-agent" conversationId="task-chat" />);
  fireEvent.change(screen.getByPlaceholderText(/Ask anything/), { target: { value: "Continue the task" } });
  fireEvent.click(screen.getByTitle("Send message"));
  fireEvent.click(await screen.findByRole("button", { name: "Reject tool" }));
  expect(mockResumeStream).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Approve tool" }));
  await waitFor(() => expect(mockResumeStream).toHaveBeenCalledTimes(1));
  expect(JSON.parse(mockResumeStream.mock.calls[0][0].resumeData)).toEqual({ type: "tool_approval", interrupt_id: "approval-batch", decisions: [{ decision: "reject" }, { decision: "approve" }] });
});

const sandboxAgent = {
  _id: "example-agent", name: "Example", system_prompt: "Use permitted tools", execution: { kind: "sandbox", profile_id: "primary" },
  model: { id: "retained-native-model", provider: "example", reasoning_effort: "high" }, allowed_tools: {}, subagents: [], skills: [], enabled: true,
} as import("@/types/dynamic-agent").DynamicAgentConfig;

it.each([false, true])('offers durable history editing for either runtime (sandbox=%s)', (sandbox) => {
  mockConversation = { ...mockConversation, source: 'web', task_id: undefined, messages: [{
    id: 'editable-user', role: 'user', content: 'Earlier question', turnId: 'earlier-turn', timestamp: new Date(),
  }] };
  render(<ChatPanel agent={sandbox ? sandboxAgent : { ...sandboxAgent, execution: { kind: 'native' } }} agentId="example-agent" conversationId="task-chat" />);
  expect(screen.getByRole('button', { name: 'Edit message' })).toBeInTheDocument();
});

it.each(["start", "form", "tool"])("does not use a retained native model for sandbox %s requests", async (action) => {
  mockConversation = { ...mockConversation, source: "web", task_id: undefined, messages: [] };
  global.fetch = jest.fn().mockResolvedValue({ ok: true, json: async () => ({ reasoning_efforts: ["high"] }) });
  mockStreamMessage.mockImplementationOnce(async (_params, callbacks: StreamCallbacks) => {
    if (action === "form") callbacks.onInputRequired?.("input-current", "Provide input", [], "example-agent");
    if (action === "tool") callbacks.onToolApprovalRequired?.("approval-current", "read_file", {}, ["reject"], "example-agent");
  });
  render(<ChatPanel agent={sandboxAgent} agentId="example-agent" conversationId="task-chat" />);
  expect(screen.getByTestId("composer-model-effort")).toHaveTextContent("Sandbox · primary");
  expect(screen.getByTestId("composer-model-effort")).not.toHaveTextContent("retained-native-model");
  fireEvent.change(screen.getByPlaceholderText(/Ask anything/), { target: { value: "Continue the task" } });
  fireEvent.click(screen.getByTitle("Send message"));
  await waitFor(() => expect(mockStreamMessage).toHaveBeenCalledTimes(1));
  expect(mockStreamMessage.mock.calls[0][0].reasoningEffort).toBeUndefined();
  if (action !== "start") {
    fireEvent.click(await screen.findByRole("button", { name: action === "form" ? "Submit input" : "Reject tool" }));
    await waitFor(() => expect(mockResumeStream).toHaveBeenCalledTimes(1));
    expect(mockResumeStream.mock.calls[0][0].reasoningEffort).toBeUndefined();
  }
  expect((global.fetch as jest.Mock).mock.calls.some(([url]) => String(url).includes("model-capabilities"))).toBe(false);
});

it("explains that sandbox reasoning belongs to the profile instead of persisting a native override", async () => {
  mockConversation = { ...mockConversation, source: "web", task_id: undefined, messages: [] };
  render(<ChatPanel agent={sandboxAgent} agentId="example-agent" conversationId="task-chat" />);
  fireEvent.change(screen.getByPlaceholderText(/Ask anything/), { target: { value: "/effort high" } });
  fireEvent.click(screen.getByTitle("Send message"));
  expect(await screen.findByText("Reasoning is managed by the sandbox runtime profile.")).toBeInTheDocument();
  expect(mockStreamMessage).not.toHaveBeenCalled();
  expect(mockResumeStream).not.toHaveBeenCalled();
});


it("recovers an unfinished edit after refresh when its original message is already absent", async () => {
  mockStorageMode = "mongodb";
  mockConversation = { ...mockConversation, source: "web", task_id: undefined, messages: [] };
  mockGetConversation.mockResolvedValue({ pending_edit: { agent_id: "example-agent", message_id: "removed-message", phase: "history_applied" } } as Awaited<ReturnType<typeof apiClient.getConversation>>);
  render(<ChatPanel agent={sandboxAgent} agentId="example-agent" conversationId="task-chat" />);
  const button = await screen.findByRole("button", { name: "Finish conversation edit" });
  expect(screen.getByRole("textbox", { name: "Message" })).toBeDisabled();
  fireEvent.click(button);
  await waitFor(() => expect(mockRewindConversation).toHaveBeenCalledWith("task-chat", { agent_id: "example-agent", message_id: "removed-message" }));
  expect(mockChatState.loadMessagesFromServer).toHaveBeenCalledWith("task-chat", { force: true });
  await waitFor(() => expect(screen.queryByRole("button", { name: "Finish conversation edit" })).toBeNull());
  expect(screen.getByRole("textbox", { name: "Message" })).toBeEnabled();
  expect(mockStreamMessage).not.toHaveBeenCalled();
});

it("keeps edit recovery available after a failed acknowledgement and succeeds on retry", async () => {
  mockStorageMode = "mongodb";
  mockConversation = { ...mockConversation, source: "web", task_id: undefined, messages: [] };
  mockGetConversation.mockResolvedValue({ pending_edit: { agent_id: "example-agent", message_id: "removed-message", phase: "history_applied" } } as Awaited<ReturnType<typeof apiClient.getConversation>>);
  mockRewindConversation.mockRejectedValueOnce(new Error("Confirmation is pending"));
  render(<ChatPanel agent={sandboxAgent} agentId="example-agent" conversationId="task-chat" />);
  fireEvent.click(await screen.findByRole("button", { name: "Finish conversation edit" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("Confirmation is pending");
  expect(screen.getByRole("textbox", { name: "Message" })).toBeDisabled();
  fireEvent.click(screen.getByRole("button", { name: "Finish conversation edit" }));
  await waitFor(() => expect(mockRewindConversation).toHaveBeenCalledTimes(2));
  await waitFor(() => expect(screen.queryByRole("button", { name: "Finish conversation edit" })).toBeNull());
  expect(mockStreamMessage).not.toHaveBeenCalled();
});

it("does not fetch or offer private edit recovery in a shared read-only view", async () => {
  mockStorageMode = "mongodb";
  mockConversation = { ...mockConversation, source: "web", task_id: undefined, messages: [] };
  render(<ChatPanel agent={sandboxAgent} agentId="example-agent" conversationId="task-chat" readOnly readOnlyReason="shared_readonly" />);
  expect(mockGetConversation).not.toHaveBeenCalled();
  expect(screen.queryByRole("button", { name: "Finish conversation edit" })).toBeNull();
});
