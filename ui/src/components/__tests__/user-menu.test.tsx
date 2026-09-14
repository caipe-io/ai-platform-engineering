/**
 * Unit tests for UserMenu component
 *
 * Tests:
 * - Returns null when ssoEnabled=false
 * - Loading state
 * - Sign In when unauthenticated
 * - User initials, first name, dropdown
 * - User email, Admin/User badge, SSO info
 * - Settings, Sign Out, Personal Insights, problem reporting
 * - signOut call, outside click
 * - User image, missing name fallback
 */

import React from "react";
import { render, screen, fireEvent } from "@testing-library/react";

// ============================================================================
// Mocks — must be before imports
// ============================================================================

const mockSignIn = jest.fn();
const mockSignOut = jest.fn();
let mockUseSession: jest.Mock;

jest.mock("next-auth/react", () => ({
  useSession: () => mockUseSession(),
  signIn: (...args: unknown[]) => mockSignIn(...args),
  signOut: (...args: unknown[]) => mockSignOut(...args),
}));

let mockConfig: Record<string, unknown> = {
  ssoEnabled: true,
  mongodbEnabled: true,
  reportProblemEnabled: false,
  appName: "CAIPE",
  tagline: "Test tagline",
};

jest.mock("@/lib/config", () => ({
  get config() {
    return new Proxy(
      {},
      {
        get(_: unknown, prop: string) {
          return mockConfig[prop];
        },
      }
    );
  },
}));

jest.mock("framer-motion", () => ({
  motion: {
    // eslint-disable-next-line react/display-name
    div: React.forwardRef(
      (
        { children, ...props }: { children?: React.ReactNode } & Record<string, unknown>,
        ref: React.Ref<HTMLDivElement>
      ) => (
        <div ref={ref} {...props}>
          {children}
        </div>
      )
    ),
  },
  AnimatePresence: ({ children }: { children?: React.ReactNode }) => (
    <>{children}</>
  ),
}));

jest.mock("lucide-react", () => ({
  LogIn: () => <span data-testid="icon-login" />,
  LogOut: () => <span data-testid="icon-logout" />,
  ChevronDown: () => <span data-testid="icon-chevron" />,
  ChevronUp: () => <span data-testid="icon-chevron-up" />,
  ChevronRight: () => <span data-testid="icon-chevron-right" />,
  Shield: () => <span data-testid="icon-shield" />,
  Lightbulb: () => <span data-testid="icon-lightbulb" />,
  FileText: () => <span data-testid="icon-filetext" />,
  Tag: () => <span data-testid="icon-tag" />,
  Wrench: () => <span data-testid="icon-wrench" />,
  Sparkles: () => <span data-testid="icon-sparkles" />,
  Users: () => <span data-testid="icon-users" />,
  Hash: () => <span data-testid="icon-hash" />,
  Code: () => <span data-testid="icon-code" />,
  Layers: () => <span data-testid="icon-layers" />,
  ExternalLink: () => <span data-testid="icon-external" />,
  Clock: () => <span data-testid="icon-clock" />,
  RefreshCw: () => <span data-testid="icon-refresh" />,
  Bug: () => <span data-testid="icon-bug" />,
  Copy: () => <span data-testid="icon-copy" />,
  Check: () => <span data-testid="icon-check" />,
  KeyRound: () => <span data-testid="icon-keyround" />,
  Search: () => <span data-testid="icon-search" />,
  X: () => <span data-testid="icon-x" />,
  SlidersHorizontal: () => <span data-testid="icon-sliders" />,
  Brain: () => <span data-testid="icon-brain" />,
  Eye: () => <span data-testid="icon-eye" />,
  ArrowDownToLine: () => <span data-testid="icon-arrowdown" />,
  Info: () => <span data-testid="icon-info" />,
  Loader2: () => <span data-testid="icon-loader" />,
}));

jest.mock("@/store/feature-flag-store", () => ({
  useFeatureFlagStore: () => ({ initialize: jest.fn(), flags: {}, toggle: jest.fn() }),
  isFeatureEnabled: jest.fn(() => false),
  FEATURE_FLAGS: [],
  CATEGORY_LABELS: {},
}));


