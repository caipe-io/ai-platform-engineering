import { render,screen } from "@testing-library/react";
import { getServerSession } from "next-auth";
import { redirect } from "next/navigation";

import AppLayout from "../layout";

const mockGetCookie = jest.fn();
const mockGetHeader = jest.fn();
const mockGetConfig = jest.fn();
const mockAfter = jest.fn();
const mockRecordAppVisit = jest.fn();
jest.mock("next/server", () => ({ after: (...args: unknown[]) => mockAfter(...args) }));
jest.mock("@/lib/app-usage", () => ({ recordAppVisit: (...args: unknown[]) => mockRecordAppVisit(...args) }));

jest.mock("next/headers", () => ({
  cookies: jest.fn(async () => ({ get: mockGetCookie })),
  headers: jest.fn(async () => ({ get: mockGetHeader })),
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
  it('renders a retryable outage without redirecting or exposing page content', async () => {
    mockGetConfig.mockReturnValue(true);
    (getServerSession as jest.Mock).mockResolvedValue({ error: 'SessionUnavailable', expires: 'later' });
    render(await AppLayout({ children: <span>Protected page</span> }));
    expect(screen.getByRole('alert')).toHaveTextContent('temporarily unavailable');
    expect(screen.queryByText('Protected page')).not.toBeInTheDocument();
    expect(redirect).not.toHaveBeenCalled();
    expect(mockAfter).not.toHaveBeenCalled();
  });

  it('rejects an old or revoked session even though the error object is non-null', async () => {
    mockGetConfig.mockReturnValue(true);
    (getServerSession as jest.Mock).mockResolvedValue({ error: 'SessionExpired', expires: 'later' });
    await expect(AppLayout({ children: <span>Protected page</span> })).rejects.toThrow('redirect');
    expect(redirect).toHaveBeenCalledWith('/login');
    expect(mockAfter).not.toHaveBeenCalled();
  });

  const originalUsage = process.env.APP_USAGE_ENABLED;
  afterEach(() => {
    if (originalUsage === undefined) delete process.env.APP_USAGE_ENABLED;
    else process.env.APP_USAGE_ENABLED = originalUsage;
  });
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetHeader.mockReturnValue(null);
    process.env.APP_USAGE_ENABLED = "true";
    mockGetConfig.mockReturnValue(true);
    (getServerSession as jest.Mock).mockResolvedValue({
      user: { email: "user@example.com" },
      isAuthorized: true,
    });
  });

  it.each([null, { error: 'SessionExpired' }])('preserves the requested page and query for a missing or expired session', async session => {
    (getServerSession as jest.Mock).mockResolvedValue(session);
    mockGetHeader.mockReturnValue('/chat/example?tab=activity');
    await expect(AppLayout({ children: <span>Protected page</span> })).rejects.toThrow('redirect');
    expect(redirect).toHaveBeenCalledWith('/login?callbackUrl=%2Fchat%2Fexample%3Ftab%3Dactivity');
    expect(mockAfter).not.toHaveBeenCalled();
  });

  it("defers the aggregate write without capturing a user identity", async () => {
    mockRecordAppVisit.mockReturnValue(new Promise(() => {}));
    await AppLayout({ children: <span>Content</span> });
    expect(mockRecordAppVisit).not.toHaveBeenCalled();
    expect(mockAfter).toHaveBeenCalledTimes(1);
    void mockAfter.mock.calls[0][0]();
    expect(mockRecordAppVisit).toHaveBeenCalledWith(expect.any(Date));
  });

  it("does not schedule collection when disabled", async () => {
    delete process.env.APP_USAGE_ENABLED;
    await AppLayout({ children: <span>Content</span> });
    expect(mockAfter).not.toHaveBeenCalled();
  });

  it("renders anonymous development pages without scheduling collection", async () => {
    mockGetConfig.mockReturnValue(false);

    render(await AppLayout({ children: <span>Development page</span> }));

    expect(screen.getByText("Development page")).toBeInTheDocument();
    expect(getServerSession).not.toHaveBeenCalled();
    expect(mockAfter).not.toHaveBeenCalled();
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
    expect(mockAfter).not.toHaveBeenCalled();
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
    expect(mockAfter).not.toHaveBeenCalled();
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

it("returns an anonymous app bookmark to the same query after sign-in", async () => {
  mockGetConfig.mockReturnValue(true);
  (getServerSession as jest.Mock).mockResolvedValue(null);
  mockGetHeader.mockReturnValue("/apps/example?report=snapshot-1&repo=example%2Fproject");
  await expect(AppLayout({children:<span>Protected</span>})).rejects.toThrow("redirect");
  expect(redirect).toHaveBeenLastCalledWith("/login?callbackUrl=%2Fapps%2Fexample%3Freport%3Dsnapshot-1%26repo%3Dexample%252Fproject");
});

it.each(["//other.example.test", "/apps/../login\n", "https://other.example.test"])("rejects an invalid app callback %s", async (path) => {
  mockGetConfig.mockReturnValue(true); (getServerSession as jest.Mock).mockResolvedValue(null); mockGetHeader.mockReturnValue(path);
  await expect(AppLayout({children:<span>Protected</span>})).rejects.toThrow("redirect");
  expect(redirect).toHaveBeenLastCalledWith("/login");
});

it("retains a configured host-route app bookmark during sign-in", async () => {
  mockGetConfig.mockReturnValue(true); (getServerSession as jest.Mock).mockResolvedValue(null);
  mockGetHeader.mockReturnValue("/example/wiki?wikiSearch=release");
  await expect(AppLayout({children:<span>Protected</span>})).rejects.toThrow("redirect");
  expect(redirect).toHaveBeenLastCalledWith("/login?callbackUrl=%2Fexample%2Fwiki%3FwikiSearch%3Drelease");
});
