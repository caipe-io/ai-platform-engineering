/**
 * @jest-environment jsdom
 */

import { render,waitFor } from "@testing-library/react";

const mockDeliverAgentCompletionAlert = jest.fn(async () => ({
  chimePlayed: false,
  notificationShown: true,
}));
const mockLoadPreferences = jest.fn(async () => ({
  browserEnabled: true,
  chimeEnabled: false,
}));

let mockChatState: {
  conversations: Array<Record<string,unknown>>;
  streamingConversations: Map<string,Record<string,unknown>>;
};

jest.mock("@/lib/agent-completion-notifications",() => ({
  deliverAgentCompletionAlert: (...args: unknown[]) => mockDeliverAgentCompletionAlert(...args),
  loadAgentCompletionPreferences: () => mockLoadPreferences(),
  prepareBrowserNotificationDelivery: jest.fn(async () => true),
  primeCompletionChime: jest.fn(async () => true),
}));

jest.mock("@/store/chat-store",() => ({
  useChatStore: (selector: (state: typeof mockChatState) => unknown) => selector(mockChatState),
}));

import { AgentCompletionNotifier } from "../AgentCompletionNotifier";

function conversation(turnStatus: "done" | "interrupted" | "waiting_for_input") {
  return {
    id: "conversation-primary",
    title: "Example conversation",
    messages: [{
      id: "message-primary",
      role: "assistant",
      content: "Finished",
      isFinal: turnStatus === "done",
      turnStatus,
      agentName: "Example agent",
    }],
  };
}

describe("AgentCompletionNotifier",() => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockChatState = {
      conversations: [conversation("done")],
      streamingConversations: new Map([["conversation-primary",{}]]),
    };
  });

  it("emits one alert when a successful stream leaves the shared streaming map",async () => {
    const view = render(<AgentCompletionNotifier />);

    mockChatState = {
      conversations: [conversation("done")],
      streamingConversations: new Map(),
    };
    view.rerender(<AgentCompletionNotifier />);

    await waitFor(() => {
      expect(mockDeliverAgentCompletionAlert).toHaveBeenCalledWith({
        agentName: "Example agent",
        conversationId: "conversation-primary",
        messageId: "message-primary",
      });
    });
    expect(mockDeliverAgentCompletionAlert).toHaveBeenCalledTimes(1);
  });

  it.each(["interrupted","waiting_for_input"] as const)(
    "does not alert for a %s turn",
    async (turnStatus) => {
      const view = render(<AgentCompletionNotifier />);

      mockChatState = {
        conversations: [conversation(turnStatus)],
        streamingConversations: new Map(),
      };
      view.rerender(<AgentCompletionNotifier />);

      await Promise.resolve();
      expect(mockDeliverAgentCompletionAlert).not.toHaveBeenCalled();
    },
  );
});
