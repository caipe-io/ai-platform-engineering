import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

import { AgenticAppShell } from "../AgenticAppShell";
import AppRouteLayout from "../../../app/(app)/agentic-app-routes/[appId]/layout";

jest.mock("next-auth/react", () => ({
  useSession: () => ({ status: "authenticated", data: { user: { email: "test-user@example.test" } } }),
}));
let mockSearch = "";

const mockResolveUsableChatAgent = jest.fn();

const mockRouter = { push: jest.fn() };

jest.mock("next/navigation", () => ({
  useRouter: () => mockRouter,
  usePathname: () => window.location.pathname,
  useSearchParams: () => new URLSearchParams(mockSearch),
}));

jest.mock("@/lib/chat-agent-selection", () => ({
  resolveUsableChatAgent: (options: unknown) => mockResolveUsableChatAgent(options),
}));

jest.mock("../AgenticAppAssistantOverlay", () => ({
  AgenticAppAssistantOverlay: ({
    assistantLabel,
    activeContext,
    composerDraft,
    onComposerDraftApplied,
    open,
  }: {
    assistantLabel?: string;
    activeContext: { title?: string } | null;
    composerDraft?: { id: string; text: string; attachment?: { name: string; content: string } } | null;
    onComposerDraftApplied?: (id: string) => void;
    open: boolean;
  }) => (
    <div
      data-testid="assistant-overlay"
      data-open={String(open)}
      data-draft={composerDraft?.text ?? ""}
      data-attachment={composerDraft?.attachment?.name ?? ""}
      data-context={activeContext?.title ?? ""}
    >
      {assistantLabel ?? "Ask CAIPE"}
      <button onClick={() => composerDraft && onComposerDraftApplied?.(composerDraft.id)}>Apply draft</button>
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
  it("accepts only the connected frame's allowlisted host shortcut without an assistant", async () => {
    global.fetch = jest.fn().mockResolvedValue({ ok: true, json: async () => ({ item: app({ assistantEnabled: false }) }) });
    const open = jest.fn(); window.addEventListener("caipe:open-application-search", open);
    const view = render(<AgenticAppShell appId="example-app" path={[]} />);
    try {
      const frame = await screen.findByTitle("Example App") as HTMLIFrameElement;
      const message = { type: "caipe.agenticApp.shortcut.v1", appId: "example-app", version: "1.0", shortcut: "search" };
      const send = (origin: string, source: MessageEventSource | null, data = message) => act(() => window.dispatchEvent(new MessageEvent("message", { origin, source, data })));
      send("https://other.example.test", frame.contentWindow);
      send(window.location.origin, window);
      send(window.location.origin, frame.contentWindow, { ...message, appId: "other" });
      send(window.location.origin, frame.contentWindow, { ...message, version: "2.0" });
      send(window.location.origin, frame.contentWindow, { ...message, shortcut: "execute" });
      expect(open).not.toHaveBeenCalled();
      send(window.location.origin, frame.contentWindow);
      expect(open).toHaveBeenCalledTimes(1);
    } finally { window.removeEventListener("caipe:open-application-search", open); view.unmount(); }
  });
  beforeEach(() => {
    jest.clearAllMocks();
    mockSearch = "";
    window.history.replaceState(null, "", "/apps/example-app");
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

  it.each([false, true])("syncs queries without reloading the frame or catalog (host route=%s)", async hostRoute => {
    const path = hostRoute ? ["example"] : [];
    const publicPath = hostRoute ? "/example" : "/apps/example-app";
    const runtimePath = hostRoute ? "/apps/example-app/example" : publicPath;
    window.history.replaceState(null, "", publicPath);
    (global.fetch as jest.Mock).mockResolvedValue({ ok: true, status: 200, json: async () => ({ item: app({ assistantEnabled: false, hostPaths: hostRoute ? ["/example"] : [] }) }) });
    const { rerender } = render(<AgenticAppShell appId="example-app" path={path} hostRoute={hostRoute} />);
    const iframe = await screen.findByTitle("Example App") as HTMLIFrameElement;
    act(() => {
      window.dispatchEvent(new MessageEvent("message", {
        source: iframe.contentWindow, origin: window.location.origin,
        data: { type: "caipe.agenticApp.bridge.connect.v1", appId: "example-app", version: "1.0" },
      }));
    });
    act(() => {
      window.dispatchEvent(new MessageEvent("message", {
        source: iframe.contentWindow, origin: window.location.origin,
        data: { type: "caipe.agenticApp.navigate.v1", appId: "example-app", version: "1.0", href: `${publicPath}?tab=instances&search=example`, history: "push" },
      }));
    });
    expect(window.location.search).toBe("?tab=instances&search=example");
    mockSearch = window.location.search;
    rerender(<AgenticAppShell appId="example-app" path={path} hostRoute={hostRoute} />);
    expect(screen.getByTitle("Example App")).toBe(iframe);
    expect(iframe).toHaveAttribute("src", runtimePath);
    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId("assistant-overlay")).not.toBeInTheDocument();
  });

  it("keeps shared assistant capabilities in every query handshake reply", async () => {
    render(<AgenticAppShell appId="example-app" path={[]} />);
    const iframe = await screen.findByTitle("Example App") as HTMLIFrameElement;
    await screen.findByTestId("assistant-overlay");
    const post = jest.spyOn(iframe.contentWindow!, "postMessage");
    act(() => window.dispatchEvent(new MessageEvent("message", {
      source: iframe.contentWindow, origin: window.location.origin,
      data: { type: "caipe.agenticApp.bridge.connect.v1", appId: "example-app", version: "1.0" },
    })));
    const replies = post.mock.calls.filter(([message]) => message.type === "caipe.agenticApp.bridge.capabilities.v1");
    expect(replies).toHaveLength(1);
    for (const [message] of replies) expect(message.capabilities).toMatchObject({
      assistant: true, queryNavigation: true, composerExtensions: expect.arrayContaining(["configuration.v1"]),
    });
    post.mockRestore();
  });

  it("keeps the connected iframe document across app paths and continues syncing queries", async () => {
    const view = render(<AgenticAppShell appId="example-app" path={[]} />);
    const iframe = await screen.findByTitle("Example App") as HTMLIFrameElement;
    const send = (data: object) => act(() => window.dispatchEvent(new MessageEvent("message", {
      origin: window.location.origin, source: iframe.contentWindow,
      data: { version: "1.0", appId: "example-app", ...data },
    })));
    send({ type: "caipe.agenticApp.bridge.connect.v1" });
    send({ type: "caipe.agenticApp.navigate.v1", href: "/apps/example-app/details" });
    expect(window.location.pathname).toBe("/apps/example-app/details");
    expect(mockRouter.push).not.toHaveBeenCalled();
    window.history.replaceState(null, "", "/apps/example-app/details");
    view.rerender(<AgenticAppShell appId="example-app" path={["details"]} />);
    expect(screen.getByTitle("Example App")).toBe(iframe);
    expect(iframe).toHaveAttribute("src", "/apps/example-app");
    send({ type: "caipe.agenticApp.navigate.v1", href: "/apps/example-app/details?tab=overview", history: "replace" });
    expect(window.location.search).toBe("?tab=overview");
    window.history.replaceState(null, "", "/apps/example-app");
    mockSearch = "";
    view.rerender(<AgenticAppShell appId="example-app" path={[]} />);
    expect(screen.getByTitle("Example App")).toBe(iframe);
    expect(iframe).toHaveAttribute("src", "/apps/example-app");
  });

  it("renders app breadcrumbs in the host independently of assistant availability", async () => {
    (global.fetch as jest.Mock).mockResolvedValue({ ok: true, status: 200, json: async () => ({ item: app({ assistantEnabled: false }) }) });
    render(<AgenticAppShell appId="example-app" path={[]} />);
    const iframe = await screen.findByTitle("Example App") as HTMLIFrameElement;
    const message = { type: "caipe.agenticApp.breadcrumbs.v1", version: "1.0", appId: "example-app", route: "/apps/example-app",
      breadcrumbs: [{ label: "Home", href: "/" }, { label: "Example page" }] };
    act(() => window.dispatchEvent(new MessageEvent("message", { origin: window.location.origin, source: window, data: message })));
    expect(screen.queryByText("Example page")).toBeNull();
    act(() => window.dispatchEvent(new MessageEvent("message", { origin: window.location.origin, source: iframe.contentWindow, data: message })));
    expect(screen.getByText("Example page")).toBeInTheDocument();
    expect(screen.queryByTestId("assistant-overlay")).toBeNull();
  });

  it("keeps Home and the app as the root while frame breadcrumbs load, change routes, and reconnect", async () => {
    window.history.replaceState(null, "", "/example/wiki");
    (global.fetch as jest.Mock).mockResolvedValue({ ok: true, status: 200,
      json: async () => ({ item: app({ assistantEnabled: false, hostPaths: ["/example"] }) }) });
    const view = render(<AgenticAppShell appId="example-app" path={["example", "wiki"]} hostRoute />);
    const frame = await screen.findByTitle("Example App") as HTMLIFrameElement;
    const assertRoot = () => {
      const breadcrumb = within(screen.getByRole("navigation", { name: "Breadcrumb" }));
      expect(breadcrumb.getByText("Home")).toHaveAttribute("href", "/");
      expect(breadcrumb.getByText("Example App")).toBeInTheDocument();
      expect(breadcrumb.queryByText("Apps")).not.toBeInTheDocument();
    };
    assertRoot();
    act(() => window.dispatchEvent(new MessageEvent("message", {
      origin: window.location.origin, source: frame.contentWindow,
      data: { type: "caipe.agenticApp.breadcrumbs.v1", appId: "example-app", version: "1.0", route: "/example/wiki",
        breadcrumbs: [{ label: "Home", href: "/" }, { label: "Example App", href: "/example" }, { label: "Example page" }] },
    })));
    assertRoot();
    expect(screen.getByText("Example page")).toBeInTheDocument();
    window.history.replaceState(null, "", "/example/ask");
    view.rerender(<AgenticAppShell appId="example-app" path={["example", "ask"]} hostRoute />);
    assertRoot();
    expect(screen.queryByText("Example page")).not.toBeInTheDocument();
    fireEvent.load(frame);
    assertRoot();
  });

  it("retains the iframe when Next replaces the catch-all page at a different app route", async () => {
    (global.fetch as jest.Mock).mockResolvedValue({ ok: true, status: 200, json: async () => ({ item: app({ hostPaths: ["/example"] }) }) });
    window.history.replaceState(null, "", "/example/wiki");
    const params = Promise.resolve({ appId: "example-app" });
    const view = render(await AppRouteLayout({ params, children: <span key="wiki">Wiki route</span> }));
    const iframe = await screen.findByTitle("Example App") as HTMLIFrameElement;
    act(() => window.dispatchEvent(new MessageEvent("message", { origin: window.location.origin, source: iframe.contentWindow,
      data: { type: "caipe.agenticApp.bridge.connect.v1", version: "1.0", appId: "example-app" } })));
    window.history.replaceState(null, "", "/example");
    view.rerender(await AppRouteLayout({ params, children: <span key="hub">Hub route</span> }));
    expect(screen.getByTitle("Example App")).toBe(iframe);
    expect(iframe).toHaveAttribute("src", "/apps/example-app/example/wiki");
    expect(screen.getByText("Hub route")).toBeInTheDocument();
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

  it("replays the current assistant state when the iframe connects or reconnects", async () => {
    render(<AgenticAppShell appId="example-app" path={[]} />);
    const iframe = (await screen.findByTitle("Example App")) as HTMLIFrameElement;
    const overlay = await screen.findByTestId("assistant-overlay");
    const postMessage = jest.spyOn(iframe.contentWindow!, "postMessage");
    function send(type: string, origin = window.location.origin, source: Window | null = iframe.contentWindow) {
      act(() => { window.dispatchEvent(new MessageEvent("message", { origin, source,
        data: { type: `caipe.agenticApp.${type}.v1`, version: "1.0", appId: "example-app" } })); });
    }
    send("assistant.open");
    await waitFor(() => expect(overlay).toHaveAttribute("data-open", "true"));
    postMessage.mockClear();
    send("bridge.connect");
    expect(postMessage).toHaveBeenCalledWith({ type: "caipe.agenticApp.assistant.state.v1", version: "1.0",
      appId: "example-app", open: true }, window.location.origin);

    send("assistant.close");
    await waitFor(() => expect(overlay).toHaveAttribute("data-open", "false"));
    postMessage.mockClear();
    send("bridge.connect");
    expect(postMessage).toHaveBeenCalledWith({ type: "caipe.agenticApp.assistant.state.v1", version: "1.0",
      appId: "example-app", open: false }, window.location.origin);

    postMessage.mockClear();
    send("bridge.connect", "https://other.example.test");
    send("bridge.connect", window.location.origin, window);
    expect(postMessage).not.toHaveBeenCalled();
    postMessage.mockRestore();
  });

  it("accepts a draft only from the same-origin app iframe", async () => {
    render(<AgenticAppShell appId="example-app" path={[]} />);
    const iframe = (await screen.findByTitle("Example App")) as HTMLIFrameElement;
    const overlay = await screen.findByTestId("assistant-overlay");
    const send = (origin: string, source: MessageEventSource | null, appId = "example-app", text = "Find source") => act(() => {
      window.dispatchEvent(new MessageEvent("message", { origin, source, data: {
        type: "caipe.agenticApp.assistant.open.v1", version: "1.0", appId, draft: { id: "request-1", text },
      } }));
    });
    send("https://other.example.com", iframe.contentWindow);
    send(window.location.origin, window);
    send(window.location.origin, iframe.contentWindow, "other-app");
    expect(overlay).toHaveAttribute("data-open", "false");
    send(window.location.origin, iframe.contentWindow, "example-app", "x".repeat(12001));
    expect(overlay).toHaveAttribute("data-draft", "");
    send(window.location.origin, iframe.contentWindow);
    expect(overlay).toHaveAttribute("data-draft", "Find source");
    fireEvent.click(screen.getByRole("button", { name: "Apply draft" }));
    expect(overlay).toHaveAttribute("data-draft", "");
    send(window.location.origin, iframe.contentWindow);
    expect(overlay).toHaveAttribute("data-draft", "");
  });

  it("hands a Markdown attachment to the composer only from the app iframe", async () => {
    render(<AgenticAppShell appId="example-app" path={[]} />);
    const iframe = (await screen.findByTitle("Example App")) as HTMLIFrameElement;
    const overlay = await screen.findByTestId("assistant-overlay");
    const draft = { id: "digest-1", text: "", attachment: { name: "example-digest.md", content: "# Example digest", mimeType: "text/markdown" } };
    act(() => { window.dispatchEvent(new MessageEvent("message", { origin: window.location.origin, source: iframe.contentWindow, data: {
      type: "caipe.agenticApp.assistant.open.v1", version: "1.0", appId: "example-app", draft,
    } })); });
    expect(overlay).toHaveAttribute("data-attachment", "example-digest.md");
    expect(overlay).toHaveAttribute("data-draft", "");
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
