import React from "react";
import { fireEvent, render, screen } from "@testing-library/react";

jest.mock("@/components/ui/button", () => {
  const MockButton = React.forwardRef<HTMLButtonElement, React.ButtonHTMLAttributes<HTMLButtonElement>>(
    ({ children, ...props }, ref) => (
      <button ref={ref} {...props}>
        {children}
      </button>
    ),
  );
  MockButton.displayName = "MockButton";
  return { Button: MockButton };
});

interface MockDialogProps {
  open: boolean;
  children: React.ReactNode;
}

interface MockChildrenProps {
  children: React.ReactNode;
}

jest.mock("@/components/ui/dialog", () => ({
  Dialog: ({ open, children }: MockDialogProps) => (open ? <div role="dialog">{children}</div> : null),
  DialogContent: ({ children }: MockChildrenProps) => <div>{children}</div>,
  DialogHeader: ({ children }: MockChildrenProps) => <div>{children}</div>,
  DialogTitle: ({ children }: MockChildrenProps) => <h2>{children}</h2>,
  DialogDescription: ({ children }: MockChildrenProps) => <p>{children}</p>,
  DialogFooter: ({ children }: MockChildrenProps) => <div>{children}</div>,
}));

jest.mock("remark-gfm", () => ({
  __esModule: true,
  default: jest.fn(),
}));

jest.mock("react-markdown", () => ({
  __esModule: true,
  default: ({
    children,
    components = {},
  }: {
    children: React.ReactNode;
    components?: Record<string, React.ElementType<{ children: React.ReactNode }>>;
  }) => {
    const text = String(children ?? "");
    const rendered = text.split(/(\*\*[^*]+\*\*)/g).map((part, index) => {
      const match = part.match(/^\*\*([^*]+)\*\*$/);
      if (!match) return <React.Fragment key={index}>{part}</React.Fragment>;
      const Strong = components.strong ?? "strong";
      return <Strong key={index}>{match[1]}</Strong>;
    });
    const P = components.p;
    return P ? <P>{rendered}</P> : <div>{rendered}</div>;
  },
}));

import { ReleaseUpgradeDialog } from "../ReleaseUpgradeDialog";

const release = {
  version: "0.5.1",
  date: "2026-05-19",
  sections: [
    {
      type: "Features",
      items: [
        { text: "Added Slack and Webex ReBAC migration assistant", scope: "rbac" },
        { text: "Improved admin migration visibility", scope: null },
      ],
    },
  ],
};

