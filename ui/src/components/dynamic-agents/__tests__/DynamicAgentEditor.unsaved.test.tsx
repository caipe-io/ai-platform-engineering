/**
 * Integration tests for DynamicAgentEditor unsaved-changes back-button guard.
 *
 * Covers:
 * - Clean form: clicking back invokes onCancel directly, no dialog.
 * - Dirty form: clicking back opens the in-app modal, onCancel NOT invoked.
 * - "Keep editing" closes the modal and preserves edits; onCancel still NOT invoked.
 * - "Discard changes" closes the modal, clears the global flag, and invokes onCancel.
 * - readOnly mode never marks the global flag dirty.
 * - Successful save clears the global flag BEFORE onSave is invoked.
 * - Failed save leaves the global flag dirty.
 */

import React from "react";
import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";

// ============================================================================
// Mocks — must be hoisted above component import
// ============================================================================

// Replace the lazy CodeMirror with a trivial textarea so the editor can mount
// in jsdom without dynamic-import gymnastics.
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

// CodeMirror language modules are dynamically imported by the editor's effect;
// stub them out so the import promise resolves with harmless empty extensions.
jest.mock("@codemirror/lang-markdown", () => ({ markdown: () => ({}) }));
jest.mock("@codemirror/language-data", () => ({ languages: [] }));
jest.mock("@codemirror/view", () => ({ EditorView: { lineWrapping: {} } }));
jest.mock("@/lib/codemirror/jinja2-highlight", () => ({ jinja2Highlight: {} }));
jest.mock("@/lib/codemirror/markdown-highlight", () => ({ markdownHighlight: {} }));

// Picker subcomponents are unrelated to the back-button guard and have their
// own complex internal data fetching. Replace each with a no-op stub.
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

// Markdown rendering is irrelevant for these tests.
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
    }
  ),
  AnimatePresence: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

// ============================================================================
// Imports — after mocks
// ============================================================================

import { DynamicAgentEditor } from "../DynamicAgentEditor";
import { useUnsavedChangesStore } from "@/store/unsaved-changes-store";
import type { DynamicAgentConfig } from "@/types/dynamic-agent";
import { pickTeam } from "@/__test-utils__/team-picker";

// ============================================================================
// Helpers
// ============================================================================

function resetStore() {
  useUnsavedChangesStore.setState({
    hasUnsavedChanges: false,
    pendingNavigationHref: null,
  });
}

const fixtureAgent: DynamicAgentConfig = {
  _id: "agent-test",
  name: "Test Agent",
  description: "A test agent",
  system_prompt: "You are a test agent.",
  allowed_tools: {},
  builtin_tools: undefined,
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
  created_at: "2026-04-29T00:00:00Z",
  updated_at: "2026-04-29T00:00:00Z",
};

function jsonResponse(body: unknown) {
  return {
    ok: true,
    status: 200,
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

function mockApi() {
  // Use a single fetch mock that routes by URL.
  const fetchMock = jest.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    const u = typeof url === "string" ? url : url.toString();
    if (u.includes("/api/dynamic-agents/models")) {
      return jsonResponse({
        success: true,
        data: [
          { model_id: "gpt-4o", name: "GPT-4o", provider: "openai", description: "" },
        ],
      });
    }
    if (u.includes("/api/dynamic-agents/teams")) {
      return jsonResponse({ success: true, data: [] });
    }
    if (init?.method === "PUT") {
      return jsonResponse({ success: true, data: {} });
    }
    if (u.includes("/api/dynamic-agents")) {
      return jsonResponse({ success: true, data: { items: [{ _id: "agent-test" }] } });
    }
    return jsonResponse({ success: true, data: {} });
  });
  // @ts-expect-error - global fetch override for tests
  global.fetch = fetchMock;
  return fetchMock;
}

async function flushAsync() {
  // Allow the editor's mount-time fetches and effects to settle so the
  // model-defaults snapshot sentinel flips and the form is "clean".
  await act(async () => {
    await new Promise((r) => setTimeout(r, 50));
  });
}

