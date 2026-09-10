import React from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

jest.mock("@/lib/gradient-themes", () => ({
  getGradientStyle: jest.fn(() => null),
  getAccentColor: jest.fn(() => "white"),
}));

jest.mock("@/components/ui/button", () => ({
  Button: ({ children, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement>) => (
    <button {...props}>{children}</button>
  ),
}));

jest.mock("lucide-react", () => ({
  Plus: () => <span data-testid="plus-icon" />,
  ChevronDown: () => <span data-testid="chevron-icon" />,
  Bot: () => <span data-testid="bot-icon" />,
  Loader2: () => <span data-testid="loader-icon" />,
  Search: () => <span data-testid="search-icon" />,
}));

const mockFetch = jest.fn();
const mockResolveUsableChatAgent = jest.fn();

jest.mock("@/lib/chat-agent-selection", () => ({
  resolveUsableChatAgent: () => mockResolveUsableChatAgent(),
}));

import { NewChatButton } from "../NewChatButton";

beforeEach(() => {
  jest.clearAllMocks();
  global.fetch = mockFetch;
});

describe("NewChatButton", () => {
  it("waits for default-agent resolution before creating a new chat", async () => {
    let resolveAgent: (value: { id: string; name: string; source: "platform-default" }) => void = () => {};
    mockResolveUsableChatAgent.mockReturnValue(new Promise((resolve) => {
      resolveAgent = resolve;
    }));
    const onNewChat = jest.fn();

    render(<NewChatButton collapsed={false} onNewChat={onNewChat} />);

    const mainButton = screen.getByRole("button", { name: /new chat/i });
    expect(mainButton).toBeDisabled();
    fireEvent.click(mainButton);
    expect(onNewChat).not.toHaveBeenCalled();

    resolveAgent({ id: "agent-default", name: "Platform Helper", source: "platform-default" });

    await waitFor(() => expect(mainButton).not.toBeDisabled());
    fireEvent.click(mainButton);

    expect(onNewChat).toHaveBeenCalledWith("agent-default");
  });

  it("shows the configured default agent name once it can resolve the agent", async () => {
    mockResolveUsableChatAgent.mockResolvedValue({
      id: "agent-default",
      name: "Platform Helper",
      source: "platform-default",
    });

    render(<NewChatButton collapsed={false} onNewChat={jest.fn()} />);

    expect(await screen.findByText("Platform Helper")).toBeInTheDocument();
  });

  it("prefers the user's web default over the platform default", async () => {
    mockResolveUsableChatAgent.mockResolvedValue({
      id: "agent-user",
      name: "My Agent",
      source: "user-default",
    });
    const onNewChat = jest.fn();

    render(<NewChatButton collapsed={false} onNewChat={onNewChat} />);

    expect(await screen.findByText("My Agent")).toBeInTheDocument();
    const mainButton = screen.getByRole("button", { name: /my agent/i });
    fireEvent.click(mainButton);
    expect(onNewChat).toHaveBeenCalledWith("agent-user");
  });

  it("uses the first accessible agent when no personal or platform default is configured", async () => {
    mockResolveUsableChatAgent.mockResolvedValue({
      id: "agent-first",
      name: "First Accessible Agent",
      source: "first-available",
    });
    const onNewChat = jest.fn();

    render(<NewChatButton collapsed={false} onNewChat={onNewChat} />);

    const mainButton = await screen.findByRole("button", { name: /first accessible agent/i });
    await waitFor(() => expect(mainButton).not.toBeDisabled());
    fireEvent.click(mainButton);

    expect(onNewChat).toHaveBeenCalledWith("agent-first");
  });
});
