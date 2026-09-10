/**
 * Tests for SkillsGallery component.
 *
 * Covers:
 *  - WORKFLOW_RUNNER_ENABLED feature flag gating
 *  - Search/filter by name, description, category
 *  - Delete confirm/cancel flow
 *  - Try Skill flow (createConversation, setPendingMessage, navigation)
 *  - View mode switching (all, my-skills, team, global)
 *  - Edit/delete visibility (admin vs non-admin, system vs user configs)
 *  - Favorites section and toggle
 *  - Loading/error states
 *  - Empty states
 *  - Modal interactions (backdrop, X button, Cancel)
 *  - Edit config and onSelectConfig callbacks
 *  - Per-skill backend sync badge remains hidden
 */

import React from "react";
import { render, screen, fireEvent, waitFor, act, within } from "@testing-library/react";
import { SkillsGallery } from "../SkillsGallery";
import type { AgentSkill } from "@/types/agent-skill";

// ---------------------------------------------------------------------------
// Config mock — controlled per-test via mockWorkflowRunnerEnabled
// ---------------------------------------------------------------------------

let mockWorkflowRunnerEnabled = false;

jest.mock("@/lib/config", () => ({
  getConfig: jest.fn((key: string) => {
    if (key === "workflowRunnerEnabled") return mockWorkflowRunnerEnabled;
    return undefined;
  }),
  config: {},
}));

// ---------------------------------------------------------------------------
// Store / hook mocks — controllable per-test
// ---------------------------------------------------------------------------

const mockLoadConfigs = jest.fn();
const mockDeleteConfig = jest.fn();
const mockToggleFavorite = jest.fn();
const mockIsFavorite = jest.fn().mockReturnValue(false);
const mockGetFavoriteConfigs = jest.fn().mockReturnValue([]);
const mockCreateConversation = jest.fn().mockReturnValue("conv-abc");
const mockSetPendingMessage = jest.fn();
const mockRouterPush = jest.fn();

let mockIsLoading = false;
let mockError: string | null = null;
let mockIsAdmin = false;

jest.mock("@/store/agent-skills-store", () => ({
  useAgentSkillsStore: () => ({
    configs: mockConfigs(),
    isLoading: mockIsLoading,
    error: mockError,
    loadSkills: mockLoadConfigs,
    deleteSkill: mockDeleteConfig,
    toggleFavorite: mockToggleFavorite,
    isFavorite: mockIsFavorite,
    getFavoriteSkills: mockGetFavoriteConfigs,
  }),
}));

jest.mock("@/store/chat-store", () => ({
  useChatStore: () => ({
    createConversation: mockCreateConversation,
    setPendingMessage: mockSetPendingMessage,
  }),
}));

jest.mock("@/hooks/use-admin-role", () => ({
  useAdminRole: () => ({ isAdmin: mockIsAdmin }),
}));

jest.mock("next/navigation", () => ({
  useRouter: () => ({ push: mockRouterPush }),
}));

jest.mock("next-auth/react", () => ({
  useSession: () => ({ data: { user: { email: "test@example.com" } }, status: "authenticated" }),
}));

jest.mock("framer-motion", () => ({
  motion: {
    // eslint-disable-next-line react/display-name
    div: React.forwardRef(({ children, ...rest }: unknown, ref: unknown) => (
      <div ref={ref} {...rest}>{children}</div>
    )),
  },
  AnimatePresence: ({ children }: unknown) => <>{children}</>,
}));

// `SkillFolderViewer` (used by gallery's view-files dialog) imports
// react-markdown / remark-gfm which ship as ESM and aren't in the Jest
// transformIgnorePatterns allowlist. Mock them out — these tests don't
// exercise the viewer's markdown rendering.
jest.mock("react-markdown", () => ({
  __esModule: true,
  default: ({ children }: unknown) => <div>{children}</div>,
}));

jest.mock("remark-gfm", () => ({
  __esModule: true,
  default: () => {},
}));

jest.mock("@/components/ui/caipe-spinner", () => ({
  CAIPESpinner: ({ message }: unknown) => <div data-testid="spinner">{message}</div>,
}));

jest.mock("@/components/ui/toast", () => ({
  useToast: () => ({ toast: jest.fn() }),
}));

// Mock the scan-status indicator so the gallery tests can drive its
// `onScanComplete` callback directly without simulating the full
// override/scan dialog flow. The mock renders a hidden button keyed
// by `data-testid="scan-complete-${configId}"` that, when clicked,
// invokes the prop. This is how the catalog-refresh-after-override
// test triggers the same code path the real dialog uses, so we can
// assert the gallery refetches `/api/skills` to clear stale rows.
jest.mock("../SkillScanStatusIndicator", () => ({
  __esModule: true,
  SkillScanStatusIndicator: ({
    config,
    onScanComplete,
  }: {
    config: { id: string };
    onScanComplete?: () => void;
  }) => (
    <button
      type="button"
      data-testid={`scan-complete-${config.id}`}
      onClick={() => onScanComplete?.()}
    >
      mock-scan-indicator
    </button>
  ),
}));

// ---------------------------------------------------------------------------
// Test data helpers
// ---------------------------------------------------------------------------

function makeQuickStart(id = "qs-1"): AgentSkill {
  return {
    id,
    name: "Incident Correlation & Root Cause Analysis",
    description: "Correlate incidents across PagerDuty, Jira, and ArgoCD.",
    category: "SRE",
    is_quick_start: true,
    is_system: true,
    owner_id: "system",
    tasks: [
      {
        display_text: "Correlate incidents",
        llm_prompt: "You are an SRE agent. Correlate the incident.",
        subagent: "user_input",
      },
    ],
    created_at: new Date(),
    updated_at: new Date(),
    thumbnail: "AlertTriangle",
  };
}

