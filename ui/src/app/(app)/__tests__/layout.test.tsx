import { render,screen } from "@testing-library/react";
import { getServerSession } from "next-auth";
import { redirect } from "next/navigation";

import AppLayout from "../layout";

const mockGetCookie = jest.fn();
const mockGetConfig = jest.fn();

jest.mock("next/headers", () => ({
  cookies: jest.fn(async () => ({ get: mockGetCookie })),
}));

jest.mock("next-auth", () => ({
  getServerSession: jest.fn(),
}));

jest.mock("next/navigation", () => ({
  redirect: jest.fn(() => {
    throw new Error("redirect");
  }),
}));

jest.mock("@/lib/auth-config", () => ({
  authOptions: {},
}));

jest.mock("@/lib/config", () => ({
  getConfig: (...args: unknown[]) => mockGetConfig(...args),
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
    mockGetConfig.mockReturnValue(true);
    (getServerSession as jest.Mock).mockResolvedValue({
      user: { email: "user@example.com" },
      isAuthorized: true,
    });
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

  it("redirects unauthenticated users before rendering any application route", async () => {
    (getServerSession as jest.Mock).mockResolvedValue(null);

    await expect(
      AppLayout({ children: <span>Page content</span> }),
    ).rejects.toThrow("redirect");

    expect(redirect).toHaveBeenCalledWith("/login");
  });

  it("redirects users rejected by the SSO admission gate", async () => {
    (getServerSession as jest.Mock).mockResolvedValue({
      user: { email: "user@example.com" },
      isAuthorized: false,
    });

    await expect(
      AppLayout({ children: <span>Page content</span> }),
    ).rejects.toThrow("redirect");

    expect(redirect).toHaveBeenCalledWith("/unauthorized");
  });

  it("fails closed in production even when SSO is misconfigured off", async () => {
    const previousNodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    mockGetConfig.mockReturnValue(false);
    (getServerSession as jest.Mock).mockResolvedValue(null);

    try {
      await expect(
        AppLayout({ children: <span>Page content</span> }),
      ).rejects.toThrow("redirect");
    } finally {
      process.env.NODE_ENV = previousNodeEnv;
    }

    expect(redirect).toHaveBeenCalledWith("/login");
  });
});
