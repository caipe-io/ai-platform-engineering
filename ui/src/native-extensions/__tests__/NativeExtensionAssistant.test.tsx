import { fireEvent, render, screen } from "@testing-library/react";

import { NativeExtensionAssistant } from "../NativeExtensionAssistant";

const createConversation = jest.fn();

jest.mock("@/store/chat-store", () => ({
  useChatStore: { getState: () => ({ createConversation }) },
}));

jest.mock("@/components/chat/DynamicAgentChatPanel", () => ({
  ChatPanel: () => <div data-testid="agent-chat" />,
}));

describe("NativeExtensionAssistant", () => {
  afterEach(() => {
    jest.restoreAllMocks();
    createConversation.mockReset();
  });

  it("opens a host-owned assistant for the declared agent", async () => {
    createConversation.mockResolvedValue("example-conversation");
    jest.spyOn(global, "fetch").mockResolvedValue({
      ok: true,
      json: async () => ({ success: true, data: { enabled: true, name: "Example Assistant" } }),
    } as Response);

    render(
      <NativeExtensionAssistant
        assistant={{ agentId: "agent-example", label: "Ask Example", name: "Example Assistant" }}
        extensionId="example-app"
        pathname="/example/detail"
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Ask Example" }));
    expect(await screen.findByTestId("agent-chat")).toBeInTheDocument();
    expect(createConversation).toHaveBeenCalledWith("agent-example");
    expect(global.fetch).toHaveBeenCalledWith(
      "/api/dynamic-agents/agents/agent-example",
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it("does not render a chat when agent access is denied", async () => {
    createConversation.mockResolvedValue("example-conversation");
    jest.spyOn(global, "fetch").mockResolvedValue({ ok: false } as Response);

    render(
      <NativeExtensionAssistant
        assistant={{ agentId: "agent-example", label: "Ask Example", name: "Example Assistant" }}
        extensionId="example-app"
        pathname="/example"
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Ask Example" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("access was denied");
    expect(screen.queryByTestId("agent-chat")).not.toBeInTheDocument();
  });
});