function makeWorkflow(id = "wf-1"): AgentSkill {
  return {
    id,
    name: "Deploy Pipeline Workflow",
    description: "Deploy, verify, rollback if needed.",
    category: "ArgoCD",
    is_quick_start: false,
    is_system: true,
    owner_id: "system",
    tasks: [
      { display_text: "Deploy", llm_prompt: "Deploy the app.", subagent: "user_input" },
      { display_text: "Verify", llm_prompt: "Verify health.", subagent: "user_input" },
    ],
    created_at: new Date(),
    updated_at: new Date(),
  };
}

// Configs returned by the store — set per describe block
let _configs: AgentSkill[] = [];
function mockConfigs() {
  return _configs;
}

function requestUrl(input: string | URL | Request): string {
  return typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function renderGallery(props: Partial<React.ComponentProps<typeof SkillsGallery>> = {}) {
  let result: ReturnType<typeof render>;
  await act(async () => {
    result = render(
      <SkillsGallery
        onEditConfig={jest.fn()}
        onCreateNew={jest.fn()}
        {...props}
      />
    );
  });
  return result!;
}

// ---------------------------------------------------------------------------
// Global reset + fetch mock
// ---------------------------------------------------------------------------

beforeEach(() => {
  jest.clearAllMocks();
  mockWorkflowRunnerEnabled = false;
  mockIsLoading = false;
  mockError = null;
  mockIsAdmin = false;
  mockIsFavorite.mockReturnValue(false);
  mockGetFavoriteConfigs.mockReturnValue([]);
  mockCreateConversation.mockReturnValue("conv-abc");
  _configs = [];

  // Mock global.fetch for catalog endpoints
  global.fetch = jest.fn((url: string | URL | Request) => {
    const urlStr = requestUrl(url);

    if (urlStr.includes("/api/skills")) {
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ skills: [] }),
      } as Response);
    }

    if (urlStr.includes("/api/admin/platform-config")) {
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({
          success: true,
          data: { default_agent_id: "default-agent" },
        }),
      } as Response);
    }

    if (urlStr.includes("/api/dynamic-agents/available")) {
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({
          success: true,
          data: [{ _id: "default-agent", name: "Default Agent", enabled: true }],
        }),
      } as Response);
    }

    // Default: return empty OK response
    return Promise.resolve({
      ok: true,
      json: () => Promise.resolve({}),
    } as Response);
  }) as jest.Mock;
});

