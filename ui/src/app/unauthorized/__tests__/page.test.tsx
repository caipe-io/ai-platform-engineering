/**
 * Tests for /unauthorized page
 *
 * The page renders the OIDC required group name in two places:
 *   1. <code> inside "Required Group Membership" box
 *   2. <strong> inside the "Contact your IT administrator" bullet
 *
 * Before this fix the page imported REQUIRED_GROUP from the server-side
 * auth-config module — which is always `undefined` in a "use client"
 * component — so it rendered the hardcoded fallback string regardless
 * of the actual OIDC_REQUIRED_GROUP env var.
 *
 * After the fix it reads `config.oidcRequiredGroup` from window.__APP_CONFIG__
 * (the runtime-injected client config object).
 */

import React from "react";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

// ---------------------------------------------------------------------------
// Mocks — must be declared before any imports that reference them
// ---------------------------------------------------------------------------

const mockSignOut = jest.fn();
jest.mock("next-auth/react", () => ({
  signOut: (...args: unknown[]) => mockSignOut(...args),
}));

// framer-motion — render children without animation overhead
jest.mock("framer-motion", () => ({
  motion: {
    div: ({ children, ...rest }: React.HTMLAttributes<HTMLDivElement>) => (
      <div {...rest}>{children}</div>
    ),
  },
}));

// lucide-react — lightweight stub so tests don't depend on SVG rendering
jest.mock("lucide-react", () => ({
  ShieldX: () => <span data-testid="icon-shield-x" />,
  LogOut: () => <span data-testid="icon-logout" />,
  Mail: () => <span data-testid="icon-mail" />,
}));

// shadcn Button — pass-through
jest.mock("@/components/ui/button", () => ({
  Button: ({ children, onClick, asChild, ...rest }: React.HTMLAttributes<HTMLButtonElement> & { asChild?: boolean; onClick?: () => void }) => {
    if (asChild) {
      return <div {...rest}>{children}</div>;
    }
    return (
      <button onClick={onClick} {...rest}>
        {children}
      </button>
    );
  },
}));

jest.mock("@/components/auth/ImpersonationBanner", () => ({
  ImpersonationBanner: () => <div data-testid="impersonation-banner" />,
}));

// ---------------------------------------------------------------------------
// Config mock — patched per test via mockReturnValue / mockImplementation
// ---------------------------------------------------------------------------

const mockConfig = {
  oidcRequiredGroup: "caipe-users",
  supportEmail: "support@example.com",
  appName: "CAIPE",
  tagline: "AI Platform Engineering",
};

jest.mock("@/lib/config", () => ({
  config: new Proxy(
    {},
    {
      get: (_target, key: string) => mockConfig[key as keyof typeof mockConfig],
    },
  ),
}));

// ---------------------------------------------------------------------------
// Subject under test — imported AFTER mocks are set up
// ---------------------------------------------------------------------------

import UnauthorizedPage from "../page";

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("UnauthorizedPage", () => {
  beforeEach(() => {
    // Reset to safe defaults before each test
    mockConfig.oidcRequiredGroup = "caipe-users";
    mockConfig.supportEmail = "support@example.com";
    mockConfig.appName = "CAIPE";
    mockConfig.tagline = "AI Platform Engineering";
    mockSignOut.mockReset();
  });

  // ── Group name rendering ──────────────────────────────────────────────────

  describe("required group display", () => {
    it("renders the configured group name in the code block", () => {
      render(<UnauthorizedPage />);
      expect(screen.getByRole("code")).toHaveTextContent("caipe-users");
    });

    it("renders a custom group name from config.oidcRequiredGroup in the code block", () => {
      mockConfig.oidcRequiredGroup = "my-org-caipe-users";
      render(<UnauthorizedPage />);
      expect(screen.getByRole("code")).toHaveTextContent("my-org-caipe-users");
    });

    it("renders the group name in the <strong> contact-admin bullet", () => {
      mockConfig.oidcRequiredGroup = "acme-engineers";
      render(<UnauthorizedPage />);
      // The strong element inside the list item contains the group name
      const strongs = screen.getAllByText("acme-engineers");
      const strongEl = strongs.find((el) => el.tagName === "STRONG");
      expect(strongEl).toBeTruthy();
    });

    it("renders the group name in BOTH places consistently", () => {
      mockConfig.oidcRequiredGroup = "platform-team";
      render(<UnauthorizedPage />);
      const all = screen.getAllByText("platform-team");
      // code block + strong element = 2 occurrences
      expect(all.length).toBeGreaterThanOrEqual(2);
    });

    it("renders empty string gracefully (no crash) when oidcRequiredGroup is ''", () => {
      mockConfig.oidcRequiredGroup = "";
      expect(() => render(<UnauthorizedPage />)).not.toThrow();
    });
  });

  // ── No server-side import regression ─────────────────────────────────────

  it("does NOT import REQUIRED_GROUP from @/lib/auth-config", () => {
    // If the page still imported from auth-config the jest.mock('@/lib/config')
    // override above would have no effect and the group name would be undefined.
    // We verify that the rendered output uses our mocked value, not undefined.
    mockConfig.oidcRequiredGroup = "sentinel-value-12345";
    render(<UnauthorizedPage />);
    expect(screen.getByRole("code")).toHaveTextContent("sentinel-value-12345");
    expect(screen.getByRole("code")).not.toHaveTextContent("undefined");
    expect(screen.getByRole("code")).not.toHaveTextContent("caipe-users");
  });

  // ── Static content ────────────────────────────────────────────────────────

  it("renders Access Needed heading", () => {
    render(<UnauthorizedPage />);
    expect(
      screen.getByRole("heading", { name: /access needed/i }),
    ).toBeInTheDocument();
  });

  it("keeps the impersonation exit banner available", () => {
    render(<UnauthorizedPage />);
    expect(screen.getByTestId("impersonation-banner")).toBeInTheDocument();
  });

  it("renders the sign-out button", () => {
    render(<UnauthorizedPage />);
    expect(
      screen.getByRole("button", { name: /try another account/i }),
    ).toBeInTheDocument();
  });

  it("renders a contact-support mailto link", () => {
    mockConfig.supportEmail = "help@mycompany.com";
    mockConfig.appName = "MyApp";
    render(<UnauthorizedPage />);
    const link = screen.getByRole("link", { name: /contact support/i });
    expect(link).toHaveAttribute(
      "href",
      expect.stringContaining("help@mycompany.com"),
    );
    expect(link).toHaveAttribute("href", expect.stringContaining("MyApp"));
  });

  it("renders appName and tagline in the footer", () => {
    mockConfig.appName = "TestApp";
    mockConfig.tagline = "Tagline Text";
    render(<UnauthorizedPage />);
    expect(screen.getByText(/TestApp.*Tagline Text/)).toBeInTheDocument();
  });

  // ── Interactions ──────────────────────────────────────────────────────────

  it("calls signOut with callbackUrl '/login' when sign-out button is clicked", async () => {
    const user = userEvent.setup();
    render(<UnauthorizedPage />);
    await user.click(screen.getByRole("button", { name: /try another account/i }));
    expect(mockSignOut).toHaveBeenCalledWith({ callbackUrl: "/login" });
  });
});
