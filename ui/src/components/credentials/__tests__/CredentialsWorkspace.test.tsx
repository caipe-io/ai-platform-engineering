import { render,screen,waitFor,within } from "@testing-library/react";

import { CredentialsWorkspace } from "../CredentialsWorkspace";

const mockPush = jest.fn();
const mockReplace = jest.fn();

jest.mock("next/navigation",() => ({
  useRouter: () => ({ push: mockPush,replace: mockReplace }),
  usePathname: () => "/credentials/connections",
}));

jest.mock("../SecretsManager",() => ({
  SecretsManager: () => <div>Saved Secrets content</div>,
}));

jest.mock("../ProviderConnections",() => ({
  ProviderConnections: () => <div>Connected Apps content</div>,
}));

describe("CredentialsWorkspace",() => {
  beforeEach(() => {
    jest.clearAllMocks();
    window.history.replaceState(null,"","/credentials/connections");
  });

  it("renders Connections as a canonical routed workspace section",() => {
    render(<CredentialsWorkspace activeSection="connections" />);

    expect(screen.getByRole("heading",{ level: 1,name: "Connected Apps" })).toBeInTheDocument();
    expect(
      screen.getByText("Connect approved apps so agents can use your account access."),
    ).toBeInTheDocument();
    expect(screen.getByText("Connected Apps content")).toBeInTheDocument();
    expect(screen.queryByText("Saved Secrets content")).not.toBeInTheDocument();

    const breadcrumb = screen.getByRole("navigation",{ name: "Breadcrumb" });
    expect(within(breadcrumb).getByRole("link",{ name: "Home" })).toHaveAttribute("href","/");
    expect(within(breadcrumb).getByRole("link",{ name: "Credentials" })).toHaveAttribute(
      "href",
      "/credentials/connections",
    );
    expect(within(breadcrumb).getByRole("link",{ name: "Connected Apps" })).toHaveAttribute(
      "aria-current",
      "page",
    );

    const navigation = screen.getByRole("navigation",{ name: "Credentials sections" });
    const activeLink = within(navigation).getByRole("link",{ name: "Connected Apps" });
    expect(activeLink).toHaveAttribute("href","/credentials/connections");
    expect(activeLink).toHaveAttribute("aria-current","page");
    expect(within(navigation).getByRole("link",{ name: "Saved Secrets" })).toHaveAttribute(
      "href",
      "/credentials/secrets",
    );
  });

  it("renders only the selected Secrets section",() => {
    render(<CredentialsWorkspace activeSection="secrets" />);

    expect(screen.getByRole("heading",{ level: 1,name: "Saved Secrets" })).toBeInTheDocument();
    expect(screen.getByText("Saved Secrets content")).toBeInTheDocument();
    expect(screen.queryByText("Connected Apps content")).not.toBeInTheDocument();
    expect(
      within(screen.getByRole("navigation",{ name: "Credentials sections" }))
        .getByRole("link",{ name: "Saved Secrets" }),
    ).toHaveAttribute(
      "aria-current",
      "page",
    );
  });

  it("returns OAuth completion events to Connected apps",async () => {
    render(<CredentialsWorkspace activeSection="secrets" />);

    window.dispatchEvent(new MessageEvent("message",{
      data: { type: "caipe.oauth.connection" },
      origin: window.location.origin,
    }));

    await waitFor(() => expect(mockReplace).toHaveBeenCalledWith("/credentials/connections"));
  });

});
