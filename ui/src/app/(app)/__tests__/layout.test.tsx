import { render,screen } from "@testing-library/react";

import AppLayout from "../layout";

const mockGetCookie = jest.fn();

jest.mock("next/headers", () => ({
  cookies: jest.fn(async () => ({ get: mockGetCookie })),
}));

jest.mock("../layout-client", () => ({
  AppLayoutClient: ({
    children,
    initialNavigationCollapsed,
  }: {
    children: React.ReactNode;
    initialNavigationCollapsed: boolean;
  }) => (
    <div data-collapsed={String(initialNavigationCollapsed)}>
      {children}
    </div>
  ),
}));

describe("AppLayout", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("passes the persisted collapsed state into the first application render", async () => {
    mockGetCookie.mockReturnValue({ value: "true" });

    render(await AppLayout({ children: <span>Page content</span> }));

    expect(screen.getByText("Page content").parentElement).toHaveAttribute(
      "data-collapsed",
      "true",
    );
    expect(mockGetCookie).toHaveBeenCalledWith(
      "caipe-application-navigation-collapsed",
    );
  });

  it("defaults to an expanded rail when no preference exists", async () => {
    mockGetCookie.mockReturnValue(undefined);

    render(await AppLayout({ children: <span>Page content</span> }));

    expect(screen.getByText("Page content").parentElement).toHaveAttribute(
      "data-collapsed",
      "false",
    );
  });
});
