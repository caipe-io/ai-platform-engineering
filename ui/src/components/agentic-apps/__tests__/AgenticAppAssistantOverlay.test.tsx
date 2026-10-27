import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";

import { useChatStore } from "@/store/chat-store";
import type { Conversation } from "@/types/a2a";

import { AgenticAppAssistantOverlay } from "../AgenticAppAssistantOverlay";

const mockCreateConversation = jest.fn();
const mockDeleteConversation = jest.fn();
const mockLoadConversationsFromServer = jest.fn();
const mockLoadMessagesFromServer = jest.fn();
const mockSetActiveConversation = jest.fn();
const mockFindConversation = jest.fn();
const mockRestoreConversation = jest.fn();
jest.mock("next/navigation", () => ({ useSearchParams: () => new URLSearchParams(window.location.search) }));
jest.mock("@/native-extensions/host-chat", () => ({ loadHostConversation: (...args: unknown[]) => mockRestoreConversation(...args) }));
jest.mock("@/lib/agentic-apps/assistant-conversations", () => ({
  ...jest.requireActual("@/lib/agentic-apps/assistant-conversations"),
  findLatestAppConversation: (...args: unknown[]) => mockFindConversation(...args),
}));
const mockChatStoreState: {
  activeConversationId: string | null;
  conversations: Conversation[];
  createConversation: typeof mockCreateConversation;
  deleteConversation: typeof mockDeleteConversation;
  loadConversationsFromServer: typeof mockLoadConversationsFromServer;
  loadMessagesFromServer: typeof mockLoadMessagesFromServer;
  setActiveConversation: typeof mockSetActiveConversation;
} = {
  activeConversationId: "previous-conversation",
  conversations: [],
  createConversation: mockCreateConversation,
  deleteConversation: mockDeleteConversation,
  loadConversationsFromServer: mockLoadConversationsFromServer,
  loadMessagesFromServer: mockLoadMessagesFromServer,
  setActiveConversation: mockSetActiveConversation,
};

jest.mock("@/store/chat-store", () => ({ useChatStore: jest.fn() }));

jest.mock("@/components/chat/DynamicAgentChatPanel", () => ({
  ChatPanel: ({
    conversationId,
    agentId,
    clientContext,
    readOnly,
  }: {
    conversationId?: string;
    agentId: string;
    clientContext?: Record<string, unknown>;
    readOnly?: boolean;
  }) => (
    <div
      data-testid="chat-panel"
      data-conversation-id={conversationId}
      data-agent-id={agentId}
      data-context={JSON.stringify(clientContext ?? {})}
      data-read-only={String(Boolean(readOnly))}
    />
  ),
}));

