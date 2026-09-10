import React from "react";
import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";

// assisted-by Codex Codex-sonnet-4-6

const mockPush = jest.fn();
const mockCreateConversation = jest.fn();

jest.mock("next/navigation", () => ({
  useRouter: () => ({ push: mockPush }),
}));

jest.mock("@/store/chat-store", () => ({
  useChatStore: (selector: (state: unknown) => unknown) => selector({
    createConversation: mockCreateConversation,
  }),
}));

// DynamicAgentEditor pulls in react-markdown/react-syntax-highlighter, which
// is unrelated to search/pagination and breaks jsdom module transforms.
jest.mock("../DynamicAgentEditor", () => ({
  DynamicAgentEditor: ({
    agent,
    initialStep,
    onStepChange,
    onCancel,
  }: {
    agent?: DynamicAgentConfigWithPermissions | null;
    initialStep?: string;
    onStepChange?: (step: string) => void;
    onCancel: () => void;
  }) => (
    <div
      data-testid="dynamic-agent-editor"
      data-agent-id={agent?._id ?? ""}
      data-step={initialStep ?? ""}
    >
      <button type="button" onClick={() => onStepChange?.("tools")}>Editor tools step</button>
      <button type="button" onClick={onCancel}>Close editor</button>
    </div>
  ),
}));

import { DynamicAgentsTab } from "../DynamicAgentsTab";
import type { DynamicAgentConfigWithPermissions } from "@/types/dynamic-agent";

function makeAgent(overrides: Partial<DynamicAgentConfigWithPermissions> = {}): DynamicAgentConfigWithPermissions {
  return {
    _id: "agent-1",
    name: "Ops Helper",
    description: "Helps with ops",
    system_prompt: "You help.",
    allowed_tools: {},
    model: { id: "gpt-4o", provider: "openai" },
    visibility: "team",
    owner_team_slug: "platform",
    owner_team_id: "team-1",
    shared_with_teams: [],
    subagents: [],
    skills: [],
    ui: { gradient_theme: "default" },
    enabled: true,
    owner_id: "user-1",
    is_system: false,
    created_at: "2026-05-01T00:00:00Z",
    updated_at: "2026-05-01T00:00:00Z",
    permissions: { can_manage: true, can_write: true, can_discover: true },
    ...overrides,
  } as DynamicAgentConfigWithPermissions;
}

function jsonResponse(body: unknown) {
  return {
    json: async () => body,
  } as Response;
}

