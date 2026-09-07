import { expect, test } from "@playwright/test";

import { mockedRbacEnabled } from "./_mocked-rbac";
import {
  buildDefaultWorkflowCatalog,
  buildMcpWorkflowAgentFixture,
  buildPrivateAgentFixture,
  GLOBAL_ACCESS_LABEL,
  openWorkflowEditor,
  runVisibleWorkflow,
  WORKFLOW_ORG_ADMIN_SESSION,
  WORKFLOW_OUTSIDER_SESSION,
  WORKFLOW_PLATFORM_TEAM,
  WORKFLOW_TEAM_MANAGER_SESSION,
  WORKFLOW_TEAM_MEMBER_SESSION,
  installWorkflowBrowserMocks,
  type WorkflowScenario,
  workflowFixtureFromScenario,
} from "./_workflow-browser-fixtures";

test.describe("mocked workflows RBAC and MCP regression", () => {
  test.beforeEach(() => {
    test.skip(
      !mockedRbacEnabled(),
      "Set RUN_RBAC_REGRESSION=1 to run the mocked workflows browser regression.",
    );
  });

  test("lets a non-org-admin team member discover and run a team-shared workflow", async ({
    page,
  }) => {
    const mocks = await installWorkflowBrowserMocks(page, {
      session: WORKFLOW_TEAM_MEMBER_SESSION,
      teamSlugs: [WORKFLOW_PLATFORM_TEAM.slug],
    });

    await page.goto("/workflows", { waitUntil: "domcontentloaded" });
    const breadcrumb = page.getByRole("navigation",{ name: "Breadcrumb" });
    await expect(breadcrumb.getByRole("link",{ name: "Home" })).toHaveAttribute("href","/");
    await expect(breadcrumb.getByRole("link",{ name: "Workflows" })).toHaveAttribute(
      "href",
      "/workflows",
    );
    await expect(page.getByText("Platform team workflow")).toBeVisible();
    await expect(page.getByText("Global SRE workflow")).toBeVisible();
    await expect(page.getByText("Member private workflow")).toBeVisible();

    await openWorkflowEditor(page, "Platform team workflow");
    await runVisibleWorkflow(page);

    await expect.poll(() => mocks.runRequests.length).toBe(1);
    expect(mocks.runRequests[0]).toMatchObject({
      workflow_config_id: "wf-team-platform",
      trigger_info: { triggered_by: "webui" },
    });
    await expect(page).toHaveURL(/\/workflows\/run\/wfrun-playwright-rbac$/);
  });

  test("hides team workflows from org users who are not on the shared team", async ({ page }) => {
    await installWorkflowBrowserMocks(page, {
      session: WORKFLOW_OUTSIDER_SESSION,
      teamSlugs: [],
    });

    await page.goto("/workflows", { waitUntil: "domcontentloaded" });
    await expect(page.getByText("Global SRE workflow")).toBeVisible();
    await expect(page.getByText("Platform team workflow")).toHaveCount(0);
    await expect(page.getByText("Member private workflow")).toHaveCount(0);
  });

  test("shows a private workflow only to its owner", async ({ page }) => {
    await installWorkflowBrowserMocks(page, {
      session: WORKFLOW_TEAM_MEMBER_SESSION,
      teamSlugs: [WORKFLOW_PLATFORM_TEAM.slug],
    });

    await page.goto("/workflows", { waitUntil: "domcontentloaded" });
    await expect(page.getByText("Member private workflow")).toBeVisible();
  });

  test("lets any org user run a global workflow backed by an MCP-enabled agent", async ({ page }) => {
    const mocks = await installWorkflowBrowserMocks(page, {
      session: WORKFLOW_OUTSIDER_SESSION,
      teamSlugs: [],
    });

    await openWorkflowEditor(page, "Global SRE workflow");
    await runVisibleWorkflow(page);

    await expect.poll(() => mocks.runRequests.length).toBe(1);
    expect(mocks.runRequests[0]).toMatchObject({
      workflow_config_id: "wf-global-mcp",
      trigger_info: { triggered_by: "webui" },
    });
  });

  test("restricts MCP tools on a workflow step and probes the Jira MCP server", async ({
    page,
  }) => {
    const mocks = await installWorkflowBrowserMocks(page, {
      session: WORKFLOW_ORG_ADMIN_SESSION,
      isAdmin: true,
      teamSlugs: [WORKFLOW_PLATFORM_TEAM.slug],
    });

    await openWorkflowEditor(page, "Global SRE workflow");
    await page.getByText("Probe Jira issues", { exact: true }).click();
    await page.getByRole("button", { name: /Restrict Tool Access/i }).click();
    await expect(page.getByRole("button", { name: /All tools in this agent/i })).toBeVisible({
      timeout: 15_000,
    });
    await page.getByRole("button", { name: /Restrict for this step/i }).click();
    await page.getByRole("button", { name: "mcp-jira" }).click();

    await expect.poll(() => mocks.probeRequests).toContain("mcp-jira");
    await expect(page.getByText("search", { exact: true })).toBeVisible();
    await expect(page.getByText("get_issue", { exact: true })).toBeVisible();
  });

  test("grants team agent access and saves when the manager can authorize grants", async ({
    page,
  }) => {
    const privateAgent = buildPrivateAgentFixture();
    const scenario: WorkflowScenario = {
      workflowId: "wf-playwright-team-grant",
      workflowName: "Team workflow grant path",
      visibility: "team",
      sharedWithTeams: [WORKFLOW_PLATFORM_TEAM.slug],
      gapTarget: WORKFLOW_PLATFORM_TEAM.slug,
      expectedGrant: {
        resource: { type: "agent", id: privateAgent.id },
        grantee: { type: "team", id: WORKFLOW_PLATFORM_TEAM.slug },
        capability: "use",
      },
    };

    const mocks = await installWorkflowBrowserMocks(page, {
      session: WORKFLOW_TEAM_MANAGER_SESSION,
      isAdmin: false,
      teamSlugs: [WORKFLOW_PLATFORM_TEAM.slug],
      workflows: [
        workflowFixtureFromScenario(
          scenario,
          privateAgent.id,
          WORKFLOW_TEAM_MANAGER_SESSION.email,
        ),
      ],
      agents: [privateAgent],
      agentAccessGaps: [
        {
          agentId: privateAgent.id,
          agentName: privateAgent.name,
          teamsWithoutAccess: [WORKFLOW_PLATFORM_TEAM.slug],
        },
      ],
    });

    await openWorkflowEditor(page, scenario.workflowName);
    await page.getByRole("button", { name: /^Save$/ }).click();

    const dialog = page.getByRole("dialog", { name: /agent access required/i });
    await expect(dialog).toBeVisible();
    await page.getByRole("button", { name: /grant access and save/i }).click();

    await expect.poll(() => mocks.grantRequests.length).toBe(1);
    await expect.poll(() => mocks.saveRequests.length).toBe(1);
    expect(mocks.grantRequests[0]).toMatchObject(scenario.expectedGrant);
    await expect(dialog).toHaveCount(0);
  });

  test("blocks save when a non-manager cannot grant global agent access", async ({ page }) => {
    const privateAgent = buildPrivateAgentFixture();
    const scenario: WorkflowScenario = {
      workflowId: "wf-playwright-global-deny",
      workflowName: "Global workflow needing private agent",
      visibility: "global",
      gapTarget: GLOBAL_ACCESS_LABEL,
      expectedGrant: {
        resource: { type: "agent", id: privateAgent.id },
        grantee: { type: "everyone" },
        capability: "use",
      },
    };

    const mocks = await installWorkflowBrowserMocks(page, {
      session: WORKFLOW_TEAM_MEMBER_SESSION,
      teamSlugs: [WORKFLOW_PLATFORM_TEAM.slug],
      workflows: [
        workflowFixtureFromScenario(
          scenario,
          privateAgent.id,
          WORKFLOW_TEAM_MEMBER_SESSION.email,
        ),
      ],
      agents: [privateAgent],
      denyGrants: true,
      agentAccessGaps: [
        {
          agentId: privateAgent.id,
          agentName: privateAgent.name,
          teamsWithoutAccess: [GLOBAL_ACCESS_LABEL],
        },
      ],
    });

    await openWorkflowEditor(page, scenario.workflowName);
    await page.getByRole("button", { name: /^Save$/ }).click();

    const dialog = page.getByRole("dialog", { name: /agent access required/i });
    await expect(dialog).toBeVisible();
    await page.getByRole("button", { name: /grant access and save/i }).click();

    await expect(page.getByText(/cannot manage agent-private/i)).toBeVisible();
    await expect.poll(() => mocks.grantRequests.length).toBe(1);
    await expect.poll(() => mocks.saveRequests.length).toBe(0);
  });

  test("saves as private when a non-manager cannot grant global agent access", async ({ page }) => {
    const privateAgent = buildPrivateAgentFixture();
    const scenario: WorkflowScenario = {
      workflowId: "wf-playwright-global-save-private",
      workflowName: "Global workflow save private fallback",
      visibility: "global",
      gapTarget: GLOBAL_ACCESS_LABEL,
      expectedGrant: {
        resource: { type: "agent", id: privateAgent.id },
        grantee: { type: "everyone" },
        capability: "use",
      },
    };

    const mocks = await installWorkflowBrowserMocks(page, {
      session: WORKFLOW_TEAM_MEMBER_SESSION,
      teamSlugs: [WORKFLOW_PLATFORM_TEAM.slug],
      workflows: [
        workflowFixtureFromScenario(
          scenario,
          privateAgent.id,
          WORKFLOW_TEAM_MEMBER_SESSION.email,
        ),
      ],
      agents: [privateAgent],
      agentAccessGaps: [
        {
          agentId: privateAgent.id,
          agentName: privateAgent.name,
          teamsWithoutAccess: [GLOBAL_ACCESS_LABEL],
        },
      ],
    });

    await openWorkflowEditor(page, scenario.workflowName);
    await page.getByRole("button", { name: /^Save$/ }).click();

    const dialog = page.getByRole("dialog", { name: /agent access required/i });
    await expect(dialog).toBeVisible();
    await page.getByRole("button", { name: /save as private instead/i }).click();

    await expect.poll(() => mocks.saveRequests.length).toBe(1);
    expect(mocks.saveRequests[0]).toMatchObject({ visibility: "private" });
    await expect(dialog).toHaveCount(0);
  });

  test("lists MCP-backed and team workflows together for org admins", async ({ page }) => {
    await installWorkflowBrowserMocks(page, {
      session: WORKFLOW_ORG_ADMIN_SESSION,
      isAdmin: true,
      teamSlugs: [WORKFLOW_PLATFORM_TEAM.slug],
      workflows: buildDefaultWorkflowCatalog(),
      agents: [buildPrivateAgentFixture(), buildMcpWorkflowAgentFixture()],
    });

    await page.goto("/workflows", { waitUntil: "domcontentloaded" });
    await expect(page.getByText("Global SRE workflow")).toBeVisible();
    await expect(page.getByText("Platform team workflow")).toBeVisible();
    await expect(page.getByText("Member private workflow")).toBeVisible();
  });
});
