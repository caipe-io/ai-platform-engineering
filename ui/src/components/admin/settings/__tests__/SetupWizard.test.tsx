import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { SetupWizardDialog, SetupWizardSettings } from "../SetupWizard";

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

    expect(await screen.findByRole("heading", { name: "Readiness" })).toBeInTheDocument();
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

    expect(await screen.findByRole("heading", { name: "Readiness" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /continue/i }));
    expect(await screen.findByRole("heading", { name: "Model" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /continue/i }));
    expect(await screen.findByRole("heading", { name: "Agent" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /continue/i }));
    expect(await screen.findByRole("heading", { name: "Knowledge & tools" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /skip this step/i }));
    expect(await screen.findByRole("heading", { name: "Test" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /create agent and run test/i }));

    expect(await screen.findByText("Your starter agent is working")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /open test chat/i })).toHaveAttribute("href", "/chat/conversation-setup");
    expect(global.fetch).toHaveBeenCalledWith(
      "/api/v1/chat/invoke",
      expect.objectContaining({ method: "POST" }),
    );
  });
});