describe("DynamicAgentsTab search + pagination", () => {
  let fetchMock: jest.Mock;

  beforeEach(() => {
    jest.useFakeTimers();
    mockPush.mockReset();
    mockCreateConversation.mockReset();
    mockCreateConversation.mockResolvedValue("conversation-1");
    fetchMock = jest.fn(() => {
      return Promise.resolve(
        jsonResponse({
          success: true,
          data: { items: [makeAgent()], total: 1 },
        }),
      );
    });
    global.fetch = fetchMock as unknown as typeof fetch;
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it("shows agent-shaped rows while the list is loading", async () => {
    let resolveFetch!: (response: Response) => void;
    fetchMock.mockImplementation(
      () => new Promise<Response>((resolve) => {
        resolveFetch = resolve;
      }),
    );

    render(<DynamicAgentsTab />);

    expect(screen.getByTestId("agents-list-skeleton")).toBeInTheDocument();
    expect(screen.getByText("Loading agents...")).toBeInTheDocument();

    await act(async () => {
      resolveFetch(jsonResponse({
        success: true,
        data: { items: [makeAgent()], total: 1 },
      }));
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(screen.queryByTestId("agents-list-skeleton")).not.toBeInTheDocument();
    });
  });

  it("fetches agents on mount with default page and page_size params", async () => {
    render(<DynamicAgentsTab />);

    await act(async () => {
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith("/api/dynamic-agents?page=1&page_size=20");
    });
  });

  it("starts a chat with the selected row's agent", async () => {
    render(<DynamicAgentsTab />);

    const chatButton = await screen.findByRole("button", { name: "Chat with Ops Helper" });
    fireEvent.click(chatButton);

    await waitFor(() => {
      expect(mockCreateConversation).toHaveBeenCalledWith("agent-1");
      expect(mockPush).toHaveBeenCalledWith("/chat/conversation-1");
    });
  });

  it("debounces search input and calls fetch with the search param after 300ms", async () => {
    render(<DynamicAgentsTab />);

    await act(async () => {
      await Promise.resolve();
    });

    fetchMock.mockClear();

    fireEvent.change(screen.getByPlaceholderText("Search by name or ID..."), {
      target: { value: "ops" },
    });

    // Not yet fired before debounce elapses.
    await act(async () => {
      jest.advanceTimersByTime(200);
      await Promise.resolve();
    });
    expect(fetchMock).not.toHaveBeenCalled();

    await act(async () => {
      jest.advanceTimersByTime(150);
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith("/api/dynamic-agents?page=1&page_size=20&search=ops");
    });
  });

  it("resets to page 1 when the search changes while on a later page", async () => {
    fetchMock.mockImplementation(() =>
      Promise.resolve(
        jsonResponse({
          success: true,
          data: { items: [makeAgent()], total: 100 },
        }),
      ),
    );

    render(<DynamicAgentsTab />);

    await act(async () => {
      await Promise.resolve();
    });

    // Move to page 2 via the page button.
    fireEvent.click(screen.getByText("2"));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenLastCalledWith("/api/dynamic-agents?page=2&page_size=20");
    });

    fetchMock.mockClear();

    fireEvent.change(screen.getByPlaceholderText("Search by name or ID..."), {
      target: { value: "ops" },
    });

    await act(async () => {
      jest.advanceTimersByTime(300);
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith("/api/dynamic-agents?page=1&page_size=20&search=ops");
    });
  });

  it("calls fetch with the updated page when a page button is clicked", async () => {
    fetchMock.mockImplementation(() =>
      Promise.resolve(
        jsonResponse({
          success: true,
          data: { items: [makeAgent()], total: 100 },
        }),
      ),
    );

    render(<DynamicAgentsTab />);

    await act(async () => {
      await Promise.resolve();
    });

    fetchMock.mockClear();
    fireEvent.click(screen.getByText("2"));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith("/api/dynamic-agents?page=2&page_size=20");
    });
  });

  it("calls fetch with the updated page_size and resets to page 1 when rows-per-page changes", async () => {
    fetchMock.mockImplementation(() =>
      Promise.resolve(
        jsonResponse({
          success: true,
          data: { items: [makeAgent()], total: 100 },
        }),
      ),
    );

    render(<DynamicAgentsTab />);

    await act(async () => {
      await Promise.resolve();
    });

    // Move to page 2 first so we can assert the reset-to-1 behavior.
    fireEvent.click(screen.getByText("2"));
    await waitFor(() => {
      expect(fetchMock).toHaveBeenLastCalledWith("/api/dynamic-agents?page=2&page_size=20");
    });
    const pageSizeSelect = await screen.findByRole("combobox");

    fetchMock.mockClear();

    fireEvent.change(pageSizeSelect, { target: { value: "50" } });

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith("/api/dynamic-agents?page=1&page_size=50");
    });
  });

  it("shows the no-results empty state for a search term, and Clear search resets search + refetches", async () => {
    fetchMock.mockImplementation((url: string) => {
      const isSearching = url.includes("search=zzz-no-match");
      return Promise.resolve(
        jsonResponse({
          success: true,
          data: {
            items: isSearching ? [] : [makeAgent()],
            total: isSearching ? 0 : 1,
          },
        }),
      );
    });

    render(<DynamicAgentsTab />);

    await act(async () => {
      await Promise.resolve();
    });

    fireEvent.change(screen.getByPlaceholderText("Search by name or ID..."), {
      target: { value: "zzz-no-match" },
    });

    await act(async () => {
      jest.advanceTimersByTime(300);
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(fetchMock).toHaveBeenLastCalledWith(
        "/api/dynamic-agents?page=1&page_size=20&search=zzz-no-match",
      );
    });

    expect(await screen.findByText('No agents match "zzz-no-match"')).toBeInTheDocument();
    const clearButton = screen.getByRole("button", { name: "Clear search" });

    fetchMock.mockClear();
    fireEvent.click(clearButton);

    await act(async () => {
      await Promise.resolve();
    });

    expect(screen.getByPlaceholderText("Search by name or ID...")).toHaveValue("");
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith("/api/dynamic-agents?page=1&page_size=20");
    });
    await screen.findByText("Ops Helper");
  });

  it("loads a directly linked agent and keeps its setup step and close action URL-controlled", async () => {
    const onSelectedAgentChange = jest.fn();
    const onStepChange = jest.fn();
    fetchMock.mockImplementation((url: string) => {
      if (url === "/api/dynamic-agents/agents/agent-1") {
        return Promise.resolve(jsonResponse({ success: true, data: makeAgent() }));
      }
      return Promise.resolve(
        jsonResponse({ success: true, data: { items: [makeAgent()], total: 1 } }),
      );
    });

    render(
      <DynamicAgentsTab
        selectedAgentId="agent-1"
        initialStep="instructions"
        onSelectedAgentChange={onSelectedAgentChange}
        onStepChange={onStepChange}
      />,
    );

    const editor = await screen.findByTestId("dynamic-agent-editor");
    expect(fetchMock).toHaveBeenCalledWith("/api/dynamic-agents/agents/agent-1");
    expect(editor).toHaveAttribute("data-agent-id", "agent-1");
    expect(editor).toHaveAttribute("data-step", "instructions");

    fireEvent.click(screen.getByRole("button", { name: "Editor tools step" }));
    expect(onStepChange).toHaveBeenCalledWith("tools");

    fireEvent.click(screen.getByRole("button", { name: "Close editor" }));
    expect(onSelectedAgentChange).toHaveBeenCalledWith(null);
  });

  it("shows an editor-shaped skeleton while a directly linked agent loads", async () => {
    let resolveAgent!: (response: Response) => void;
    fetchMock.mockImplementation((url: string) => {
      if (url === "/api/dynamic-agents/agents/agent-1") {
        return new Promise<Response>((resolve) => {
          resolveAgent = resolve;
        });
      }
      return Promise.resolve(
        jsonResponse({ success: true, data: { items: [makeAgent()], total: 1 } }),
      );
    });

    render(<DynamicAgentsTab selectedAgentId="agent-1" />);

    expect(screen.getByTestId("agent-editor-skeleton")).toBeInTheDocument();
    expect(screen.getByText("Loading agent...")).toBeInTheDocument();

    await act(async () => {
      resolveAgent(jsonResponse({ success: true, data: makeAgent() }));
      await Promise.resolve();
    });

    expect(await screen.findByTestId("dynamic-agent-editor")).toBeInTheDocument();
    expect(screen.queryByTestId("agent-editor-skeleton")).not.toBeInTheDocument();
  });

  it("keeps the selected row open when the page adds the agent ID to the URL", async () => {
    const onSelectedAgentChange = jest.fn();
    const { rerender } = render(
      <DynamicAgentsTab onSelectedAgentChange={onSelectedAgentChange} />,
    );

    fireEvent.click(await screen.findByText("Ops Helper"));

    expect(onSelectedAgentChange).toHaveBeenCalledWith("agent-1");
    expect(screen.getByTestId("dynamic-agent-editor")).toHaveAttribute(
      "data-agent-id",
      "agent-1",
    );

    fetchMock.mockClear();
    rerender(
      <DynamicAgentsTab
        selectedAgentId="agent-1"
        onSelectedAgentChange={onSelectedAgentChange}
      />,
    );

    expect(fetchMock).not.toHaveBeenCalledWith("/api/dynamic-agents/agents/agent-1");
    expect(screen.getByTestId("dynamic-agent-editor")).toHaveAttribute(
      "data-agent-id",
      "agent-1",
    );
  });
  it("no longer renders the autonomous enablement or task controls", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        success: true,
        data: {
          items: [
            makeAgent({
              _id: "deploy-agent",
              name: "Deploy Agent",
              owner_team_slug: "primary",
              permissions: {
                can_manage: true,
                can_write: true,
                can_discover: true,
              },
            }),
          ],
          total: 1,
        },
      }),
    );

    render(<DynamicAgentsTab />);
    await act(async () => {
      await Promise.resolve();
    });

    await waitFor(() => expect(screen.getByText("Deploy Agent")).toBeInTheDocument());
    expect(screen.queryByLabelText(/enable autonomous/i)).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/disable autonomous/i)).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/autonomous status/i)).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/manage autonomous tasks/i)).not.toBeInTheDocument();
  });
});
