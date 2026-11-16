import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { ProviderConnections } from "../ProviderConnections";

function response(data: unknown, ok = true, status = ok ? 200 : 500): Response {
  return {
    ok,
    status,
    json: async () => ({ data }),
  } as Response;
}

describe("ProviderConnections", () => {
  beforeEach(() => {
    global.fetch = jest.fn(async (url) => {
      if (String(url).includes("/oauth-connectors")) {
        return {
          ok: true,
          json: async () => ({
            data: [
              { id: "connector-1", name: "GitHub", provider: "github", enabled: true },
              { id: "connector-2", name: "Atlassian Cloud", provider: "atlassian", enabled: true },
            ],
          }),
        } as Response;
      }
      return {
        ok: true,
        json: async () => ({
          data: [{ id: "conn-1", provider: "github", status: "connected" }],
        }),
      } as Response;
    }) as jest.Mock;
  });

  it("renders user provider connections without token material", async () => {
    render(<ProviderConnections />);

    await waitFor(() => expect(screen.getByText("github")).toBeInTheDocument());
    expect(screen.getAllByText("connected").length).toBeGreaterThan(0);
    expect(screen.queryByText(/access_token/i)).not.toBeInTheDocument();
  });

  it("always shows every connector with connection health and relink actions", async () => {
    global.fetch = jest.fn(async (url) => {
      if (String(url).includes("/oauth-connectors")) {
        return {
          ok: true,
          json: async () => ({
            data: [
              { id: "connector-1", name: "GitHub", provider: "github", enabled: true },
              { id: "connector-2", name: "Atlassian", provider: "atlassian", enabled: true },
              { id: "connector-3", name: "Webex", provider: "webex", enabled: true },
              { id: "connector-4", name: "PagerDuty", provider: "pagerduty", enabled: true },
            ],
          }),
        } as Response;
      }
      return {
        ok: true,
        json: async () => ({
          data: [
            {
              id: "conn-1",
              connectorId: "connector-2",
              provider: "atlassian",
              status: "connected",
              updatedAt: "2026-05-21T16:00:00.000Z",
              expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
            },
          ],
        }),
      } as Response;
    }) as jest.Mock;

    render(<ProviderConnections />);

    expect(await screen.findByText("Atlassian")).toBeInTheDocument();
    expect(screen.getByText("GitHub")).toBeInTheDocument();
    expect(screen.getByText("Webex")).toBeInTheDocument();
    expect(screen.getByText("PagerDuty")).toBeInTheDocument();
    expect(screen.getByLabelText("GitHub logo")).toBeInTheDocument();
    expect(screen.getByLabelText("Atlassian logo")).toBeInTheDocument();
    expect(screen.getByLabelText("Atlassian logo").querySelector("img")?.getAttribute("src")).toContain(
      "atlassian.svg",
    );
    expect(screen.getByLabelText("Atlassian logo")).toHaveClass("from-slate-950");
    expect(screen.getByLabelText("Atlassian logo")).toHaveClass("to-sky-900");
    expect(screen.getByLabelText("Atlassian logo").querySelector("img")?.getAttribute("src")).not.toContain(
      "/_next/image",
    );
    expect(screen.getByLabelText("Atlassian logo").querySelector("img")).not.toHaveAttribute("data-nimg");
    expect(screen.getByLabelText("Webex logo")).toBeInTheDocument();
    expect(screen.getByLabelText("Webex logo").querySelector("img")?.getAttribute("src")).toContain("webex.svg");
    expect(screen.getByLabelText("Webex logo")).toHaveClass("from-slate-950");
    expect(screen.getByLabelText("Webex logo")).toHaveClass("to-teal-900");
    expect(screen.getByLabelText("Webex logo").querySelector("img")?.getAttribute("src")).not.toContain(
      "/_next/image",
    );
    expect(screen.getByLabelText("Webex logo").querySelector("img")).not.toHaveAttribute("data-nimg");
    expect(screen.getByLabelText("PagerDuty logo")).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: /provider/i })).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: /connection health/i })).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: /actions/i })).toBeInTheDocument();
    expect(screen.getByText("healthy")).toBeInTheDocument();
    expect(screen.getAllByText("Never connected").length).toBeGreaterThan(0);
    expect(screen.getAllByText("No refresh yet").length).toBeGreaterThan(0);
    expect(screen.getByRole("link", { name: /reconnect atlassian/i })).toHaveAttribute(
      "href",
      "/api/credentials/oauth/atlassian/connect",
    );
    expect(screen.queryByRole("button", { name: /check atlassian profile/i })).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Atlassian connected")).not.toBeInTheDocument();
    expect(screen.getByLabelText("Atlassian connection status connected")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /test atlassian connection/i })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /connect github/i })).toHaveAttribute(
      "href",
      "/api/credentials/oauth/github/connect",
    );
  });

  it("clears a connected app via DELETE and reloads connections", async () => {
    const user = userEvent.setup();
    let connections = [
      {
        id: "atlassian-connection",
        connectorId: "connector-2",
        provider: "atlassian",
        status: "connected",
        updatedAt: "2026-05-21T16:00:00.000Z",
        expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      },
    ];
    const fetchMock = jest.fn(async (url: string, init?: RequestInit) => {
      if (url === "/api/credentials/oauth-connectors") {
        return response([
          { id: "connector-2", name: "Atlassian", provider: "atlassian", enabled: true },
        ]);
      }
      if (url === "/api/credentials/connections" && (!init || init.method === undefined)) {
        return response(connections);
      }
      if (url === "/api/credentials/connections/atlassian-connection" && init?.method === "DELETE") {
        connections = [];
        return response({ id: "atlassian-connection", provider: "atlassian", status: "disabled" });
      }
      return response({}, false, 404);
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    render(<ProviderConnections />);

    expect(await screen.findByRole("link", { name: /reconnect atlassian/i })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /clear atlassian connection/i }));

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/credentials/connections/atlassian-connection",
        expect.objectContaining({ method: "DELETE" }),
      ),
    );
    await waitFor(() =>
      expect(screen.getByRole("link", { name: /connect atlassian/i })).toBeInTheDocument(),
    );
    expect(screen.queryByRole("button", { name: /clear atlassian connection/i })).not.toBeInTheDocument();
  });

  it("uses the newest connection when historical duplicate provider rows exist", async () => {
    const fetchMock = jest.fn(async (url: string, init?: RequestInit) => {
      if (url === "/api/credentials/oauth-connectors") {
        return response([
          { id: "atlassian-connector", provider: "atlassian", name: "Atlassian", enabled: true },
        ]);
      }
      if (url === "/api/credentials/connections") {
        return response([
          {
            id: "new-atlassian-connection",
            connectorId: "atlassian-connector",
            provider: "atlassian",
            status: "connected",
            expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
            updatedAt: "2026-06-21T04:44:00.000Z",
            grantedScopes: ["offline_access", "read:me", "read:jira-work", "read:jira-user"],
          },
          {
            id: "old-atlassian-connection",
            connectorId: "atlassian-connector",
            provider: "atlassian",
            status: "connected",
            expiresAt: new Date(Date.now() - 60_000).toISOString(),
            updatedAt: "2026-06-01T04:44:00.000Z",
            grantedScopes: ["offline_access", "read:me", "read:jira-work"],
          },
        ]);
      }
      if (url === "/api/credentials/connections/new-atlassian-connection/profile") {
        expect(init).toMatchObject({ method: "POST" });
        return response({
          ok: true,
          provider: "atlassian",
          profile: { name: "Alice" },
          diagnostics: [],
        });
      }
      return response({}, false, 404);
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    render(<ProviderConnections />);

    expect(await screen.findByText("Atlassian")).toBeInTheDocument();
    expect(screen.getByText("healthy")).toBeInTheDocument();
    expect(screen.queryByText("expired")).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: /test atlassian connection/i }));

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/credentials/connections/new-atlassian-connection/profile",
        expect.objectContaining({ method: "POST" }),
      ),
    );
    expect(fetchMock).not.toHaveBeenCalledWith(
      "/api/credentials/connections/old-atlassian-connection/profile",
      expect.anything(),
    );
  });

  it("shows available OAuth providers with connect links when not yet connected", async () => {
    global.fetch = jest.fn(async (url) => {
      if (String(url).includes("/oauth-connectors")) {
        return {
          ok: true,
          json: async () => ({
            data: [{ id: "connector-1", name: "GitHub", provider: "github", enabled: true }],
          }),
        } as Response;
      }
      return {
        ok: true,
        json: async () => ({ data: [] }),
      } as Response;
    }) as jest.Mock;

    render(<ProviderConnections />);

    await waitFor(() => expect(screen.getByText("GitHub")).toBeInTheDocument());
    expect(screen.getByRole("link", { name: /connect github/i })).toHaveAttribute(
      "href",
      "/api/credentials/oauth/github/connect",
    );
  });

  it("keeps existing connector rows when an OAuth callback reload returns a transient empty connector list", async () => {
    const connectorResponses = [
      [{ id: "connector-1", name: "GitHub", provider: "github", enabled: true }],
      [],
    ];

    global.fetch = jest.fn(async (url) => {
      if (String(url).includes("/oauth-connectors")) {
        return response(connectorResponses.shift() ?? []);
      }
      return response([]);
    }) as jest.Mock;

    render(<ProviderConnections />);

    expect(await screen.findByText("GitHub")).toBeInTheDocument();

    await act(async () => {
      window.dispatchEvent(
        new MessageEvent("message", {
          origin: window.location.origin,
          data: { type: "caipe.oauth.connection", status: "success", provider: "github" },
        }),
      );
    });

    await waitFor(() => expect(global.fetch).toHaveBeenCalledTimes(4));
    expect(screen.getByText("GitHub")).toBeInTheDocument();
    expect(screen.queryByText("No provider connections yet.")).not.toBeInTheDocument();
  });

  it("opens OAuth connections in a popup without following the link in the same window", async () => {
    const open = jest.spyOn(window, "open").mockReturnValue(null);
    const connectionResponses = [[], [{ id: "conn-1", provider: "github", status: "connected" }]];

    global.fetch = jest.fn(async (url) => {
      if (String(url).includes("/oauth-connectors")) {
        return {
          ok: true,
          json: async () => ({
            data: [{ id: "connector-1", name: "GitHub", provider: "github", enabled: true }],
          }),
        } as Response;
      }
      return {
        ok: true,
        json: async () => ({ data: connectionResponses.shift() ?? connectionResponses[0] }),
      } as Response;
    }) as jest.Mock;

    render(<ProviderConnections />);

    const connectLink = await screen.findByRole("link", { name: /connect github/i });
    expect(connectLink).toHaveAttribute(
      "href",
      "/api/credentials/oauth/github/connect",
    );

    const defaultAllowed = connectLink.dispatchEvent(
      new MouseEvent("click", { bubbles: true, cancelable: true }),
    );

    expect(defaultAllowed).toBe(false);
    expect(open).toHaveBeenCalledWith(
      "/api/credentials/oauth/github/connect",
      "caipe-oauth-github",
      expect.stringContaining("width=640"),
    );

    window.dispatchEvent(
      new MessageEvent("message", {
        origin: window.location.origin,
        data: { type: "caipe.oauth.connection", status: "success", provider: "github" },
      }),
    );

    await waitFor(() => expect(screen.getAllByText("connected").length).toBeGreaterThan(0));

    open.mockRestore();
  });

  it("checks a connected provider profile and reports the result", async () => {
    const fetchMock = jest.fn(async (url: string) => {
      if (url === "/api/credentials/oauth-connectors") {
        return response([
            { id: "github-connector", provider: "github", name: "GitHub", enabled: true },
            { id: "atlassian-connector", provider: "atlassian", name: "Atlassian", enabled: true },
            { id: "webex-connector", provider: "webex", name: "Webex", enabled: true },
        ]);
      }
      if (url === "/api/credentials/connections") {
        return response([
            {
              id: "github-connection",
              connectorId: "github-connector",
              provider: "github",
              status: "connected",
              expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
              updatedAt: "2026-05-21T10:00:00.000Z",
            },
        ]);
      }
      if (url === "/api/credentials/connections/github-connection/profile") {
        return response({ ok: true, provider: "github", profile: { login: "alice" } });
      }
      return response({}, false, 404);
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    render(<ProviderConnections />);

    await userEvent.click(await screen.findByRole("button", { name: /Test GitHub connection/i }));

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/credentials/connections/github-connection/profile",
      expect.objectContaining({ method: "POST" }),
    );
    expect(await screen.findByText(/GitHub connection test passed/i)).toBeInTheDocument();
    expect(screen.getByText(/alice/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /view github connection details/i })).toBeInTheDocument();
  });

  it("opens PagerDuty diagnostics for PagerDuty instead of reusing GitHub diagnostics", async () => {
    const fetchMock = jest.fn(async (url: string) => {
      if (url === "/api/credentials/oauth-connectors") {
        return response([
          { id: "github-connector", provider: "github", name: "GitHub", enabled: true },
          { id: "pagerduty-connector", provider: "pagerduty", name: "PagerDuty", enabled: true },
        ]);
      }
      if (url === "/api/credentials/connections") {
        return response([
          {
            id: "github-connection",
            connectorId: "github-connector",
            provider: "github",
            status: "connected",
            expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
          },
          {
            id: "pagerduty-connection",
            connectorId: "pagerduty-connector",
            provider: "pagerduty",
            status: "connected",
            expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
          },
        ]);
      }
      if (url === "/api/credentials/connections/github-connection/profile") {
        return response({
          ok: false,
          provider: "github",
          diagnostics: [
            {
              id: "connection_owner",
              label: "Connection ownership",
              status: "passed",
              detail: "This connection belongs to the signed-in user.",
              action: "No action needed.",
            },
          ],
          next_action: "Relink GitHub.",
        });
      }
      if (url === "/api/credentials/connections/pagerduty-connection/profile") {
        return response({
          ok: true,
          provider: "pagerduty",
          profile: { id: "PD123", name: "Alice" },
          diagnostics: [
            {
              id: "connection_owner",
              label: "Connection ownership",
              status: "passed",
              detail: "This connection belongs to the signed-in user.",
              action: "No action needed.",
            },
            {
              id: "provider_profile",
              label: "PagerDuty user profile",
              status: "passed",
              detail: "PagerDuty returned a redacted user profile.",
              action: "No action needed.",
            },
          ],
          next_action: "No action needed.",
        });
      }
      return response({}, false, 404);
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    render(<ProviderConnections />);

    await userEvent.click(await screen.findByRole("button", { name: /test github connection/i }));
    expect(await screen.findByRole("dialog", { name: /GitHub connection details/i })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /^close$/i }));

    await userEvent.click(await screen.findByRole("button", { name: /test pagerduty connection/i }));

    const dialog = await screen.findByRole("dialog", { name: /PagerDuty connection details/i });
    expect(within(dialog).getByText("PagerDuty user profile")).toBeInTheDocument();
    expect(within(dialog).queryByText(/GitHub/i)).not.toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/credentials/connections/pagerduty-connection/profile",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("shows PagerDuty profile failures without repeating relink guidance or generic HTTP text", async () => {
    const fetchMock = jest.fn(async (url: string) => {
      if (url === "/api/credentials/oauth-connectors") {
        return response([
          { id: "pagerduty-connector", provider: "pagerduty", name: "PagerDuty", enabled: true },
        ]);
      }
      if (url === "/api/credentials/connections") {
        return response([
          {
            id: "pagerduty-connection",
            connectorId: "pagerduty-connector",
            provider: "pagerduty",
            status: "connected",
            expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
          },
        ]);
      }
      if (url === "/api/credentials/connections/pagerduty-connection/profile") {
        return response({
          ok: false,
          provider: "pagerduty",
          diagnostics: [
            {
              id: "connection_owner",
              label: "Connection ownership",
              status: "passed",
              detail: "This connection belongs to the signed-in user.",
              action: "No action needed.",
            },
            {
              id: "provider_profile",
              label: "PagerDuty user profile",
              status: "failed",
              detail: "PagerDuty returned HTTP 403.",
              action: "Relink PagerDuty and try the profile check again.",
              http_status: 403,
            },
          ],
          next_action: "Relink PagerDuty and try the profile check again.",
        });
      }
      return response({}, false, 404);
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    render(<ProviderConnections />);

    await userEvent.click(await screen.findByRole("button", { name: /test pagerduty connection/i }));

    const dialog = await screen.findByRole("dialog", { name: /PagerDuty connection details/i });
    expect(within(dialog).getByText("PagerDuty user profile")).toBeInTheDocument();
    expect(within(dialog).getByText("PagerDuty returned HTTP 403.")).toBeInTheDocument();
    expect(within(dialog).getAllByText(/Relink PagerDuty and try the profile check again/i)).toHaveLength(1);
    expect(within(dialog).queryByText(/Profile check failed with HTTP 403/i)).not.toBeInTheDocument();
    expect(within(dialog).queryByText("Connection ownership")).not.toBeInTheDocument();
  });

  it("shows Webex 403 guidance for missing people scope or account access", async () => {
    const webexGuidance =
      "Verify the Webex integration includes spark:people_read, then relink Webex. If it still fails, confirm the Webex user can sign in and has the required role or license.";
    const fetchMock = jest.fn(async (url: string) => {
      if (url === "/api/credentials/oauth-connectors") {
        return response([
          { id: "webex-connector", provider: "webex", name: "Webex", enabled: true },
        ]);
      }
      if (url === "/api/credentials/connections") {
        return response([
          {
            id: "webex-connection",
            connectorId: "webex-connector",
            provider: "webex",
            status: "connected",
            expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
          },
        ]);
      }
      if (url === "/api/credentials/connections/webex-connection/profile") {
        return response({
          ok: false,
          provider: "webex",
          diagnostics: [
            {
              id: "connection_owner",
              label: "Connection ownership",
              status: "passed",
              detail: "This connection belongs to the signed-in user.",
              action: "No action needed.",
            },
            {
              id: "provider_profile",
              label: "Webex user profile",
              status: "failed",
              detail:
                "Webex returned HTTP 403: The access token is missing required scopes or the user is missing required roles or licenses.",
              action: webexGuidance,
              http_status: 403,
            },
          ],
          next_action: webexGuidance,
        });
      }
      return response({}, false, 404);
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    render(<ProviderConnections />);

    await userEvent.click(await screen.findByRole("button", { name: /test webex connection/i }));

    const dialog = await screen.findByRole("dialog", { name: /Webex connection details/i });
    expect(within(dialog).getByText("Webex user profile")).toBeInTheDocument();
    expect(within(dialog).getAllByText(/spark:people_read/i)).toHaveLength(1);
    expect(within(dialog).getByText(/required scopes or the user is missing required roles or licenses/i)).toBeInTheDocument();
    expect(within(dialog).queryByText("Connection ownership")).not.toBeInTheDocument();
  });

  it("shows failed token refresh diagnostics instead of no-action ownership noise", async () => {
    const fetchMock = jest.fn(async (url: string) => {
      if (url === "/api/credentials/oauth-connectors") {
        return response([
          { id: "github-connector", provider: "github", name: "GitHub", enabled: true },
        ]);
      }
      if (url === "/api/credentials/connections") {
        return response([
          {
            id: "github-connection",
            connectorId: "github-connector",
            provider: "github",
            status: "connected",
            expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
          },
        ]);
      }
      if (url === "/api/credentials/connections/github-connection/profile") {
        return response({
          ok: false,
          provider: "github",
          diagnostics: [
            {
              id: "connection_owner",
              label: "Connection ownership",
              status: "passed",
              detail: "This connection belongs to the signed-in user.",
              action: "No action needed.",
            },
            {
              id: "token_refresh",
              label: "Token refresh",
              status: "failed",
              detail: "GitHub did not accept the stored refresh token.",
              action: "Relink GitHub to grant CAIPE a fresh refresh token.",
            },
          ],
          next_action: "Relink GitHub to grant CAIPE a fresh refresh token.",
        });
      }
      return response({}, false, 404);
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    render(<ProviderConnections />);

    await userEvent.click(await screen.findByRole("button", { name: /test github connection/i }));

    const dialog = await screen.findByRole("dialog", { name: /GitHub connection details/i });
    expect(within(dialog).getByText("Token refresh")).toBeInTheDocument();
    expect(within(dialog).getByText("failed")).toBeInTheDocument();
    expect(within(dialog).getAllByText(/Relink GitHub to grant CAIPE a fresh refresh token/i)).toHaveLength(1);
    expect(within(dialog).queryByText("Connection ownership")).not.toBeInTheDocument();
    expect(within(dialog).queryByText("What to do: No action needed.")).not.toBeInTheDocument();
  });

  it("reports Atlassian accessible resources when the user profile endpoint is denied", async () => {
    const fetchMock = jest.fn(async (url: string) => {
      if (url === "/api/credentials/oauth-connectors") {
        return response([
          { id: "atlassian-connector", provider: "atlassian", name: "Atlassian Cloud", enabled: true },
        ]);
      }
      if (url === "/api/credentials/connections") {
        return response([
          {
            id: "atlassian-connection",
            connectorId: "atlassian-connector",
            provider: "atlassian",
            status: "connected",
            expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
            updatedAt: "2026-05-21T10:00:00.000Z",
          },
        ]);
      }
      if (url === "/api/credentials/connections/atlassian-connection/profile") {
        return response({
          ok: true,
          provider: "atlassian",
          profile_check: { ok: false, status: 403, message: "forbidden" },
          accessible_resources: [{ id: "cloud-1", name: "CAIPE" }],
          diagnostics: [
            {
              id: "connection_owner",
              label: "Connection ownership",
              status: "passed",
              detail: "This connection belongs to the signed-in user.",
              action: "No action needed.",
            },
            {
              id: "token_refresh",
              label: "Token refresh",
              status: "passed",
              detail: "Atlassian accepted the refresh token.",
              action: "No action needed.",
            },
            {
              id: "atlassian_accessible_resources",
              label: "Accessible Atlassian sites",
              status: "passed",
              detail: "CAIPE is accessible with read:me, read:jira-work.",
              action: "No action needed.",
            },
          ],
          next_action: "No action needed.",
        });
      }
      return response({}, false, 404);
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    render(<ProviderConnections />);

    await userEvent.click(await screen.findByRole("button", { name: /Test Atlassian connection/i }));

    expect(await screen.findByText(/Atlassian access check passed/i)).toBeInTheDocument();
    expect(screen.getAllByText(/CAIPE/i).length).toBeGreaterThan(0);
    expect(screen.queryByText(/profile endpoint returned HTTP 403/i)).not.toBeInTheDocument();
    const dialog = await screen.findByRole("dialog", { name: /Atlassian connection details/i });
    expect(within(dialog).getByText("Connection ownership")).toBeInTheDocument();
    expect(within(dialog).queryByText("Token refresh")).not.toBeInTheDocument();
    expect(within(dialog).queryByText("Atlassian user profile")).not.toBeInTheDocument();
    expect(within(dialog).queryByText(/Ask an Atlassian admin/i)).not.toBeInTheDocument();
    expect(within(dialog).getAllByText(/No action needed/i).length).toBeGreaterThan(0);
    await userEvent.click(within(dialog).getByRole("button", { name: /test atlassian again/i }));
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/credentials/connections/atlassian-connection/profile",
      expect.objectContaining({ method: "POST" }),
    );
    expect(fetchMock.mock.calls.filter(([url]) => url === "/api/credentials/connections/atlassian-connection/profile")).toHaveLength(2);
  });

  it("automatically refreshes expired connected providers without exposing token material", async () => {
    const fetchMock = jest.fn(async (url: string, init?: RequestInit) => {
      if (url === "/api/credentials/oauth-connectors") {
        return response([
          { id: "atlassian-connector", provider: "atlassian", name: "Atlassian", enabled: true },
        ]);
      }
      if (url === "/api/credentials/connections") {
        return response([
          {
            id: "atlassian-connection",
            connectorId: "atlassian-connector",
            provider: "atlassian",
            status: "connected",
            expiresAt: new Date(Date.now() - 60_000).toISOString(),
            updatedAt: "2026-05-21T10:00:00.000Z",
          },
        ]);
      }
      if (url === "/api/credentials/connections/atlassian-connection/refresh") {
        expect(init).toMatchObject({ method: "POST" });
        return response({ id: "atlassian-connection", provider: "atlassian", ok: true, expires_in: 3600 });
      }
      return response({}, false, 404);
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    render(<ProviderConnections />);

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/credentials/connections/atlassian-connection/refresh",
        expect.objectContaining({ method: "POST" }),
      ),
    );
    expect(await screen.findByText("healthy")).toBeInTheDocument();
    expect(JSON.stringify(fetchMock.mock.calls)).not.toContain("access_token");
  });

  it("alerts the user when an expired connection cannot be refreshed", async () => {
    const fetchMock = jest.fn(async (url: string, init?: RequestInit) => {
      if (url === "/api/credentials/oauth-connectors") {
        return response([
          { id: "atlassian-connector", provider: "atlassian", name: "Atlassian", enabled: true },
        ]);
      }
      if (url === "/api/credentials/connections") {
        return response([
          {
            id: "atlassian-connection",
            connectorId: "atlassian-connector",
            provider: "atlassian",
            status: "connected",
            expiresAt: new Date(Date.now() - 60_000).toISOString(),
            updatedAt: "2026-05-21T10:00:00.000Z",
          },
        ]);
      }
      if (url === "/api/credentials/connections/atlassian-connection/refresh") {
        expect(init).toMatchObject({ method: "POST" });
        return response({ message: "refresh failed" }, false, 401);
      }
      return response({}, false, 404);
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    render(<ProviderConnections />);

    expect(await screen.findByText("expired")).toBeInTheDocument();
    expect(await screen.findByText(/Atlassian connection expired/i)).toBeInTheDocument();
    expect(screen.getAllByText(/Reconnect Atlassian to restore access/i)).toHaveLength(2);
  });

  it("does not auto-refresh an expiring connection with renewable === false", async () => {
    // Regression test for needsAutoRefresh(): a connection with no refresh
    // token (renewable === false) must never be silently POSTed to
    // /refresh just because it falls inside the 15-minute expiry window —
    // it needs manual reconnect instead.
    const fetchMock = jest.fn(async (url: string) => {
      if (url === "/api/credentials/oauth-connectors") {
        return response([
          { id: "atlassian-connector", provider: "atlassian", name: "Atlassian", enabled: true },
        ]);
      }
      if (url === "/api/credentials/connections") {
        return response([
          {
            id: "atlassian-connection",
            connectorId: "atlassian-connector",
            provider: "atlassian",
            status: "connected",
            renewable: false,
            expiresAt: new Date(Date.now() + 60_000).toISOString(),
            updatedAt: "2026-05-21T10:00:00.000Z",
          },
        ]);
      }
      return response({}, false, 404);
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    render(<ProviderConnections />);

    expect(await screen.findByText("connected")).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalledWith(
      "/api/credentials/connections/atlassian-connection/refresh",
      expect.anything(),
    );
  });

  describe("advanced scope selection", () => {
    function mockFetch(connectors: unknown[], connections: unknown[]) {
      global.fetch = jest.fn(async (url) => {
        if (String(url).includes("/oauth-connectors")) {
          return response(connectors);
        }
        return response(connections);
      }) as jest.Mock;
    }

    it("connects with the connector default (no scopes param) until the user narrows the selection", async () => {
      const open = jest.spyOn(window, "open").mockReturnValue(null);
      mockFetch(
        [
          {
            id: "connector-2",
            name: "Atlassian",
            provider: "atlassian",
            enabled: true,
            scopes: ["read:jira-work", "write:jira-work", "offline_access"],
          },
        ],
        [],
      );

      render(<ProviderConnections />);

      // Default connect omits the scopes param (legacy behavior).
      const connectLink = await screen.findByRole("link", { name: /connect atlassian/i });
      connectLink.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
      expect(open).toHaveBeenLastCalledWith(
        "/api/credentials/oauth/atlassian/connect",
        expect.any(String),
        expect.any(String),
      );

      // Open permissions; all allowed scopes are pre-selected.
      await userEvent.click(screen.getByRole("button", { name: /permissions/i }));
      const writeScope = screen.getByRole("checkbox", { name: /write:jira-work/i });
      expect(writeScope).toBeChecked();
      expect(screen.getByRole("checkbox", { name: /^read:jira-work/i })).toBeChecked();

      // Narrow the selection; connect now carries only the chosen scopes.
      await userEvent.click(writeScope);
      connectLink.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
      expect(open).toHaveBeenLastCalledWith(
        `/api/credentials/oauth/atlassian/connect?scopes=${encodeURIComponent("read:jira-work,offline_access")}`,
        expect.any(String),
        expect.any(String),
      );

      open.mockRestore();
    });

    it("pre-fills the editor from a connection's stored scopes and preserves them on relink", async () => {
      const open = jest.spyOn(window, "open").mockReturnValue(null);
      mockFetch(
        [
          {
            id: "connector-2",
            name: "Atlassian",
            provider: "atlassian",
            enabled: true,
            scopes: ["read:jira-work", "write:jira-work", "offline_access"],
          },
        ],
        [
          {
            id: "conn-1",
            connectorId: "connector-2",
            provider: "atlassian",
            status: "connected",
            requestedScopes: ["read:jira-work", "offline_access"],
            expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
          },
        ],
      );

      render(<ProviderConnections />);

      await userEvent.click(await screen.findByRole("button", { name: /permissions/i }));
      expect(screen.getByRole("checkbox", { name: /^read:jira-work/i })).toBeChecked();
      expect(screen.getByRole("checkbox", { name: /write:jira-work/i })).not.toBeChecked();
      expect(screen.getByText(/provider did not report the granted permissions/i)).toBeInTheDocument();
      expect(screen.queryByText(/Reconnect Atlassian for permission changes to take effect/i)).not.toBeInTheDocument();
      await userEvent.click(screen.getByRole("checkbox", { name: /write:jira-work/i }));
      expect(screen.getByText(/Reconnect Atlassian for permission changes to take effect/i)).toBeInTheDocument();
      await userEvent.click(screen.getByRole("checkbox", { name: /write:jira-work/i }));
      expect(screen.queryByText(/Reconnect Atlassian for permission changes to take effect/i)).not.toBeInTheDocument();

      // Reconnect preserves the stored narrowing.
      const relink = screen.getByRole("link", { name: /reconnect atlassian/i });
      relink.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
      expect(open).toHaveBeenLastCalledWith(
        `/api/credentials/oauth/atlassian/connect?scopes=${encodeURIComponent("read:jira-work,offline_access")}`,
        expect.any(String),
        expect.any(String),
      );

      open.mockRestore();
    });

    it("shows granted GitHub scopes without suggesting an unchanged connection needs reconnecting", async () => {
      mockFetch(
        [{ id: "connector-1", name: "GitHub", provider: "github", enabled: true, scopes: ["repo", "read:user"] }],
        [{
          id: "conn-1", connectorId: "connector-1", provider: "github", status: "connected",
          grantedScopes: ["read:user", "repo"],
        }],
      );

      render(<ProviderConnections />);
      await userEvent.click(await screen.findByRole("button", { name: /permissions/i }));
      expect(screen.getByText("Granted by GitHub: read:user, repo")).toBeInTheDocument();
      expect(screen.getByText(/Reconnecting does not approve an organization/)).toBeInTheDocument();
      expect(screen.queryByText(/Reconnect GitHub for permission changes/)).not.toBeInTheDocument();
      await userEvent.click(screen.getByRole("checkbox", { name: /^repo$/ }));
      expect(screen.getByText(/Reconnect GitHub for permission changes/)).toBeInTheDocument();
      expect(screen.getByText("Granted by GitHub: read:user, repo")).toBeInTheDocument();
    });

    it("drops a stored scope the connector no longer offers (connector shrink)", async () => {
      mockFetch(
        [
          {
            id: "connector-2",
            name: "Atlassian",
            provider: "atlassian",
            enabled: true,
            scopes: ["read:jira-work", "offline_access"],
          },
        ],
        [
          {
            id: "conn-1",
            connectorId: "connector-2",
            provider: "atlassian",
            status: "connected",
            // write:jira-work was removed from the connector since this connected.
            requestedScopes: ["read:jira-work", "write:jira-work"],
            expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
          },
        ],
      );

      render(<ProviderConnections />);

      await userEvent.click(await screen.findByRole("button", { name: /permissions/i }));
      expect(screen.queryByRole("checkbox", { name: /write:jira-work/i })).not.toBeInTheDocument();
      expect(screen.getByRole("checkbox", { name: /^read:jira-work/i })).toBeChecked();
    });

    it("disables Connect when the user clears every scope", async () => {
      mockFetch(
        [
          {
            id: "connector-1",
            name: "GitHub",
            provider: "github",
            enabled: true,
            scopes: ["repo"],
          },
        ],
        [],
      );

      render(<ProviderConnections />);

      await userEvent.click(await screen.findByRole("button", { name: /permissions/i }));
      await userEvent.click(screen.getByRole("checkbox", { name: /^repo/i }));
      expect(screen.getByText(/Select at least one scope/i)).toBeInTheDocument();
      expect(screen.getByRole("link", { name: /connect github/i })).toHaveAttribute(
        "aria-disabled",
        "true",
      );
    });
  });
});
