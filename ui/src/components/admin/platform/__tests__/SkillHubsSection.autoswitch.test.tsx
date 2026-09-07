/**
 * Unit tests for the auto-switch behavior on the Skill Hubs admin
 * form's Source pill.
 *
 * The bug being prevented: pasting `https://gitlab.com/gitlab-org/ai/skills`
 * into the form while the GitHub source pill is selected used to
 * silently send a `{type: "github", location: <gitlab URL>}` request,
 * which the legacy GitHub URL parser truncated to `gitlab-org/ai`,
 * producing a confusing `api.github.com/repos/gitlab-org/ai/...` 404.
 *
 * The form now detects the URL host on every keystroke and flips the
 * Source pill to the matching provider, surfacing an inline notice so
 * the change is visible and reversible.
 *
 * These tests exercise the input handler and source pill ARIA state
 * directly — full Mongo / fetch lifecycle is mocked away because the
 * focus is the auto-switch UX, not the surrounding CRUD.
 */

import React from "react";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

// ============================================================================
// Mocks — must come before the component import
// ============================================================================

const mockFetch = jest.fn();
global.fetch = mockFetch;

// Minimal fetch contract for the initial GET /api/skill-hubs. The
// ``headers.get("content-type")`` shim is required because ``loadHubs``
// now goes through ``readJson`` to surface non-JSON responses (e.g. an
// upstream 504 HTML page) as actionable errors instead of opaque
// ``Unexpected token '<', "<!DOCTYPE "`` parse failures.
const jsonHeaders = {
  get: (n: string) => (n.toLowerCase() === "content-type" ? "application/json" : null),
};
beforeEach(() => {
  mockFetch.mockReset();
  mockFetch.mockImplementation((url: string) => {
    if (typeof url === "string" && url.includes("/api/skill-hubs")) {
      return Promise.resolve({
        ok: true,
        status: 200,
        headers: jsonHeaders,
        json: async () => ({ hubs: [] }),
        text: async () => JSON.stringify({ hubs: [] }),
      });
    }
    return Promise.resolve({
      ok: true,
      status: 200,
      headers: jsonHeaders,
      json: async () => ({}),
      text: async () => "{}",
    });
  });
});

jest.mock("lucide-react", () => ({
  Loader2: ({ className }: { className?: string }) => (
    <span data-testid="icon-loader" className={className} />
  ),
  Plus: () => <span data-testid="icon-plus" />,
  Trash2: () => <span data-testid="icon-trash" />,
  Globe: () => <span data-testid="icon-globe" />,
  AlertCircle: () => <span data-testid="icon-alert" />,
  AlertTriangle: () => <span data-testid="icon-alert-triangle" />,
  CheckCircle2: () => <span data-testid="icon-check" />,
  X: () => <span data-testid="icon-x" />,
  RefreshCcw: () => <span data-testid="icon-refresh" />,
  Search: () => <span data-testid="icon-search" />,
  ShieldAlert: () => <span data-testid="icon-shield-alert" />,
  Zap: () => <span data-testid="icon-zap" />,
  ListFilter: () => <span data-testid="icon-list-filter" />,
}));

jest.mock("@/components/ui/card", () => ({
  Card: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
  CardContent: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
  CardDescription: ({ children }: { children?: React.ReactNode }) => <p>{children}</p>,
  CardHeader: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
  CardTitle: ({ children }: { children?: React.ReactNode }) => <h3>{children}</h3>,
}));

jest.mock("@/components/ui/button", () => ({
  Button: ({
    children,
    onClick,
    ...rest
  }: {
    children?: React.ReactNode;
    onClick?: () => void;
    [k: string]: unknown;
  }) => (
    <button onClick={onClick} {...rest}>
      {children}
    </button>
  ),
}));

jest.mock("@/components/ui/badge", () => ({
  Badge: ({ children }: { children?: React.ReactNode }) => <span>{children}</span>,
}));

jest.mock("@/components/ui/icons", () => ({
  GithubIcon: () => <span data-testid="icon-github" />,
  GitlabIcon: () => <span data-testid="icon-gitlab" />,
}));

jest.mock("@/components/skills/ScanAllDialog", () => ({
  ScanAllDialog: () => null,
}));

import { SkillHubsSection } from "../SkillHubsSection";

// ============================================================================
// Helpers
// ============================================================================

async function renderAndOpenAddForm() {
  render(<SkillHubsSection isAdmin={true} />);
  // Wait for the initial loading state to clear (the component shows a
  // spinner until the GET completes).
  await waitFor(() => {
    expect(screen.queryByTestId("icon-loader")).not.toBeInTheDocument();
  });
  // Click "Add Hub" to reveal the form.
  fireEvent.click(screen.getByText(/Add Hub/));
  // Form is visible once the Source label appears.
  await screen.findByText("Source");
}

function getSourcePill(name: "GitHub" | "GitLab") {
  // The pill is a button with role="radio" and aria-checked.
  return screen.getByRole("radio", { name: new RegExp(`^${name}$`) });
}

function getLocationInput() {
  // The label text is dynamic ("GitHub repository" / "GitLab project")
  // but there's exactly one text input under that label, so finding by
  // placeholder works for either provider.
  const inputs = screen
    .getAllByRole("textbox")
    .filter((el) => el.tagName === "INPUT");
  // The first text input in the form is the location field.
  return inputs[0] as HTMLInputElement;
}

// ============================================================================
// Tests
// ============================================================================

