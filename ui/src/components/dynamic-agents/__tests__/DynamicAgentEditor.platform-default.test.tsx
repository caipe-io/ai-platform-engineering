/**
 * Platform-default and global-visibility OpenFGA grant preview on DynamicAgentEditor.
 */

import React from "react";
import { render, screen, act, fireEvent } from "@testing-library/react";

jest.mock("@uiw/react-codemirror", () => ({
  __esModule: true,
  default: ({ value, onChange }: { value?: string; onChange?: (v: string) => void }) => (
    <textarea
      data-testid="codemirror-mock"
      value={value || ""}
      onChange={(e) => onChange?.(e.target.value)}
    />
  ),
}));

jest.mock("@codemirror/lang-markdown", () => ({ markdown: () => ({}) }));
jest.mock("@codemirror/language-data", () => ({ languages: [] }));
jest.mock("@codemirror/view", () => ({ EditorView: { lineWrapping: {} } }));
jest.mock("@/lib/codemirror/jinja2-highlight", () => ({ jinja2Highlight: {} }));
jest.mock("@/lib/codemirror/markdown-highlight", () => ({ markdownHighlight: {} }));

jest.mock("@/components/dynamic-agents/AllowedToolsPicker", () => ({
  AllowedToolsPicker: () => <div data-testid="allowed-tools-picker" />,
}));
jest.mock("@/components/dynamic-agents/BuiltinToolsPicker", () => ({
  BuiltinToolsPicker: () => <div data-testid="builtin-tools-picker" />,
}));
jest.mock("@/components/dynamic-agents/MiddlewarePicker", () => ({
  MiddlewarePicker: () => <div data-testid="middleware-picker" />,
}));
jest.mock("@/components/dynamic-agents/SubagentPicker", () => ({
  SubagentPicker: () => <div data-testid="subagent-picker" />,
}));
jest.mock("@/components/dynamic-agents/SkillsSelector", () => ({
  SkillsSelector: () => <div data-testid="skills-selector" />,
}));

