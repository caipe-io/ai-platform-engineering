/**
 * Tests for SkillWorkspace — focuses on the shell behaviours:
 *   - tab navigation
 *   - read-only badge
 *   - dirty-back guard + discard dialog
 *   - submit button enable/disable
 *
 * The individual tab bodies have their own tests; here we mock them out so
 * we don't need to set up CodeMirror, runner, etc.
 */

import React from "react";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const pushMock = jest.fn();
jest.mock("next/navigation", () => ({
  useRouter: () => ({ push: pushMock, replace: pushMock }),
}));

const mockToast = jest.fn();
jest.mock("@/components/ui/toast", () => ({
  useToast: () => ({ toast: mockToast }),
}));

// Mock the scan indicator
jest.mock("@/components/skills/SkillScanStatusIndicator", () => ({
  SkillScanStatusIndicator: () => <span data-testid="scan-indicator" />,
}));

// Mock heavy tab bodies
jest.mock("@/components/skills/workspace/tabs/OverviewTab", () => ({
  OverviewTab: () => <div data-testid="overview-tab">overview</div>,
}));
jest.mock("@/components/skills/workspace/tabs/FilesTab", () => ({
  FilesTab: () => <div data-testid="files-tab">files</div>,
}));
jest.mock("@/components/skills/workspace/tabs/VariablesTab", () => ({
  VariablesTab: () => <div data-testid="variables-tab">vars</div>,
}));
jest.mock("@/components/skills/workspace/tabs/ToolsTab", () => ({
  ToolsTab: () => <div data-testid="tools-tab">tools</div>,
}));
jest.mock("@/components/skills/workspace/tabs/VersionsTab", () => ({
  VersionsTab: () => <div data-testid="versions-tab">versions</div>,
}));
jest.mock("@/components/skills/workspace/tabs/HistoryTab", () => ({
  // The file now exports `ScanTab` as the canonical name (with a
  // backwards-compat `HistoryTab` alias). Mock both so SkillWorkspace's
  // `import { ScanTab }` resolves and any legacy callers still work.
  ScanTab: () => <div data-testid="scan-tab">scan</div>,
  HistoryTab: () => <div data-testid="scan-tab">scan</div>,
}));

// Mock the form hook to give us deterministic state — we toggle `isDirty`
// via setters captured in `formState`.
type FormShape = {
  isDirty: boolean;
  isSubmitting: boolean;
  ancillaryOverLimit: boolean;
  showDiscardConfirm: boolean;
  formData: { name: string; description: string; category: string; difficulty: string; thumbnail: string };
  guardedClose: jest.Mock;
  cancelDiscard: jest.Mock;
  confirmDiscard: jest.Mock;
  handleSubmit: jest.Mock;
  setSkillContent: jest.Mock;
};

let mockForm: FormShape;
function resetForm(overrides: Partial<FormShape> = {}) {
  mockForm = {
    isDirty: false,
    isSubmitting: false,
    ancillaryOverLimit: false,
    showDiscardConfirm: false,
    formData: {
      name: "Triage",
      description: "",
      category: "Custom",
      difficulty: "intermediate",
      thumbnail: "",
    },
    guardedClose: jest.fn(),
    cancelDiscard: jest.fn(),
    confirmDiscard: jest.fn(),
    handleSubmit: jest.fn().mockResolvedValue(undefined),
    setSkillContent: jest.fn(),
    ...overrides,
  };
}
resetForm();

jest.mock("@/components/skills/workspace/use-skill-form", () => ({
  useSkillForm: () => mockForm,
}));

// Mock the global unsaved-changes store so we can assert the workspace
// wires its `form.isDirty` into it (and reads `pendingNavigationHref`).
const mockSetUnsaved = jest.fn();
const mockCancelNav = jest.fn();
const mockConfirmNav = jest.fn(() => "/chat");
const mockStoreState: {
  pendingNavigationHref: string | null;
} = { pendingNavigationHref: null };
jest.mock("@/store/unsaved-changes-store", () => ({
  useUnsavedChangesStore: () => ({
    setUnsaved: mockSetUnsaved,
    pendingNavigationHref: mockStoreState.pendingNavigationHref,
    cancelNavigation: mockCancelNav,
    confirmNavigation: mockConfirmNav,
  }),
}));

