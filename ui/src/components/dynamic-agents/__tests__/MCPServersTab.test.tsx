import React from "react";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MCP_SERVERS_REFRESH_INTERVAL_MS, MCPServersTab } from "../MCPServersTab";

/** Opens the `Tool` AgentPicker, searches for `toolName`, and picks it. */
async function selectTool(toolName: string): Promise<void> {
  fireEvent.click(await screen.findByLabelText("Tool"));
  fireEvent.change(await screen.findByLabelText("Search tools..."), {
    target: { value: toolName },
  });
  fireEvent.click(await screen.findByRole("option", { name: toolName }));
}

const jiraServer = {
  _id: "jira",
  name: "Jira",
  transport: "http",
  endpoint: "http://mcp-jira:8000/mcp",
  enabled: true,
  created_at: "2026-05-17T00:00:00.000Z",
  updated_at: "2026-05-17T00:00:00.000Z",
  permissions: { can_manage: true, can_invoke: true, can_discover: true },
};

const agentGatewayRagServer = {
  _id: "rag",
  name: "RAG",
  transport: "http",
  endpoint: "http://agentgateway:4000/mcp",
  enabled: true,
  config_driven: true,
  source: "agentgateway",
  agentgateway_discovered: true,
  agentgateway_target_endpoint: "http://rag-server:9446/mcp",
  created_at: "2026-05-17T00:00:00.000Z",
  updated_at: "2026-05-17T00:00:00.000Z",
  permissions: { can_manage: false, can_invoke: true, can_discover: true },
};

const listCapabilities = { repair_agentgateway: true };

