/**
 * @jest-environment jsdom
 */

import { fireEvent, render, screen, waitFor } from "@testing-library/react";

let mockSearchParams = new URLSearchParams();
const mockPush = jest.fn();

jest.mock("next/navigation", () => ({
  useRouter: () => ({ push: mockPush }),
  useSearchParams: () => mockSearchParams,
}));

import { AccessSettings } from "../AccessSettings";

const BASE_POSTURE = {
  email: "person-1@example.com",
  name: "Person One",
  role: "user",
  slack_linked: false,
  teams: [],
  webex_link_available: false,
  webex_linked: false,
};

function installFetchMock(
  posture: Partial<typeof BASE_POSTURE> = {},
  unlink: { ok?: boolean; error?: string } = {},
): jest.Mock {
  const { ok: unlinkOk = true, error: unlinkError } = unlink;
  const mock = jest.fn(async (url: string) => {
    if (typeof url === "string" && url.includes("/api/auth/webex-link/unlink")) {
      return {
        ok: unlinkOk,
        status: unlinkOk ? 200 : 400,
        json: async () =>
          unlinkOk ? { success: true, data: { unlinked: true } } : { error: unlinkError ?? "Could not unlink" },
      };
    }
    return {
      ok: true,
      status: 200,
      json: async () => ({ ...BASE_POSTURE, ...posture }),
    };
  });
  global.fetch = mock as unknown as typeof fetch;
  return mock;
}

describe("AccessSettings", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockSearchParams = new URLSearchParams();
  });

  it("hides the Webex link control when linking is not configured", async () => {
    installFetchMock({ webex_link_available: false });
    render(<AccessSettings />);

    await screen.findByText("Identity and role");
    expect(screen.queryByText(/Webex account:/)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Link Webex account|Relink/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /Link Webex account|Relink/ })).not.toBeInTheDocument();
    expect(screen.queryByText("Technical access details")).not.toBeInTheDocument();
  });

  it("uses document navigation to start Webex account linking", async () => {
    installFetchMock({ webex_link_available: true, webex_linked: false });
    render(<AccessSettings />);

    expect(await screen.findByText("Webex account: Not linked")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Link Webex account" })).toHaveAttribute("href", "/api/auth/webex-link/start");
    expect(mockPush).not.toHaveBeenCalled();
  });

  it("uses the same document-navigation route to relink an account", async () => {
    installFetchMock({ webex_link_available: true, webex_linked: true });
    render(<AccessSettings />);

    expect(await screen.findByText("Webex account: Linked")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Relink" })).toHaveAttribute("href", "/api/auth/webex-link/start");
  });

  it("shows a success banner and refreshes posture after a successful grant", async () => {
    mockSearchParams = new URLSearchParams("webex_link=success");
    const fetchMock = installFetchMock({ webex_link_available: true, webex_linked: true });
    render(<AccessSettings />);

    expect(await screen.findByText("Your Webex account has been linked.")).toBeInTheDocument();
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
  });

  it("shows a mapped error banner for a known failure reason", async () => {
    mockSearchParams = new URLSearchParams("webex_link=error&reason=WEBEX_ORG_MISMATCH");
    installFetchMock({ webex_link_available: true });
    render(<AccessSettings />);

    expect(
      await screen.findByRole("alert"),
    ).toHaveTextContent("That Webex account does not belong to this organization.");
  });

  it("falls back to a generic error banner for an unknown failure reason", async () => {
    mockSearchParams = new URLSearchParams("webex_link=error&reason=SOMETHING_UNKNOWN");
    installFetchMock({ webex_link_available: true });
    render(<AccessSettings />);

    expect(
      await screen.findByRole("alert"),
    ).toHaveTextContent("Could not link your Webex account. Please try again.");
  });

  it("does not show an Unlink button when not linked", async () => {
    installFetchMock({ webex_link_available: true, webex_linked: false });
    render(<AccessSettings />);

    await screen.findByText("Webex account: Not linked");
    expect(screen.queryByRole("button", { name: "Unlink" })).not.toBeInTheDocument();
  });

  it("unlinks the Webex account and refreshes posture", async () => {
    const fetchMock = installFetchMock({ webex_link_available: true, webex_linked: true });
    render(<AccessSettings />);

    const unlinkButton = await screen.findByRole("button", { name: "Unlink" });
    fireEvent.click(unlinkButton);

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith("/api/auth/webex-link/unlink", { method: "DELETE" }),
    );
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
  });

  it("shows an inline error when unlinking fails", async () => {
    installFetchMock({ webex_link_available: true, webex_linked: true }, { ok: false, error: "boom" });
    render(<AccessSettings />);

    const unlinkButton = await screen.findByRole("button", { name: "Unlink" });
    fireEvent.click(unlinkButton);

    expect(await screen.findByRole("alert")).toHaveTextContent("boom");
  });

  it("disables the Relink button while an unlink request is in flight", async () => {
    let resolveUnlink: (() => void) | undefined;
    const mock = jest.fn(async (url: string) => {
      if (typeof url === "string" && url.includes("/api/auth/webex-link/unlink")) {
        await new Promise<void>((resolve) => {
          resolveUnlink = resolve;
        });
        return { ok: true, status: 200, json: async () => ({ success: true, data: { unlinked: true } }) };
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({ ...BASE_POSTURE, webex_link_available: true, webex_linked: true }),
      };
    });
    global.fetch = mock as unknown as typeof fetch;
    render(<AccessSettings />);

    const unlinkButton = await screen.findByRole("button", { name: "Unlink" });
    expect(screen.getByRole("link", { name: "Relink" })).toBeInTheDocument();

    fireEvent.click(unlinkButton);
    await waitFor(() => expect(screen.getByRole("button", { name: "Relink" })).toBeDisabled());
    expect(screen.queryByRole("link", { name: "Relink" })).not.toBeInTheDocument();

    resolveUnlink?.();
    expect(await screen.findByRole("link", { name: "Relink" })).toHaveAttribute("href", "/api/auth/webex-link/start");
  });
});
