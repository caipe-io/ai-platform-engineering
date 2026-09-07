import { fireEvent, render, screen } from "@testing-library/react";

import { AgenticAppAssistantOverlay } from "../AgenticAppAssistantOverlay";

jest.mock("@/components/chat/DynamicAgentChatPanel", () => ({
  ChatPanel: ({ clientContext }: { clientContext?: Record<string, unknown> }) => (
    <div data-testid="chat-panel" data-context={JSON.stringify(clientContext ?? {})} />
  ),
}));

describe("AgenticAppAssistantOverlay", () => {
  beforeEach(() => window.localStorage.clear());

  it("renders a floating launcher and opens the glass chat panel", () => {
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
    expect(screen.getByTestId("chat-panel")).toBeInTheDocument();
  });

  it("passes validated app context into the chat panel", () => {
    render(
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

    expect(screen.getByTestId("chat-panel")).toHaveAttribute(
      "data-context",
      expect.stringContaining('"appId":"example-app"'),
    );
    expect(screen.getByText("Current report")).toBeInTheDocument();
  });
});