jest.mock("@/components/ui/button", () => ({
  // eslint-disable-next-line react/display-name
  Button: React.forwardRef(
    (
      { children, onClick, ...props }: { children?: React.ReactNode; onClick?: () => void } & Record<string, unknown>,
      ref: React.Ref<HTMLButtonElement>
    ) => (
      <button ref={ref} onClick={onClick} {...props}>
        {children}
      </button>
    )
  ),
}));

jest.mock("@/components/ui/dialog", () => ({
  Dialog: ({ children, open }: { children?: React.ReactNode; open?: boolean }) =>
    open ? <div data-testid="dialog">{children}</div> : null,
  DialogContent: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
  DialogHeader: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
  DialogTitle: ({ children }: { children?: React.ReactNode }) => <h2>{children}</h2>,
  DialogDescription: ({ children }: { children?: React.ReactNode }) => <p>{children}</p>,
}));

jest.mock("@/components/ui/tabs", () => ({
  Tabs: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
  TabsList: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
  TabsTrigger: ({ children }: { children?: React.ReactNode }) => <button>{children}</button>,
  TabsContent: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
}));

jest.mock("@/components/ticket/ReportProblemDialog", () => ({
  ReportProblemDialog: ({ open }: { open: boolean }) =>
    open ? <div data-testid="report-problem-dialog">ReportProblemDialog</div> : null,
}));

jest.mock("@/components/layout/ApplicationVersion", () => ({
  ApplicationVersion: () => <div>Version: v0.6.0</div>,
}));

jest.mock("@/lib/utils", () => ({
  cn: (...args: unknown[]) => args.filter(Boolean).join(" "),
}));

// ============================================================================
// Imports — after mocks
// ============================================================================

import { UserMenu } from "../user-menu";

// ============================================================================
// Tests
// ============================================================================

