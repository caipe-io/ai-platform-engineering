import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { MCPServerEditor } from "../MCPServerEditor";

// assisted-by Codex Codex-sonnet-4-6

function response(data: unknown, ok = true): Response {
  return {
    ok,
    json: async () => ({ success: ok, data }),
  } as Response;
}

function createBody(): Record<string, unknown> {
  const createCall = (global.fetch as jest.Mock).mock.calls.find(
    ([url, init]: [string, RequestInit | undefined]) =>
      url === "/api/mcp-servers" && init?.method === "POST",
  );
  expect(createCall).toBeDefined();
  return JSON.parse(String(createCall?.[1]?.body)) as Record<string, unknown>;
}

function updateBody(): Record<string, unknown> {
  const updateCall = (global.fetch as jest.Mock).mock.calls.find(
    ([url, init]: [string, RequestInit | undefined]) =>
      typeof url === "string" && url.startsWith("/api/mcp-servers?id=") && init?.method === "PUT",
  );
  expect(updateCall).toBeDefined();
  return JSON.parse(String(updateCall?.[1]?.body)) as Record<string, unknown>;
}

async function chooseSecret(
  user: ReturnType<typeof userEvent.setup>,
  name: string,
  index = 0,
): Promise<void> {
  const picker = screen.getAllByRole("combobox", { name: /^secret$/i })[index];
  await user.click(picker);
  await user.click(await screen.findByRole("option", { name }));
}