// ============================================================================
// Tests
// ============================================================================

describe("DynamicAgentEditor — unsaved-changes back-button guard", () => {
  beforeEach(() => {
    resetStore();
    mockApi();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("clean form: clicking back invokes onCancel directly, no dialog", async () => {
    const onCancel = jest.fn();
    const onSave = jest.fn();

    render(<DynamicAgentEditor agent={fixtureAgent} onCancel={onCancel} onSave={onSave} />);
    await flushAsync();

    expect(useUnsavedChangesStore.getState().hasUnsavedChanges).toBe(false);

    // Back button is the first ghost icon button (the ArrowLeft in the header).
    const backButton = screen.getAllByRole("button")[0];
    fireEvent.click(backButton);

    expect(onCancel).toHaveBeenCalledTimes(1);
    // No "Keep editing" or "Discard changes" labels rendered.
    expect(screen.queryByText("Keep editing")).not.toBeInTheDocument();
    expect(screen.queryByText("Discard changes")).not.toBeInTheDocument();
  });

  it("dirty form: back-button opens dialog and does NOT invoke onCancel", async () => {
    const onCancel = jest.fn();
    const onSave = jest.fn();

    render(<DynamicAgentEditor agent={fixtureAgent} onCancel={onCancel} onSave={onSave} />);
    await flushAsync();

    // Mutate the agent name field.
    const nameInput = screen.getByPlaceholderText(/Code Review Agent/i) as HTMLInputElement;
    fireEvent.change(nameInput, { target: { value: "Test Agent — edited" } });

    await waitFor(() =>
      expect(useUnsavedChangesStore.getState().hasUnsavedChanges).toBe(true)
    );

    const backButton = screen.getAllByRole("button")[0];
    fireEvent.click(backButton);

    expect(screen.getByText("Keep editing")).toBeInTheDocument();
    expect(screen.getByText("Discard changes")).toBeInTheDocument();
    expect(onCancel).not.toHaveBeenCalled();
  });

  it("'Keep editing' closes the dialog and preserves edits", async () => {
    const onCancel = jest.fn();
    const onSave = jest.fn();

    render(<DynamicAgentEditor agent={fixtureAgent} onCancel={onCancel} onSave={onSave} />);
    await flushAsync();

    const nameInput = screen.getByPlaceholderText(/Code Review Agent/i) as HTMLInputElement;
    fireEvent.change(nameInput, { target: { value: "Test Agent — edited" } });
    await waitFor(() =>
      expect(useUnsavedChangesStore.getState().hasUnsavedChanges).toBe(true)
    );

    fireEvent.click(screen.getAllByRole("button")[0]); // back arrow → opens dialog
    fireEvent.click(screen.getByText("Keep editing"));

    expect(screen.queryByText("Keep editing")).not.toBeInTheDocument();
    expect(onCancel).not.toHaveBeenCalled();
    expect(nameInput.value).toBe("Test Agent — edited");
    expect(useUnsavedChangesStore.getState().hasUnsavedChanges).toBe(true);
  });

  it("'Discard changes' clears the flag and invokes onCancel", async () => {
    const onCancel = jest.fn();
    const onSave = jest.fn();

    render(<DynamicAgentEditor agent={fixtureAgent} onCancel={onCancel} onSave={onSave} />);
    await flushAsync();

    const nameInput = screen.getByPlaceholderText(/Code Review Agent/i) as HTMLInputElement;
    fireEvent.change(nameInput, { target: { value: "Test Agent — edited" } });
    await waitFor(() =>
      expect(useUnsavedChangesStore.getState().hasUnsavedChanges).toBe(true)
    );

    fireEvent.click(screen.getAllByRole("button")[0]); // back arrow → opens dialog
    fireEvent.click(screen.getByText("Discard changes"));

    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(useUnsavedChangesStore.getState().hasUnsavedChanges).toBe(false);
  });

  it("readOnly mode never marks the global flag dirty even after edits", async () => {
    const onCancel = jest.fn();
    const onSave = jest.fn();

    render(
      <DynamicAgentEditor
        agent={fixtureAgent}
        readOnly
        onCancel={onCancel}
        onSave={onSave}
      />
    );
    await flushAsync();

    expect(useUnsavedChangesStore.getState().hasUnsavedChanges).toBe(false);

    // Even if we somehow programmatically force a state change, readOnly
    // disables the dirty hook so the store flag stays false. Here we verify
    // by trying to change the input; it's disabled, but assert the store
    // remains clean regardless.
    const nameInput = screen.getByPlaceholderText(/Code Review Agent/i) as HTMLInputElement;
    fireEvent.change(nameInput, { target: { value: "edited" } });

    expect(useUnsavedChangesStore.getState().hasUnsavedChanges).toBe(false);

    // Back arrow goes straight to onCancel because dirty stays false.
    fireEvent.click(screen.getAllByRole("button")[0]);
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(screen.queryByText("Keep editing")).not.toBeInTheDocument();
  });

  it("successful save clears the global flag before onSave is called", async () => {
    const onCancel = jest.fn();
    const flagAtOnSaveTime: boolean[] = [];
    const onSave = jest.fn(() => {
      flagAtOnSaveTime.push(useUnsavedChangesStore.getState().hasUnsavedChanges);
    });

    render(<DynamicAgentEditor agent={fixtureAgent} onCancel={onCancel} onSave={onSave} />);
    await flushAsync();

    const nameInput = screen.getByPlaceholderText(/Code Review Agent/i) as HTMLInputElement;
    fireEvent.change(nameInput, { target: { value: "Test Agent — edited" } });
    await waitFor(() =>
      expect(useUnsavedChangesStore.getState().hasUnsavedChanges).toBe(true)
    );

    // Click "Save Changes" (label for editing flow).
    await act(async () => {
      fireEvent.click(screen.getByText("Save Changes"));
      // Allow the async save flow (network + state updates) to complete.
      await new Promise((r) => setTimeout(r, 50));
    });

    expect(onSave).toHaveBeenCalledTimes(1);
    expect(useUnsavedChangesStore.getState().hasUnsavedChanges).toBe(false);
    // The flag was already false at the moment onSave fired.
    expect(flagAtOnSaveTime[0]).toBe(false);
  });

  it("shows a disabled Save spinner until the request returns, then shows pending without closing", async () => {
    const originalFetch = global.fetch;
    let finish!: (value: Response) => void;
    global.fetch = jest.fn((url, init) => init?.method === "PUT"
      ? new Promise<Response>(resolve => { finish = resolve; }) : originalFetch(url, init));
    const onSave = jest.fn();
    render(<DynamicAgentEditor agent={fixtureAgent} onCancel={jest.fn()} onSave={onSave} />);
    await flushAsync();
    fireEvent.change(screen.getByPlaceholderText(/Code Review Agent/i), { target: { value: "Changed" } });
    const save = screen.getByRole("button", { name: "Save Changes" });
    fireEvent.click(save);
    expect(save).toBeDisabled();
    expect(save).toHaveAttribute("aria-busy", "true");
    expect(save.querySelector(".animate-spin")).not.toBeNull();
    fireEvent.click(save);
    expect(jest.mocked(fetch).mock.calls.filter(([, init]) => init?.method === "PUT")).toHaveLength(1);
    await act(async () => { finish({ ...jsonResponse({ success: true, data: {
      permission_sync: { id: "example-operation", state: "pending", requested_at: "2026-01-01" },
    } }), status: 202 } as Response); });
    const pending = screen.getByRole("button", { name: "Permissions pending" });
    expect(pending).toBeDisabled();
    expect(pending).toHaveAttribute("aria-busy", "false");
    expect(pending.querySelector(".animate-spin")).toBeNull();
    expect(screen.getByText(/Previous access may still work/)).toBeInTheDocument();
    expect(onSave).not.toHaveBeenCalled();
    expect(useUnsavedChangesStore.getState().hasUnsavedChanges).toBe(false);
  });

  it("restores pending state from the saved agent when the editor is reopened", async () => {
    render(<DynamicAgentEditor agent={{ ...fixtureAgent, permission_sync: {
      id: "example-operation", state: "pending", requested_at: "2026-01-01",
    } }} onCancel={jest.fn()} onSave={jest.fn()} />);
    await flushAsync();
    expect(screen.getByRole("button", { name: "Permissions pending" })).toBeDisabled();
    expect(screen.getByPlaceholderText(/Code Review Agent/i)).toBeDisabled();
    expect(screen.getByText(/Previous access may still work/)).toBeInTheDocument();
  });

  it("failed save leaves the global flag dirty so subsequent back-clicks warn", async () => {
    const onCancel = jest.fn();
    const onSave = jest.fn();

    // Override fetch so the PUT call fails.
    // @ts-expect-error - test override
    global.fetch = jest.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      const u = typeof url === "string" ? url : url.toString();
      if (u.includes("/api/dynamic-agents/models")) {
        return jsonResponse({
          success: true,
          data: [
            { model_id: "gpt-4o", name: "GPT-4o", provider: "openai", description: "" },
          ],
        });
      }
      if (u.includes("/api/dynamic-agents/teams")) {
        return jsonResponse({ success: true, data: [] });
      }
      if (init?.method === "PUT") {
        return jsonResponse({ success: false, error: "boom" });
      }
      return jsonResponse({ success: true, data: { items: [{ _id: "agent-test" }] } });
    });

    render(<DynamicAgentEditor agent={fixtureAgent} onCancel={onCancel} onSave={onSave} />);
    await flushAsync();

    const nameInput = screen.getByPlaceholderText(/Code Review Agent/i) as HTMLInputElement;
    fireEvent.change(nameInput, { target: { value: "Test Agent — edited" } });
    await waitFor(() =>
      expect(useUnsavedChangesStore.getState().hasUnsavedChanges).toBe(true)
    );

    fireEvent.click(screen.getByText("Save Changes"));

    await waitFor(() => expect(onSave).not.toHaveBeenCalled() || true);
    // The dirty flag must NOT have been cleared by the failed save.
    expect(useUnsavedChangesStore.getState().hasUnsavedChanges).toBe(true);

    // Back-click should still open the dialog.
    fireEvent.click(screen.getAllByRole("button")[0]);
    expect(screen.getByText("Keep editing")).toBeInTheDocument();
    expect(onCancel).not.toHaveBeenCalled();
  });

  it("requires and sends owner-team metadata when creating an agent", async () => {
    const onCancel = jest.fn();
    const onSave = jest.fn();
    const fetchMock = jest.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
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
          data: [{ _id: "team-id", name: "Platform", slug: "platform", user_role: "admin", can_own_agents: true }],
        });
      }
      if (init?.method === "POST") {
        return jsonResponse({ success: true, data: {} });
      }
      if (u.includes("/api/dynamic-agents")) {
        return jsonResponse({ success: true, data: { items: [] } });
      }
      return jsonResponse({ success: true, data: {} });
    });
    // @ts-expect-error - global fetch override for tests
    global.fetch = fetchMock;

    render(<DynamicAgentEditor agent={null} onCancel={onCancel} onSave={onSave} />);
    await flushAsync();

    fireEvent.change(screen.getByPlaceholderText(/Code Review Agent/i), { target: { value: "Ops Helper" } });
    // Owner Team picker is now a searchable TeamPicker (2026-05-27).
    await pickTeam(/Owner Team/i, "platform");
    fireEvent.click(screen.getByText("Next"));
    fireEvent.change(await screen.findByTestId("codemirror-mock"), { target: { value: "Help ops." } });

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Create Agent" }));
      await new Promise((r) => setTimeout(r, 50));
    });

    const postCall = fetchMock.mock.calls.find(([, init]) => init?.method === "POST");
    expect(postCall).toBeDefined();
    expect(JSON.parse(String(postCall?.[1]?.body))).toMatchObject({
      name: "Ops Helper",
      owner_team_slug: "platform",
    });
    expect(onSave).toHaveBeenCalledTimes(1);
  });
});
