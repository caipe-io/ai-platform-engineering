import { act, render, screen, waitFor } from "@testing-library/react";

import { AgenticAppShell } from "../AgenticAppShell";

const mockResolveUsableChatAgent = jest.fn();

const mockRouter = { push: jest.fn() };

jest.mock("next/navigation", () => ({
  useRouter: () => mockRouter,
  useSearchParams: () => new URLSearchParams(),
}));

jest.mock("@/lib/chat-agent-selection", () => ({
  resolveUsableChatAgent: (options: unknown) => mockResolveUsableChatAgent(options),
}));

jest.mock("../AgenticAppAssistantOverlay", () => ({
  AgenticAppAssistantOverlay: ({
    assistantLabel,
    activeContext,
    open,
  }: {
    assistantLabel?: string;
    activeContext: { title?: string } | null;
    open: boolean;
  }) => (
    <div
      data-testid="assistant-overlay"
      data-open={String(open)}
      data-context={activeContext?.title ?? ""}
    >
      {assistantLabel ?? "Ask CAIPE"}
    </div>
  ),
}));

function app(overrides: Record<string, unknown> = {}) {
  return {
    appId: "example-app",
    displayName: "Example App",
    description: "Example description",
    href: "/apps/example-app",
    canLaunch: true,
    blockedReasons: [],
    categories: [],
    capabilities: [],
    assistantEnabled: true,
    ...overrides,
  };
}

describe("AgenticAppShell", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        item: app({
            assistantAgentId: "agent-example",
            assistantAgentName: "Example Agent",
            assistantLabel: "Ask Example",
          }),
      }),
    }) as jest.Mock;
    mockResolveUsableChatAgent.mockResolvedValue({
      id: "agent-example",
      name: "Example Agent",
      source: "configured",
    });
  });

  it("renders the app and its configured assistant", async () => {
    render(<AgenticAppShell appId="example-app" path={[]} />);

    expect(await screen.findByTitle("Example App")).toHaveAttribute(
      "src",
      "/apps/example-app",
    );
    expect(await screen.findByTestId("assistant-overlay")).toHaveTextContent("Ask Example");
    expect(mockResolveUsableChatAgent).toHaveBeenCalledWith({
      signal: expect.any(AbortSignal),
      requestedAgentId: "agent-example",
      requireAvailableAgent: true,
    });
  });

  it("opens the assistant and accepts context from its own iframe", async () => {
    render(<AgenticAppShell appId="example-app" path={[]} />);

    const iframe = (await screen.findByTitle("Example App")) as HTMLIFrameElement;
    const overlay = await screen.findByTestId("assistant-overlay");
    expect(overlay).toHaveAttribute("data-open", "false");

    act(() => {
      window.dispatchEvent(
        new MessageEvent("message", {
          origin: window.location.origin,
          source: iframe.contentWindow,
          data: {
            type: "caipe.agenticApp.context.v1",
            version: "1.0",
            appId: "example-app",
            context: { route: "/", title: "Selected dashboard context" },
          },
        }),
      );
      window.dispatchEvent(
        new MessageEvent("message", {
          origin: window.location.origin,
          source: iframe.contentWindow,
          data: {
            type: "caipe.agenticApp.assistant.open.v1",
            version: "1.0",
            appId: "example-app",
          },
        }),
      );
    });

    await waitFor(() => {
      expect(overlay).toHaveAttribute("data-open", "true");
      expect(overlay).toHaveAttribute("data-context", "Selected dashboard context");
    });
  });

  it("uses an authorized default agent when the app does not specify one", async () => {
    (global.fetch as jest.Mock).mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ item: app() }),
    });
    mockResolveUsableChatAgent.mockResolvedValue({
      id: "agent-default",
      name: "Default Agent",
      source: "platform-default",
    });

    render(<AgenticAppShell appId="example-app" path={[]} />);

    expect(await screen.findByTestId("assistant-overlay")).toHaveTextContent("Ask CAIPE");
    expect(mockResolveUsableChatAgent).toHaveBeenCalledWith({
      signal: expect.any(AbortSignal),
      requestedAgentId: undefined,
      requireAvailableAgent: true,
    });
  });

  it("does not resolve or render an assistant when the app disables it", async () => {
    (global.fetch as jest.Mock).mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ item: app({ assistantEnabled: false }) }),
    });

    render(<AgenticAppShell appId="example-app" path={[]} />);

    expect(await screen.findByTitle("Example App")).toBeInTheDocument();
    await waitFor(() => expect(mockResolveUsableChatAgent).not.toHaveBeenCalled());
    expect(screen.queryByTestId("assistant-overlay")).not.toBeInTheDocument();
  });

  it("aborts the assistant lookup on unmount without reporting a cancellation as failure", async () => {
    const warning = jest.spyOn(console, "warn").mockImplementation(() => undefined);
    let rejectLookup!: (error: unknown) => void;
    mockResolveUsableChatAgent.mockImplementationOnce(() => new Promise((_, reject) => {
      rejectLookup = reject;
    }));
    const { unmount } = render(<AgenticAppShell appId="example-app" path={[]} />);
    await waitFor(() => expect(mockResolveUsableChatAgent).toHaveBeenCalledTimes(1));
    const signal = mockResolveUsableChatAgent.mock.calls[0][0].signal as AbortSignal;
    expect(signal.aborted).toBe(false);
    unmount();
    expect(signal.aborted).toBe(true);
    await act(async () => rejectLookup(signal.reason));
    expect(warning).not.toHaveBeenCalled();
    warning.mockRestore();
  });
});