describe("MCPServerEditor credential sources", () => {
  beforeEach(() => {
    global.fetch = jest.fn(async (url: string, init?: RequestInit) => {
      if (url === "/api/mcp-servers/agentgateway/discover") {
        return response({ targets: [] });
      }
      if (url === "/api/mcp-servers/endpoint-probe") {
        return response({
          attempts: [
            { url: "http://mcp-argocd:8000", ok: false, status: 404 },
            { url: "http://mcp-argocd:8000/mcp", ok: true, status: 200 },
          ],
          suggestedUrl: "http://mcp-argocd:8000/mcp",
        });
      }
      if (url === "/api/credentials/secrets") {
        return response([
          {
            id: "secret-jira",
            name: "Jira token",
            type: "bearer_token",
            maskedPreview: "j...a",
          },
          {
            id: "secret-pagerduty",
            name: "PagerDuty token",
            type: "api_key",
            maskedPreview: "pd_...1234",
          },
        ]);
      }
      if (url === "/api/credentials/connections") {
        return response([
          {
            id: "conn-atlassian",
            connectorId: "atlassian-connector",
            provider: "atlassian",
            status: "connected",
          },
        ]);
      }
      if (url === "/api/credentials/oauth-connectors") {
        return response([
          {
            id: "atlassian-connector",
            name: "Atlassian Cloud",
            provider: "atlassian",
          },
        ]);
      }
      if (url === "/api/mcp-servers" && init?.method === "POST") {
        return response({ _id: "mcp-github" }, true);
      }
      return response({});
    }) as jest.Mock;
  });

  it("creates header and environment secret refs from selectable secrets", async () => {
    const user = userEvent.setup();
    render(<MCPServerEditor server={null} onSave={jest.fn()} onCancel={jest.fn()} />);

    await user.type(screen.getByLabelText(/display name/i), "GitHub MCP");
    await user.type(screen.getByLabelText(/upstream url|endpoint url/i), "https://mcp.example.com/sse");

    await user.click(screen.getByRole("button", { name: /add credential/i }));
    await screen.findByRole("combobox", { name: /^secret$/i });
    expect(screen.getByLabelText(/^secret$/i)).toHaveTextContent("Select a secret");
    expect(screen.queryByRole("option", { name: /bearer_token|fingerprint|preview/i })).not.toBeInTheDocument();
    expect(screen.queryByText(/Preview j\.\.\.a/i)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /create server/i })).toBeDisabled();
    expect(screen.getByLabelText(/credential header/i)).toHaveValue("X-CAIPE-Provider-Token");
    await chooseSecret(user, "Jira token");
    expect(screen.getByText("Preview j...a")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /add credential/i }));
    await user.selectOptions(screen.getAllByLabelText(/credential target/i)[1], "env");
    await user.type(screen.getByLabelText(/credential name/i), "JIRA_TOKEN");
    await chooseSecret(user, "PagerDuty token", 1);
    expect(screen.getByText("Preview pd_...1234")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /create server/i }));

    await waitFor(() => expect(createBody().credential_sources).toEqual([
      {
        kind: "secret_ref",
        target: "header",
        name: "X-CAIPE-Provider-Token",
        secret_ref: "secret-jira",
      },
      {
        kind: "secret_ref",
        target: "env",
        name: "JIRA_TOKEN",
        secret_ref: "secret-pagerduty",
      },
    ]));
    expect(screen.queryByLabelText(/credential reference/i)).not.toBeInTheDocument();
  });

  it("lets users choose a common header or type a custom header name", async () => {
    const user = userEvent.setup();
    render(<MCPServerEditor server={null} onSave={jest.fn()} onCancel={jest.fn()} />);

    await user.type(screen.getByLabelText(/display name/i), "Token Test");
    await user.type(screen.getByLabelText(/upstream url|endpoint url/i), "https://mcp.example.com/mcp");
    await user.click(screen.getByRole("button", { name: /add credential/i }));
    await screen.findByRole("combobox", { name: /^secret$/i });

    await user.selectOptions(screen.getByLabelText(/credential header/i), "X-CAIPE-Provider-Token");
    await chooseSecret(user, "Jira token");
    await user.click(screen.getByRole("button", { name: /create server/i }));

    await waitFor(() => expect(createBody().credential_sources).toEqual([
      expect.objectContaining({
        target: "header",
        name: "X-CAIPE-Provider-Token",
      }),
    ]));
  });

  it("warns when Authorization is selected for AgentGateway-routed servers", async () => {
    const user = userEvent.setup();
    render(<MCPServerEditor server={null} onSave={jest.fn()} onCancel={jest.fn()} />);

    await user.type(screen.getByLabelText(/display name/i), "Auth Warning Test");
    await user.type(screen.getByLabelText(/upstream url|endpoint url/i), "https://mcp.example.com/mcp");
    await user.click(screen.getByRole("button", { name: /add credential/i }));

    expect(screen.getByText(/route through AgentGateway/i)).toBeInTheDocument();

    await user.selectOptions(screen.getByLabelText(/credential header/i), "Authorization");
    expect(
      screen.getByText(/Authorization is not forwarded to the upstream MCP server via AgentGateway/i),
    ).toBeInTheDocument();
  });

  it("lets users type a custom header name", async () => {
    const user = userEvent.setup();
    render(<MCPServerEditor server={null} onSave={jest.fn()} onCancel={jest.fn()} />);

    await user.type(screen.getByLabelText(/display name/i), "Custom Token Test");
    await user.type(screen.getByLabelText(/upstream url|endpoint url/i), "https://mcp.example.com/mcp");
    await user.click(screen.getByRole("button", { name: /add credential/i }));
    await screen.findByRole("combobox", { name: /^secret$/i });

    await user.selectOptions(screen.getByLabelText(/credential header/i), "__custom__");
    await user.type(screen.getByLabelText(/custom header name/i), "X-My-Token");
    await chooseSecret(user, "Jira token");
    await user.click(screen.getByRole("button", { name: /create server/i }));

    await waitFor(() => expect(createBody().credential_sources).toEqual([
      expect.objectContaining({
        target: "header",
        name: "X-My-Token",
      }),
    ]));
  });

  it("can probe an endpoint and apply the suggested /mcp URL", async () => {
    const user = userEvent.setup();
    render(<MCPServerEditor server={null} onSave={jest.fn()} onCancel={jest.fn()} />);

    await user.type(screen.getByLabelText(/upstream url|endpoint url/i), "http://mcp-argocd:8000");
    await user.click(screen.getByRole("button", { name: /check url/i }));

    expect(await screen.findByText(/http:\/\/mcp-argocd:8000\/mcp/i)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /use suggested url/i }));
    expect(screen.getByLabelText(/upstream url|endpoint url/i)).toHaveValue("http://mcp-argocd:8000/mcp");
  });

  it("derives the saved MCP server name from the display name", async () => {
    const user = userEvent.setup();
    render(<MCPServerEditor server={null} onSave={jest.fn()} onCancel={jest.fn()} />);

    await user.type(screen.getByLabelText(/display name/i), "Meraki Docs");
    expect(screen.getByText(/mcp-meraki-docs/i)).toBeInTheDocument();
    await user.type(screen.getByLabelText(/upstream url|endpoint url/i), "https://mcp.example.com/mcp");
    await user.click(screen.getByRole("button", { name: /create server/i }));

    await waitFor(() => expect(createBody()).toEqual(
      expect.objectContaining({
        id: "meraki-docs",
        name: "Meraki Docs",
      }),
    ));
  });

  it("lets users override the generated MCP server name when needed", async () => {
    const user = userEvent.setup();
    render(<MCPServerEditor server={null} onSave={jest.fn()} onCancel={jest.fn()} />);

    await user.type(screen.getByLabelText(/display name/i), "Meraki Docs");
    await user.click(screen.getByRole("button", { name: /edit generated name/i }));
    await user.clear(screen.getByLabelText(/generated name/i));
    await user.type(screen.getByLabelText(/generated name/i), "meraki-devnet-docs");
    await user.type(screen.getByLabelText(/upstream url|endpoint url/i), "https://mcp.example.com/mcp");
    await user.click(screen.getByRole("button", { name: /create server/i }));

    await waitFor(() => expect(createBody()).toEqual(
      expect.objectContaining({
        id: "meraki-devnet-docs",
        name: "Meraki Docs",
      }),
    ));
  });

  it("keeps the generated MCP server name stable after manual edits", async () => {
    const user = userEvent.setup();
    render(<MCPServerEditor server={null} onSave={jest.fn()} onCancel={jest.fn()} />);

    await user.type(screen.getByLabelText(/display name/i), "Meraki Docs");
    await user.click(screen.getByRole("button", { name: /edit generated name/i }));
    await user.clear(screen.getByLabelText(/generated name/i));
    await user.type(screen.getByLabelText(/generated name/i), "meraki-api-docs");
    await user.type(screen.getByLabelText(/display name/i), " DevNet");

    expect(screen.getByLabelText(/generated name/i)).toHaveValue("meraki-api-docs");
  });


  it("updates the endpoint from the selected AgentGateway target", async () => {
    (global.fetch as jest.Mock).mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === "/api/mcp-servers/agentgateway/discover") {
        return response({
          targets: [
            {
              id: "argocd",
              name: "ArgoCD",
              endpoint: "http://agentgateway:4000/mcp/argocd",
              target_endpoint: "http://mcp-argocd:8000/mcp",
            },
            {
              id: "mcp-test-argocd",
              name: "Test ArgoCD",
              endpoint: "http://agentgateway:4000/mcp/mcp-test-argocd",
              target_endpoint: "http://mcp-argocd:8000/mcp",
            },
          ],
        });
      }
      if (url === "/api/credentials/secrets" || url === "/api/credentials/connections" || url === "/api/credentials/oauth-connectors") {
        return response([]);
      }
      return response({}, init?.method !== "POST" || url === "/api/mcp-servers");
    });
    const user = userEvent.setup();
    render(<MCPServerEditor server={null} onSave={jest.fn()} onCancel={jest.fn()} />);

    await user.click(await screen.findByRole("combobox", { name: /agentgateway target/i }));
    await user.click(screen.getByRole("option", { name: /Test ArgoCD/i }));

    expect(screen.getByLabelText(/upstream url|endpoint url/i)).toHaveValue("http://mcp-argocd:8000/mcp");
  });

  it("submits the picked AgentGateway upstream when creating a new server", async () => {
    (global.fetch as jest.Mock).mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === "/api/mcp-servers/agentgateway/discover") {
        return response({
          targets: [
            {
              id: "jira",
              name: "Jira",
              endpoint: "http://agentgateway:4000/mcp/jira",
              target_endpoint: "http://mcp-jira:8000/mcp",
            },
          ],
        });
      }
      if (url === "/api/credentials/secrets" || url === "/api/credentials/connections" || url === "/api/credentials/oauth-connectors") {
        return response([]);
      }
      if (url === "/api/mcp-servers" && init?.method === "POST") {
        return response({ _id: "mcp-jira-gu" }, true);
      }
      return response({});
    });
    const user = userEvent.setup();
    render(<MCPServerEditor server={null} onSave={jest.fn()} onCancel={jest.fn()} />);

    await user.type(screen.getByLabelText(/display name/i), "JIRA_GU");
    await user.click(screen.getByRole("button", { name: /edit generated name/i }));
    await user.clear(screen.getByLabelText(/generated name/i));
    await user.type(screen.getByLabelText(/generated name/i), "jira-gu");
    await user.click(await screen.findByRole("combobox", { name: /agentgateway target/i }));
    await user.click(screen.getByRole("option", { name: /^Jira$/i }));
    await user.click(screen.getByRole("button", { name: /create server/i }));

    await waitFor(() =>
      expect(createBody()).toMatchObject({
        id: "jira-gu",
        endpoint: "http://mcp-jira:8000/mcp",
        agentgateway_target_endpoint: "http://mcp-jira:8000/mcp",
      }),
    );
  });

  it("creates caller-scoped provider credentials keyed by provider", async () => {
    const user = userEvent.setup();
    render(<MCPServerEditor server={null} onSave={jest.fn()} onCancel={jest.fn()} />);

    await user.type(screen.getByLabelText(/display name/i), "Caller Atlassian MCP");
    await user.type(screen.getByLabelText(/upstream url|endpoint url/i), "https://mcp.example.com/mcp");
    await user.click(screen.getByRole("button", { name: /add credential/i }));
    await user.selectOptions(screen.getByLabelText(/credential kind/i), "provider_connection");
    // No "connection scope" dropdown exists anymore — provider connections are
    // always caller-scoped, so the editor only asks for the provider.
    expect(screen.queryByLabelText(/connection scope/i)).not.toBeInTheDocument();
    await user.selectOptions(screen.getByLabelText(/^provider$/i), "atlassian");
    await user.click(screen.getByRole("button", { name: /create server/i }));

    await waitFor(() =>
      expect(createBody().credential_sources).toEqual([
        {
          kind: "provider_connection",
          target: "header",
          name: "X-CAIPE-Provider-Token",
          connection_scope: "caller",
          provider: "atlassian",
        },
      ]),
    );
  });

  it("does not offer a per-connection (all-callers) picker for provider connections", async () => {
    const user = userEvent.setup();
    render(<MCPServerEditor server={null} onSave={jest.fn()} onCancel={jest.fn()} />);

    await user.type(screen.getByLabelText(/display name/i), "Atlassian MCP");
    await user.type(screen.getByLabelText(/upstream url|endpoint url/i), "https://mcp.example.com/mcp");
    await user.click(screen.getByRole("button", { name: /add credential/i }));

    await user.selectOptions(screen.getByLabelText(/credential kind/i), "provider_connection");
    // The removed "pinned" scope used a "Provider connection" picker that bound a
    // single connection id for all callers. It must no longer be rendered.
    expect(screen.queryByLabelText(/provider connection/i)).not.toBeInTheDocument();
    expect(screen.getByLabelText(/^provider$/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/credential header/i)).toHaveValue("X-CAIPE-Provider-Token");
  });

  it("sends an empty credential_sources array when all credentials are removed on edit", async () => {
    global.fetch = jest.fn(async (url: string, init?: RequestInit) => {
      if (url === "/api/mcp-servers/agentgateway/discover") {
        return response({ targets: [] });
      }
      if (url === "/api/credentials/secrets" || url === "/api/credentials/connections" || url === "/api/credentials/oauth-connectors") {
        return response([]);
      }
      if (typeof url === "string" && url.startsWith("/api/mcp-servers?id=jira") && init?.method === "PUT") {
        return response({ _id: "jira" }, true);
      }
      return response({});
    });

    const user = userEvent.setup();
    render(
      <MCPServerEditor
        server={{
          _id: "jira",
          name: "Jira",
          transport: "http",
          endpoint: "http://agentgateway:4000/mcp/jira",
          credential_sources: [
            {
              kind: "provider_connection",
              target: "header",
              name: "X-CAIPE-Provider-Token",
              provider_connection_id: "conn-atlassian",
              provider: "atlassian",
            },
          ],
        }}
        onSave={jest.fn()}
        onCancel={jest.fn()}
      />,
    );

    await user.click(screen.getByRole("button", { name: /remove credential/i }));
    await user.click(screen.getByRole("button", { name: /save changes/i }));

    await waitFor(() => expect(updateBody().credential_sources).toEqual([]));
  });
});
