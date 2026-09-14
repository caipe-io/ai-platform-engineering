// assisted-by Codex Codex-sonnet-4-6

import { expect, test } from "@playwright/test";

import { chooseSearchablePickerOption } from "./_helpers";
import {
  DEFAULT_JIRA_MCP_SERVER,
  gotoMcpServersTab,
  installMcpBrowserMocks,
  MCP_BROWSER_MEMBER_SESSION,
  openAddMcpServerEditor,
  openMcpServerEditor,
} from "./_mcp-browser-fixtures";
import { mockedRbacEnabled } from "./_mocked-rbac";

const JIRA_AGENTGATEWAY_SERVER = {
  ...DEFAULT_JIRA_MCP_SERVER,
  _id: "jira",
  name: "Jira",
  description: "Discovered from AgentGateway target jira",
  credential_sources: [
    {
      kind: "provider_connection",
      target: "header",
      name: "X-CAIPE-Provider-Token",
      provider: "atlassian",
      provider_connection_id: "conn-atlassian",
    },
  ],
};

const INVOKE_ONLY_PERMISSIONS = {
  can_manage: false,
  can_invoke: true,
  can_discover: true,
};

test.describe("RBAC e2e — MCP credential editor", () => {
  test.beforeEach(() => {
    test.skip(
      !mockedRbacEnabled(),
      "Set RUN_RBAC_REGRESSION=1 to run the mocked MCP credential editor regression.",
    );
  });

  test("removes all credentials on edit and persists an empty credential_sources array", async ({
    page,
  }) => {
    const mocks = await installMcpBrowserMocks(page, {
      servers: [JIRA_AGENTGATEWAY_SERVER],
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
    await openMcpServerEditor(page, "Jira");
    // Provider connections render a caller-scoped "Provider" select now (the
    // per-connection "Provider connection" picker was removed for security).
    await expect(page.getByLabel(/^Provider$/i)).toBeVisible();

    await page.getByRole("button", { name: "Remove credential" }).click();
    await expect(page.getByLabel(/^Provider$/i)).toHaveCount(0);

    await page.getByRole("button", { name: "Save Changes" }).click();

    await expect.poll(() => mocks.updateRequests.length).toBe(1);
    expect(mocks.updateRequests[0]).toMatchObject({
      serverId: "jira",
      body: {
        credential_sources: [],
      },
    });

    await expect(page.getByText("Jira", { exact: true })).toBeVisible();
    await openMcpServerEditor(page, "Jira");
    await expect(page.getByLabel(/^Provider$/i)).toHaveCount(0);
    await expect(page.getByLabel(/^Secret$/)).toHaveCount(0);
  });

  test("keeps credential_sources empty after save and full page reload", async ({ page }) => {
    const mocks = await installMcpBrowserMocks(page, {
      servers: [JIRA_AGENTGATEWAY_SERVER],
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
    await openMcpServerEditor(page, "Jira");
    await page.getByRole("button", { name: "Remove credential" }).click();
    await page.getByRole("button", { name: "Save Changes" }).click();
    await expect.poll(() => mocks.updateRequests.length).toBe(1);

    await page.reload({ waitUntil: "domcontentloaded" });
    await gotoMcpServersTab(page);
    await openMcpServerEditor(page, "Jira");

    await expect(page.getByLabel(/^Provider$/i)).toHaveCount(0);
    await expect(page.getByLabel(/^Secret$/)).toHaveCount(0);
    expect(mocks.updateRequests[0].body.credential_sources).toEqual([]);
  });

  test("replaces a connected app binding with a saved secret on edit", async ({ page }) => {
    const mocks = await installMcpBrowserMocks(page, {
      servers: [JIRA_AGENTGATEWAY_SERVER],
      secrets: [
        {
          id: "secret-jira-team",
          name: "Team Jira token",
          type: "bearer_token",
          maskedPreview: "jira_...team",
        },
      ],
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
    await openMcpServerEditor(page, "Jira");

    await page.getByLabel(/Credential kind/i).selectOption("secret_ref");
    await chooseSearchablePickerOption(
      page,
      page.getByLabel(/^Secret$/),
      "Team Jira token",
    );
    await page.getByRole("button", { name: "Save Changes" }).click();

    await expect.poll(() => mocks.updateRequests.length).toBe(1);
    expect(mocks.updateRequests[0].body.credential_sources).toEqual([
      expect.objectContaining({
        kind: "secret_ref",
        target: "header",
        name: "X-CAIPE-Provider-Token",
        secret_ref: "secret-jira-team",
      }),
    ]);
  });

  test("lists team-shared secrets for members in the MCP credential picker", async ({ page }) => {
    await installMcpBrowserMocks(page, {
      servers: [],
      session: MCP_BROWSER_MEMBER_SESSION,
      isAdmin: false,
      secrets: [
        {
          id: "secret-github-shared",
          name: "Shared GitHub PAT",
          type: "bearer_token",
          maskedPreview: "ghp_...team",
        },
      ],
    });

    await gotoMcpServersTab(page);
    await openAddMcpServerEditor(page);
    await page.getByRole("button", { name: "Add Credential" }).click();

    await chooseSearchablePickerOption(
      page,
      page.getByLabel(/^Secret$/),
      "Shared GitHub PAT",
    );
    await expect(page.getByText("Preview jira_...team")).toHaveCount(0);
    await expect(page.getByText("Preview ghp_...team")).toBeVisible();
  });

  test("hides credential removal and save actions in read-only MCP server view", async ({ page }) => {
    await installMcpBrowserMocks(page, {
      servers: [
        {
          ...JIRA_AGENTGATEWAY_SERVER,
          permissions: INVOKE_ONLY_PERMISSIONS,
        },
      ],
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
      session: MCP_BROWSER_MEMBER_SESSION,
      isAdmin: false,
    });

    await gotoMcpServersTab(page);
    await openMcpServerEditor(page, "Jira");

    await expect(page.getByText("View MCP Server")).toBeVisible();
    await expect(page.getByRole("button", { name: "Remove credential" })).toBeDisabled();
    await expect(page.getByRole("button", { name: "Add Credential" })).toBeDisabled();
    await expect(page.getByRole("button", { name: "Save Changes" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Close" })).toBeVisible();
    await expect(page.getByLabel(/^Provider$/i)).toBeDisabled();
  });

  test("adds a second credential row and sends both bindings on create", async ({ page }) => {
    const mocks = await installMcpBrowserMocks(page, {
      servers: [],
      secrets: [
        {
          id: "secret-fallback",
          name: "Fallback API key",
          type: "api_key",
          maskedPreview: "key_...back",
        },
      ],
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
    await page.getByLabel(/Display Name/i).fill("Dual Credential MCP");
    await page.getByLabel(/Endpoint URL/i).fill("http://agentgateway:4000/mcp/dual");

    await page.getByRole("button", { name: "Add Credential" }).click();
    await page.getByLabel(/Credential kind/i).selectOption("provider_connection");
    await page.getByLabel(/^Provider$/i).selectOption("atlassian");

    await page.getByRole("button", { name: "Add Credential" }).click();
    const credentialRows = page.getByLabel(/Credential kind/i);
    await expect(credentialRows).toHaveCount(2);
    await credentialRows.nth(1).selectOption("secret_ref");
    await chooseSearchablePickerOption(
      page,
      page.getByLabel(/^Secret$/),
      "Fallback API key",
    );

    await page.getByRole("button", { name: "Create Server" }).click();

    await expect.poll(() => mocks.createRequests.length).toBe(1);
    expect(mocks.createRequests[0].credential_sources).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "provider_connection",
          connection_scope: "caller",
          provider: "atlassian",
        }),
        expect.objectContaining({
          kind: "secret_ref",
          secret_ref: "secret-fallback",
        }),
      ]),
    );
    expect((mocks.createRequests[0].credential_sources as unknown[]).length).toBe(2);
  });
});
