import { render,screen } from "@testing-library/react";
import type { ReactNode } from "react";

import { AppLayoutClient } from "../layout-client";

jest.mock("next/navigation", () => ({
  usePathname: () => "/knowledge-bases/collections",
}));

jest.mock("@/components/layout/AppHeader", () => ({
  AppHeader: () => <header data-testid="app-header" />,
}));

jest.mock("@/components/layout/ApplicationNavigation", () => ({
  ApplicationNavigationDrawer: () => <div data-testid="navigation-drawer" />,
  ApplicationNavigationRail: () => <aside data-testid="navigation-rail" />,
}));

jest.mock("@/components/layout/ApplicationNavigationContext", () => ({
  ApplicationNavigationProvider: ({
    children,
  }: {
    children: ReactNode;
  }) => <>{children}</>,
}));

jest.mock("@/components/layout/LiveStreamBanner", () => ({
  LiveStreamBanner: () => <div data-testid="live-stream-banner" />,
}));

jest.mock("@/hooks/use-user-init", () => ({
  useUserInit: jest.fn(),
}));

jest.mock("@/lib/navigation-progress", () => ({
  finishNavigationProgress: jest.fn(),
}));

describe("AppLayoutClient", () => {
  it("keeps page scrolling inside the viewport shell", () => {
    render(
      <AppLayoutClient initialNavigationCollapsed={false}>
        <div data-testid="page-content" />
      </AppLayoutClient>,
    );

    const viewportShell = screen.getByTestId("navigation-rail").parentElement;
    const contentColumn = screen.getByTestId("app-header").parentElement;

    expect(viewportShell).toHaveClass("h-dvh", "overflow-hidden");
    expect(contentColumn).toHaveClass("min-h-0", "overflow-hidden");
  });
});
