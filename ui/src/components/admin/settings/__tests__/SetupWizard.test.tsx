import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { SetupWizardDialog, SetupWizardGate, SetupWizardSettings } from "../SetupWizard";

const mockPush = jest.fn();
jest.mock("next/navigation", () => ({
  useRouter: () => ({ push: mockPush }),
  usePathname: () => "/",
}));

jest.mock("@/hooks/use-admin-role", () => ({
  useAdminRole: () => ({ isAdmin: true, loading: false }),
}));

jest.mock("@/lib/config", () => ({
  getConfig: (key: string) => key === "setupWizardEnabled" ? true : undefined,
  getLogoFilterClass: () => "",
}));

jest.mock("@/components/ui/caipe-spinner", () => ({
  CAIPESpinner: ({ message }: { message?: string }) => <div>{message ?? "Loading"}</div>,
}));

const setupPayload = {
  success: true,
  data: {
    auto_start: false,
    enabled: true,
    fresh_install: false,
    inventory: {
      agents: 1,
      custom_agents: 1,
      conversations: 1,
      knowledge_sources: 0,
      mcp_servers: 1,
      models: 1,
      users: 1,
    },
    state: {
      version: 1,
      status: "completed",
      current_step: 5,
      completed_steps: [1, 2, 3, 4, 5],
      skipped_steps: [],
      created_agent_id: "agent-sre-starter",
      completed_at: "2026-09-17T00:00:00.000Z",
      run_count: 1,
    },
  },
};

function response(data: unknown, status = 200): Promise<Response> {
  return Promise.resolve({
    ok: status >= 200 && status < 300,
    status,
    json: async () => data,
  } as Response);
}

