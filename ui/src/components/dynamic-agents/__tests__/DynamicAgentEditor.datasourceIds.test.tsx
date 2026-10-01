/**
 * Regression test: clearing the datasource picker on an existing agent must
 * persist as an explicit empty array, not be dropped from the PUT body.
 *
 * `pickMutableFields` (ui/src/app/api/dynamic-agents/route.ts) only copies
 * fields that are `!== undefined` into Mongo's `$set`. Sending
 * `datasource_ids: undefined` when the picker is emptied would leave the
 * previously-saved restriction in place instead of clearing it.
 */

import React from "react";
import { render, screen, fireEvent, act } from "@testing-library/react";

// ============================================================================
// Mocks — must be hoisted above the component import
// ============================================================================

jest.mock("@uiw/react-codemirror", () => ({
  __esModule: true,
  default: ({
    value,
    onChange,
  }: {
    value?: string;
    onChange?: (v: string) => void;
  }) => (
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
jest.mock("@/lib/codemirror/markdown-highlight", () => ({
  markdownHighlight: {},
}));

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

jest.mock("@/components/dynamic-agents/DatasourcePicker", () => ({
  DatasourcePicker: ({
    value,
    onChange,
    collectionValue,
    onCollectionChange,
    disabled,
  }: {
    value: string[];
    onChange: (v: string[]) => void;
    collectionValue: string[];
    onCollectionChange: (v: string[]) => void;
    disabled?: boolean;
  }) => (
    <div
      data-testid="datasource-picker-mock"
      data-disabled={disabled ? "true" : "false"}
    >
      <span data-testid="datasource-picker-value">{value.join(",")}</span>
      <span data-testid="collection-picker-value">
        {collectionValue.join(",")}
      </span>
      <button type="button" onClick={() => onChange([])}>
        Clear Datasources
      </button>
      <button type="button" onClick={() => onCollectionChange([])}>
        Clear Collections
      </button>
    </div>
  ),
}));

jest.mock("react-markdown", () => ({
  __esModule: true,
  default: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
}));
jest.mock("remark-gfm", () => ({}));
jest.mock("@/lib/markdown-components", () => ({
  getMarkdownComponents: () => ({}),
}));

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
        ({
          children,
          ...props
        }: {
          children?: React.ReactNode;
          [k: string]: unknown;
        }) => <div {...(props as object)}>{children}</div>,
    },
  ),
  AnimatePresence: ({ children }: { children: React.ReactNode }) => (
    <>{children}</>
  ),
}));

// ============================================================================
// Imports — after mocks
// ============================================================================

import { DynamicAgentEditor } from "../DynamicAgentEditor";

// ============================================================================
// Helpers
// ============================================================================

function jsonResponse(body: unknown) {
  return {
    ok: true,
    status: 200,
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

function mockApi() {
  const fetchMock = jest.fn(
    async (url: RequestInfo | URL, init?: RequestInit) => {
      const u = typeof url === "string" ? url : url.toString();
      if (u.includes("/api/dynamic-agents/models")) {
        return jsonResponse({
          success: true,
          data: [
            {
              model_id: "gpt-4o",
              name: "GPT-4o",
              provider: "openai",
              description: "",
            },
          ],
        });
      }
      if (u.includes("/api/dynamic-agents/teams")) {
        return jsonResponse({
          success: true,
          data: [
            {
              _id: "team-1",
              slug: "platform",
              name: "Platform",
              can_own_agents: true,
              user_role: "admin",
            },
          ],
        });
      }
      if (init?.method === "PUT" || init?.method === "POST") {
        return jsonResponse({ success: true, data: {} });
      }
      if (u.includes("/api/dynamic-agents")) {
        return jsonResponse({ success: true, data: { items: [] } });
      }
      return jsonResponse({ success: true, data: {} });
    },
  );
  // @ts-expect-error - global fetch override for tests
  global.fetch = fetchMock;
  return fetchMock;
}

async function flushAsync() {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 50));
  });
}

const agent = {
  _id: "agent-with-datasources",
  name: "Existing Agent",
  description: "",
  system_prompt: "You exist.",
  allowed_tools: { "knowledge-base": ["search", "fetch_document"] },
  builtin_tools: undefined,
  model: { id: "gpt-4o", provider: "openai" as const },
  visibility: "team" as const,
  owner_team_slug: "platform",
  owner_team_id: "team-1",
  shared_with_teams: [],
  subagents: [],
  skills: [],
  datasource_ids: ["ds-1", "ds-2"],
  // Reproduces rows created with a datasource but no collection selection.
  rag_collection_ids: null as unknown as string[],
  ui: { gradient_theme: "default" as const },
  enabled: true,
  owner_id: "user-1",
  is_system: false,
  created_at: "2026-04-29T00:00:00Z",
  updated_at: "2026-04-29T00:00:00Z",
};

// ============================================================================
// Tests
// ============================================================================

describe("DynamicAgentEditor — clearing the datasource picker", () => {
  beforeEach(() => {
    mockApi();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("sends datasource_ids: [] on save instead of omitting the field", async () => {
    const onSave = jest.fn();
    render(
      <DynamicAgentEditor
        agent={agent}
        initialStep="knowledge"
        onCancel={jest.fn()}
        onSave={onSave}
      />,
    );
    await flushAsync();

    expect(screen.getByTestId("datasource-picker-value")).toHaveTextContent(
      "ds-1,ds-2",
    );

    fireEvent.click(screen.getByRole("button", { name: /Clear Datasources/i }));
    expect(screen.getByTestId("datasource-picker-value")).toHaveTextContent("");

    const saveButton = screen.getByRole("button", { name: /Save Changes/i });
    expect(saveButton).not.toBeDisabled();

    await act(async () => {
      fireEvent.click(saveButton);
      await new Promise((r) => setTimeout(r, 50));
    });

    const fetchMock = global.fetch as jest.Mock;
    const putCall = fetchMock.mock.calls.find(
      ([, init]) => init?.method === "PUT",
    );
    expect(putCall).toBeDefined();
    const body = JSON.parse(String(putCall?.[1]?.body));
    expect(body).toHaveProperty("datasource_ids");
    expect(body.datasource_ids).toEqual([]);
    expect(body).toHaveProperty("rag_collection_ids");
    expect(body.rag_collection_ids).toEqual([]);
    expect(onSave).toHaveBeenCalledTimes(1);
  });

  it("keeps the Knowledge step visible but disabled until RAG tools are enabled", async () => {
    render(
      <DynamicAgentEditor
        agent={{ ...agent, allowed_tools: {} }}
        initialStep="knowledge"
        onCancel={jest.fn()}
        onSave={jest.fn()}
      />,
    );
    await flushAsync();

    expect(
      screen.getByRole("heading", { name: "Step 4: Knowledge" }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/enable the Knowledge Base tool calls/i),
    ).toBeInTheDocument();
    expect(screen.getByTestId("datasource-picker-mock")).toHaveAttribute(
      "data-disabled",
      "true",
    );
  });
});