describe("AgenticAppAssistantOverlay", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    window.localStorage.clear();
    window.history.replaceState(null, "", "/");
    mockChatStoreState.activeConversationId = "previous-conversation";
    mockChatStoreState.conversations = [];
    mockCreateConversation.mockResolvedValue("assistant-conversation");
    mockDeleteConversation.mockResolvedValue(undefined);
    mockLoadConversationsFromServer.mockResolvedValue(undefined);
    mockLoadMessagesFromServer.mockResolvedValue(undefined);
    mockSetActiveConversation.mockImplementation((id) => { mockChatStoreState.activeConversationId = id; });
    mockFindConversation.mockImplementation(async () => mockChatStoreState.conversations.at(-1) ?? null);
    mockRestoreConversation.mockImplementation(async (appId: string, agentId: string, id: string) => ({ saved: {
      _id: id, title: "Saved app chat", access_level: "owner", participants: [{ type: "agent", id: agentId }],
      created_at: new Date("2026-01-01"), updated_at: new Date("2026-01-01"),
      metadata: { conversation_surface: "agentic-app", agentic_app_id: appId, agentic_app_agent_id: agentId },
    } }));
    const mockUseChatStore = useChatStore as unknown as jest.Mock & {
      getState: () => typeof mockChatStoreState;
    };
    mockUseChatStore.mockImplementation(
      (selector: (state: typeof mockChatStoreState) => unknown) => selector(mockChatStoreState),
    );
    mockUseChatStore.getState = () => mockChatStoreState;
    Object.assign(mockUseChatStore, { setState: jest.fn((update: (state: typeof mockChatStoreState) => object) =>
      Object.assign(mockChatStoreState, update(mockChatStoreState))) });
  });

  afterEach(() => jest.restoreAllMocks());

  it("renders a floating launcher and opens an isolated glass chat panel", async () => {
    const onOpenChange = jest.fn();
    const { rerender } = render(
      <AgenticAppAssistantOverlay
        appId="example-app"
        appName="Example App"
        activeContext={null}
        onClearContext={jest.fn()}
        assistantAgentId="agent-example"
        open={false}
        onOpenChange={onOpenChange}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Open Ask CAIPE" }));
    expect(onOpenChange).toHaveBeenCalledWith(true);

    rerender(
      <AgenticAppAssistantOverlay
        appId="example-app"
        appName="Example App"
        assistantLabel="Ask Example"
        assistantAgentName="Example Assistant"
        activeContext={null}
        onClearContext={jest.fn()}
        assistantAgentId="agent-example"
        open
        onOpenChange={onOpenChange}
      />,
    );

    expect(screen.getByRole("dialog", { name: "Example Assistant" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Disable translucent assistant mode" }))
      .toHaveAttribute("aria-pressed", "true");
    expect(screen.getByText("Starting Ask Example…")).toBeInTheDocument();
    await waitFor(() => {
      expect(mockCreateConversation).toHaveBeenCalledWith("agent-example", {
        activate: false,
        title: "Example App Assistant",
        metadata: {
          conversation_surface: "agentic-app",
          agentic_app_id: "example-app",
          agentic_app_agent_id: "agent-example",
        },
      });
    });
    const chat = await screen.findByTestId("chat-panel");
    expect(chat).toHaveAttribute("data-conversation-id", "assistant-conversation");
    expect(chat).toHaveAttribute("data-agent-id", "agent-example");
  });

  it("dismisses display settings on the first Escape and the assistant on the next", async () => {
    const onOpenChange = jest.fn();
    render(<AgenticAppAssistantOverlay appId="example-app" appName="Example App" assistantAgentId="agent-example"
      activeContext={null} onClearContext={jest.fn()} open onOpenChange={onOpenChange} />);
    await screen.findByTestId("chat-panel");
    fireEvent.click(screen.getByRole("button", { name: "Assistant display settings" }));
    await screen.findByLabelText("Assistant text size");
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByLabelText("Assistant text size")).toBeNull();
    expect(onOpenChange).not.toHaveBeenCalled();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("retains server ownership and read-only access when restoring a shared deep link", async () => {
    const restore = mockRestoreConversation.getMockImplementation()!;
    mockRestoreConversation.mockImplementationOnce(async (...args: unknown[]) => {
      const result = await restore(...args);
      return { saved: { ...result.saved, owner_id: "owner@example.test", access_level: "shared_readonly" } };
    });
    window.history.replaceState(null, "", "/example?assistant_chat=shared-chat");
    renderExampleOverlay();
    expect(await screen.findByTestId("chat-panel")).toHaveAttribute("data-read-only", "true");
    expect(mockChatStoreState.conversations.find(item => item.id === "shared-chat"))
      .toMatchObject({ owner_id: "owner@example.test", accessLevel: "shared_readonly" });
  });

  it("keeps display settings closed when reopening the assistant", async () => {
    const props = { appId: "example-app", appName: "Example App", assistantAgentId: "agent-example",
      activeContext: null, onClearContext: jest.fn(), onOpenChange: jest.fn() };
    const { rerender } = render(<AgenticAppAssistantOverlay {...props} open />);
    await screen.findByTestId("chat-panel");
    fireEvent.click(screen.getByRole("button", { name: "Assistant display settings" }));
    await screen.findByLabelText("Assistant text size");
    await act(async () => rerender(<AgenticAppAssistantOverlay {...props} open={false} />));
    rerender(<AgenticAppAssistantOverlay {...props} open />);
    await screen.findByTestId("chat-panel");
    expect(screen.queryByLabelText("Assistant text size")).toBeNull();
  });

  it.each([undefined, { agentic_app_id: "secondary-app" }, { agentic_app_id: "example-app" }])(
    "rejects deep links without a complete matching app binding: %j", async metadata => {
      window.history.replaceState(null, "", "/example?assistant_chat=other-chat");
      mockRestoreConversation.mockResolvedValue({ saved: { _id: "other-chat", metadata,
        participants: [{ type: "agent", id: "agent-example" }] } });
      renderExampleOverlay();
      expect(await screen.findByRole("alert")).toHaveTextContent("not bound to this app");
      expect(screen.queryByTestId("chat-panel")).toBeNull();
      expect(useChatStore.setState).not.toHaveBeenCalled();
      expect(mockSetActiveConversation).not.toHaveBeenCalled();
      expect(mockCreateConversation).not.toHaveBeenCalled();
    },
  );

  it("restores a changed deep link while mounted and hides the old chat during validation", async () => {
    window.history.replaceState(null, "", "/example?assistant_chat=chat-a");
    const view = renderExampleOverlay();
    await waitFor(() => expect(screen.getByTestId("chat-panel")).toHaveAttribute("data-conversation-id", "chat-a"));
    const restore = mockRestoreConversation.getMockImplementation()!;
    let finish!: () => void;
    mockRestoreConversation.mockImplementationOnce((...args: unknown[]) => new Promise(resolve => {
      finish = () => { void restore(...args).then(resolve); };
    }));
    window.history.pushState(null, "", "/example?assistant_chat=chat-b");
    view.rerender(exampleOverlay());
    expect(screen.queryByTestId("chat-panel")).toBeNull();
    expect(screen.getByRole("button", { name: "Clear assistant chat" })).toBeDisabled();
    await act(async () => { finish(); });
    await waitFor(() => expect(screen.getByTestId("chat-panel")).toHaveAttribute("data-conversation-id", "chat-b"));
    expect(mockCreateConversation).not.toHaveBeenCalled();
  });

  it("reports a denied changed deep link without showing the previous chat, then accepts another link", async () => {
    window.history.replaceState(null, "", "/example?assistant_chat=chat-a");
    const view = renderExampleOverlay();
    await screen.findByTestId("chat-panel");
    mockRestoreConversation.mockRejectedValueOnce(new Error("Conversation access denied"));
    window.history.pushState(null, "", "/example?assistant_chat=denied-chat");
    view.rerender(exampleOverlay());
    expect(await screen.findByRole("alert")).toHaveTextContent("access denied");
    expect(screen.queryByTestId("chat-panel")).toBeNull();
    window.history.pushState(null, "", "/example?assistant_chat=chat-c");
    view.rerender(exampleOverlay());
    await waitFor(() => expect(screen.getByTestId("chat-panel")).toHaveAttribute("data-conversation-id", "chat-c"));
    expect(mockCreateConversation).not.toHaveBeenCalled();
  });

  it("ignores a late restoration after navigation selects a newer deep link", async () => {
    const restore = mockRestoreConversation.getMockImplementation()!;
    let finish!: () => void;
    mockRestoreConversation.mockImplementationOnce((...args: unknown[]) => new Promise(resolve => {
      finish = () => { void restore(...args).then(resolve); };
    }));
    window.history.replaceState(null, "", "/example?assistant_chat=chat-a");
    const view = renderExampleOverlay();
    window.history.pushState(null, "", "/example?assistant_chat=chat-b");
    view.rerender(exampleOverlay());
    await waitFor(() => expect(screen.getByTestId("chat-panel")).toHaveAttribute("data-conversation-id", "chat-b"));
    await act(async () => { finish(); });
    expect(screen.getByTestId("chat-panel")).toHaveAttribute("data-conversation-id", "chat-b");
    expect(mockChatStoreState.activeConversationId).toBe("chat-b");
  });

  it("clears a failed deep-link error when a valid history selection succeeds", async () => {
    window.history.replaceState(null, "", "/example?assistant_chat=denied-chat");
    const history = makeConversation("history-chat", "2026-01-01");
    history.messages.push({ id: "example-message", role: "user", content: "Example question", timestamp: new Date("2026-01-01") });
    mockChatStoreState.conversations = [history];
    mockRestoreConversation.mockRejectedValueOnce(new Error("Access denied"));
    renderExampleOverlay();
    await screen.findByRole("alert");
    fireEvent.click(screen.getByRole("button", { name: "History" }));
    fireEvent.click(await screen.findByRole("button", { name: "Example App Assistant" }));
    await waitFor(() => expect(screen.getByTestId("chat-panel")).toHaveAttribute("data-conversation-id", "history-chat"));
    expect(screen.queryByText("Access denied")).toBeNull();
  });

  it("revalidates changed legacy aliases and hides the selected chat for conflicting links", async () => {
    const overlay = () => <AgenticAppAssistantOverlay appId="example-app" appName="Example App"
      assistantAgentId="agent-example" activeContext={null} onClearContext={jest.fn()} open onOpenChange={jest.fn()}
      options={{ version: "1.0", legacyConversationQueryParams: ["legacy_chat"] }} />;
    window.history.replaceState(null, "", "/example?legacy_chat=chat-a");
    const view = render(overlay());
    await waitFor(() => expect(screen.getByTestId("chat-panel")).toHaveAttribute("data-conversation-id", "chat-a"));
    expect(window.location.search).toBe("?assistant_chat=chat-a");
    window.history.pushState(null, "", "/example?legacy_chat=chat-b");
    view.rerender(overlay());
    await waitFor(() => expect(screen.getByTestId("chat-panel")).toHaveAttribute("data-conversation-id", "chat-b"));
    window.history.pushState(null, "", "/example?assistant_chat=chat-a&legacy_chat=chat-b");
    view.rerender(overlay());
    expect(await screen.findByRole("alert")).toHaveTextContent("conflicting assistant conversation link");
    expect(screen.queryByTestId("chat-panel")).toBeNull();
    expect(mockCreateConversation).not.toHaveBeenCalled();
  });

  it("passes validated app context into the chat panel and restores the prior chat", async () => {
    const { unmount } = render(
      <AgenticAppAssistantOverlay
        appId="example-app"
        appName="Example App"
        activeContext={{
          contextId: "context-1",
          appId: "example-app",
          sessionId: "browser-session",
          schemaVersion: "1.0",
          route: "/reports",
          payloadSizeBytes: 100,
          validationStatus: "accepted",
          createdAt: "2026-01-01T00:00:00.000Z",
          expiresAt: "2026-01-01T00:10:00.000Z",
          title: "Current report",
        }}
        onClearContext={jest.fn()}
        assistantAgentId="agent-example"
        open
        onOpenChange={jest.fn()}
      />,
    );

    expect(await screen.findByTestId("chat-panel")).toHaveAttribute(
      "data-context",
      expect.stringContaining('"appId":"example-app"'),
    );
    expect(screen.getByText("Current report")).toBeInTheDocument();

    unmount();
    await waitFor(() => {
      expect(mockSetActiveConversation).toHaveBeenCalledWith("previous-conversation");
    });
  });

  it("restores the latest matching app conversation from chat history", async () => {
    mockChatStoreState.conversations = [
      makeConversation("older", "2026-01-01T00:00:00.000Z"),
      makeConversation("latest", "2026-02-01T00:00:00.000Z"),
    ];

    renderExampleOverlay();

    expect(await screen.findByTestId("chat-panel")).toHaveAttribute(
      "data-conversation-id",
      "latest",
    );
    expect(mockCreateConversation).not.toHaveBeenCalled();
    expect(mockLoadMessagesFromServer).toHaveBeenCalledWith("latest", { force: true });
  });

  it("unmounts a deleted chat and shows replacement failure, then retries safely", async () => {
    jest.spyOn(window, "confirm").mockReturnValue(true);
    mockCreateConversation.mockResolvedValueOnce("assistant-conversation").mockRejectedValueOnce(new Error("Replacement unavailable"));
    mockDeleteConversation.mockImplementation(async () => { mockChatStoreState.activeConversationId = null; });
    renderExampleOverlay(); await screen.findByTestId("chat-panel");
    fireEvent.click(screen.getByRole("button", { name: "Clear assistant chat" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Replacement unavailable");
    expect(screen.queryByTestId("chat-panel")).toBeNull();
    mockCreateConversation.mockResolvedValueOnce("replacement-chat");
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(screen.getByTestId("chat-panel")).toHaveAttribute("data-conversation-id", "replacement-chat"));
  });

  it("shows a failed New chat action instead of silently leaving the old panel", async () => {
    mockCreateConversation.mockResolvedValueOnce("assistant-conversation").mockRejectedValueOnce(new Error("New chat unavailable"));
    renderExampleOverlay(); await screen.findByTestId("chat-panel");
    fireEvent.click(screen.getByRole("button", { name: "Start new assistant chat" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("New chat unavailable");
    expect(screen.queryByTestId("chat-panel")).toBeNull();
  });

  it("starts a new chat while retaining the prior conversation in history", async () => {
    mockCreateConversation
      .mockResolvedValueOnce("assistant-conversation")
      .mockResolvedValueOnce("new-assistant-conversation");
    renderExampleOverlay();
    await screen.findByTestId("chat-panel");

    fireEvent.click(screen.getByRole("button", { name: "Start new assistant chat" }));

    await waitFor(() => {
      expect(screen.getByTestId("chat-panel")).toHaveAttribute(
        "data-conversation-id",
        "new-assistant-conversation",
      );
    });
    expect(mockDeleteConversation).not.toHaveBeenCalled();
  });

  it("moves a cleared chat to Trash before starting a replacement", async () => {
    jest.spyOn(window, "confirm").mockReturnValue(true);
    mockCreateConversation
      .mockResolvedValueOnce("assistant-conversation")
      .mockResolvedValueOnce("replacement-conversation");
    renderExampleOverlay();
    await screen.findByTestId("chat-panel");

    fireEvent.click(screen.getByRole("button", { name: "Clear assistant chat" }));

    await waitFor(() => {
      expect(mockDeleteConversation).toHaveBeenCalledWith("assistant-conversation", { selectNext: false });
      expect(screen.getByTestId("chat-panel")).toHaveAttribute(
        "data-conversation-id",
        "replacement-conversation",
      );
    });
  });
  it.each(["initialization", "new", "clear"])("does not steal selection after close during %s", async (operation) => {
    let finish: (id: string) => void = () => undefined;
    const pending = new Promise<string>((resolve) => { finish = resolve; });
    const props = {
      appId: "example-app", appName: "Example App", activeContext: null,
      onClearContext: jest.fn(), assistantAgentId: "agent-example", onOpenChange: jest.fn(),
    };
    if (operation === "initialization") mockCreateConversation.mockReturnValueOnce(pending);
    const { rerender } = render(<AgenticAppAssistantOverlay {...props} open />);
    if (operation === "initialization") {
      expect(screen.getByRole("button", { name: "Start new assistant chat" })).toBeDisabled();
      expect(screen.getByRole("button", { name: "Clear assistant chat" })).toBeDisabled();
    }
    if (operation !== "initialization") {
      await screen.findByTestId("chat-panel");
      mockCreateConversation.mockReturnValueOnce(pending);
      jest.spyOn(window, "confirm").mockReturnValue(true);
      fireEvent.click(screen.getByRole("button", { name: operation === "new" ? "Start new assistant chat" : "Clear assistant chat" }));
    }
    await act(async () => { await Promise.resolve(); });
    rerender(<AgenticAppAssistantOverlay {...props} open={false} />);
    mockChatStoreState.activeConversationId = "user-selected-chat";
    mockSetActiveConversation.mockClear();
    await act(async () => { finish("late-assistant-chat"); });
    expect(mockSetActiveConversation).not.toHaveBeenCalled();
    expect(mockChatStoreState.activeConversationId).toBe("user-selected-chat");
  });

  it("does not reuse another app's conversation when both apps share an agent", async () => {
    const props = {
      appName: "Example App", activeContext: null, onClearContext: jest.fn(),
      assistantAgentId: "agent-example", onOpenChange: jest.fn(), open: true,
    };
    mockCreateConversation.mockResolvedValueOnce("first-app-chat").mockResolvedValueOnce("second-app-chat");
    const { rerender } = render(<AgenticAppAssistantOverlay {...props} appId="example-app" />);
    await waitFor(() => expect(screen.getByTestId("chat-panel")).toHaveAttribute("data-conversation-id", "first-app-chat"));
    rerender(<AgenticAppAssistantOverlay {...props} appId="secondary-app" />);
    await waitFor(() => expect(screen.getByTestId("chat-panel")).toHaveAttribute("data-conversation-id", "second-app-chat"));
    expect(mockFindConversation).toHaveBeenLastCalledWith([], "secondary-app", "agent-example", undefined);
  });

  it("retries a failed initialization when the assistant is reopened", async () => {
    const props = {
      appId: "example-app", appName: "Example App", activeContext: null,
      onClearContext: jest.fn(), assistantAgentId: "agent-example", onOpenChange: jest.fn(),
    };
    mockFindConversation.mockRejectedValueOnce(new Error("History unavailable"));
    const { rerender } = render(<AgenticAppAssistantOverlay {...props} open />);
    await screen.findByText("History unavailable");
    rerender(<AgenticAppAssistantOverlay {...props} open={false} />);
    rerender(<AgenticAppAssistantOverlay {...props} open />);
    expect(await screen.findByTestId("chat-panel")).toHaveAttribute("data-conversation-id", "assistant-conversation");
    expect(mockFindConversation).toHaveBeenCalledTimes(2);
  });
});

function renderExampleOverlay() {
  return render(exampleOverlay());
}

function exampleOverlay() {
  return (
    <AgenticAppAssistantOverlay
      appId="example-app"
      appName="Example App"
      assistantLabel="Ask Example"
      assistantAgentName="Example Assistant"
      activeContext={null}
      onClearContext={jest.fn()}
      assistantAgentId="agent-example"
      open
      onOpenChange={jest.fn()}
    />
  );
}

function makeConversation(id: string, updatedAt: string): Conversation {
  return {
    id,
    title: "Example App Assistant",
    createdAt: new Date(updatedAt),
    updatedAt: new Date(updatedAt),
    messages: [],
    streamEvents: [],
    participants: [{ type: "agent", id: "agent-example" }],
    metadata: {
      conversation_surface: "agentic-app",
      agentic_app_id: "example-app",
      agentic_app_agent_id: "agent-example",
    },
  };
}