describe("SetupWizardSettings", () => {
  beforeEach(() => {
    mockPush.mockClear();
    global.fetch = jest.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "/api/admin/setup-wizard" && init?.method === "PATCH") {
        return response({
          success: true,
          data: {
            state: {
              ...setupPayload.data.state,
              status: "in_progress",
              current_step: 1,
              completed_steps: [],
            },
          },
        });
      }
      if (url === "/api/admin/setup-wizard") return response(setupPayload);
      if (url.startsWith("/api/platform/health")) {
        return response({
          status: "healthy",
          capabilities: [{
            id: "dynamic-agents",
            label: "Dynamic Agents",
            status: "healthy",
            detail: "Runtime reachable",
            required: true,
          }],
        });
      }
      if (url.startsWith("/api/llm-models")) {
        return response({ success: true, data: { items: [{ _id: "model-primary", name: "Primary", provider: "openai" }] } });
      }
      if (url.startsWith("/api/mcp-servers")) {
        return response({ success: true, data: { items: [{ _id: "netutils", name: "Network utilities", enabled: true }] } });
      }
      if (url === "/api/credentials/connections") {
        return response({ success: true, data: [{ id: "connection-github", provider: "github", status: "connected" }] });
      }
      if (url === "/api/credentials/oauth-connectors") {
        return response({ success: true, data: [
          { id: "connector-github", name: "GitHub", provider: "github", enabled: true },
          { id: "connector-notion", name: "Notion", provider: "notion", enabled: true },
        ] });
      }
      return response({ error: "Not found" }, 404);
    }) as jest.Mock;
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("shows saved completion status and allows an admin to rerun setup", async () => {
    render(<SetupWizardSettings />);

    expect((await screen.findAllByText("Completed")).length).toBeGreaterThan(0);
    expect(screen.getByText("agent-sre-starter")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /run setup again/i }));

    expect(await screen.findByRole("heading", { name: "Welcome" })).toBeInTheDocument();
    await waitFor(() => {
      expect(global.fetch).toHaveBeenCalledWith(
        "/api/admin/setup-wizard",
        expect.objectContaining({ method: "PATCH" }),
      );
    });
  });

  it("keeps manual setup available when automatic prompting is disabled", async () => {
    const fetchMock = global.fetch as jest.Mock;
    fetchMock.mockImplementation((input: RequestInfo | URL) => {
      if (String(input) === "/api/admin/setup-wizard") {
        return response({
          ...setupPayload,
          data: {
            ...setupPayload.data,
            enabled: false,
            state: { ...setupPayload.data.state, status: "dismissed", current_step: 3 },
          },
        });
      }
      return response({ error: "Not found" }, 404);
    });

    render(<SetupWizardSettings />);

    const resume = await screen.findByRole("button", { name: /resume setup/i });
    expect(resume).toBeEnabled();
    expect(screen.getByText(/automatic setup is disabled/i)).toBeInTheDocument();
  });

  it("keeps the add-model flow available when a model was discovered", async () => {
    render(<SetupWizardDialog open onOpenChange={jest.fn()} />);

    expect(await screen.findByRole("heading", { name: "Try your agent" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Choose a model" }));

    expect(await screen.findByRole("button", { name: /add another model/i })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /add another model/i }));
    expect(screen.getByLabelText("Model ID")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Add model" })).toBeDisabled();
  });

  it("creates a starter agent and completes an end-to-end smoke test", async () => {
    const freshPayload = {
      ...setupPayload,
      data: {
        ...setupPayload.data,
        auto_start: true,
        fresh_install: true,
        state: {
          version: 1,
          status: "not_started",
          current_step: 1,
          completed_steps: [],
          skipped_steps: [],
          run_count: 0,
        },
      },
    };
    global.fetch = jest.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "/api/admin/setup-wizard" && init?.method === "PATCH") {
        const body = JSON.parse(String(init.body)) as { action: string; current_step?: number };
        return response({
          success: true,
          data: {
            state: {
              ...freshPayload.data.state,
              status: body.action === "complete" ? "completed" : "in_progress",
              current_step: body.current_step ?? 1,
              created_agent_id: body.action === "complete" ? "agent-sre-starter" : undefined,
            },
          },
        });
      }
      if (url === "/api/admin/setup-wizard") return response(freshPayload);
      if (url.startsWith("/api/platform/health")) {
        return response({
          status: "healthy",
          capabilities: [{
            id: "dynamic-agents",
            label: "Dynamic Agents",
            status: "healthy",
            detail: "Runtime reachable",
            required: true,
          }],
        });
      }
      if (url.startsWith("/api/llm-models")) {
        return response({ success: true, data: { items: [{ _id: "model-primary", name: "Primary", provider: "openai" }] } });
      }
      if (url.startsWith("/api/mcp-servers")) {
        return response({ success: true, data: { items: [{ _id: "netutils", name: "Network utilities", enabled: true }] } });
      }
      if (url === "/api/dynamic-agents" && init?.method === "POST") {
        return response({ success: true, data: { _id: "agent-sre-starter" } }, 201);
      }
      if (url === "/api/chat/conversations" && init?.method === "POST") {
        return response({ success: true, data: { conversation: { _id: "conversation-setup" }, created: true } }, 201);
      }
      if (url === "/api/v1/chat/invoke" && init?.method === "POST") {
        return response({ content: "Starter agent is ready." });
      }
      return response({ error: "Not found" }, 404);
    }) as jest.Mock;

    render(<SetupWizardDialog open onOpenChange={jest.fn()} />);

    expect(await screen.findByRole("heading", { name: "Welcome" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /get started/i }));
    expect(await screen.findByRole("heading", { name: "Choose a model" })).toBeInTheDocument();
    fireEvent.click(screen.getAllByRole("button", { name: "Choose an agent" }).at(-1)!);
    expect(await screen.findByRole("heading", { name: "Choose an agent" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /add optional context/i }));
    expect(await screen.findByRole("heading", { name: "Add context" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /skip this step/i }));
    expect(await screen.findByRole("heading", { name: "Try your agent" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /create agent and run test/i }));

    expect(await screen.findByText("Your starter agent is working")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /open test chat/i })).toHaveAttribute("href", "/chat/conversation-setup");
    expect(global.fetch).toHaveBeenCalledWith(
      "/api/v1/chat/invoke",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("guides first-time users through credentials and remote MCP onboarding", async () => {
    render(<SetupWizardDialog open onOpenChange={jest.fn()} />);

    expect(await screen.findByRole("heading", { name: "Try your agent" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Add context" }));

    expect(await screen.findByText("Connect credentials")).toBeInTheDocument();
    expect(screen.getByText("Connected", { selector: "p" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Connect" })).toHaveAttribute(
      "href",
      "/api/credentials/oauth/notion/connect",
    );
    expect(screen.getByRole("link", { name: /Manage connected credentials/i })).toHaveAttribute(
      "href",
      "/credentials/connections",
    );
    fireEvent.click(screen.getByRole("button", { name: "Tools", exact: true }));
    expect(screen.getAllByRole("link", { name: /Add from catalog/i })).toHaveLength(2);
  });

  it("saves the selected step before minimizing and navigating to provider access", async () => {
    const originalFetch = global.fetch;
    global.fetch = jest.fn((input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) === "/api/admin/setup-wizard" && !init?.method) {
        return response({ ...setupPayload, data: { ...setupPayload.data, state: { ...setupPayload.data.state, status: "in_progress", current_step: 2 } } });
      }
      return originalFetch(input, init);
    }) as jest.Mock;
    const onOpenChange = jest.fn();
    render(<SetupWizardDialog open onOpenChange={onOpenChange} />);
    await screen.findByRole("heading", { name: "Choose a model" });
    fireEvent.click(screen.getAllByRole("link", { name: /Configure provider access/i })[0]);
    await waitFor(() => expect(global.fetch).toHaveBeenCalledWith("/api/admin/setup-wizard", expect.objectContaining({
      method: "PATCH",
      body: expect.stringContaining('"current_step":2'),
    })));
    expect(mockPush).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.getByRole("dialog")).toHaveClass("setup-minimizing"));
    await waitFor(() => expect(mockPush).toHaveBeenCalledWith("/dynamic-agents?tab=model-providers"));
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("keeps the draft open when saving a handoff fails", async () => {
    const originalFetch = global.fetch;
    global.fetch = jest.fn((input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) === "/api/admin/setup-wizard") {
        if (init?.method === "PATCH") return response({ error: "Could not save your place" }, 500);
        return response({ ...setupPayload, data: { ...setupPayload.data, state: { ...setupPayload.data.state, status: "in_progress", current_step: 4 } } });
      }
      return originalFetch(input, init);
    }) as jest.Mock;
    const onOpenChange = jest.fn();
    render(<SetupWizardDialog open onOpenChange={onOpenChange} />);
    await screen.findByRole("heading", { name: "Add context" });
    fireEvent.click(screen.getByRole("link", { name: /Manage connected credentials/i }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Could not save your place");
    expect(mockPush).not.toHaveBeenCalled();
    expect(onOpenChange).not.toHaveBeenCalled();
  });

  it("offers one-click resume after manually minimizing previously completed setup", async () => {
    const originalFetch = global.fetch;
    const saved = { ...setupPayload.data, state: { ...setupPayload.data.state, current_step: 2, checklist_hidden: true } };
    global.fetch = jest.fn((input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) === "/api/admin/setup-wizard" && !init?.method) return response({ success: true, data: saved });
      return originalFetch(input, init);
    }) as jest.Mock;
    render(<SetupWizardGate />);
    await waitFor(() => expect(global.fetch).toHaveBeenCalled());
    expect(screen.queryByRole("button", { name: "Resume setup", exact: true })).not.toBeInTheDocument();
    act(() => { window.dispatchEvent(new CustomEvent("caipe:setup-minimized", { detail: saved })); });
    fireEvent.click(await screen.findByRole("button", { name: "Resume setup", exact: true }));
    expect(await screen.findByRole("heading", { name: "Choose a model" })).toBeInTheDocument();
  });

  it("links to Platform Health instead of duplicating diagnostics and remediation", async () => {
    const freshPayload = {
      ...setupPayload,
      data: {
        ...setupPayload.data,
        fresh_install: true,
        state: {
          ...setupPayload.data.state,
          status: "not_started",
          current_step: 1,
          completed_steps: [],
          skipped_steps: [],
        },
      },
    };
    global.fetch = jest.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "/api/admin/setup-wizard" && init?.method === "PATCH") {
        return response({
          success: true,
          data: { state: { ...freshPayload.data.state, status: "in_progress" } },
        });
      }
      if (url === "/api/admin/setup-wizard") return response(freshPayload);
      if (url.startsWith("/api/platform/health")) {
        return response({
          status: "degraded",
          capabilities: [{
            id: "knowledge-bases",
            label: "Knowledge Bases",
            status: "degraded",
            detail: "Knowledge Bases health check is unreachable",
            required: false,
          }],
          probes: [
            { id: "rag-server", label: "RAG server", status: "down", detail: "RAG server is not reachable" },
            { id: "rebac-migrations", label: "RBAC Migrations", status: "warning", detail: "23 blocking migrations pending", remediation: { href: "/admin/security", label: "Migration Assistant" } },
          ],
        });
      }
      if (url.startsWith("/api/llm-models")) {
        return response({ success: true, data: { items: [{ _id: "model-primary", name: "Primary", provider: "openai" }] } });
      }
      if (url.startsWith("/api/mcp-servers")) {
        return response({ success: true, data: { items: [] } });
      }
      if (url === "/api/admin/rebac/migrations/apply-all" && init?.method === "POST") {
        return response({ success: true, data: { applied_count: 23, failed_count: 0, skipped_count: 0 } });
      }
      return response({ error: "Not found" }, 404);
    }) as jest.Mock;

    render(<SetupWizardDialog open onOpenChange={jest.fn()} />);

    expect(await screen.findByRole("link", { name: "Open Platform Health" })).toHaveAttribute("href", "/admin/operations/health");
    expect(screen.queryByText("Platform services")).not.toBeInTheDocument();
    expect(screen.queryByText("Readiness checks")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Auto-remediate" })).not.toBeInTheDocument();

  });
});