describe("MCPServersTab AgentGateway repair", () => {
  let serverItems: Record<string, unknown>[];

  beforeEach(() => {
    jest.clearAllMocks();
    serverItems = [jiraServer];
    global.fetch = jest.fn((url: string, init?: RequestInit) => {
      if (url === "/api/mcp-servers?page_size=100") {
        return Promise.resolve({
          json: async () => ({
            success: true,
            data: {
              items: serverItems,
              capabilities: listCapabilities,
            },
          }),
        } as Response);
      }
      if (url === "/api/mcp-servers?id=jira") {
        return Promise.resolve({
          json: async () => ({ success: true, data: jiraServer }),
        } as Response);
      }
      if (url === "/api/mcp-servers/agentgateway/sync" && init?.method === "POST") {
        return Promise.resolve({
          json: async () => ({
            success: true,
            data: {
              added: ["rag"],
              skipped: [{ id: "jira", reason: "conflict" }],
              summary: { added: 1, existing: 0, conflicts: 1, skipped: 1 },
              migration_warnings: [
                {
                  id: "jira",
                  endpoint: "http://agentgateway:4000/mcp",
                  target_endpoint: "http://mcp-jira:8000/mcp",
                  existing_endpoint: "http://legacy-jira:8000/mcp",
                  message:
                    "Legacy MCP server conflicts with AgentGateway target \"jira\". Remove or rename the legacy MCP server to let AgentGateway manage it.",
                },
              ],
            },
          }),
        } as Response);
      }
      if (url === "/api/mcp-servers/probe?id=jira" && init?.method === "POST") {
        return Promise.resolve({
          json: async () => ({
            success: true,
            data: {
              server_id: "jira",
              success: true,
              tools: [
                {
                  name: "version",
                  namespaced_name: "version",
                  description: "Return the MCP server version.",
                },
                {
                  name: "search",
                  namespaced_name: "search",
                  description: "Search Jira issues using JQL.",
                  inputSchema: {
                    type: "object",
                    properties: {
                      jql: {
                        type: "string",
                        description: "JQL query.",
                      },
                    },
                    required: ["jql"],
                  },
                },
              ],
            },
          }),
        } as Response);
      }
      if (url === "/api/admin/platform-config") {
        return Promise.resolve({
          json: async () => ({
            success: true,
            data: {
              release_notes: { enabled: false },
              remote_mcp_catalog: { enabled_providers: null, custom_entries: [] },
            },
          }),
        } as Response);
      }
      if (url === "/api/mcp-servers/test-tool" && init?.method === "POST") {
        return Promise.resolve({
          json: async () => ({
            success: true,
            data: {
              success: true,
              status: 200,
              result: { content: [{ type: "text", text: "1.2.3" }] },
            },
          }),
        } as Response);
      }
      throw new Error(`Unexpected fetch: ${url}`);
    }) as unknown as typeof fetch;
  });

  it("repairs AgentGateway MCP server registrations and shows migration conflicts", async () => {
    render(<MCPServersTab />);

    await screen.findByText("Jira");
    fireEvent.click(screen.getByRole("button", { name: /Repair AgentGateway/i }));

    await waitFor(() => {
      expect(global.fetch).toHaveBeenCalledWith(
        "/api/mcp-servers/agentgateway/sync",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({}),
        }),
      );
    });

    // Message format changed to break down counts:
    //   "Added 1, migrated 0, and refreshed 0 MCP server from AgentGateway."
    expect(
      await screen.findByText(/Added 1, migrated 0, and refreshed 0 MCP server/i),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/1 legacy MCP server conflicts with AgentGateway targets/i),
    ).toBeInTheDocument();
    expect(screen.getByText(/Remove or rename the legacy MCP server/i)).toBeInTheDocument();
    expect(screen.getAllByText("jira").length).toBeGreaterThan(0);
    expect(screen.getByText(/Current: http:\/\/legacy-jira:8000\/mcp/i)).toBeInTheDocument();
    expect(screen.getByText(/AgentGateway: http:\/\/mcp-jira:8000\/mcp/i)).toBeInTheDocument();
  });

  it("marks AgentGateway-registered MCP servers in the table", async () => {
    serverItems = [jiraServer, agentGatewayRagServer];
    render(<MCPServersTab />);

    await screen.findByText("RAG");

    expect(screen.getByText("AgentGateway")).toBeInTheDocument();
    expect(screen.getByText(/Target: http:\/\/rag-server:9446\/mcp/i)).toBeInTheDocument();
  });

  it("opens a test modal and invokes a saved MCP tool", async () => {
    render(<MCPServersTab />);

    await screen.findByText("Jira");
    fireEvent.click(screen.getByRole("button", { name: /test mcp tools for jira/i }));

    expect(await screen.findByRole("dialog")).toHaveTextContent(/Test MCP tools/i);
    expect(await screen.findByLabelText("Tool")).toHaveTextContent("version");
    expect(screen.getByRole("button", { name: "Fields" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Add parameter" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /run tool/i }));

    await waitFor(() => {
      expect(global.fetch).toHaveBeenCalledWith(
        "/api/mcp-servers/test-tool",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({
            serverId: "jira",
            toolName: "version",
            params: {},
          }),
        }),
      );
    });
    expect(await screen.findByText(/Tool call succeeded/i)).toBeInTheDocument();
    expect(screen.getByText(/1.2.3/i)).toBeInTheDocument();
  });

  it("filters the tool picker's options by search text", async () => {
    render(<MCPServersTab />);

    await screen.findByText("Jira");
    fireEvent.click(screen.getByRole("button", { name: /test mcp tools for jira/i }));

    fireEvent.click(await screen.findByLabelText("Tool"));
    const listbox = await screen.findByRole("listbox", { name: "Tool" });
    expect(within(listbox).getAllByRole("option")).toHaveLength(2);

    fireEvent.change(screen.getByLabelText("Search tools..."), {
      target: { value: "sea" },
    });
    expect(within(listbox).getAllByRole("option")).toHaveLength(1);
    expect(within(listbox).getByRole("option", { name: "search" })).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("Search tools..."), {
      target: { value: "no-match" },
    });
    expect(within(listbox).queryAllByRole("option")).toHaveLength(0);
    expect(screen.getByText("No tools match")).toBeInTheDocument();
  });

  it("renders schema parameters as fields and sends them as JSON", async () => {
    render(<MCPServersTab />);

    await screen.findByText("Jira");
    fireEvent.click(screen.getByRole("button", { name: /test mcp tools for jira/i }));

    await selectTool("search");

    expect(await screen.findByLabelText("Value for jql")).toBeInTheDocument();
    expect(screen.getByText("Required")).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Value for jql"), { target: { value: "project = MERAKI" } });
    fireEvent.click(screen.getByRole("button", { name: /run tool/i }));

    await waitFor(() => {
      expect(global.fetch).toHaveBeenCalledWith(
        "/api/mcp-servers/test-tool",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({
            serverId: "jira",
            toolName: "search",
            params: { jql: "project = MERAKI" },
          }),
        }),
      );
    });
  });

  it("accepts free-form parameter rows when a tool has no advertised schema", async () => {
    render(<MCPServersTab />);

    await screen.findByText("Jira");
    fireEvent.click(screen.getByRole("button", { name: /test mcp tools for jira/i }));

    await selectTool("version");
    fireEvent.change(screen.getByPlaceholderText("parameter_name"), { target: { value: "limit" } });
    fireEvent.change(await screen.findByLabelText("Value for limit"), { target: { value: "5" } });
    fireEvent.click(screen.getByRole("button", { name: /run tool/i }));

    await waitFor(() => {
      expect(global.fetch).toHaveBeenCalledWith(
        "/api/mcp-servers/test-tool",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({
            serverId: "jira",
            toolName: "version",
            params: { limit: 5 },
          }),
        }),
      );
    });
  });

  it("adds extra parameter rows with the + button", async () => {
    render(<MCPServersTab />);

    await screen.findByText("Jira");
    fireEvent.click(screen.getByRole("button", { name: /test mcp tools for jira/i }));

    await selectTool("search");

    fireEvent.change(await screen.findByLabelText("Value for jql"), {
      target: { value: "project = MERAKI" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Add parameter" }));

    fireEvent.change(await screen.findByLabelText("Parameter value 2"), { target: { value: "50" } });
    fireEvent.change(screen.getAllByPlaceholderText("parameter_name")[1], {
      target: { value: "maxResults" },
    });
    fireEvent.click(screen.getByRole("button", { name: /run tool/i }));

    await waitFor(() => {
      expect(global.fetch).toHaveBeenCalledWith(
        "/api/mcp-servers/test-tool",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({
            serverId: "jira",
            toolName: "search",
            params: { jql: "project = MERAKI", maxResults: 50 },
          }),
        }),
      );
    });
  });

  it("refreshes the mounted list when servers are added outside the tab", async () => {
    jest.useFakeTimers();
    const { unmount } = render(<MCPServersTab />);

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(screen.getByText("Jira")).toBeInTheDocument();
    expect(screen.queryByText("RAG")).not.toBeInTheDocument();

    serverItems = [jiraServer, agentGatewayRagServer];

    await act(async () => {
      jest.advanceTimersByTime(MCP_SERVERS_REFRESH_INTERVAL_MS);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(screen.getByText("RAG")).toBeInTheDocument();
    expect(global.fetch).toHaveBeenCalledWith(
      "/api/mcp-servers?page_size=100",
      expect.objectContaining({ cache: "no-store" }),
    );

    unmount();
    jest.useRealTimers();
  });

  it("refreshes the mounted list when servers are removed outside the tab", async () => {
    jest.useFakeTimers();
    serverItems = [jiraServer, agentGatewayRagServer];
    const { unmount } = render(<MCPServersTab />);

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(screen.getByText("Jira")).toBeInTheDocument();
    expect(screen.getByText("RAG")).toBeInTheDocument();

    serverItems = [jiraServer];

    await act(async () => {
      jest.advanceTimersByTime(MCP_SERVERS_REFRESH_INTERVAL_MS);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(screen.getByText("Jira")).toBeInTheDocument();
    expect(screen.queryByText("RAG")).not.toBeInTheDocument();

    unmount();
    jest.useRealTimers();
  });

  it("hides repair, probe, test, and delete actions when row permissions deny them", async () => {
    serverItems = [
      {
        ...jiraServer,
        permissions: { can_manage: false, can_invoke: false, can_discover: false },
      },
    ];
    global.fetch = jest.fn((url: string) => {
      if (url === "/api/mcp-servers?page_size=100") {
        return Promise.resolve({
          json: async () => ({
            success: true,
            data: {
              items: serverItems,
              capabilities: { repair_agentgateway: false },
            },
          }),
        } as Response);
      }
      throw new Error(`Unexpected fetch: ${url}`);
    }) as unknown as typeof fetch;

    render(<MCPServersTab />);

    await screen.findByText("Jira");
    expect(screen.queryByRole("button", { name: /Repair AgentGateway/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Probe tools for Jira/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /test mcp tools for jira/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Delete Jira/i })).not.toBeInTheDocument();
  });

  it("opens the create editor when Add Server is clicked", async () => {
    render(<MCPServersTab />);

    await screen.findByText("Jira");
    fireEvent.click(screen.getByRole("button", { name: "Add Server" }));
    expect(await screen.findByText("Add MCP Server")).toBeInTheDocument();
  });

  it("shows repair, probe, test, and delete when list permissions allow them", async () => {
    render(<MCPServersTab />);

    await screen.findByText("Jira");
    expect(screen.getByRole("button", { name: /Repair AgentGateway/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Probe tools for Jira/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /test mcp tools for jira/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Delete Jira/i })).toBeInTheDocument();
  });

  it("opens a read-only editor when the caller lacks can_manage", async () => {
    serverItems = [
      {
        ...jiraServer,
        permissions: { can_manage: false, can_invoke: true, can_discover: true },
      },
    ];

    render(<MCPServersTab />);

    await screen.findByText("Jira");
    fireEvent.click(screen.getByText("Jira"));
    expect(await screen.findByText("View MCP Server")).toBeInTheDocument();
    expect(screen.queryByText("Edit MCP Server")).not.toBeInTheDocument();
  });

  it("loads a directly linked MCP server and reports when its editor closes", async () => {
    const onSelectedServerChange = jest.fn();

    render(
      <MCPServersTab
        selectedServerId="jira"
        onSelectedServerChange={onSelectedServerChange}
      />,
    );

    expect(await screen.findByText("Edit MCP Server")).toBeInTheDocument();
    expect(global.fetch).toHaveBeenCalledWith(
      "/api/mcp-servers?id=jira",
      { cache: "no-store" },
    );

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onSelectedServerChange).toHaveBeenCalledWith(null);
  });

  it("keeps the selected row open when the page adds the server ID to the URL", async () => {
    const onSelectedServerChange = jest.fn();
    const { rerender } = render(
      <MCPServersTab onSelectedServerChange={onSelectedServerChange} />,
    );

    fireEvent.click(await screen.findByText("Jira"));

    expect(onSelectedServerChange).toHaveBeenCalledWith("jira");
    expect(await screen.findByText("Edit MCP Server")).toBeInTheDocument();

    jest.mocked(global.fetch).mockClear();
    rerender(
      <MCPServersTab
        selectedServerId="jira"
        onSelectedServerChange={onSelectedServerChange}
      />,
    );

    expect(global.fetch).not.toHaveBeenCalledWith(
      "/api/mcp-servers?id=jira",
      { cache: "no-store" },
    );
    expect(screen.getByText("Edit MCP Server")).toBeInTheDocument();
  });

  it("does not issue update requests when toggling enabled without can_manage", async () => {
    serverItems = [
      {
        ...jiraServer,
        permissions: { can_manage: false, can_invoke: true, can_discover: true },
      },
    ];
    const putCalls: string[] = [];
    global.fetch = jest.fn((url: string, init?: RequestInit) => {
      if (url === "/api/mcp-servers?page_size=100") {
        return Promise.resolve({
          json: async () => ({
            success: true,
            data: {
              items: serverItems,
              capabilities: listCapabilities,
            },
          }),
        } as Response);
      }
      if (typeof url === "string" && url.startsWith("/api/mcp-servers?id=") && init?.method === "PUT") {
        putCalls.push(url);
      }
      throw new Error(`Unexpected fetch: ${url}`);
    }) as unknown as typeof fetch;

    render(<MCPServersTab />);

    await screen.findByText("Jira");
    const toggle = screen.getByTitle("You do not have permission to modify this server");
    expect(toggle).toBeDisabled();
    fireEvent.click(toggle);
    expect(putCalls).toHaveLength(0);
  });

  it("uses inline delete confirmation instead of a browser confirm dialog", async () => {
    const confirmSpy = jest.spyOn(window, "confirm").mockImplementation(() => true);
    const deleteCalls: string[] = [];
    global.fetch = jest.fn((url: string, init?: RequestInit) => {
      if (url === "/api/mcp-servers?page_size=100") {
        return Promise.resolve({
          json: async () => ({
            success: true,
            data: {
              items: serverItems,
              capabilities: listCapabilities,
            },
          }),
        } as Response);
      }
      if (typeof url === "string" && url.startsWith("/api/mcp-servers?id=jira") && init?.method === "DELETE") {
        deleteCalls.push(url);
        return Promise.resolve({ json: async () => ({ success: true }) } as Response);
      }
      throw new Error(`Unexpected fetch: ${url}`);
    }) as unknown as typeof fetch;

    render(<MCPServersTab />);

    await screen.findByText("Jira");
    fireEvent.click(screen.getByRole("button", { name: /Delete Jira/i }));
    expect(screen.getByText(/Delete Jira\?/i)).toBeInTheDocument();
    expect(confirmSpy).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: /Confirm delete Jira/i }));
    await waitFor(() => expect(deleteCalls).toHaveLength(1));
    expect(deleteCalls[0]).toContain("id=jira");

    confirmSpy.mockRestore();
  });
});