describe("ReleaseUpgradeDialog", () => {
  it("shows admin release notes with skip and dismiss actions", () => {
    const onSkipUntilNextLogin = jest.fn();
    const onDismissPermanently = jest.fn();

    render(
      <ReleaseUpgradeDialog
        open
        isAdmin
        releaseVersion="0.5.1"
        release={release}
        onSkipUntilNextLogin={onSkipUntilNextLogin}
        onDismissPermanently={onDismissPermanently}
      />,
    );

    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(screen.getByText("What's new in 0.5.1")).toBeInTheDocument();
    expect(screen.getByText("Added Slack and Webex ReBAC migration assistant")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "View full changelog" })).toHaveAttribute(
      "href",
      "https://github.com/caipe-io/ai-platform-engineering/blob/main/CHANGELOG.md",
    );
    expect(screen.queryByRole("button", { name: "Open Migration Assistant" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Skip until next login" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Skip until next login" }));
    fireEvent.click(screen.getByRole("button", { name: "Do not show again" }));

    expect(onSkipUntilNextLogin).toHaveBeenCalledTimes(1);
    expect(onDismissPermanently).toHaveBeenCalledTimes(1);
  });

  it("renders markdown emphasis in release note items", () => {
    render(
      <ReleaseUpgradeDialog
        open
        isAdmin
        releaseVersion="0.5.1"
        release={{
          version: "0.5.1",
          date: "2026-05-19",
          sections: [
            {
              type: "Feat",
              items: [{ text: "**rbac/ui**: gate Graph tab on any-KB-readable", scope: "rbac/ui" }],
            },
          ],
        }}
        onSkipUntilNextLogin={jest.fn()}
        onDismissPermanently={jest.fn()}
      />,
    );

    expect(screen.queryByText(/\*\*rbac\/ui\*\*/)).not.toBeInTheDocument();
    expect(screen.getByText("rbac/ui", { selector: "strong" })).toBeInTheDocument();
    expect(screen.getByText(/gate Graph tab on any-KB-readable/)).toBeInTheDocument();
  });

  it("shows non-admin feature notes without skip action", () => {
    const onDismissPermanently = jest.fn();

    render(
      <ReleaseUpgradeDialog
        open
        isAdmin={false}
        releaseVersion="0.5.1"
        release={release}
        onSkipUntilNextLogin={jest.fn()}
        onDismissPermanently={onDismissPermanently}
      />,
    );

    expect(screen.getByText("What's new in 0.5.1")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Skip until next login" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Do not show again" }));
    expect(screen.queryByText("Added Slack and Webex ReBAC migration assistant")).not.toBeInTheDocument();
    expect(onDismissPermanently).toHaveBeenCalledTimes(1);
  });

  it("never renders the migration assistant CTA or reminder for admins", () => {
    render(
      <ReleaseUpgradeDialog
        open
        isAdmin
        releaseVersion="0.5.1"
        release={release}
        onSkipUntilNextLogin={jest.fn()}
        onDismissPermanently={jest.fn()}
      />,
    );

    expect(screen.queryByText(/schema migrations/i)).not.toBeInTheDocument();
    expect(screen.queryByText("Admin migration reminder")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Open Migration Assistant" })).not.toBeInTheDocument();
  });

  const markdownNotes = {
    matchedVersion: "0.5.7",
    title: "Release 0.5.7",
    date: "2026-06-04",
    body: [
      "## Highlights",
      "Brand new feature for everyone.",
      "",
      "## Upgrade Guide: 0.5.6 → 0.5.7",
      "Run the migration runbook before applying schema changes.",
    ].join("\n"),
  };

  it("renders the full curated markdown body and prefers it over parsed sections (admin)", () => {
    render(
      <ReleaseUpgradeDialog
        open
        isAdmin
        releaseVersion="0.5.7"
        release={release}
        releaseMarkdown={markdownNotes}
        onSkipUntilNextLogin={jest.fn()}
        onDismissPermanently={jest.fn()}
      />,
    );

    // Curated markdown body is rendered.
    expect(screen.getByText(/Brand new feature for everyone/)).toBeInTheDocument();
    // Admins see the Upgrade Guide section.
    expect(screen.getByText(/Run the migration runbook/)).toBeInTheDocument();
    // The terse parsed CHANGELOG sections are NOT shown when markdown is present.
    expect(screen.queryByText("Added Slack and Webex ReBAC migration assistant")).not.toBeInTheDocument();
  });

  it("hides the admin Upgrade Guide portion of the markdown body for non-admins", () => {
    render(
      <ReleaseUpgradeDialog
        open
        isAdmin={false}
        releaseVersion="0.5.7"
        release={release}
        releaseMarkdown={markdownNotes}
        onSkipUntilNextLogin={jest.fn()}
        onDismissPermanently={jest.fn()}
      />,
    );

    expect(screen.getByText(/Brand new feature for everyone/)).toBeInTheDocument();
    // Non-admins do not see the upgrade runbook / migration content.
    expect(screen.queryByText(/Run the migration runbook/)).not.toBeInTheDocument();
  });

  it("shows an error state (no hardcoded fallback) when no real release notes are available", () => {
    render(
      <ReleaseUpgradeDialog
        open
        isAdmin={false}
        releaseVersion="dev"
        release={null}
        onSkipUntilNextLogin={jest.fn()}
        onDismissPermanently={jest.fn()}
      />,
    );

    expect(screen.getByText("What's new in dev")).toBeInTheDocument();
    expect(screen.getByText(/Couldn't load the release notes for dev/i)).toBeInTheDocument();
    // The full changelog link is still offered as the next step.
    expect(screen.getByRole("link", { name: "View full changelog" })).toBeInTheDocument();
    // No hardcoded fallback prose leaks through any more.
    expect(
      screen.queryByText(
        "Use the same agents and knowledge from the web UI, Slack, and Webex with more consistent permissions.",
      ),
    ).not.toBeInTheDocument();
    expect(screen.queryByText(/ReBAC admin diagnostics/i)).not.toBeInTheDocument();
  });

  it("shows the error state when only admin-only sections exist for a non-admin", () => {
    render(
      <ReleaseUpgradeDialog
        open
        isAdmin={false}
        releaseVersion="0.5.1"
        release={{
          version: "0.5.1",
          date: "2026-05-19",
          sections: [
            {
              type: "Admin Notes",
              items: [{ text: "ReBAC admin diagnostics improved", scope: "admin" }],
            },
          ],
        }}
        onSkipUntilNextLogin={jest.fn()}
        onDismissPermanently={jest.fn()}
      />,
    );

    expect(screen.getByText(/Couldn't load the release notes for 0.5.1/i)).toBeInTheDocument();
    expect(screen.queryByText("ReBAC admin diagnostics improved")).not.toBeInTheDocument();
  });
});