afterEach(() => {
  jest.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("SkillsGallery — WORKFLOW_RUNNER_ENABLED=false (default)", () => {
  beforeEach(() => {
    mockWorkflowRunnerEnabled = false;
    _configs = [makeQuickStart(), makeWorkflow()];
  });

  it("still renders the quick-start card gallery when the flag is off", async () => {
    await renderGallery();
    expect(screen.getByText("Incident Correlation & Root Cause Analysis")).toBeInTheDocument();
  });

  it("does not fetch backend sync status for per-skill badges", async () => {
    await renderGallery();

    const urls = (global.fetch as jest.Mock).mock.calls.map(([url]) => requestUrl(url));
    expect(urls).toEqual(["/api/skills?include_content=true"]);
  });

  it("opens modal with Try Skill button when clicking a skill card", async () => {
    await renderGallery();
    const card = screen.getByText("Incident Correlation & Root Cause Analysis");
    await act(async () => { fireEvent.click(card); });
    expect(screen.getByRole("button", { name: /try skill/i })).toBeInTheDocument();
  });

  it("does NOT show Run Workflow or Run in Chat buttons in the modal", async () => {
    await renderGallery();
    const card = screen.getByText("Incident Correlation & Root Cause Analysis");
    await act(async () => { fireEvent.click(card); });
    expect(screen.queryByRole("button", { name: /run workflow/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /run in chat/i })).not.toBeInTheDocument();
  });

  it("still renders Cancel button in the modal when the flag is off", async () => {
    await renderGallery();
    const card = screen.getByText("Incident Correlation & Root Cause Analysis");
    await act(async () => { fireEvent.click(card); });
    expect(screen.getByRole("button", { name: /cancel/i })).toBeInTheDocument();
  });
});

describe("SkillsGallery — WORKFLOW_RUNNER_ENABLED=true", () => {
  beforeEach(() => {
    mockWorkflowRunnerEnabled = true;
    _configs = [makeQuickStart(), makeWorkflow()];
  });

  it("opens modal and shows Try Skill button when clicking a quick-start card", async () => {
    await renderGallery();
    const card = screen.getByText("Incident Correlation & Root Cause Analysis");
    await act(async () => { fireEvent.click(card); });
    expect(screen.getByRole("button", { name: /try skill/i })).toBeInTheDocument();
  });

  it("displays multi-task workflow in the main Skills grid", async () => {
    await renderGallery();
    // The page H1 is "Skills Gallery" (level 1); we assert on level 1
    // explicitly so this match can't be satisfied by section H2s like
    // "My Skills" / "Team Skills" / "Global Skills" if the H1 silently
    // disappears in a future refactor.
    expect(
      screen.getByRole("heading", { level: 1, name: /^Skills Gallery$/ }),
    ).toBeInTheDocument();
    expect(screen.getAllByText("Deploy Pipeline Workflow").length).toBeGreaterThan(0);
  });
});

describe("SkillsGallery — flag transition (disabled → enabled)", () => {
  it("reflects flag changes without remounting", async () => {
    mockWorkflowRunnerEnabled = false;
    _configs = [makeQuickStart()];
    let result: ReturnType<typeof render>;
    await act(async () => {
      result = render(
        <SkillsGallery onEditConfig={jest.fn()} onCreateNew={jest.fn()} />
      );
    });

    // Open modal
    await act(async () => {
      fireEvent.click(screen.getByText("Incident Correlation & Root Cause Analysis"));
    });
    expect(screen.getByRole("button", { name: /try skill/i })).toBeInTheDocument();

    // Simulate flag flip
    mockWorkflowRunnerEnabled = true;
    await act(async () => {
      result!.rerender(
        <SkillsGallery onEditConfig={jest.fn()} onCreateNew={jest.fn()} />
      );
    });

    expect(screen.getByRole("button", { name: /try skill/i })).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// Search & filter
// ---------------------------------------------------------------------------

describe("SkillsGallery — search and filter", () => {
  beforeEach(() => {
    mockWorkflowRunnerEnabled = false;
    _configs = [
      makeQuickStart("qs-1"),
      { ...makeQuickStart("qs-devops"), name: "DevOps Health Check", description: "Check cluster health", category: "DevOps" },
      { ...makeQuickStart("qs-cloud"), name: "Cost Explorer", description: "Analyze AWS costs", category: "Cloud" },
    ] as AgentSkill[];
  });

  it("filters configs by search query matching name", async () => {
    await renderGallery();
    const searchInput = screen.getByPlaceholderText(/search name/i);
    fireEvent.change(searchInput, { target: { value: "DevOps" } });
    expect(screen.getByText("DevOps Health Check")).toBeInTheDocument();
    expect(screen.queryByText("Cost Explorer")).not.toBeInTheDocument();
  });

  it("filters configs by search query matching description", async () => {
    await renderGallery();
    const searchInput = screen.getByPlaceholderText(/search name/i);
    fireEvent.change(searchInput, { target: { value: "AWS costs" } });
    expect(screen.getByText("Cost Explorer")).toBeInTheDocument();
    expect(screen.queryByText("DevOps Health Check")).not.toBeInTheDocument();
  });

  it("shows all configs when search query is empty", async () => {
    await renderGallery();
    expect(screen.getByText("Incident Correlation & Root Cause Analysis")).toBeInTheDocument();
    expect(screen.getByText("DevOps Health Check")).toBeInTheDocument();
    expect(screen.getByText("Cost Explorer")).toBeInTheDocument();
  });

  it("filters by category picker", async () => {
    await renderGallery();
    fireEvent.click(screen.getByRole("combobox", { name: /category filter/i }));
    fireEvent.click(await screen.findByRole("option", { name: "Cloud" }));
    expect(screen.getByText("Cost Explorer")).toBeInTheDocument();
    expect(screen.queryByText("DevOps Health Check")).not.toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// Delete flow
// ---------------------------------------------------------------------------

describe("SkillsGallery — delete", () => {
  beforeEach(() => {
    mockWorkflowRunnerEnabled = false;
    mockDeleteConfig.mockClear();
    _configs = [{
      ...makeQuickStart("qs-del"),
      is_system: false,
      owner_id: "test@example.com",
    }] as AgentSkill[];
  });

  // Delete now uses a UI Dialog confirmation (not the browser confirm()),
  // so these tests exercise the dialog's Delete / Cancel buttons.

  it("calls deleteSkill when user confirms deletion in the dialog", async () => {
    await renderGallery();
    const deleteButtons = screen.getAllByTitle("Delete");
    fireEvent.click(deleteButtons[0]);
    // Dialog opens; click the destructive "Delete" button inside it. The
    // built-in template variant uses "Remove" so we accept either.
    const confirmBtn = await screen.findByRole("button", {
      name: /^(Delete|Remove)$/,
    });
    fireEvent.click(confirmBtn);
    await waitFor(() => {
      expect(mockDeleteConfig).toHaveBeenCalledWith("qs-del");
    });
  });

  it("does NOT call deleteSkill when user cancels the dialog", async () => {
    await renderGallery();
    const deleteButtons = screen.getAllByTitle("Delete");
    fireEvent.click(deleteButtons[0]);
    const cancelBtn = await screen.findByRole("button", { name: /Cancel/i });
    fireEvent.click(cancelBtn);
    expect(mockDeleteConfig).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Skills Builder button
// ---------------------------------------------------------------------------

describe("SkillsGallery — Skills Builder button", () => {
  beforeEach(() => {
    mockWorkflowRunnerEnabled = false;
    _configs = [makeQuickStart()];
  });

  it("calls onCreateNew when Skill Builder button is clicked", async () => {
    const onCreateNew = jest.fn();
    await renderGallery({ onCreateNew });
    const btn = screen.getByRole("button", { name: /skill builder/i });
    fireEvent.click(btn);
    expect(onCreateNew).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// Edit/delete visibility (Mongo rows vs catalog-only merge entries)
// ---------------------------------------------------------------------------

describe("SkillsGallery — source filter (built-in vs custom)", () => {
  it("labels user agent_skills from the catalog feed as Custom, not Built-in", async () => {
    const mongoId = "skill-random-p2h9h87ty";
    _configs = [];
    (global.fetch as jest.Mock).mockImplementation((url: string | URL | Request) => {
      const urlStr = typeof url === "string" ? url : url instanceof URL ? url.toString() : url.url;
      if (urlStr.includes("/api/skills?")) {
        return Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve({
              skills: [
                {
                  id: mongoId,
                  name: "random",
                  description: "random",
                  source: "agent_skills",
                  source_id: mongoId,
                  owner_id: "test@example.com",
                  visibility: "private",
                  metadata: { is_system: false, category: "Custom" },
                },
              ],
            }),
        } as Response);
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve({}) } as Response);
    });

    await renderGallery();

    const heading = screen.getByRole("heading", { name: "random" });
    expect(heading).toBeInTheDocument();
    const card = heading.closest("div[class*='group']") ?? heading.parentElement!;
    expect(within(card as HTMLElement).getByText("Custom")).toBeInTheDocument();
    expect(within(card as HTMLElement).queryByText("Built-in")).not.toBeInTheDocument();
  });

  it("keeps catalog-projected Mongo skills editable under their real id", async () => {
    const mongoId = "skill-imported-real-id";
    _configs = [];
    (global.fetch as jest.Mock).mockImplementation((url: string | URL | Request) => {
      const urlStr = requestUrl(url);
      if (urlStr.includes("/api/skills?")) {
        return Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve({
              skills: [
                {
                  id: mongoId,
                  name: "Imported editable skill",
                  description: "",
                  source: "agent_skills",
                  source_id: mongoId,
                  owner_id: "test@example.com",
                  content: "# Imported",
                  ancillary_files: { "scripts/run.sh": "echo ok" },
                  metadata: { is_system: false, category: "imported" },
                },
              ],
            }),
        } as Response);
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve({}) } as Response);
    });

    await renderGallery();

    expect(screen.getByRole("heading", { name: "Imported editable skill" })).toBeInTheDocument();
    expect(screen.getAllByTitle("Edit").length).toBeGreaterThan(0);
    expect(screen.getAllByTitle("Delete").length).toBeGreaterThan(0);
    expect(screen.getByTestId(`scan-complete-${mongoId}`)).toBeInTheDocument();
    expect(screen.queryByTestId(`scan-complete-catalog-${mongoId}`)).not.toBeInTheDocument();
  });

  it("does not duplicate a Mongo skill when catalog returns the same agent_skills id", async () => {
    const mongoId = "skill-random-p2h9h87ty";
    _configs = [
      {
        ...makeQuickStart(mongoId),
        id: mongoId,
        name: "random",
        description: "random",
        is_system: false,
        owner_id: "test@example.com",
        visibility: "private",
      } as AgentSkill,
    ];
    (global.fetch as jest.Mock).mockImplementation((url: string | URL | Request) => {
      const urlStr = typeof url === "string" ? url : url instanceof URL ? url.toString() : url.url;
      if (urlStr.includes("/api/skills?")) {
        return Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve({
              skills: [
                {
                  id: mongoId,
                  name: "random",
                  description: "random",
                  source: "agent_skills",
                  source_id: mongoId,
                  owner_id: "test@example.com",
                  visibility: "private",
                  metadata: { is_system: false, category: "Custom" },
                },
              ],
            }),
        } as Response);
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve({}) } as Response);
    });

    await renderGallery();

    expect(screen.getAllByRole("heading", { name: "random" })).toHaveLength(1);
    const heading = screen.getByRole("heading", { name: "random" });
    const card = heading.closest("div[class*='group']") ?? heading.parentElement!;
    expect(within(card as HTMLElement).getByText("Custom")).toBeInTheDocument();
    expect(within(card as HTMLElement).queryByText("Built-in")).not.toBeInTheDocument();
  });

  it("shows only user Mongo skills under Custom and only is_system under Built-in", async () => {
    const userSkill = {
      ...makeQuickStart("user-owned-1"),
      name: "My Custom Only Skill",
      is_system: false,
      owner_id: "test@example.com",
    } as AgentSkill;
    _configs = [makeQuickStart("builtin-1"), userSkill];
    await renderGallery();

    const sourceGroup = screen.getByRole("group", { name: /filter by skill source/i });

    await act(async () => {
      fireEvent.click(within(sourceGroup).getByRole("button", { name: "Custom" }));
    });
    expect(screen.getByText("My Custom Only Skill")).toBeInTheDocument();
    expect(screen.queryByText("Incident Correlation & Root Cause Analysis")).not.toBeInTheDocument();

    await act(async () => {
      fireEvent.click(within(sourceGroup).getByRole("button", { name: "Built-in" }));
    });
    expect(screen.getByText("Incident Correlation & Root Cause Analysis")).toBeInTheDocument();
    expect(screen.queryByText("My Custom Only Skill")).not.toBeInTheDocument();
  });
});

describe("SkillsGallery — edit/delete visibility", () => {
  it("shows edit and delete buttons for non-system configs", async () => {
    _configs = [{
      ...makeQuickStart("user-skill"),
      is_system: false,
      owner_id: "test@example.com",
    }] as AgentSkill[];
    await renderGallery();
    expect(screen.getAllByTitle("Edit").length).toBeGreaterThan(0);
    expect(screen.getAllByTitle("Delete").length).toBeGreaterThan(0);
  });

  it("locks edit and delete on built-in Mongo configs by default (lock policy)", async () => {
    // ALLOW_BUILTIN_SKILL_MUTATION defaults to false → built-ins
    // are surfaced with disabled Edit/Delete buttons + Clone CTA.
    // The actionable affordances (`title="Edit"` / `title="Delete"`)
    // are absent; only the locked-tooltip variants are present.
    mockIsAdmin = false;
    _configs = [makeQuickStart("sys-1")];
    await renderGallery();
    expect(screen.queryByTitle("Edit")).toBeNull();
    expect(screen.queryByTitle("Delete")).toBeNull();
    expect(
      screen.getAllByTitle(/Built-in skill is read-only/i).length,
    ).toBeGreaterThan(0);
    expect(
      screen.getAllByTitle(/Built-in skill cannot be deleted/i).length,
    ).toBeGreaterThan(0);
    // Clone is the escape hatch and must always be reachable.
    expect(
      screen.getAllByTitle(/Clone to an editable copy/i).length,
    ).toBeGreaterThan(0);
  });

  it("disables delete for catalog-only merge entries", async () => {
    mockIsAdmin = false;
    _configs = [
      {
        ...makeQuickStart("catalog-x"),
        id: "catalog-hub-1",
        is_system: true,
      } as AgentSkill,
    ];
    await renderGallery();
    // Hub-crawled rows now route through `renderRowActions`'s hub branch:
    // the trash button is disabled with a "Crawled from GitHub" explanation
    // and the edit pencil is replaced by a read-only Eye view button.
    expect(
      screen.getAllByTitle(/Crawled from GitHub/i).length
    ).toBeGreaterThan(0);
    expect(screen.queryByTitle("Delete")).not.toBeInTheDocument();
    expect(screen.queryByTitle("Edit")).not.toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// Try Skill flow
// ---------------------------------------------------------------------------

describe("SkillsGallery — Try Skill", () => {
  beforeEach(() => {
    _configs = [{
      ...makeQuickStart("qs-chat"),
      name: "Chat Skill",
      is_system: false,
      owner_id: "test@example.com",
      tasks: [{ display_text: "Do it", llm_prompt: "Perform the task", subagent: "user_input" }],
    }] as AgentSkill[];
  });

  it("creates a conversation, stages the prompt, and opens the chat on Try Skill", async () => {
    await renderGallery();
    await act(async () => { fireEvent.click(screen.getByText("Chat Skill")); });
    const tryBtn = screen.getByRole("button", { name: /try skill/i });
    await act(async () => { fireEvent.click(tryBtn); });
    expect(mockCreateConversation).toHaveBeenCalledTimes(1);
    expect(mockCreateConversation).toHaveBeenCalledWith("default-agent");
    expect(mockSetPendingMessage).toHaveBeenCalledWith(
      "Execute skill: qs-chat\n\nRead and follow the instructions in the SKILL.md file for the \"qs-chat\" skill."
    );
    expect(mockRouterPush).toHaveBeenCalledWith("/chat/conv-abc");
  });

  it("closes the modal after navigation", async () => {
    await renderGallery();
    await act(async () => { fireEvent.click(screen.getByText("Chat Skill")); });
    expect(screen.getByRole("button", { name: /try skill/i })).toBeInTheDocument();
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: /try skill/i })); });
    expect(screen.queryByRole("button", { name: /try skill/i })).not.toBeInTheDocument();
  });

  it("Try Skill stays enabled without backend sync gating", async () => {
    await renderGallery();
    await act(async () => { fireEvent.click(screen.getByText("Chat Skill")); });
    const tryBtn = screen.getByRole("button", { name: /try skill/i });
    expect(tryBtn).not.toBeDisabled();
  });

  it("Try Skill is enabled when required parameters are valid", async () => {
    await renderGallery();
    await act(async () => { fireEvent.click(screen.getByText("Chat Skill")); });
    const tryBtn = screen.getByRole("button", { name: /try skill/i });
    expect(tryBtn).not.toBeDisabled();
  });
});

// ---------------------------------------------------------------------------
// Template variable parameters
// ---------------------------------------------------------------------------

describe("SkillsGallery — template variable parameters", () => {
  beforeEach(() => {
    _configs = [{
      ...makeQuickStart("qs-vars"),
      name: "Deploy Helper",
      is_system: false,
      owner_id: "test@example.com",
      tasks: [{
        display_text: "Deploy",
        llm_prompt: "Deploy {{app_name}} to {{cluster:prod-us}} with {{replicas:3}} replicas",
        subagent: "user_input",
      }],
    }] as AgentSkill[];
  });

  it("renders parameter input fields for template variables", async () => {
    await renderGallery();
    await act(async () => { fireEvent.click(screen.getByText("Deploy Helper")); });
    expect(screen.getByText("Parameters")).toBeInTheDocument();
    expect(screen.getByText(/App Name/)).toBeInTheDocument();
    expect(screen.getByText(/Cluster/)).toBeInTheDocument();
    expect(screen.getByText(/Replicas/)).toBeInTheDocument();
  });

  it("pre-fills default values for variables with defaults", async () => {
    await renderGallery();
    await act(async () => { fireEvent.click(screen.getByText("Deploy Helper")); });
    const clusterInput = screen.getByDisplayValue("prod-us") as HTMLInputElement;
    expect(clusterInput).toBeInTheDocument();
    const replicasInput = screen.getByDisplayValue("3") as HTMLInputElement;
    expect(replicasInput).toBeInTheDocument();
  });

  it("disables Try Skill when required parameter is empty", async () => {
    await renderGallery();
    await act(async () => { fireEvent.click(screen.getByText("Deploy Helper")); });
    // app_name is required (no default) and starts empty
    const tryBtn = screen.getByRole("button", { name: /try skill/i });
    expect(tryBtn).toBeDisabled();
  });

  it("enables Try Skill when required parameter is filled", async () => {
    await renderGallery();
    await act(async () => { fireEvent.click(screen.getByText("Deploy Helper")); });
    const appInput = screen.getByPlaceholderText(/enter app name/i);
    await act(async () => { fireEvent.change(appInput, { target: { value: "my-service" } }); });
    const tryBtn = screen.getByRole("button", { name: /try skill/i });
    expect(tryBtn).not.toBeDisabled();
  });

  it("sends message with parameters on Try Skill", async () => {
    await renderGallery();
    await act(async () => { fireEvent.click(screen.getByText("Deploy Helper")); });
    const appInput = screen.getByPlaceholderText(/enter app name/i);
    await act(async () => { fireEvent.change(appInput, { target: { value: "my-service" } }); });
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: /try skill/i })); });
    expect(mockSetPendingMessage).toHaveBeenCalledWith(
      "Execute skill: qs-vars\n\nRead and follow the instructions in the SKILL.md file for the \"qs-vars\" skill.\n\nParameters:\n- app_name: my-service\n- cluster: prod-us\n- replicas: 3"
    );
    expect(mockRouterPush).toHaveBeenCalledWith("/chat/conv-abc");
  });

  it("does not render Parameters section for skills without variables", async () => {
    _configs = [{
      ...makeQuickStart("qs-no-vars"),
      name: "Simple Skill",
      is_system: false,
      owner_id: "test@example.com",
      tasks: [{ display_text: "Do it", llm_prompt: "Just do the thing", subagent: "user_input" }],
    }] as AgentSkill[];
    await renderGallery();
    await act(async () => { fireEvent.click(screen.getByText("Simple Skill")); });
    expect(screen.queryByText("Parameters")).not.toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// View mode switching
// ---------------------------------------------------------------------------

describe("SkillsGallery — view mode", () => {
  const mySkill: AgentSkill = {
    ...makeQuickStart("my-1"),
    name: "My Personal Skill",
    is_system: false,
    owner_id: "test@example.com",
    visibility: "private",
  } as AgentSkill;

  const globalSkill: AgentSkill = {
    ...makeQuickStart("global-1"),
    name: "Global System Skill",
    is_system: true,
    owner_id: "system",
    visibility: "global",
  } as AgentSkill;

  const teamSkill: AgentSkill = {
    ...makeQuickStart("team-1"),
    name: "Team Shared Skill",
    is_system: false,
    owner_id: "other@example.com",
    visibility: "team",
  } as AgentSkill;

  beforeEach(() => {
    _configs = [mySkill, globalSkill, teamSkill];
  });

  it("My Skills view shows only user-owned non-system configs", async () => {
    await renderGallery();
    const allButtons = screen.getAllByRole("button");
    const mySkillsBtn = allButtons.find(b => b.textContent?.includes("My Skills"));
    fireEvent.click(mySkillsBtn!);
    expect(screen.getByText("My Personal Skill")).toBeInTheDocument();
    expect(screen.queryByText("Global System Skill")).not.toBeInTheDocument();
    expect(screen.queryByText("Team Shared Skill")).not.toBeInTheDocument();
  });

  it("Global view shows configs where visibility=global or is_system", async () => {
    await renderGallery();
    const allButtons = screen.getAllByRole("button");
    const globalBtn = allButtons.find(b => b.textContent?.trim() === "Global");
    fireEvent.click(globalBtn!);
    expect(screen.getByText("Global System Skill")).toBeInTheDocument();
    expect(screen.queryByText("My Personal Skill")).not.toBeInTheDocument();
  });

  it("All view lists quick-start and multi-task skills together", async () => {
    mockWorkflowRunnerEnabled = true;
    const wf = makeWorkflow("wf-view");
    _configs = [mySkill, wf];
    await renderGallery();
    expect(screen.getByText("Deploy Pipeline Workflow")).toBeInTheDocument();
    expect(screen.getByText("My Personal Skill")).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// Favorites
// ---------------------------------------------------------------------------

describe("SkillsGallery — favorites", () => {
  const favSkill: AgentSkill = {
    ...makeQuickStart("fav-1"),
    name: "Favorite Skill",
    is_system: false,
    owner_id: "test@example.com",
  } as AgentSkill;

  it("renders Favorites section when getFavoriteSkills returns configs", async () => {
    _configs = [favSkill];
    mockGetFavoriteConfigs.mockReturnValue([favSkill]);
    mockIsFavorite.mockImplementation((id: string) => id === "fav-1");
    await renderGallery();
    expect(screen.getByText("Favorites")).toBeInTheDocument();
  });

  it("hides Favorites section when empty", async () => {
    _configs = [makeQuickStart()];
    mockGetFavoriteConfigs.mockReturnValue([]);
    await renderGallery();
    expect(screen.queryByText("Favorites")).not.toBeInTheDocument();
  });

  it("clicking the star button calls toggleFavorite", async () => {
    _configs = [{
      ...makeQuickStart("star-1"),
      name: "Star Skill",
      is_system: false,
      owner_id: "test@example.com",
    }] as AgentSkill[];
    await renderGallery();
    const starBtn = screen.getByTitle("Add to favorites");
    fireEvent.click(starBtn);
    expect(mockToggleFavorite).toHaveBeenCalledWith("star-1");
  });
});

// ---------------------------------------------------------------------------
// Loading and error states
// ---------------------------------------------------------------------------

describe("SkillsGallery — loading/error", () => {
  it("renders spinner when isLoading=true", async () => {
    mockIsLoading = true;
    _configs = [];
    await renderGallery();
    expect(screen.getByTestId("spinner")).toBeInTheDocument();
  });

  it("renders error with Try Again button when error is set", async () => {
    mockError = "Failed to load configs";
    _configs = [];
    await renderGallery();
    expect(screen.getByText("Failed to load configs")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /try again/i })).toBeInTheDocument();
  });

  it("Try Again calls loadSkills", async () => {
    mockError = "Network error";
    _configs = [];
    mockLoadConfigs.mockClear();
    await renderGallery();
    fireEvent.click(screen.getByRole("button", { name: /try again/i }));
    expect(mockLoadConfigs).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Empty states
// ---------------------------------------------------------------------------

describe("SkillsGallery — empty states", () => {
  it("shows 'No skills match your search' when search yields no results", async () => {
    _configs = [makeQuickStart()];
    await renderGallery();
    const searchInput = screen.getByPlaceholderText(/search name/i);
    fireEvent.change(searchInput, { target: { value: "nonexistent-xyz" } });
    await waitFor(() => {
      expect(screen.getByText(/No skills match your search/)).toBeInTheDocument();
    });
  });

  it("My Skills empty state shows 'Create your first skill' with Skills Builder button", async () => {
    _configs = [makeQuickStart()];
    const onCreateNew = jest.fn();
    await renderGallery({ onCreateNew });
    const allButtons = screen.getAllByRole("button");
    const mySkillsBtn = allButtons.find(b => b.textContent?.includes("My Skills"));
    fireEvent.click(mySkillsBtn!);
    await waitFor(() => {
      expect(screen.getByText(/create your first skill/i)).toBeInTheDocument();
    });
    expect(screen.getAllByRole("button", { name: /skills builder/i }).length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Modal interactions
// ---------------------------------------------------------------------------

describe("SkillsGallery — modal interactions", () => {
  beforeEach(() => {
    _configs = [{
      ...makeQuickStart("qs-modal"),
      name: "Modal Skill",
      is_system: false,
      owner_id: "test@example.com",
    }] as AgentSkill[];
  });

  it("clicking Cancel closes modal", async () => {
    await renderGallery();
    await act(async () => { fireEvent.click(screen.getByText("Modal Skill")); });
    expect(screen.getByRole("button", { name: /try skill/i })).toBeInTheDocument();
    const cancelBtns = screen.getAllByRole("button", { name: /cancel/i });
    await act(async () => { fireEvent.click(cancelBtns[0]); });
    expect(screen.queryByRole("button", { name: /try skill/i })).not.toBeInTheDocument();
  });

  it("clicking backdrop closes modal", async () => {
    await renderGallery();
    await act(async () => { fireEvent.click(screen.getByText("Modal Skill")); });
    expect(screen.getByRole("button", { name: /try skill/i })).toBeInTheDocument();
    const backdrop = document.querySelector("[class*='fixed inset-0']") as HTMLElement;
    if (backdrop) {
      await act(async () => { fireEvent.click(backdrop); });
    }
    expect(screen.queryByRole("button", { name: /try skill/i })).not.toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// Edit config callback
// ---------------------------------------------------------------------------

describe("SkillsGallery — edit callback", () => {
  it("calls onEditConfig for user-owned config when edit button is clicked", async () => {
    const userConfig = {
      ...makeQuickStart("edit-1"),
      name: "Editable Skill",
      is_system: false,
      owner_id: "test@example.com",
    } as AgentSkill;
    _configs = [userConfig];
    const onEditConfig = jest.fn();
    await renderGallery({ onEditConfig });
    const editBtn = screen.getByTitle("Edit");
    fireEvent.click(editBtn);
    expect(onEditConfig).toHaveBeenCalledTimes(1);
    expect(onEditConfig).toHaveBeenCalledWith(expect.objectContaining({ id: "edit-1" }));
  });

  it("locks Edit on system (built-in) configs by default — surfaces a disabled affordance instead", async () => {
    // Built-in lock is on by default (ALLOW_BUILTIN_SKILL_MUTATION
    // unset → false). The Edit button must NOT invoke onEditConfig
    // for an `is_system: true` row, and the read-only tooltip must
    // be exposed so admins discover the Clone path.
    mockIsAdmin = false;
    _configs = [makeQuickStart("sys-edit")];
    const onEditConfig = jest.fn();
    await renderGallery({ onEditConfig });

    // The actionable Edit button is gone; only the disabled,
    // read-only-tooltip variant remains.
    expect(screen.queryByTitle("Edit")).toBeNull();
    const lockedBtn = screen.getByTitle(/Built-in skill is read-only/i);
    expect(lockedBtn).toBeDisabled();

    fireEvent.click(lockedBtn);
    expect(onEditConfig).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Multi-task skill card opens modal
// ---------------------------------------------------------------------------

describe("SkillsGallery — multi-task skill card opens modal", () => {
  it("clicking a workflow card opens the modal with Try Skill button", async () => {
    mockWorkflowRunnerEnabled = true;
    _configs = [makeWorkflow("wf-select")];
    await renderGallery();
    const cards = screen.getAllByText("Deploy Pipeline Workflow");
    await act(async () => { fireEvent.click(cards[0]); });
    expect(screen.getByRole("button", { name: /try skill/i })).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// Catalog refresh after scan/override (regression for stale "Disabled"
// badge requiring a hard refresh)
// ---------------------------------------------------------------------------
//
// This block locks in the fix for the bug where clearing a hub
// skill's admin scan-override left the gallery showing the red
// "Disabled — flagged" badge until a hard browser refresh. The root
// cause was twofold:
//
//   1. `onScanComplete` only re-ran the Zustand `loadSkills()`, which
//      hits `/api/skills/configs` (the agent_skills branch). Hub-
//      projected rows live in a separate `/api/skills` fetch and need
//      an explicit refresh after admin actions.
//   2. The catalog mapping dropped `scan_override` on its way through
//      an inline type cast, so even a manual refetch would lose the
//      gate signal that `isFlaggedSkill` uses to compute the
//      synthetic "admin-overridden" UX state.
//
// We assert both: the catalog endpoint is re-hit on `onScanComplete`,
// AND `scan_override` from the response actually suppresses the
// flagged-disabled badge on hub-projected rows.

describe("SkillsGallery — catalog refresh after scan/override", () => {
  // Track every `/api/skills` (catalog) request so the test can
  // assert that `onScanComplete` re-fetched it. We only count GETs
  // for the unified catalog (the path with `include_content=true`).
  let catalogFetchCount = 0;
  // Per-test mutable response payload — flips between "flagged with
  // override" and "flagged without override" to simulate the admin
  // toggling the override on/off without remounting the component.
  let catalogResponse: { skills: Array<Record<string, unknown>> } = { skills: [] };

  beforeEach(() => {
    catalogFetchCount = 0;
    catalogResponse = { skills: [] };
    _configs = [];

    global.fetch = jest.fn((url: string | URL | Request) => {
      const urlStr =
        typeof url === "string"
          ? url
          : url instanceof URL
          ? url.toString()
          : url.url;

      // Both the unified catalog endpoint (`/api/skills?...`) and
      // the per-source mongo endpoint (`/api/skills/configs`) start
      // with `/api/skills`. We only want to count the unified one,
      // so we discriminate on the query string the gallery uses.
      if (urlStr.includes("/api/skills?include_content=true")) {
        catalogFetchCount += 1;
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve(catalogResponse),
        } as Response);
      }

      if (urlStr.includes("/api/skills/configs")) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve([]),
        } as Response);
      }

      // Fallback: the gallery's seed/favorites paths. Empty OK is fine.
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({}),
      } as Response);
    }) as jest.Mock;
  });

  it("propagates scan_override from the catalog response so a flagged hub skill with override does NOT show 'Disabled — flagged'", async () => {
    catalogResponse = {
      skills: [
        {
          id: "hub-acme-secrets",
          name: "Hub Skill With Override",
          source: "hub",
          source_id: "acme/secrets",
          description: "Flagged hub skill that admin has explicitly green-lit.",
          metadata: { catalog_source: "hub", category: "Hub" },
          scan_status: "flagged",
          scan_summary: "Found shell injection",
          scan_override: {
            set_by: "admin@example.com",
            set_at: new Date().toISOString(),
            reason: "Reviewed manually, the apparent shell call is in a comment.",
            prior_scan_status: "flagged",
            prior_scan_summary: "Found shell injection",
          },
        },
      ],
    };
    await renderGallery();

    // Card must render (the catalog feed is what drives hub rows).
    expect(await screen.findByText("Hub Skill With Override")).toBeInTheDocument();

    // The scoped "Disabled — flagged" badge belongs to this card iff
    // `isFlaggedSkill` returned true. With `scan_override` present
    // the predicate must return false. We don't bind to the card
    // wrapper because the gallery shows the same row in multiple
    // sections (My Skills / Built-in / All); just assert no such
    // badge exists anywhere.
    expect(screen.queryByText(/Disabled — flagged/i)).not.toBeInTheDocument();
  });

  it("shows the 'Disabled — flagged' badge for a flagged hub skill WITHOUT an override (control case)", async () => {
    catalogResponse = {
      skills: [
        {
          id: "hub-acme-leak",
          name: "Hub Skill Without Override",
          source: "hub",
          source_id: "acme/leak",
          description: "Flagged hub skill, no admin override.",
          metadata: { catalog_source: "hub", category: "Hub" },
          scan_status: "flagged",
          scan_summary: "Found credential leak",
          // no scan_override
        },
      ],
    };
    await renderGallery();

    expect(await screen.findByText("Hub Skill Without Override")).toBeInTheDocument();
    // At least one occurrence: the card lives in both the All-skills
    // grid and the source-filtered "Built-in" grid (hub rows are
    // surfaced as built-in by `skillCatalogSource`). Both should
    // show the badge.
    expect(screen.getAllByText(/Disabled — flagged/i).length).toBeGreaterThan(0);
  });

  it("re-fetches the unified catalog when SkillScanStatusIndicator.onScanComplete fires", async () => {
    // Initial response: flagged + override. We don't actually mutate
    // it — we only need to confirm the gallery re-hits the endpoint
    // when `onScanComplete` triggers, which is the contract that
    // breaks if `refreshAll` regresses back to `loadSkills` alone.
    catalogResponse = {
      skills: [
        {
          id: "hub-acme-runme",
          name: "Hub Skill Refresh Probe",
          source: "hub",
          source_id: "acme/runme",
          description: "Used purely to host a scan indicator we can poke.",
          metadata: { catalog_source: "hub", category: "Hub" },
          scan_status: "flagged",
          scan_override: {
            set_by: "admin@example.com",
            set_at: new Date().toISOString(),
            reason: "Trusted source.",
            prior_scan_status: "flagged",
          },
        },
      ],
    };
    await renderGallery();

    await waitFor(() => {
      expect(catalogFetchCount).toBeGreaterThanOrEqual(1);
    });
    const initialCount = catalogFetchCount;

    // Catalog rows are rendered with id `catalog-<source>-<source_id>`
    // (see `mapCatalog` in SkillsGallery). Find any of the mocked
    // indicator buttons — there is one per visible occurrence of
    // the row, which is enough to drive the callback.
    const triggers = await screen.findAllByTestId(/^scan-complete-catalog-/);
    expect(triggers.length).toBeGreaterThan(0);

    await act(async () => {
      fireEvent.click(triggers[0]);
    });

    // `refreshAll` runs `loadSkills()` and `reloadCatalog()` in
    // parallel. We don't care about the agent_skills branch here —
    // the regression we're guarding against is specifically the
    // catalog branch, so we wait on its counter. Without the fix
    // this stayed pinned at `initialCount` forever, which is what
    // forced the user's hard refresh.
    await waitFor(() => {
      expect(catalogFetchCount).toBeGreaterThan(initialCount);
    });
  });
});