describe("UserMenu", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockConfig = {
      ssoEnabled: true,
      mongodbEnabled: true,
      reportProblemEnabled: false,
      appName: "CAIPE",
      tagline: "Test tagline",
    };
    mockUseSession = jest.fn().mockReturnValue({
      data: {
        user: { name: "John Doe", email: "john@example.com" },
        role: "user",
      },
      status: "authenticated",
      update: jest.fn(),
    });
  });

  it("returns null when ssoEnabled=false", () => {
    mockConfig = { ...mockConfig, ssoEnabled: false };
    const { container } = render(<UserMenu />);
    expect(container.firstChild).toBeNull();
  });

  it("shows loading state", () => {
    mockUseSession.mockReturnValue({ data: null, status: "loading" });
    const { container } = render(<UserMenu />);
    expect(container.querySelector(".animate-pulse")).toBeInTheDocument();
  });

  it("shows Sign In when unauthenticated", () => {
    mockUseSession.mockReturnValue({ data: null, status: "unauthenticated" });
    render(<UserMenu />);
    expect(screen.getByText("Sign In")).toBeInTheDocument();
  });

  it("shows user initials from name", () => {
    mockUseSession.mockReturnValue({
      data: {
        user: { name: "Jane Smith", email: "jane@example.com" },
        role: "user",
      },
      status: "authenticated",
      update: jest.fn(),
    });
    render(<UserMenu />);
    expect(screen.getByText("JS")).toBeInTheDocument();
  });

  it("button shows avatar only (no name) but carries user name in aria-label", () => {
    render(<UserMenu />);
    const btn = screen.getByRole("button", { name: /user menu for John/i });
    // The button itself should not contain the user's name as visible text
    expect(btn).toBeInTheDocument();
    expect(btn.textContent).not.toContain("John");
  });

  it("opens dropdown and shows user info, role badge, SSO note, and actions", () => {
    render(<UserMenu />);
    fireEvent.click(screen.getByRole("button", { name: /user menu for John/i }));
    expect(screen.getByText("john@example.com")).toBeInTheDocument();
    expect(screen.getByText("User")).toBeInTheDocument();
    expect(screen.getByText("Authenticated via SSO")).toBeInTheDocument();
    expect(screen.queryByText("Settings")).not.toBeInTheDocument();
    expect(screen.getByText("About")).toBeInTheDocument();
    expect(screen.getByText("Sign Out")).toBeInTheDocument();
  });

  it("shows build information in About instead of the navigation footer", () => {
    render(<UserMenu />);
    fireEvent.click(screen.getByRole("button", { name: /user menu for John/i }));
    fireEvent.click(screen.getByRole("button", { name: "About" }));

    expect(screen.getByText("Version: v0.6.0")).toBeInTheDocument();
  });

  it("shows Admin badge and Personal Insights when role is admin and mongodb is enabled", () => {
    mockConfig = { ...mockConfig, mongodbEnabled: true };
    mockUseSession.mockReturnValue({
      data: {
        user: { name: "Admin User", email: "admin@example.com" },
        role: "admin",
      },
      status: "authenticated",
      update: jest.fn(),
    });
    render(<UserMenu />);
    fireEvent.click(screen.getByRole("button", { name: /user menu for Admin User/i }));
    expect(screen.getByText("Admin")).toBeInTheDocument();
    expect(screen.getByText("Personal Insights")).toBeInTheDocument();
  });

  it("hides Personal Insights when mongodbEnabled is false", () => {
    mockConfig = { ...mockConfig, mongodbEnabled: false };
    render(<UserMenu />);
    fireEvent.click(screen.getByRole("button", { name: /user menu for John/i }));
    expect(screen.queryByText("Personal Insights")).not.toBeInTheDocument();
  });

  it("opens problem reporting from the user menu when enabled", () => {
    mockConfig = { ...mockConfig, reportProblemEnabled: true };
    render(<UserMenu />);

    fireEvent.click(screen.getByRole("button", { name: /user menu for John/i }));
    fireEvent.click(screen.getByRole("button", { name: "Report a Problem" }));

    expect(screen.getByTestId("report-problem-dialog")).toBeInTheDocument();
    expect(screen.queryByText("john@example.com")).not.toBeInTheDocument();
  });

  it("hides problem reporting when disabled", () => {
    render(<UserMenu />);

    fireEvent.click(screen.getByRole("button", { name: /user menu for John/i }));

    expect(screen.queryByRole("button", { name: "Report a Problem" })).not.toBeInTheDocument();
  });

  it("calls signOut and closes dropdown on Sign Out", () => {
    render(
      <div>
        <UserMenu />
        <button data-testid="outside">Outside</button>
      </div>
    );
    fireEvent.click(screen.getByRole("button", { name: /user menu for John/i }));
    fireEvent.click(screen.getByText("Sign Out"));
    expect(mockSignOut).toHaveBeenCalledWith({ callbackUrl: "/login" });

    // Dropdown should also close on outside click
    fireEvent.click(screen.getByRole("button", { name: /user menu for John/i }));
    expect(screen.getByText("john@example.com")).toBeInTheDocument();
    fireEvent.mouseDown(screen.getByTestId("outside"));
    expect(screen.queryByText("john@example.com")).not.toBeInTheDocument();
  });

  it("shows user image when available", () => {
    mockUseSession.mockReturnValue({
      data: {
        user: {
          name: "Photo User",
          email: "photo@example.com",
          image: "https://example.com/avatar.png",
        },
        role: "user",
      },
      status: "authenticated",
      update: jest.fn(),
    });
    render(<UserMenu />);
    const img = screen.getByRole("img", { name: "Photo User" });
    expect(img).toBeInTheDocument();
    expect(img).toHaveAttribute("src", "https://example.com/avatar.png");
  });

  it("handles missing name (falls back to 'User')", () => {
    mockUseSession.mockReturnValue({
      data: {
        user: { email: "noname@example.com" },
        role: "user",
      },
      status: "authenticated",
      update: jest.fn(),
    });
    render(<UserMenu />);
    // Button shows avatar + chevron; name fallback visible in aria-label
    expect(screen.getByRole("button", { name: /user menu for User/i })).toBeInTheDocument();
  });
});