jest.mock("react-markdown", () => ({
  __esModule: true,
  default: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));
jest.mock("remark-gfm", () => ({}));
jest.mock("@/lib/markdown-components", () => ({ getMarkdownComponents: () => ({}) }));

jest.mock("@/components/ui/toast", () => ({
  useToast: () => ({ toast: jest.fn() }),
}));

jest.mock("framer-motion", () => ({
  __esModule: true,
  motion: new Proxy(
    {},
    {
      get:
        () =>
        ({ children, ...props }: { children?: React.ReactNode; [k: string]: unknown }) =>
          <div {...(props as object)}>{children}</div>,
    },
  ),
  AnimatePresence: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

import { DynamicAgentEditor } from "../DynamicAgentEditor";

function jsonResponse(body: unknown) {
  return {
    ok: true,
    status: 200,
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

const editAgent = {
  _id: "hello-world",
  name: "Hello-world",
  description: "Default starter agent",
  system_prompt: "You are helpful.",
  allowed_tools: {},
  builtin_tools: undefined,
  model: { id: "gpt-4o", provider: "openai" as const },
  visibility: "team" as const,
  owner_team_slug: "platform",
  owner_team_id: "team-1",
  shared_with_teams: [],
  subagents: [],
  skills: [],
  ui: { gradient_theme: "default" as const },
  enabled: true,
  owner_id: "user-1",
  is_system: false,
  created_at: "2026-04-29T00:00:00Z",
  updated_at: "2026-04-29T00:00:00Z",
};

function mockFetch(platformDefaultId: string | null, includeHarnesses = false) {
  const fetchMock = jest.fn(async (url: RequestInfo | URL) => {
    const u = typeof url === "string" ? url : url.toString();
    if (u.includes("/api/dynamic-agents/models")) {
      return jsonResponse({
        success: true,
        data: [{ model_id: "gpt-4o", name: "GPT-4o", provider: "openai", description: "" }],
      });
    }
    if (u.includes("/api/dynamic-agents/teams")) {
      return jsonResponse({
        success: true,
        data: [
          { _id: "team-1", slug: "platform", name: "Platform", can_own_agents: true, user_role: "admin" },
        ],
      });
    }
    if (u.includes("/api/admin/platform-config")) {
      return jsonResponse({
        success: true,
        data: platformDefaultId ? { default_agent_id: platformDefaultId } : {},
      });
    }
    if (u.endsWith("/api/harness-engine/harnesses")) {
      return jsonResponse({
        success: true,
        data: {
          catalog_revision: "catalog-1",
          harnesses: includeHarnesses ? [{
            id: "claude_agent_sdk",
            display_name: "Claude Agent SDK",
            adapter_version: "1.0.0",
            contract_version: 1,
            execution_mode: "in_process",
            availability: "available",
            certification: "experimental",
            profiles: [{
              id: "safe",
              harness_id: "claude_agent_sdk",
              display_name: "Safe",
              description: "",
              available: true,
            }],
            options_schema: {
              type: "object",
              properties: {
                max_turns: { type: "integer", title: "Maximum turns", default: 20 },
              },
            },
            ui_schema: {},
            capabilities: {},
          }] : [],
        },
      });
    }
    return jsonResponse({ success: true, data: {} });
  });
  // @ts-expect-error test override
  global.fetch = fetchMock;
  return fetchMock;
}

async function flushAsync() {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 50));
  });
}

describe("DynamicAgentEditor — platform default grant preview", () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("shows the platform-default visibility note when the agent is the platform default", async () => {
    mockFetch("hello-world");
    render(<DynamicAgentEditor agent={editAgent} onCancel={jest.fn()} onSave={jest.fn()} />);
    await flushAsync();

    // The shared TeamOwnershipFields "Effective access summary" grant preview
    // (including its user:* platform-default line) was intentionally removed;
    // the platform-default note remains the user-facing signal here.
    expect(await screen.findByTestId("platform-default-visibility-note")).toBeInTheDocument();
  });

  it("shows concise global visibility guidance without backend terms", async () => {
    mockFetch(null);
    const globalAgent = { ...editAgent, _id: "agent-global", visibility: "global" as const };
    render(<DynamicAgentEditor agent={globalAgent} onCancel={jest.fn()} onSave={jest.fn()} />);
    await flushAsync();

    const option = await screen.findByRole("button", { name: /Global Every signed-in user/i });
    expect(option).toBeInTheDocument();
    // Backend implementation details must not leak into the UX.
    expect(option).not.toHaveTextContent("user:*");
    expect(option).not.toHaveTextContent("OpenFGA");
  });

  it("renders provider options from the selected harness descriptor", async () => {
    mockFetch(null, true);
    render(<DynamicAgentEditor agent={editAgent} onCancel={jest.fn()} onSave={jest.fn()} />);
    await flushAsync();

    fireEvent.change(screen.getByLabelText("Execution harness"), {
      target: { value: "claude_agent_sdk" },
    });

    expect(screen.getByLabelText("Operator profile")).toHaveValue("safe");
    expect(screen.getByText(/Profiles are managed by your administrator/)).toBeInTheDocument();

    fireEvent.focus(screen.getByRole("button", { name: "About operator profiles" }));
    expect(screen.getByRole("tooltip")).toHaveTextContent(
      "An operator profile is an administrator-managed execution configuration",
    );
    expect(screen.getByRole("tooltip")).toHaveTextContent(
      "without exposing credentials or infrastructure identifiers",
    );
    fireEvent.click(screen.getByRole("button", { name: /Advanced/i }));
    expect(screen.getByLabelText("Maximum turns")).toHaveValue(20);
  });

  it("validates a provider blueprint before updating existing agent metadata", async () => {
    const fetchMock = mockFetch(null, true);
    render(<DynamicAgentEditor agent={editAgent} onCancel={jest.fn()} onSave={jest.fn()} />);
    await flushAsync();

    fireEvent.change(screen.getByLabelText("Execution harness"), {
      target: { value: "claude_agent_sdk" },
    });
    fireEvent.click(screen.getByRole("button", { name: /Save Changes/i }));
    await flushAsync();

    const validationCallIndex = fetchMock.mock.calls.findIndex(
      ([url, init]) =>
        String(url).endsWith("/api/harness-engine/agent-drafts/validate") &&
        init?.method === "POST",
    );
    const metadataMutationIndex = fetchMock.mock.calls.findIndex(
      ([url, init]) =>
        String(url).startsWith("/api/dynamic-agents?id=") &&
        init?.method === "PUT",
    );

    expect(validationCallIndex).toBeGreaterThanOrEqual(0);
    expect(metadataMutationIndex).toBe(-1);
    expect(await screen.findByText(/agent was not saved/i)).toBeInTheDocument();
  });

  it("rolls back a newly created agent when its provider blueprint cannot be persisted", async () => {
    mockFetch(null, true);
    const onSave = jest.fn();
    render(<DynamicAgentEditor onCancel={jest.fn()} onSave={onSave} />);
    await flushAsync();

    fireEvent.change(screen.getByPlaceholderText(/Code Review Agent/i), {
      target: { value: "Provider Agent" },
    });
    fireEvent.click(screen.getByRole("button", { name: /^Global/ }));
    fireEvent.change(screen.getByLabelText("Execution harness"), {
      target: { value: "claude_agent_sdk" },
    });
    fireEvent.click(screen.getByRole("button", { name: /^\d+\s+Instructions$/i }));
    fireEvent.change(await screen.findByTestId("codemirror-mock"), {
      target: { value: "You are a provider-backed agent." },
    });

    const saveFetch = jest.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      const path = String(url);
      if (path.endsWith("/api/harness-engine/agent-drafts/validate")) {
        const request = JSON.parse(String(init?.body)) as { blueprint: AgentBlueprint };
        return jsonResponse({
          success: true,
          data: {
            valid: true,
            normalized_blueprint: request.blueprint,
            catalog_revision: "catalog-1",
            config_fingerprint: "fingerprint-1",
          },
        });
      }
      if (path === "/api/dynamic-agents" && init?.method === "POST") {
        return jsonResponse({ success: true, data: { _id: "agent-provider-agent" } });
      }
      if (path.includes("/api/harness-engine/agents/") && init?.method === "PUT") {
        return {
          ok: false,
          status: 503,
          json: async () => ({ success: false, error: "provider unavailable" }),
          text: async () => "provider unavailable",
        };
      }
      if (path.startsWith("/api/dynamic-agents?id=") && init?.method === "DELETE") {
        return jsonResponse({ success: true });
      }
      return jsonResponse({ success: true, data: {} });
    });
    // @ts-expect-error test override
    global.fetch = saveFetch;

    fireEvent.click(screen.getByRole("button", { name: /Create Agent/i }));
    await flushAsync();

    const writes = saveFetch.mock.calls.map(([url, init]) => [String(url), init?.method]);
    expect(writes).toEqual([
      ["/api/harness-engine/agent-drafts/validate", "POST"],
      ["/api/dynamic-agents", "POST"],
      ["/api/harness-engine/agents/agent-provider-agent", "PUT"],
      ["/api/dynamic-agents?id=agent-provider-agent", "DELETE"],
    ]);
    expect(await screen.findByText(/creation was rolled back/i)).toBeInTheDocument();
    expect(onSave).not.toHaveBeenCalled();
  });

  it("labels the compatibility harness as LangChain Deep Agents while preserving its ID", async () => {
    mockFetch(null);
    render(<DynamicAgentEditor agent={editAgent} onCancel={jest.fn()} onSave={jest.fn()} />);
    await flushAsync();

    expect(
      screen.getByRole("option", { name: "LangChain Deep Agents (default) — Stable" }),
    ).toHaveValue("dynamic_agents");
    expect(screen.getByLabelText("Execution harness")).toHaveValue("dynamic_agents");
    expect(
      screen.getByText(/Configure tools, knowledge, and skills for LangChain Deep/),
    ).toBeInTheDocument();
  });
});
