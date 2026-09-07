import { fireEvent, render, screen, waitFor } from "@testing-library/react";

import { useChatStore } from "@/store/chat-store";

import { AgenticAppAssistantOverlay } from "../AgenticAppAssistantOverlay";

const mockCreateConversation = jest.fn();
const mockSetActiveConversation = jest.fn();
const mockChatStoreState = {
  activeConversationId: "previous-conversation",
  createConversation: mockCreateConversation,
  setActiveConversation: mockSetActiveConversation,
};

jest.mock("@/store/chat-store", () => ({ useChatStore: jest.fn() }));

jest.mock("@/components/chat/DynamicAgentChatPanel", () => ({
  ChatPanel: ({
    conversationId,
    agentId,
    clientContext,
  }: {
    conversationId?: string;
    agentId: string;
    clientContext?: Record<string, unknown>;
  }) => (
    <div
      data-testid="chat-panel"
      data-conversation-id={conversationId}
      data-agent-id={agentId}
      data-context={JSON.stringify(clientContext ?? {})}
    />
  ),
}));

describe("AgenticAppAssistantOverlay", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    window.localStorage.clear();
    mockChatStoreState.activeConversationId = "previous-conversation";
    mockCreateConversation.mockResolvedValue("assistant-conversation");
    const mockUseChatStore = useChatStore as unknown as jest.Mock & {
      getState: () => typeof mockChatStoreState;
    };
    mockUseChatStore.mockImplementation(
      (selector: (state: typeof mockChatStoreState) => unknown) => selector(mockChatStoreState),
    );
    mockUseChatStore.getState = () => mockChatStoreState;
  });

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

    expect(screen.getByRole("region", { name: "Example Assistant" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Disable translucent assistant mode" }))
      .toHaveAttribute("aria-pressed", "true");
    expect(screen.getByText("Starting Ask Example…")).toBeInTheDocument();
    expect(mockCreateConversation).toHaveBeenCalledWith("agent-example");
    const chat = await screen.findByTestId("chat-panel");
    expect(chat).toHaveAttribute("data-conversation-id", "assistant-conversation");
    expect(chat).toHaveAttribute("data-agent-id", "agent-example");
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
});
