import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { PRODUCT_TOUR_AGENT_CREATED_EVENT, requestProductTour } from "@/lib/product-tour";
import { ProductTourDialog, ProductTourGate } from "../ProductTour";
import { useCaipeTourStore } from "@/store/caipe-tour-store";
import { useUnsavedChangesStore } from "@/store/unsaved-changes-store";

const mockGetConfig = jest.fn();
jest.mock("@/lib/config", () => ({ getConfig: () => mockGetConfig() }));

const mockPush = jest.fn();
let mockPathname = "/";

jest.mock("next/navigation", () => ({
  useRouter: () => ({ push: mockPush }),
  usePathname: () => mockPathname,
}));

function response(data: unknown, status = 200): Promise<Response> {
  return Promise.resolve({
    ok: status >= 200 && status < 300,
    status,
    json: async () => data,
  } as Response);
}

function tourPayload(status = "not_started", autoStart = true) {
  return {
    success: true,
    data: {
      auto_start: autoStart,
      eligible: true,
      state: {
        version: 1,
        status,
        current_step: status === "completed" ? 5 : 1,
        run_count: status === "not_started" ? 0 : 1,
      },
    },
  };
}

describe("ProductTourGate", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    useCaipeTourStore.getState().reset();
    mockPathname = "/";
    window.history.replaceState({}, "", "/");
    useUnsavedChangesStore.setState({ hasUnsavedChanges: false, pendingNavigationHref: null });
    mockGetConfig.mockReturnValue(true);
    global.fetch = jest.fn((input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) !== "/api/onboarding/product-tour") {
        return response({ error: "Not found" }, 404);
      }
      if (init?.method === "PATCH") {
        const body = JSON.parse(String(init.body)) as { action: string; current_step?: number };
        return response({
          success: true,
          data: {
            state: {
              version: 1,
              status: body.action === "complete"
                ? "completed"
                : body.action === "dismiss"
                  ? "dismissed"
                  : "in_progress",
              current_step: body.current_step ?? 1,
              run_count: 1,
            },
          },
        });
      }
      return response(tourPayload());
    }) as jest.Mock;
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("loads availability without opening automatic guidance when onboarding is disabled", async () => {
    mockGetConfig.mockReturnValue(false);
    render(<ProductTourGate />);
    await waitFor(() => expect(useCaipeTourStore.getState().loaded).toBe(true));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it.each([null, { success: true, data: {} }, { success: false, data: null }])("keeps the workspace usable for an incomplete tour response: %p", async (payload) => {
    global.fetch = jest.fn(() => response(payload));
    render(<ProductTourGate />);
    await waitFor(() => expect(global.fetch).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    act(() => requestProductTour());
    expect(await screen.findByRole("alert")).toHaveTextContent("Tour progress is unavailable");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("waits for the initial start save before accepting progress", async () => {
    const originalFetch = global.fetch;
    let finishStart!: (value: Response) => void;
    global.fetch = jest.fn((input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "PATCH" && JSON.parse(String(init.body)).action === "start") {
        return new Promise<Response>((resolve) => { finishStart = resolve; });
      }
      return originalFetch(input, init);
    }) as jest.Mock;
    render(<ProductTourGate />);
    const next = await screen.findByRole("button", { name: /next/i });
    expect(next).toBeDisabled();
    expect(screen.getByRole("button", { name: /skip tour/i })).toBeDisabled();
    await act(async () => finishStart(await response({ success: true, data: { state: tourPayload().data.state } })));
    await waitFor(() => expect(next).toBeEnabled());
    fireEvent.click(next);
    expect(await screen.findByRole("heading", { name: "Pick up where you left off" })).toBeInTheDocument();
  });

  it("closes locally and reports an unsaved dismissal when the API fails", async () => {
    const originalFetch = global.fetch;
    global.fetch = jest.fn((input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "PATCH" && JSON.parse(String(init.body)).action === "dismiss") return response({ error: "Example unavailable" }, 503);
      return originalFetch(input, init);
    }) as jest.Mock;
    render(<ProductTourGate />);
    const skip = await screen.findByRole("button", { name: /skip tour/i });
    await waitFor(() => expect(skip).toBeEnabled());
    fireEvent.click(skip);
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(screen.getByRole("status")).toHaveTextContent("dismissal could not be saved");
  });

  it("keeps the workspace usable and resumes a minimized tour", async () => {
    render(<ProductTourGate />);
    const panel = await screen.findByRole("dialog");
    expect(panel).toHaveAttribute("aria-modal", "false");
    fireEvent.click(screen.getByRole("button", { name: "Minimize tour" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /resume tour/i }));
    expect(await screen.findByRole("heading", { name: "Your workspace is ready" })).toBeInTheDocument();
  });

  it("starts after setup, saves progress, and supports a persistent skip", async () => {
    render(<ProductTourGate />);

    expect(await screen.findByRole("heading", { name: "Your workspace is ready" })).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole("button", { name: /next/i })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: /next/i }));
    expect(await screen.findByRole("heading", { name: "Pick up where you left off" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /skip tour/i }));

    await waitFor(() => {
      expect(global.fetch).toHaveBeenCalledWith(
        "/api/onboarding/product-tour",
        expect.objectContaining({
          method: "PATCH",
          body: expect.stringContaining('"action":"dismiss"'),
        }),
      );
    });
  });

  it("starts a never-started tour manually before setup is complete", async () => {
    const originalFetch = global.fetch;
    global.fetch = jest.fn((input: RequestInfo | URL, init?: RequestInit) => {
      if (!init?.method) return response(tourPayload("not_started", false));
      return originalFetch(input, init);
    }) as jest.Mock;
    render(<ProductTourGate />);
    await waitFor(() => expect(global.fetch).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    act(() => requestProductTour(true));
    const next = await screen.findByRole("button", { name: "Next" });
    await waitFor(() => expect(next).toBeEnabled());
    fireEvent.click(next);
    expect(await screen.findByRole("heading", { name: "Pick up where you left off" })).toBeInTheDocument();
  });

  it("replays on demand even after completion", async () => {
    const fetchMock = global.fetch as jest.Mock;
    fetchMock.mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "PATCH") {
        return response({
          success: true,
          data: {
            state: { version: 1, status: "in_progress", current_step: 1, run_count: 2 },
          },
        });
      }
      return response(tourPayload("completed", false));
    });
    render(<ProductTourGate />);

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole("heading", { name: "Your workspace is ready" })).not.toBeInTheDocument();

    act(() => requestProductTour(true));

    expect(await screen.findByRole("heading", { name: "Your workspace is ready" })).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/onboarding/product-tour",
      expect.objectContaining({
        method: "PATCH",
        body: expect.stringContaining('"action":"reset"'),
      }),
    );
  });
  it.each([
    ["add-model", "Save provider details"],
    ["add-mcp", "Start a server connection"],
    ["chat", "Choose who you want to work with"],
    ["credentials", "Connect an account for your tools"],
  ] as const)("opens the %s tour independently of automatic onboarding", async (id, heading) => {
    mockGetConfig.mockReturnValue(false);
    const originalFetch = global.fetch;
    global.fetch = jest.fn((input: RequestInfo | URL, init?: RequestInit) => {
      if (!init?.method && String(input).includes("?tour=")) return response(tourPayload("not_started", false));
      return originalFetch(input, init);
    });
    render(<ProductTourGate />);
    act(() => requestProductTour(false, id));
    expect(await screen.findByRole("heading", { name: heading })).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole("button", { name: "Next" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    await waitFor(() => expect(global.fetch).toHaveBeenCalledWith("/api/onboarding/product-tour", expect.objectContaining({
      body: JSON.stringify({ action: "progress", tour_id: id, current_step: 2 }),
    })));
  });

  it.each(["dismiss", "complete"] as const)("ignores a delayed %s from a replaced tour", async (action) => {
    let finish!: (value: Response) => void;
    const originalFetch = global.fetch;
    global.fetch = jest.fn((input: RequestInfo | URL, init?: RequestInit) => {
      if (!init?.method) {
        const payload = tourPayload("in_progress");
        if (!String(input).includes("?tour=")) payload.data.state.current_step = action === "complete" ? 5 : 1;
        return response(payload);
      }
      if (JSON.parse(String(init.body)).action === action) return new Promise<Response>((resolve) => { finish = resolve; });
      return originalFetch(input, init);
    });
    render(<ProductTourGate />);
    await screen.findByRole("heading", { name: action === "complete" ? "Make the workspace yours" : "Your workspace is ready" });
    fireEvent.click(screen.getByRole("button", { name: action === "complete" ? "Finish tour" : "Close tour" }));
    await waitFor(() => expect(finish).toBeDefined());
    act(() => requestProductTour(false, "chat"));
    await screen.findByRole("heading", { name: "Choose who you want to work with" });
    await act(async () => finish(await response(tourPayload(action === "complete" ? "completed" : "dismissed"))));
    expect(screen.getByRole("heading", { name: "Choose who you want to work with" })).toBeInTheDocument();
  });

  it.each(["personal", "platform"] as const)("closes an active tour when the %s switch is turned off", async (scope) => {
    render(<ProductTourGate />);
    await screen.findByRole("heading", { name: "Your workspace is ready" });
    act(() => useCaipeTourStore.getState().receive({ ...tourPayload().data, ...(scope === "platform" ? { platform_enabled: false } : { tours_enabled: false }) }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    act(() => requestProductTour(true));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("returns a resumed agent guide to the start when its unsaved form is gone", async () => {
    render(<ProductTourDialog open initialPayload={{ ...tourPayload("in_progress", false).data, tour_id: "add-agent", state: { ...tourPayload().data.state, status: "in_progress", current_step: 3 } }} onOpenChange={jest.fn()} />);
    expect(await screen.findByRole("heading", { name: "Create an agent for one purpose" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Next" })).not.toBeInTheDocument();
  });

  it("follows the real agent form in both directions without a second Next button", async () => {
    const initial = { ...tourPayload("in_progress", false).data, tour_id: "add-agent" as const };
    const form = document.createElement("div");
    form.setAttribute("data-tour-agent-step", "basic");
    document.body.append(form);
    try {
      render(<ProductTourDialog open initialPayload={initial} onOpenChange={jest.fn()} />);
      expect(await screen.findByRole("heading", { name: "Choose its model and audience" })).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "Next" })).not.toBeInTheDocument();
      expect(screen.getByRole("dialog")).not.toHaveClass("fixed");
      for (const [step, title] of [
        ["instructions", "Describe the job clearly"],
        ["tools", "Review tools and optional context"],
        ["knowledge", "Review tools and optional context"],
        ["skills", "Review tools and optional context"],
        ["advanced", "Review tools and optional context"],
        ["basic", "Choose its model and audience"],
      ]) {
        await act(async () => form.setAttribute("data-tour-agent-step", step));
        expect(await screen.findByRole("heading", { name: title })).toBeInTheDocument();
      }
      await act(async () => form.remove());
      expect(await screen.findByRole("heading", { name: "Create an agent for one purpose" })).toBeInTheDocument();
    } finally { form.remove(); }
  });

  it("advances to the conversation only after the agent is saved", async () => {
    const form = document.createElement("div");
    form.setAttribute("data-tour-agent-step", "advanced");
    document.body.append(form);
    try {
      render(<ProductTourDialog open initialPayload={{ ...tourPayload("in_progress", false).data, tour_id: "add-agent" }} onOpenChange={jest.fn()} />);
      await screen.findByRole("heading", { name: "Review tools and optional context" });
      await act(async () => {
        window.dispatchEvent(new Event(PRODUCT_TOUR_AGENT_CREATED_EVENT));
        form.remove();
      });
      expect(await screen.findByRole("heading", { name: "Test the agent you created" })).toBeInTheDocument();
      await waitFor(() => expect(screen.getByRole("button", { name: "Finish tour" })).toBeEnabled());
      const saves = (global.fetch as jest.Mock).mock.calls.filter(([, init]) => init?.method === "PATCH");
      expect(JSON.parse(saves.at(-1)![1].body)).toMatchObject({ action: "progress", current_step: 5, tour_id: "add-agent" });
    } finally { form.remove(); }
  });

  it("resumes task progress without resetting it", async () => {
    mockGetConfig.mockReturnValue(false);
    global.fetch = jest.fn(() => response({ ...tourPayload("in_progress", false), data: { ...tourPayload("in_progress", false).data, state: { ...tourPayload().data.state, status: "in_progress", current_step: 3 } } }));
    render(<ProductTourGate />);
    act(() => requestProductTour(false, "chat"));
    expect(await screen.findByRole("heading", { name: "Look behind the answer" })).toBeInTheDocument();
    expect(global.fetch).toHaveBeenCalledTimes(2);
  });

  it("does not let a late automatic response replace a manually selected tour", async () => {
    const originalFetch = global.fetch;
    let resolveAutomatic!: (response: Response) => void;
    global.fetch = jest.fn((input: RequestInfo | URL, init?: RequestInit) => {
      if (!init?.method && String(input) === "/api/onboarding/product-tour") return new Promise<Response>((resolve) => { resolveAutomatic = resolve; });
      if (!init?.method && String(input).includes("?tour=")) return response(tourPayload());
      return originalFetch(input, init);
    });
    render(<ProductTourGate />);
    act(() => requestProductTour(true, "chat"));
    expect(await screen.findByRole("heading", { name: "Choose who you want to work with" })).toBeInTheDocument();
    await act(async () => resolveAutomatic(await response(tourPayload())));
    expect(screen.queryByRole("heading", { name: "Your workspace is ready" })).not.toBeInTheDocument();
  });

  it.each([
    ["add-model", "/dynamic-agents?tab=model-providers"],
    ["add-agent", "/dynamic-agents?tab=agents"],
    ["add-mcp", "/dynamic-agents?tab=mcp-servers"],
    ["chat", "/chat"],
    ["credentials", "/credentials/connections"],
  ] as const)("opens the destination for %s automatically", async (tour_id, href) => {
    render(<ProductTourDialog open initialPayload={{ ...tourPayload("in_progress", false).data, tour_id }} onOpenChange={jest.fn()} />);
    await waitFor(() => expect(mockPush).toHaveBeenCalledWith(href));
  });

  it("changes tabs on the same route, and keeps form-only steps on that tab", async () => {
    mockPathname = "/dynamic-agents";
    window.history.replaceState({}, "", "/dynamic-agents?tab=model-providers");
    render(<ProductTourDialog open initialPayload={{ ...tourPayload("in_progress", false).data, tour_id: "add-model" }} onOpenChange={jest.fn()} />);
    expect(mockPush).not.toHaveBeenCalled();
    fireEvent.click(await screen.findByRole("button", { name: "Next" }));
    await waitFor(() => expect(mockPush).toHaveBeenCalledWith("/dynamic-agents?tab=llm-models"));
    window.history.replaceState({}, "", "/dynamic-agents?tab=llm-models");
    await waitFor(() => expect(screen.getByRole("button", { name: "Next" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    await screen.findByRole("heading", { name: "Match the provider identifiers" });
    expect(mockPush).toHaveBeenCalledTimes(1);
  });

  it("preserves the current chat and does not navigate again when the guide resumes", async () => {
    mockPathname = "/chat/example";
    render(<ProductTourDialog open initialPayload={{ ...tourPayload("in_progress", false).data, tour_id: "chat" }} onOpenChange={jest.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Minimize tour" }));
    fireEvent.click(screen.getByRole("button", { name: /Resume tour/ }));
    expect(mockPush).not.toHaveBeenCalled();
  });

  it("requests the existing discard guard once, and respects cancellation", async () => {
    mockPathname = "/dynamic-agents";
    useUnsavedChangesStore.setState({ hasUnsavedChanges: true });
    render(<ProductTourDialog open initialPayload={{ ...tourPayload("in_progress", false).data, tour_id: "chat" }} onOpenChange={jest.fn()} />);
    await waitFor(() => expect(useUnsavedChangesStore.getState().pendingNavigationHref).toBe("/chat"));
    act(() => useUnsavedChangesStore.getState().cancelNavigation());
    expect(mockPush).not.toHaveBeenCalled();
    expect(useUnsavedChangesStore.getState().pendingNavigationHref).toBeNull();
  });

  it("offers Home after saving completion and lets the user stay", async () => {
    mockPathname = "/chat/example";
    const onOpenChange = jest.fn();
    render(<ProductTourDialog open initialPayload={{ ...tourPayload("in_progress", false).data, tour_id: "chat", state: { ...tourPayload().data.state, status: "in_progress", current_step: 4 } }} onOpenChange={onOpenChange} />);
    fireEvent.click(await screen.findByRole("button", { name: "Finish tour" }));
    await screen.findByRole("heading", { name: "Tour complete" });
    expect(screen.getByRole("link", { name: "Back to Home" })).toHaveAttribute("href", "/");
    expect(onOpenChange).not.toHaveBeenCalled();
    expect(mockPush).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog")).toHaveFocus();
    fireEvent.click(screen.getByRole("button", { name: "Stay here" }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("keeps the guide open if completion could not be saved", async () => {
    mockPathname = "/chat/example";
    const originalFetch = global.fetch;
    global.fetch = jest.fn((input: RequestInfo | URL, init?: RequestInit) => init?.method === "PATCH" && JSON.parse(String(init.body)).action === "complete"
      ? response({ error: "Save unavailable" }, 503) : originalFetch(input, init));
    const onOpenChange = jest.fn();
    render(<ProductTourDialog open initialPayload={{ ...tourPayload("in_progress", false).data, tour_id: "chat", state: { ...tourPayload().data.state, status: "in_progress", current_step: 4 } }} onOpenChange={onOpenChange} />);
    fireEvent.click(screen.getByRole("button", { name: "Finish tour" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Save unavailable");
    expect(screen.queryByRole("link", { name: "Back to Home" })).not.toBeInTheDocument();
    expect(onOpenChange).not.toHaveBeenCalled();
  });

  it("preserves a draft when the user cancels returning Home", async () => {
    mockPathname = "/dynamic-agents";
    window.history.replaceState({}, "", "/dynamic-agents?tab=agents");
    const onOpenChange = jest.fn();
    render(<ProductTourDialog open initialPayload={{ ...tourPayload("in_progress", false).data, tour_id: "workspace", state: { ...tourPayload().data.state, status: "in_progress", current_step: 5 } }} onOpenChange={onOpenChange} />);
    fireEvent.click(await screen.findByRole("button", { name: "Finish tour" }));
    await screen.findByRole("heading", { name: "Tour complete" });
    act(() => useUnsavedChangesStore.setState({ hasUnsavedChanges: true }));
    fireEvent.click(screen.getByRole("link", { name: "Back to Home" }));
    expect(useUnsavedChangesStore.getState().pendingNavigationHref).toBe("/");
    expect(onOpenChange).not.toHaveBeenCalled();
    act(() => useUnsavedChangesStore.getState().cancelNavigation());
    expect(screen.getByRole("heading", { name: "Tour complete" })).toBeInTheDocument();
  });

});
