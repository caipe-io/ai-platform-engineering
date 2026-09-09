/**
 * Platform-default and global-visibility OpenFGA grant preview on DynamicAgentEditor.
 */

import React from "react";
import { render, screen, act } from "@testing-library/react";

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

function mockFetch(platformDefaultId: string | null) {
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
    return jsonResponse({ success: true, data: {} });
  });
  // @ts-expect-error test override
  global.fetch = fetchMock;
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

  it("shows authorization reconciliation beside the agent builder", async () => {
    mockFetch(null);
    render(
      <DynamicAgentEditor
        agent={{
          ...editAgent,
          authz_sync_state: "ready",
          authz_revision: 2,
          authz_last_synced_revision: 2,
        }}
        onCancel={jest.fn()}
        onSave={jest.fn()}
      />,
    );
    await flushAsync();

    expect(screen.getByRole("status")).toHaveTextContent("Access synced");
  });
});
