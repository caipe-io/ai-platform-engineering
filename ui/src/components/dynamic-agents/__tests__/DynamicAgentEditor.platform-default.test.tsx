/**
 * Platform-default and global-visibility OpenFGA grant preview on DynamicAgentEditor.
 */

import React from "react";
import { render, screen, act, fireEvent, within } from "@testing-library/react";

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
jest.mock("@/components/dynamic-agents/DelegatedAgentsPicker", () => ({
  DelegatedAgentsPicker: () => <div data-testid="subagent-picker" />,
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

function mockFetch(platformDefaultId: string | null, includeHarnesses: boolean | "claude-acp" | "claude-cli-acp" = false) {
  const harnessId = includeHarnesses === "claude-cli-acp" ? "claude_code_cli_acp" : includeHarnesses === "claude-acp" ? "claude_code_acp" : "claude_agent_sdk";
  const fetchMock = jest.fn(async (url: RequestInfo | URL, _init?: RequestInit) => {
    void _init;
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
            id: harnessId,
            display_name: includeHarnesses === "claude-cli-acp" ? "Claude Code CLI (ACP)" : includeHarnesses === "claude-acp" ? "Claude Agent SDK (ACP)" : "Claude Agent SDK",
            adapter_version: "1.0.0",
            contract_version: 1,
            execution_mode: "in_process",
            availability: "available",
            certification: "experimental",
            profiles: [{
              id: "safe",
              harness_id: harnessId,
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
            capabilities: typeof includeHarnesses === "string" ? { "tools.broker": { level: "emulated", constraints: { approval_policy: ["never"] } } } : {},
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

  it("shows a plain-language global visibility summary (no backend/OpenFGA terms) when visibility is global", async () => {
    mockFetch(null);
    const globalAgent = { ...editAgent, _id: "agent-global", visibility: "global" as const };
    render(<DynamicAgentEditor agent={globalAgent} onCancel={jest.fn()} onSave={jest.fn()} />);
    await flushAsync();

    const preview = await screen.findByTestId("global-visibility-grant-preview");
    expect(preview).toHaveTextContent("Everyone can use this agent");
    expect(preview).toHaveTextContent("every signed-in user");
    // Backend implementation details must not leak into the UX.
    expect(preview).not.toHaveTextContent("user:*");
    expect(preview).not.toHaveTextContent("OpenFGA");
  });

  it("renders provider options from the selected harness descriptor", async () => {
    mockFetch(null, true);
    render(<DynamicAgentEditor agent={editAgent} onCancel={jest.fn()} onSave={jest.fn()} />);
    await flushAsync();

    fireEvent.change(screen.getByLabelText("Execution harness"), {
      target: { value: "claude_agent_sdk" },
    });

    expect(screen.getByLabelText("Operator profile")).toHaveValue(JSON.stringify(["claude_agent_sdk", "safe"]));
    expect(screen.getByText(/Profiles are managed by your administrator/)).toBeInTheDocument();

    fireEvent.focus(screen.getByRole("button", { name: "About operator profiles" }));
    expect(screen.getByRole("tooltip")).toHaveTextContent(
      "An operator profile is an administrator-managed execution configuration",
    );
    expect(screen.getByRole("tooltip")).toHaveTextContent(
      "without exposing credentials or infrastructure identifiers",
    );
    fireEvent.click(screen.getByRole("button", { name: /Advanced/i }));
    expect(screen.getByLabelText("Maximum turns")).toHaveValue("20");
  });

  it("validates a provider blueprint before updating existing agent metadata", async () => {
    const fetchMock = mockFetch(null, true);
    render(<DynamicAgentEditor agent={editAgent} onCancel={jest.fn()} onSave={jest.fn()} />);
    await flushAsync();

    fireEvent.change(screen.getByLabelText("Execution harness"), {
      target: { value: "claude_agent_sdk" },
    });
    fireEvent.click(screen.getByRole("checkbox", { name: /existing conversations keep/i }));
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

  it("keeps creation unsuccessful when atomic server publication fails", async () => {
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
        return jsonResponse({ success: false, error: "Execution configuration could not be prepared; the agent was not changed" });
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
    ]);
    expect(await screen.findByText(/agent was not changed/i)).toBeInTheDocument();
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

  it("explains local SDK, SDK ACP, and CLI execution through the information control", async () => {
    mockFetch(null, true);
    render(<DynamicAgentEditor agent={editAgent} onCancel={jest.fn()} onSave={jest.fn()} />);
    await flushAsync();
    fireEvent.click(screen.getByRole("button", { name: "About agent runtimes" }));
    const guide = screen.getByRole("dialog", { name: "Choose how your agent runs" });
    expect(within(guide).getByText(/local execution inside Harness Engine/)).toBeInTheDocument();
    expect(within(guide).getByText(/Agent Client Protocol \(ACP\) adapter process/)).toBeInTheDocument();
    expect(within(guide).getByText(/Claude Code command-line application/)).toBeInTheDocument();
    expect(within(guide).getAllByText("Experimental")).toHaveLength(4);
    expect(within(guide).getAllByText("Stable")).toHaveLength(1);
    expect(screen.getByLabelText("Execution harness")).toHaveValue("dynamic_agents");
  });

  it.each([
    ["agentcore", "Amazon Bedrock AgentCore (Remote sessions)"],
    ["claude_agent_sdk", "Claude Agent SDK"],
    ["claude_agent_sdk_remote", "Claude Agent SDK"],
    ["claude_code_acp", "Claude Agent SDK (Advanced ACP)"],
    ["claude_code_cli_acp", "Claude Code"],
  ])("keeps configured %s selectable by default and labels it experimental", async (id, label) => {
    const fetchMock = mockFetch(null, true);
    const implementation = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation(async (url, init) => {
      const result = await implementation(url, init);
      if (String(url).endsWith("/api/harness-engine/harnesses")) {
        const body = await result.json();
        Object.assign(body.data.harnesses[0], { id, display_name: label, certification: "certified" });
        return jsonResponse(body);
      }
      return result;
    });
    render(<DynamicAgentEditor agent={null} onCancel={jest.fn()} onSave={jest.fn()} />);
    await flushAsync();
    expect(screen.getByLabelText("Execution harness")).toHaveValue("dynamic_agents");
    if (id === "claude_code_acp") {
      expect(screen.queryByRole("option", { name: `${label} — Experimental` })).not.toBeInTheDocument();
      fireEvent.click(screen.getByLabelText("Show advanced runtimes"));
    }
    expect(screen.getByRole("option", { name: `${label} — Experimental` })).toBeEnabled();
  });
});


it.each([["claude-acp", "claude_code_acp"], ["claude-cli-acp", "claude_code_cli_acp"]] as const)("prepares a %s blueprint with its profile and caller-authorized tool policy", async (fixture, harnessId) => {
  const fetchMock = mockFetch(null, fixture);
  render(<DynamicAgentEditor agent={editAgent} onCancel={jest.fn()} onSave={jest.fn()} />);
  await flushAsync();
  if (harnessId === "claude_code_acp") fireEvent.click(screen.getByLabelText("Show advanced runtimes"));
  fireEvent.change(screen.getByLabelText("Execution harness"), { target: { value: harnessId } });
  expect(screen.getByRole("region", { name: "Claude configuration" })).toHaveTextContent("Responses continue when you refresh");
  expect(screen.getByLabelText("Operator profile")).toHaveValue("safe");
  fireEvent.click(screen.getByText("Access and authentication"));
  expect(screen.getByText(/Tool access is checked for every call/)).toBeInTheDocument();
  expect(screen.getByRole("button", { name: /Tools/ })).toBeInTheDocument();
  fireEvent.click(screen.getByRole("checkbox", { name: /existing conversations keep/i }));
  fireEvent.click(screen.getByRole("button", { name: /Save Changes/i }));
  await flushAsync();
  const call = fetchMock.mock.calls.find(([url]) => String(url).endsWith("/api/harness-engine/agent-drafts/validate"));
  expect(call).toBeDefined();
  const payload = JSON.parse(String(call?.[1]?.body));
  expect(payload.blueprint).toMatchObject({ harness: { id: harnessId, profile_id: "safe" },
    model: { policy: "harness_default" }, tools: { approval_policy: "never" }, thread: { persistence: "durable" } });
});


it.each(["claude_agent_sdk_remote", "claude_code_acp"])("preserves saved %s runtime, profile and options with grouped choices", async (runtimeId) => {
  const fetchMock = mockFetch(null, true);
  const base = fetchMock.getMockImplementation()!;
  fetchMock.mockImplementation(async (url, init) => {
    if (String(url) === "/api/harness-engine/agents/hello-world") return jsonResponse({ success: true, data: {
      record: { revision: 2 }, version: { blueprint: { harness: { id: runtimeId, profile_id: "safe", options: { max_turns: 7 } } } },
    } });
    const result = await base(url, init);
    if (String(url).endsWith("/api/harness-engine/harnesses")) {
      const body = await result.json();
      const template = body.data.harnesses[0];
      body.data.harnesses = ["claude_agent_sdk", "claude_agent_sdk_remote", "claude_code_acp"].map(id => ({ ...template, id,
        profiles: template.profiles.map((profile: object) => ({ ...profile, harness_id: id })) }));
      return jsonResponse(body);
    }
    return result;
  });
  render(<DynamicAgentEditor agent={{ ...editAgent, execution_harness_id: runtimeId }} onCancel={jest.fn()} onSave={jest.fn()} />);
  await flushAsync();
  expect(screen.getByLabelText("Execution harness")).toHaveValue(runtimeId === "claude_agent_sdk_remote" ? "claude_agent_sdk" : runtimeId);
  if (runtimeId === "claude_agent_sdk_remote") {
    expect(screen.getAllByRole("option", { name: "Claude Agent SDK — Experimental" })).toHaveLength(1);
    expect(screen.getByLabelText("Operator profile")).toHaveValue(JSON.stringify([runtimeId, "safe"]));
    fireEvent.change(screen.getByLabelText("Operator profile"), { target: { value: JSON.stringify(["claude_agent_sdk", "safe"]) } });
    expect(screen.getByRole("checkbox", { name: /existing conversations keep/i })).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Operator profile"), { target: { value: JSON.stringify([runtimeId, "safe"]) } });
  }
  expect(screen.queryByRole("checkbox", { name: /existing conversations keep/i })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: /Save Changes/i }));
  await flushAsync();
  const write = fetchMock.mock.calls.find(([url]) => String(url).endsWith("/api/harness-engine/agent-drafts/validate"));
  expect(JSON.parse(String(write?.[1]?.body)).blueprint.harness).toEqual({ id: runtimeId, profile_id: "safe", options: { max_turns: 7 } });
});