import { SkillWorkspace } from "../SkillWorkspace";
import type { AgentSkill } from "@/types/agent-skill";

const SAMPLE_SKILL: AgentSkill & {
  shared_team_ids: string[];
  source: string;
  user_id: string;
} = {
  id: "skill-1",
  name: "Triage",
  description: "",
  category: "Custom",
  difficulty: "intermediate",
  source: "agent_skills",
  visibility: "private",
  shared_team_ids: [],
  user_id: "u1",
  tasks: [],
  owner_id: "u1",
  is_system: false,
  created_at: new Date(),
  updated_at: new Date(),
};

beforeEach(() => {
  pushMock.mockClear();
  mockToast.mockClear();
  mockSetUnsaved.mockClear();
  mockCancelNav.mockClear();
  mockConfirmNav.mockClear();
  mockStoreState.pendingNavigationHref = null;
  resetForm();
});

// ---------------------------------------------------------------------------

describe("SkillWorkspace — header", () => {
  it("renders the skill name without a per-skill sync badge", () => {
    render(<SkillWorkspace existingConfig={SAMPLE_SKILL} />);
    expect(screen.getByText("Triage")).toBeInTheDocument();
    expect(screen.queryByTestId("sync-badge")).not.toBeInTheDocument();
  });

  it("shows a Read-only badge when readOnly is true", () => {
    render(<SkillWorkspace existingConfig={SAMPLE_SKILL} readOnly />);
    expect(screen.getByText(/Read-only/i)).toBeInTheDocument();
  });

  it("shows an Unsaved changes badge when the form is dirty", () => {
    resetForm({ isDirty: true });
    render(<SkillWorkspace existingConfig={SAMPLE_SKILL} />);
    expect(screen.getByText(/Unsaved changes/i)).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------

describe("SkillWorkspace — tabs", () => {
  it("starts on the Files tab by default for existing skills", () => {
    render(<SkillWorkspace existingConfig={SAMPLE_SKILL} />);
    expect(screen.getByTestId("files-tab")).toBeInTheDocument();
  });

  it("respects the initialTab prop", () => {
    render(
      <SkillWorkspace
        existingConfig={SAMPLE_SKILL}
        initialTab="tools"
      />,
    );
    // The Tools tab is rendered by the workspace shell when selected.
    expect(
      screen.getByRole("tab", { name: /Tools/i, selected: true }),
    ).toBeInTheDocument();
  });

  it("switches tabs when the user clicks a tab trigger", async () => {
    const user = userEvent.setup();
    render(<SkillWorkspace existingConfig={SAMPLE_SKILL} />);
    await user.click(screen.getByRole("tab", { name: /Tools/i }));
    await waitFor(() => {
      expect(
        screen.getByRole("tab", { name: /Tools/i, selected: true }),
      ).toBeInTheDocument();
    });
  });

  it("does not render a Test step (Test moved to the gallery's Try Skill flow)", () => {
    render(<SkillWorkspace existingConfig={SAMPLE_SKILL} />);
    expect(
      screen.queryByRole("tab", { name: /Test/i }),
    ).not.toBeInTheDocument();
  });

  it("disables the Scan skill step for unsaved (new) skills", () => {
    render(<SkillWorkspace />);
    expect(
      screen.getByRole("tab", { name: /Scan skill/i }),
    ).toBeDisabled();
  });

  it("renders steps with a numbered badge so the order is obvious", () => {
    render(<SkillWorkspace existingConfig={SAMPLE_SKILL} />);
    // Step rail: 5 steps total when the skill exists. Versions sits
    // between Tools and Scan skill so users have a clear roll-back
    // affordance without leaving the workspace.
    const steps = screen.getAllByRole("tab");
    expect(steps).toHaveLength(5);
    // Each tab label includes the visible step name.
    [
      "Overview",
      "Skill content",
      "Tools",
      "Versions",
      "Scan skill",
    ].forEach((label) => {
      expect(screen.getByRole("tab", { name: new RegExp(label, "i") })).toBeInTheDocument();
    });
  });
});

// ---------------------------------------------------------------------------

describe("SkillWorkspace — wizard navigation", () => {
  it("starts the wizard footer on step 1 of 3 for new skills (Versions and Scan are hidden)", () => {
    render(<SkillWorkspace />);
    // Visible steps for a NEW (unsaved) skill: Overview, Skill
    // content, Tools. Both Versions and Scan are hidden until the
    // skill exists — they read collections keyed off a persisted id.
    expect(screen.getAllByText(/Step 1 of 3/i).length).toBeGreaterThan(0);
    expect(
      screen.getByTestId("skill-workspace-step-prev"),
    ).toBeDisabled();
  });

  it("Next button advances through the wizard and labels the next step", async () => {
    const user = userEvent.setup();
    render(<SkillWorkspace existingConfig={SAMPLE_SKILL} initialTab="overview" />);
    const next = screen.getByTestId("skill-workspace-step-next");
    expect(next).toHaveTextContent(/Next: Skill content/i);
    await user.click(next);
    // Saved skills now expose 5 steps (Overview, Skill content,
    // Tools, Versions, Scan skill).
    await waitFor(() => {
      expect(screen.getAllByText(/Step 2 of 5/i).length).toBeGreaterThan(0);
    });
  });

  it("renders a Save button on the final step instead of Next", () => {
    render(
      <SkillWorkspace existingConfig={SAMPLE_SKILL} initialTab="history" />,
    );
    expect(
      screen.getByTestId("skill-workspace-step-save"),
    ).toBeInTheDocument();
    expect(
      screen.queryByTestId("skill-workspace-step-next"),
    ).not.toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------

describe("SkillWorkspace — back navigation", () => {
  it("navigates immediately when not dirty", () => {
    render(<SkillWorkspace existingConfig={SAMPLE_SKILL} />);
    fireEvent.click(screen.getByRole("button", { name: /Back to Skills/i }));
    expect(pushMock).toHaveBeenCalledWith("/skills");
  });

  it("calls guardedClose when dirty (and does NOT navigate yet)", () => {
    resetForm({ isDirty: true });
    render(<SkillWorkspace existingConfig={SAMPLE_SKILL} />);
    fireEvent.click(screen.getByRole("button", { name: /Back to Skills/i }));
    expect(mockForm.guardedClose).toHaveBeenCalledTimes(1);
    expect(pushMock).not.toHaveBeenCalled();
  });

  it("renders the Discard dialog when form.showDiscardConfirm is true", () => {
    resetForm({ showDiscardConfirm: true });
    render(<SkillWorkspace existingConfig={SAMPLE_SKILL} />);
    expect(screen.getByText(/Discard unsaved changes\?/i)).toBeInTheDocument();
  });

  it("Discard & leave button confirms and navigates", () => {
    resetForm({ showDiscardConfirm: true });
    render(<SkillWorkspace existingConfig={SAMPLE_SKILL} />);
    fireEvent.click(
      screen.getByRole("button", { name: /Discard & leave/i }),
    );
    expect(mockForm.confirmDiscard).toHaveBeenCalledTimes(1);
    expect(pushMock).toHaveBeenCalledWith("/skills");
  });
});

// ---------------------------------------------------------------------------

describe("SkillWorkspace — save", () => {
  it("Save button is disabled when name is empty", () => {
    resetForm({
      formData: {
        name: "",
        description: "",
        category: "Custom",
        difficulty: "intermediate",
        thumbnail: "",
      },
    });
    render(<SkillWorkspace existingConfig={SAMPLE_SKILL} />);
    expect(screen.getByRole("button", { name: /^Save$/i })).toBeDisabled();
  });

  it("Save button is disabled when readOnly", () => {
    render(<SkillWorkspace existingConfig={SAMPLE_SKILL} readOnly />);
    expect(screen.getByRole("button", { name: /^Save$/i })).toBeDisabled();
  });

  it("calls form.handleSubmit when clicked", () => {
    render(<SkillWorkspace existingConfig={SAMPLE_SKILL} />);
    fireEvent.click(screen.getByRole("button", { name: /^Save$/i }));
    expect(mockForm.handleSubmit).toHaveBeenCalledTimes(1);
  });

  it("shows 'Create skill' label for new skills", () => {
    render(<SkillWorkspace />);
    expect(
      screen.getByRole("button", { name: /Create skill/i }),
    ).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------

describe("SkillWorkspace — export", () => {
  // The Export button hits /api/skills/configs/[id]/export and triggers a
  // synthetic anchor download. We mock fetch + URL.createObjectURL so the
  // test can assert behaviour without touching the network or the DOM's
  // real Blob/file-saving plumbing.
  let originalCreate: typeof URL.createObjectURL;
  let originalRevoke: typeof URL.revokeObjectURL;
  let createSpy: jest.Mock;
  let revokeSpy: jest.Mock;
  let clickSpy: jest.SpyInstance;

  beforeEach(() => {
    createSpy = jest.fn(() => "blob:mock-url");
    revokeSpy = jest.fn();
    originalCreate = URL.createObjectURL;
    originalRevoke = URL.revokeObjectURL;
    URL.createObjectURL = createSpy as unknown as typeof URL.createObjectURL;
    URL.revokeObjectURL = revokeSpy as unknown as typeof URL.revokeObjectURL;
    clickSpy = jest
      .spyOn(HTMLAnchorElement.prototype, "click")
      .mockImplementation(() => {});
  });

  afterEach(() => {
    URL.createObjectURL = originalCreate;
    URL.revokeObjectURL = originalRevoke;
    clickSpy.mockRestore();
  });

  it("does NOT render the Export button for new (unsaved) skills", () => {
    render(<SkillWorkspace />);
    expect(
      screen.queryByTestId("skill-workspace-export"),
    ).not.toBeInTheDocument();
  });

  it("renders the Export button for existing skills (incl. read-only)", () => {
    const { rerender } = render(<SkillWorkspace existingConfig={SAMPLE_SKILL} />);
    expect(
      screen.getByTestId("skill-workspace-export"),
    ).toBeInTheDocument();
    rerender(<SkillWorkspace existingConfig={SAMPLE_SKILL} readOnly />);
    expect(
      screen.getByTestId("skill-workspace-export"),
    ).toBeInTheDocument();
  });

  it("downloads a ZIP from the export endpoint when clicked", async () => {
    const blob = new Blob(["zip-bytes"], { type: "application/zip" });
    const fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      blob: () => Promise.resolve(blob),
      headers: new Headers({
        "Content-Disposition": 'attachment; filename="triage.zip"',
      }),
    } as unknown as Response);
    global.fetch = fetchMock as unknown as typeof fetch;

    render(<SkillWorkspace existingConfig={SAMPLE_SKILL} />);
    fireEvent.click(screen.getByTestId("skill-workspace-export"));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/skills/configs/skill-1/export",
        expect.objectContaining({ credentials: "include" }),
      );
    });
    await waitFor(() => {
      expect(createSpy).toHaveBeenCalledWith(blob);
      expect(clickSpy).toHaveBeenCalled();
    });
    await waitFor(() => {
      expect(mockToast).toHaveBeenCalledWith(
        expect.stringMatching(/Exported "Triage"/),
        "success",
      );
    });
  });

  it("toasts an error when the export endpoint fails", async () => {
    const fetchMock = jest.fn().mockResolvedValue({
      ok: false,
      status: 404,
      blob: () => Promise.resolve(new Blob([])),
      headers: new Headers({}),
      json: () => Promise.resolve({ error: "Skill not found" }),
    } as unknown as Response);
    global.fetch = fetchMock as unknown as typeof fetch;

    render(<SkillWorkspace existingConfig={SAMPLE_SKILL} />);
    fireEvent.click(screen.getByTestId("skill-workspace-export"));

    await waitFor(() => {
      expect(mockToast).toHaveBeenCalledWith(
        expect.stringMatching(/Export failed.*Skill not found/),
        "error",
      );
    });
    expect(clickSpy).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------

describe("SkillWorkspace — unsaved-changes guard", () => {
  // ---------------------------------------------------------------------
  // (1) Wires form.isDirty into the global store so AppHeader's NavLinks
  //     intercept application-navigation clicks. The existing global tests cover the
  //     header side; here we just assert the workspace publishes its
  //     dirty state correctly.
  // ---------------------------------------------------------------------
  it("publishes hasUnsavedChanges=true to the store when the form is dirty", () => {
    resetForm({ isDirty: true });
    render(<SkillWorkspace existingConfig={SAMPLE_SKILL} />);
    // The most recent call should be `true`. We don't pin the call count
    // because React may re-render once for state propagation.
    const calls = mockSetUnsaved.mock.calls.map((c) => c[0]);
    expect(calls).toContain(true);
  });

  it("does NOT publish dirty state for read-only skills", () => {
    // Even if the form somehow reports dirty (e.g. transient state from
    // local controlled inputs), read-only skills should never block
    // navigation — the user has nothing to lose.
    resetForm({ isDirty: true });
    render(<SkillWorkspace existingConfig={SAMPLE_SKILL} readOnly />);
    const calls = mockSetUnsaved.mock.calls.map((c) => c[0]);
    expect(calls.every((v) => v === false)).toBe(true);
  });

  it("clears the dirty flag on unmount", () => {
    resetForm({ isDirty: true });
    const { unmount } = render(<SkillWorkspace existingConfig={SAMPLE_SKILL} />);
    mockSetUnsaved.mockClear();
    unmount();
    expect(mockSetUnsaved).toHaveBeenCalledWith(false);
  });

  // ---------------------------------------------------------------------
  // (2) Browser tab close / refresh — `beforeunload` only fires when the
  //     form is dirty. We dispatch a real BeforeUnloadEvent and assert
  //     the listener prevented its default (which is what triggers the
  //     browser's native confirm prompt).
  // ---------------------------------------------------------------------
  it("attaches a beforeunload listener that prevents default while dirty", () => {
    resetForm({ isDirty: true });
    render(<SkillWorkspace existingConfig={SAMPLE_SKILL} />);
    const ev = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(true);
  });

  it("does NOT prevent unload when the form is clean", () => {
    render(<SkillWorkspace existingConfig={SAMPLE_SKILL} />);
    const ev = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(false);
  });

  // ---------------------------------------------------------------------
  // (3) Top-nav click handshake — when AppHeader sets
  //     `pendingNavigationHref`, the workspace surfaces its existing
  //     discard-confirm dialog (NOT a separate header dialog) so the UX
  //     is identical for every exit path.
  // ---------------------------------------------------------------------
  it("opens the discard dialog when the application rail requests navigation", () => {
    mockStoreState.pendingNavigationHref = "/chat";
    resetForm({ isDirty: true });
    render(<SkillWorkspace existingConfig={SAMPLE_SKILL} />);
    expect(mockForm.guardedClose).toHaveBeenCalled();
  });

  it("Discard & leave honours the pending application-navigation href over backHref", () => {
    // Simulate the dialog being shown after AppHeader requested /chat.
    mockStoreState.pendingNavigationHref = "/chat";
    resetForm({ isDirty: true, showDiscardConfirm: true });

    render(<SkillWorkspace existingConfig={SAMPLE_SKILL} backHref="/skills" />);
    fireEvent.click(
      screen.getByTestId("skill-workspace-discard-confirm"),
    );
    expect(mockForm.confirmDiscard).toHaveBeenCalled();
    expect(mockConfirmNav).toHaveBeenCalled();
    expect(pushMock).toHaveBeenCalledWith("/chat");
  });

  it("Discard & leave falls back to backHref when there's no pending external nav", () => {
    resetForm({ isDirty: true, showDiscardConfirm: true });
    render(<SkillWorkspace existingConfig={SAMPLE_SKILL} backHref="/skills" />);
    fireEvent.click(
      screen.getByTestId("skill-workspace-discard-confirm"),
    );
    expect(pushMock).toHaveBeenCalledWith("/skills");
    expect(mockConfirmNav).not.toHaveBeenCalled();
  });

  it("Keep editing cancels the pending application-navigation request as well", () => {
    mockStoreState.pendingNavigationHref = "/chat";
    resetForm({ isDirty: true, showDiscardConfirm: true });
    render(<SkillWorkspace existingConfig={SAMPLE_SKILL} />);
    fireEvent.click(screen.getByRole("button", { name: /Keep editing/i }));
    expect(mockForm.cancelDiscard).toHaveBeenCalled();
    expect(mockCancelNav).toHaveBeenCalled();
  });
});