describe("SkillHubsSection — auto-switch source pill on URL paste", () => {
  it("renders configured hubs read-only without management error or actions", async () => {
    mockFetch.mockImplementation((url: string) => {
      if (typeof url === "string" && url.includes("/api/skill-hubs")) {
        return Promise.resolve({
          ok: true,
          status: 200,
          headers: jsonHeaders,
          json: async () => ({
            hubs: [
              {
                id: "hub-1",
                type: "github",
                location: "caipe-io/ai-platform-engineering",
                enabled: true,
                credentials_ref: null,
                labels: ["platform"],
                shared_with_teams: ["sre"],
                last_success_at: null,
                last_failure_at: null,
                last_failure_message: null,
                created_at: "2026-05-20T00:00:00.000Z",
                updated_at: "2026-05-20T00:00:00.000Z",
              },
            ],
          }),
          text: async () => JSON.stringify({ hubs: [] }),
        });
      }
      return Promise.resolve({
        ok: true,
        status: 200,
        headers: jsonHeaders,
        json: async () => ({}),
        text: async () => "{}",
      });
    });

    render(<SkillHubsSection isAdmin={false} />);

    expect(await screen.findByText("caipe-io/ai-platform-engineering")).toBeInTheDocument();
    expect(screen.getByText("sre")).toBeInTheDocument();
    expect(screen.queryByText(/Admin access required to manage skill hubs/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/Add Hub/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/Actions/i)).not.toBeInTheDocument();
  });

  it("auto-switches to GitLab when a gitlab.com URL is pasted while GitHub is selected", async () => {
    await renderAndOpenAddForm();

    // Default state: GitHub selected.
    expect(getSourcePill("GitHub")).toHaveAttribute("aria-checked", "true");
    expect(getSourcePill("GitLab")).toHaveAttribute("aria-checked", "false");

    // Paste the screenshot URL.
    fireEvent.change(getLocationInput(), {
      target: { value: "https://gitlab.com/gitlab-org/ai/skills" },
    });

    // Pill flipped.
    await waitFor(() => {
      expect(getSourcePill("GitLab")).toHaveAttribute("aria-checked", "true");
    });
    expect(getSourcePill("GitHub")).toHaveAttribute("aria-checked", "false");

    // Inline notice is visible (role="status" so screen-reader users
    // get the announcement too).
    const notice = screen.getByRole("status");
    expect(notice).toHaveTextContent(/Detected GitLab URL/);
  });

  it("auto-switches to GitHub when a github.com URL is pasted while GitLab is selected", async () => {
    await renderAndOpenAddForm();

    // Manually flip to GitLab first.
    fireEvent.click(getSourcePill("GitLab"));
    expect(getSourcePill("GitLab")).toHaveAttribute("aria-checked", "true");

    fireEvent.change(getLocationInput(), {
      target: { value: "https://github.com/caipe-io/ai-platform-engineering" },
    });

    await waitFor(() => {
      expect(getSourcePill("GitHub")).toHaveAttribute("aria-checked", "true");
    });
    expect(screen.getByRole("status")).toHaveTextContent(/Detected GitHub URL/);
  });

  it("does NOT switch when typing a plain owner/repo (non-URL)", async () => {
    await renderAndOpenAddForm();

    // GitHub is the default; type a flat owner/repo.
    fireEvent.change(getLocationInput(), {
      target: { value: "caipe-io/ai-platform-engineering" },
    });

    expect(getSourcePill("GitHub")).toHaveAttribute("aria-checked", "true");
    // No detected-provider notice.
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("does NOT switch when typing a matching URL (already on the right pill)", async () => {
    await renderAndOpenAddForm();

    // GitHub is selected; type a github.com URL — should NOT show the
    // notice because nothing actually changed.
    fireEvent.change(getLocationInput(), {
      target: { value: "https://github.com/owner/repo" },
    });

    expect(getSourcePill("GitHub")).toHaveAttribute("aria-checked", "true");
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("ignores look-alike hosts (evil-github.com) — no switch and no notice", async () => {
    await renderAndOpenAddForm();

    // Start on GitLab so a successful (incorrect) classification of
    // `evil-github.com` as github would visibly flip the pill.
    fireEvent.click(getSourcePill("GitLab"));

    fireEvent.change(getLocationInput(), {
      target: { value: "https://evil-github.com/owner/repo" },
    });

    // Pill stayed on GitLab — the substring `github` in the host did
    // NOT trigger a misclassification.
    expect(getSourcePill("GitLab")).toHaveAttribute("aria-checked", "true");
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("clears the auto-switch notice when the user manually flips the source pill", async () => {
    await renderAndOpenAddForm();

    // Trigger an auto-switch first.
    fireEvent.change(getLocationInput(), {
      target: { value: "https://gitlab.com/group/project" },
    });
    await waitFor(() => {
      expect(getSourcePill("GitLab")).toHaveAttribute("aria-checked", "true");
    });
    expect(screen.getByRole("status")).toBeInTheDocument();

    // User flips back to GitHub manually — they're saying "I know what
    // I'm doing" so the notice should disappear.
    fireEvent.click(getSourcePill("GitHub"));
    expect(getSourcePill("GitHub")).toHaveAttribute("aria-checked", "true");
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("clears the auto-switch notice when the user replaces the URL with a non-URL", async () => {
    await renderAndOpenAddForm();

    fireEvent.change(getLocationInput(), {
      target: { value: "https://gitlab.com/group/project" },
    });
    await waitFor(() => {
      expect(screen.getByRole("status")).toBeInTheDocument();
    });

    // Now retype to a flat path.
    fireEvent.change(getLocationInput(), {
      target: { value: "group/project" },
    });
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });
});
