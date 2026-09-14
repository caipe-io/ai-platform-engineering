// assisted-by Codex Codex-sonnet-4-6

import { expect, test } from "@playwright/test";

import {
  DEFAULT_AGENTGATEWAY_TARGETS,
  DEFAULT_GITHUB_MCP_SERVER,
  DEFAULT_JIRA_MCP_SERVER,
  GITHUB_MCP_GET_ME_TOOLS,
  JIRA_MCP_PROBE_TOOLS,
  MCP_BROWSER_GENERIC_USER_SESSION,
  fillNewMcpServerBasics,
  gotoMcpServersTab,
  installMcpBrowserMocks,
  mcpTestToolValue,
  openAddMcpServerEditor,
  openMcpTestModal,
  selectAgentGatewayTarget,
  selectMcpTestTool,
  waitForMcpTestToolsLoaded,
} from "./_mcp-browser-fixtures";
import { mockedRbacEnabled } from "./_mocked-rbac";

test.describe("RBAC e2e — MCP AgentGateway picker and test modal", () => {
  test.beforeEach(() => {
    test.skip(
      !mockedRbacEnabled(),
      "Set RUN_RBAC_REGRESSION=1 to run the mocked MCP browser regression.",
    );
  });

  test.describe("AgentGateway target picker (create flow)", () => {
    test("shows the picker above Endpoint URL when discovery returns targets", async ({ page }) => {
      const mocks = await installMcpBrowserMocks(page, { servers: [] });

      await gotoMcpServersTab(page);
      await openAddMcpServerEditor(page);

      await expect.poll(() => mocks.discoverRequests).toBeGreaterThanOrEqual(1);
      await expect(page.getByText("AgentGateway target", { exact: true })).toBeVisible();
      await expect(
        page.getByText(/Pick a routed MCP target from AgentGateway/i),
      ).toBeVisible();
      await expect(page.getByRole("combobox", { name: /agentgateway target/i })).toBeVisible();

      const agLabel = page.getByText("AgentGateway target", { exact: true });
      const endpointLabel = page.getByText(/Endpoint URL/i);
      const agBox = await agLabel.boundingBox();
      const endpointBox = await endpointLabel.boundingBox();
      expect(agBox).not.toBeNull();
      expect(endpointBox).not.toBeNull();
      expect(agBox!.y).toBeLessThan(endpointBox!.y);
    });

    test("fills the endpoint when a Jira target is selected", async ({ page }) => {
      const mocks = await installMcpBrowserMocks(page, { servers: [] });

      await gotoMcpServersTab(page);
      await openAddMcpServerEditor(page);
      await expect.poll(() => mocks.discoverRequests).toBeGreaterThanOrEqual(1);

      await selectAgentGatewayTarget(page, /Jira/i);

      await expect(page.getByLabel(/Endpoint URL/i)).toHaveValue(
        "http://mcp-jira:8000/mcp",
      );
    });

    test("switches endpoint when selecting a different AgentGateway target", async ({ page }) => {
      await installMcpBrowserMocks(page, { servers: [] });

      await gotoMcpServersTab(page);
      await openAddMcpServerEditor(page);

      await selectAgentGatewayTarget(page, /Jira/i);
      await expect(page.getByLabel(/Endpoint URL/i)).toHaveValue(
        "http://mcp-jira:8000/mcp",
      );

      await selectAgentGatewayTarget(page, /ArgoCD/i);
      await expect(page.getByLabel(/Endpoint URL/i)).toHaveValue(
        "http://mcp-argocd:8000/mcp",
      );
    });

    test("creates a server using an AgentGateway-selected endpoint", async ({ page }) => {
      const mocks = await installMcpBrowserMocks(page, { servers: [] });

      await gotoMcpServersTab(page);
      await openAddMcpServerEditor(page);

      await fillNewMcpServerBasics(page, {
        displayName: "Jira via AG",
        serverId: "jira-via-ag",
      });
      await selectAgentGatewayTarget(page, /Jira/i);
      await expect(page.getByRole("button", { name: /Streamable HTTP.*recommended/i })).toBeVisible();
      await page.getByRole("button", { name: "Create Server" }).click();

      await expect.poll(() => mocks.createRequests.length).toBe(1);
      expect(mocks.createRequests[0]).toMatchObject({
        id: "jira-via-ag",
        name: "Jira via AG",
        transport: "http",
        endpoint: "http://mcp-jira:8000/mcp",
        agentgateway_target_endpoint: "http://mcp-jira:8000/mcp",
      });
      expect(mocks.createRequests[0]).not.toHaveProperty("route_through_agentgateway");
      await expect(page.getByText("Jira via AG")).toBeVisible();
    });

    test("does not expose a direct AgentGateway bypass control on the create form", async ({
      page,
    }) => {
      const mocks = await installMcpBrowserMocks(page, { servers: [] });

      await gotoMcpServersTab(page);
      await openAddMcpServerEditor(page);
      await expect(page.getByRole("button", { name: /Streamable HTTP.*recommended/i })).toBeVisible();

      await expect(
        page.getByText(/always go through AgentGateway so tool access can be authorized/i),
      ).toBeVisible();
      await expect(page.getByText(/Bypass AgentGateway routing/i)).toHaveCount(0);
      await expect(page.getByLabel(/Route through AgentGateway/i)).toHaveCount(0);

      await fillNewMcpServerBasics(page, {
        displayName: "Custom HTTP MCP",
        serverId: "custom-http",
      });
      await page.getByLabel(/Endpoint URL/i).fill("https://mcp.example.test/custom/mcp");
      await page.getByRole("button", { name: "Create Server" }).click();

      await expect.poll(() => mocks.createRequests.length).toBe(1);
      expect(mocks.createRequests[0]).toMatchObject({
        id: "custom-http",
        transport: "http",
        endpoint: "https://mcp.example.test/custom/mcp",
        agentgateway_target_endpoint: "https://mcp.example.test/custom/mcp",
      });
      expect(mocks.createRequests[0]).not.toHaveProperty("route_through_agentgateway");
    });

    test("hides the picker when discovery returns no targets", async ({ page }) => {
      await installMcpBrowserMocks(page, {
        servers: [],
        agentGatewayTargets: [],
      });

      await gotoMcpServersTab(page);
      await openAddMcpServerEditor(page);

      await expect(page.getByText("AgentGateway target")).toHaveCount(0);
      await expect(page.getByLabel(/Endpoint URL/i)).toBeVisible();
    });

    test("still supports manual endpoint probe after typing a custom URL", async ({ page }) => {
      const mocks = await installMcpBrowserMocks(page, { servers: [] });

      await gotoMcpServersTab(page);
      await openAddMcpServerEditor(page);

      await expect(page.getByRole("button", { name: /Streamable HTTP.*recommended/i })).toBeVisible();
      await page.getByLabel(/Endpoint URL/i).fill("http://custom-mcp:8000");
      await page.getByRole("button", { name: /check url/i }).click();

      await expect(page.getByText(/http:\/\/custom-mcp:8000\/mcp/i)).toBeVisible();
      await page.getByRole("button", { name: /use suggested url/i }).click();
      await expect(page.getByLabel(/Endpoint URL/i)).toHaveValue("http://custom-mcp:8000/mcp");
      await expect.poll(() => mocks.endpointProbeRequests).toEqual(["http://custom-mcp:8000"]);
    });
  });

  test.describe("Test MCP tools modal", () => {
    test("opens the modal, probes tools, and prefers the version tool", async ({ page }) => {
      const mocks = await installMcpBrowserMocks(page);

      await gotoMcpServersTab(page);
      await expect(page.getByText("Jira MCP")).toBeVisible();
      await openMcpTestModal(page, "Jira MCP");
      await waitForMcpTestToolsLoaded(page);

      await expect.poll(() => mocks.probeRequests).toContain("mcp-jira");
      await expect.poll(() => mcpTestToolValue(page)).toBe("version");
      await expect(page.getByTestId("mcp-tool-test-scroll")).toBeVisible();
      await expect(
        page.getByText(/Run a saved tool from Jira MCP/i),
      ).toBeVisible();
    });

    test("filters and selects tools via the searchable tool picker", async ({ page }) => {
      await installMcpBrowserMocks(page);

      await gotoMcpServersTab(page);
      await openMcpTestModal(page, "Jira MCP");
      await waitForMcpTestToolsLoaded(page);

      await page.locator("#mcp-test-tool").click();
      const listbox = page.getByRole("listbox", { name: "Tool" });
      await expect(listbox).toBeVisible();
      await expect(listbox.getByRole("option")).toHaveCount(JIRA_MCP_PROBE_TOOLS.length);

      const search = page.getByLabel("Search tools...");
      await search.fill("get_i");
      await expect(listbox.getByRole("option")).toHaveCount(1);
      await expect(listbox.getByRole("option", { name: "get_issue" })).toBeVisible();

      await search.fill("nonexistent-tool");
      await expect(listbox.getByRole("option")).toHaveCount(0);
      await expect(page.getByText("No tools match")).toBeVisible();

      await search.fill("get_issue");
      await listbox.getByRole("option", { name: "get_issue" }).click();

      await expect(listbox).toBeHidden();
      await expect.poll(() => mcpTestToolValue(page)).toBe("get_issue");
    });

    test("runs the version tool and shows credential resolution for Atlassian OAuth", async ({
      page,
    }) => {
      const mocks = await installMcpBrowserMocks(page);

      await gotoMcpServersTab(page);
      await openMcpTestModal(page, "Jira MCP");
      await waitForMcpTestToolsLoaded(page);

      await page.getByRole("button", { name: "Run tool" }).click();

      await expect.poll(() => mocks.testToolRequests.length).toBe(1);
      expect(mocks.testToolRequests[0]).toMatchObject({
        serverId: "mcp-jira",
        toolName: "version",
        params: {},
      });

      await expect(page.getByText("Tool call succeeded")).toBeVisible();
      await expect(page.getByText("Credential resolution")).toBeVisible();
      await expect(page.getByText(/Authorization: provider_connection \(atlassian\)/i)).toBeVisible();
      await expect(page.getByText(/jira-mcp 1\.0\.0-playwright/i)).toBeVisible();
    });

    test("renders schema-driven fields for search and posts JQL to test-tool", async ({ page }) => {
      const mocks = await installMcpBrowserMocks(page);

      await gotoMcpServersTab(page);
      await openMcpTestModal(page, "Jira MCP");
      await waitForMcpTestToolsLoaded(page);

      await selectMcpTestTool(page, "search");
      await expect(page.getByText(/JQL query string/i)).toBeVisible();

      const jqlInput = page.getByLabel(/^Value for jql$/i);
      await jqlInput.fill("project = SRE ORDER BY updated DESC");
      await page.getByRole("button", { name: "Run tool" }).click();

      await expect.poll(() => mocks.testToolRequests.length).toBe(1);
      expect(mocks.testToolRequests[0]).toMatchObject({
        serverId: "mcp-jira",
        toolName: "search",
        params: {
          jql: "project = SRE ORDER BY updated DESC",
        },
      });
      await expect(page.getByText("Tool call succeeded")).toBeVisible();
      await expect(page.getByText(/SRE-10109/i)).toBeVisible();
    });

    test("validates required JQL before calling test-tool", async ({ page }) => {
      const mocks = await installMcpBrowserMocks(page);

      await gotoMcpServersTab(page);
      await openMcpTestModal(page, "Jira MCP");
      await waitForMcpTestToolsLoaded(page);

      await selectMcpTestTool(page, "search");
      await page.getByLabel(/^Value for jql$/i).fill("");
      await page.getByRole("button", { name: "Run tool" }).click();

      await expect(page.getByText(/jql is required/i)).toBeVisible();
      expect(mocks.testToolRequests).toHaveLength(0);
    });

    test("runs get_issue with schema fields and shows the issue payload", async ({ page }) => {
      const mocks = await installMcpBrowserMocks(page);

      await gotoMcpServersTab(page);
      await openMcpTestModal(page, "Jira MCP");
      await waitForMcpTestToolsLoaded(page);

      await selectMcpTestTool(page, "get_issue");
      await page.getByLabel(/^Value for issue_key$/i).fill("SRE-10109");
      await page.getByRole("button", { name: "Run tool" }).click();

      await expect.poll(() => mocks.testToolRequests.length).toBe(1);
      expect(mocks.testToolRequests[0]).toMatchObject({
        toolName: "get_issue",
        params: { issue_key: "SRE-10109" },
      });
      await expect(page.getByText(/Fixture issue/i)).toBeVisible();
    });

    test("supports JSON parameter mode for nested tool arguments", async ({ page }) => {
      const mocks = await installMcpBrowserMocks(page);

      await gotoMcpServersTab(page);
      await openMcpTestModal(page, "Jira MCP");
      await waitForMcpTestToolsLoaded(page);

      await selectMcpTestTool(page, "search");
      await page.getByRole("button", { name: "JSON", exact: true }).click();
      await page.locator("#mcp-test-params").fill(
        JSON.stringify({
          jql: "updated >= -7d ORDER BY updated DESC",
          max_results: 5,
        }),
      );
      await page.getByRole("button", { name: "Run tool" }).click();

      await expect.poll(() => mocks.testToolRequests.length).toBe(1);
      expect(mocks.testToolRequests[0]?.params).toMatchObject({
        jql: "updated >= -7d ORDER BY updated DESC",
        max_results: 5,
      });
    });

    test("adds custom parameter rows when the tool schema is unknown", async ({ page }) => {
      const mocks = await installMcpBrowserMocks(page);

      await gotoMcpServersTab(page);
      await openMcpTestModal(page, "Jira MCP");
      await waitForMcpTestToolsLoaded(page);

      await selectMcpTestTool(page, "get_current_user_account_id");
      await page.getByPlaceholder("parameter_name").first().fill("debug");
      await page.getByLabel(/^Value for debug$/i).fill("true");
      await page.getByRole("button", { name: "Run tool" }).click();

      await expect.poll(() => mocks.testToolRequests.length).toBe(1);
      expect(mocks.testToolRequests[0]).toMatchObject({
        toolName: "get_current_user_account_id",
        params: { debug: true },
      });
    });

    test("updates optional max_results alongside required JQL in fields mode", async ({ page }) => {
      const mocks = await installMcpBrowserMocks(page);

      await gotoMcpServersTab(page);
      await openMcpTestModal(page, "Jira MCP");
      await waitForMcpTestToolsLoaded(page);

      await selectMcpTestTool(page, "search");
      await page.getByLabel(/^Value for jql$/i).fill("project = SRE");
      await page.getByLabel(/^Value for max_results$/i).first().fill("3");
      await page.getByRole("button", { name: "Run tool" }).click();

      await expect.poll(() => mocks.testToolRequests.length).toBe(1);
      expect(mocks.testToolRequests[0]?.params).toMatchObject({
        jql: "project = SRE",
        max_results: 3,
      });
    });

    test("shows application-error warning when MCP transport succeeds but the tool fails", async ({
      page,
    }) => {
      const mocks = await installMcpBrowserMocks(page, {
        testToolResponder: () => ({
          success: true,
          application_success: false,
          status: 200,
          result: {
            content: [
              {
                type: "text",
                text: JSON.stringify({ errorMessages: ["Issue does not exist"] }),
              },
            ],
            isError: true,
          },
          credential_resolution: [
            {
              name: "Authorization",
              kind: "provider_connection",
              origin: "provider_connection",
              provider: "atlassian",
            },
          ],
        }),
      });

      await gotoMcpServersTab(page);
      await openMcpTestModal(page, "Jira MCP");
      await waitForMcpTestToolsLoaded(page);
      await page.getByRole("button", { name: "Run tool" }).click();

      await expect(
        page.getByText(/MCP call succeeded, but the tool returned an application error/i),
      ).toBeVisible();
      await expect(page.getByText("Credential resolution")).toBeVisible();
      expect(mocks.testToolRequests).toHaveLength(1);
    });

    test("shows transport failure when test-tool returns success=false", async ({ page }) => {
      const mocks = await installMcpBrowserMocks(page, {
        testToolResponder: () => ({
          success: false,
          status: 401,
          error: "Unauthorized — provider token rejected",
        }),
      });

      await gotoMcpServersTab(page);
      await openMcpTestModal(page, "Jira MCP");
      await waitForMcpTestToolsLoaded(page);
      await page.getByRole("button", { name: "Run tool" }).click();

      await expect(page.getByText("Tool call failed")).toBeVisible();
      await expect(page.getByText(/Unauthorized — provider token rejected/i)).toBeVisible();
      expect(mocks.testToolRequests).toHaveLength(1);
    });

    test("surfaces probe failures inside the modal", async ({ page }) => {
      const mocks = await installMcpBrowserMocks(page, {
        probeError: "AgentGateway denied tool discovery",
      });

      await gotoMcpServersTab(page);
      await openMcpTestModal(page, "Jira MCP");

      await expect(page.getByText(/AgentGateway denied tool discovery/i)).toBeVisible();
      await expect(page.getByRole("button", { name: "Run tool" })).toBeDisabled();
      expect(mocks.probeRequests).toContain("mcp-jira");
    });

    test("closes the modal without leaving a stale dialog", async ({ page }) => {
      await installMcpBrowserMocks(page);

      await gotoMcpServersTab(page);
      await openMcpTestModal(page, "Jira MCP");
      await waitForMcpTestToolsLoaded(page);

      await page.getByRole("dialog").getByRole("button", { name: "Close" }).first().click();
      await expect(page.getByRole("dialog")).toHaveCount(0);
      await expect(page.getByText("Jira MCP")).toBeVisible();
    });
  });

  test.describe("Permission gating with test modal", () => {
    test("invoke-only members can open the test modal but cannot delete the server", async ({
      page,
    }) => {
      await installMcpBrowserMocks(page, {
        isAdmin: false,
        session: {
          email: "member@caipe.local",
          name: "Team Member",
          role: "user",
          canViewAdmin: false,
        },
        servers: [
          {
            ...DEFAULT_JIRA_MCP_SERVER,
            permissions: {
              can_manage: false,
              can_invoke: true,
              can_discover: true,
            },
          },
        ],
      });

      await gotoMcpServersTab(page);
      await expect(page.getByRole("button", { name: /Delete Jira MCP/i })).toHaveCount(0);
      await openMcpTestModal(page, "Jira MCP");
      await waitForMcpTestToolsLoaded(page);
      await expect.poll(() => mcpTestToolValue(page)).toBe("version");
    });

    test("read-only rows hide the test action entirely", async ({ page }) => {
      await installMcpBrowserMocks(page, {
        isAdmin: false,
        session: {
          email: "member@caipe.local",
          name: "Team Member",
          role: "user",
          canViewAdmin: false,
        },
        servers: [
          {
            ...DEFAULT_JIRA_MCP_SERVER,
            permissions: {
              can_manage: false,
              can_invoke: false,
              can_discover: false,
            },
          },
        ],
      });

      await gotoMcpServersTab(page);
      await expect(page.getByText("Jira MCP")).toBeVisible();
      await expect(page.getByRole("button", { name: /Test MCP tools for Jira MCP/i })).toHaveCount(0);
    });
  });

  test.describe("Combined create + test workflow", () => {
    test("creates an Atlassian-backed server then exercises search in the test modal", async ({
      page,
    }) => {
      const mocks = await installMcpBrowserMocks(page, {
        servers: [],
        providerConnections: [
          {
            id: "conn-atlassian",
            connectorId: "atlassian-connector",
            provider: "atlassian",
            status: "connected",
          },
        ],
        oauthConnectors: [
          {
            id: "atlassian-connector",
            name: "Atlassian Cloud",
            provider: "atlassian",
          },
        ],
      });

      await gotoMcpServersTab(page);
      await openAddMcpServerEditor(page);

      await fillNewMcpServerBasics(page, {
        displayName: "Jira E2E",
        serverId: "jira-e2e",
      });
      await selectAgentGatewayTarget(page, /Jira/i);
      await expect(page.getByRole("button", { name: /Streamable HTTP.*recommended/i })).toBeVisible();

      await page.getByRole("button", { name: "Add Credential" }).click();
      await page.getByLabel(/Credential kind/i).selectOption("provider_connection");
      await page.getByLabel(/^Provider$/i).selectOption("atlassian");
      await page.getByRole("button", { name: "Create Server" }).click();

      await expect.poll(() => mocks.createRequests.length).toBe(1);
      expect(mocks.createRequests[0].credential_sources).toEqual([
        expect.objectContaining({
          kind: "provider_connection",
          connection_scope: "caller",
          provider: "atlassian",
        }),
      ]);

      await expect(page.getByText("Jira E2E")).toBeVisible();
      await openMcpTestModal(page, "Jira E2E");
      await waitForMcpTestToolsLoaded(page);

      await selectMcpTestTool(page, "search");
      await page.getByLabel(/^Value for jql$/i).fill("project = MERAKI ORDER BY updated DESC");
      await page.getByRole("button", { name: "Run tool" }).click();

      await expect.poll(() => mocks.testToolRequests.length).toBe(1);
      expect(mocks.testToolRequests[0]).toMatchObject({
        toolName: "search",
        params: { jql: "project = MERAKI ORDER BY updated DESC" },
      });
      await expect(page.getByText(/Authorization: provider_connection \(atlassian\)/i)).toBeVisible();
    });

    test("lists all discovered AgentGateway targets in the picker", async ({ page }) => {
      const mocks = await installMcpBrowserMocks(page, {
        servers: [],
        agentGatewayTargets: DEFAULT_AGENTGATEWAY_TARGETS,
      });

      await gotoMcpServersTab(page);
      await openAddMcpServerEditor(page);
      await expect.poll(() => mocks.discoverRequests).toBeGreaterThanOrEqual(1);

      await page.getByRole("combobox", { name: /agentgateway target/i }).click();
      for (const target of DEFAULT_AGENTGATEWAY_TARGETS) {
        await expect(page.getByRole("option", { name: new RegExp(target.name, "i") })).toBeVisible();
      }
    });
  });

  test.describe("Generic user team-shared secret resolution", () => {
    test("resolves a team-shared PAT for get_me and surfaces secret_ref in the modal", async ({
      page,
    }) => {
      const mocks = await installMcpBrowserMocks(page, {
        isAdmin: false,
        session: MCP_BROWSER_GENERIC_USER_SESSION,
        servers: [DEFAULT_GITHUB_MCP_SERVER],
        probeTools: GITHUB_MCP_GET_ME_TOOLS,
        secrets: [
          {
            id: "secret-github-shared",
            name: "Shared GitHub PAT",
            type: "bearer_token",
            maskedPreview: "ghp_...team",
            sharedWithTeams: ["platform-team"],
          },
        ],
        testToolResponder: () => ({
          success: true,
          application_success: true,
          status: 200,
          result: {
            content: [
              {
                type: "text",
                text: JSON.stringify({ login: "generic-user", id: 12345 }),
              },
            ],
          },
          credential_resolution: [
            {
              name: "Authorization",
              kind: "secret_ref",
              origin: "secret_ref",
            },
          ],
        }),
      });

      await gotoMcpServersTab(page);
      await openMcpTestModal(page, "GitHub MCP");
      await waitForMcpTestToolsLoaded(page);

      await selectMcpTestTool(page, "get_me");
      await page.getByRole("button", { name: "Run tool" }).click();

      await expect.poll(() => mocks.testToolRequests.length).toBe(1);
      expect(mocks.testToolRequests[0]).toMatchObject({
        serverId: "mcp-github",
        toolName: "get_me",
        params: {},
      });

      await expect(page.getByText("Tool call succeeded")).toBeVisible();
      await expect(page.getByText("Credential resolution")).toBeVisible();
      await expect(page.getByText(/Authorization: secret_ref/i)).toBeVisible();
      await expect(page.getByText(/generic-user/i)).toBeVisible();
    });
  });
});
