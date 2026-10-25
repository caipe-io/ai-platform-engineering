// assisted-by Codex:gpt-5
/**
 * Mocked browser regression for agent owner-team transfers.
 *
 * Set RUN_RBAC_REGRESSION=1 to run.
 */

import { expect, test } from "@playwright/test";

import {
  fulfillJson,
  installMockedRbacApp,
  mockedRbacEnabled,
  postJson,
  type MockRouteHandler,
} from "./_mocked-rbac";

const existingAgent = {
  _id: "agent-owner-transfer",
  name: "Ownership Transfer Agent",
  description: "Agent used by Playwright to verify owner-team transfer UX.",
  system_prompt: "Help platform users move ownership safely.",
  visibility: "team",
  owner_team_slug: "platform",
  owner_team_id: "team-platform",
  shared_with_teams: [],
  allowed_tools: {},
  builtin_tools: undefined,
  subagents: [],
  skills: [],
  model: { id: "gpt-4o", provider: "openai" },
  ui: { gradient_theme: "default" },
  enabled: true,
  owner_id: "admin@example.com",
  is_system: false,
  config_driven: false,
  permissions: {
    can_manage: true,
    can_write: true,
    can_discover: true,
  },
  created_at: "2026-06-17T00:00:00.000Z",
  updated_at: "2026-06-17T00:00:00.000Z",
};

test.describe("agent editor owner-team transfer", () => {
  test.beforeEach(() => {
    test.skip(
      !mockedRbacEnabled(),
      "Set RUN_RBAC_REGRESSION=1 to run the mocked RBAC browser regression.",
    );
  });

  test("changes owner team, shares with another team, and saves both scopes", async ({
    page,
  }) => {
    let currentAgent = { ...existingAgent };
    let updateBody: unknown = null;

    const handler: MockRouteHandler = async ({ route, path, method }) => {
      if (path === "/api/dynamic-agents" && method === "GET") {
        await fulfillJson(route, {
          success: true,
          data: {
            items: [currentAgent],
            total: 1,
            page: 1,
            page_size: 100,
            has_more: false,
          },
        });
        return true;
      }

      if (path === "/api/dynamic-agents" && method === "PUT") {
        updateBody = await postJson(route);
        currentAgent = {
          ...currentAgent,
          owner_team_slug:
            typeof updateBody === "object" &&
            updateBody !== null &&
            "owner_team_slug" in updateBody
              ? String(updateBody.owner_team_slug)
              : currentAgent.owner_team_slug,
        };
        await fulfillJson(route, { success: true, data: currentAgent });
        return true;
      }

      if (path === "/api/dynamic-agents/models" && method === "GET") {
        await fulfillJson(route, {
          success: true,
          data: [
            {
              model_id: "gpt-4o",
              name: "GPT-4o",
              provider: "openai",
              description: "Playwright model",
            },
          ],
        });
        return true;
      }

      if (path === "/api/dynamic-agents/teams" && method === "GET") {
        await fulfillJson(route, {
          success: true,
          data: [
            {
              _id: "team-platform",
              slug: "platform",
              name: "Platform",
              user_role: "admin",
              can_own_agents: true,
            },
            {
              _id: "team-data-eng",
              slug: "data-eng",
              name: "Data Eng",
              user_role: "admin",
              can_own_agents: true,
            },
            {
              _id: "team-security",
              slug: "security",
              name: "Security",
              user_role: "member",
              can_own_agents: false,
            },
          ],
        });
        return true;
      }

      if (path === "/api/review-configs/agent-system-prompt" && method === "GET") {
        await fulfillJson(route, {
          target: "agent-system-prompt",
          enabled: false,
          enforcement: "advisory",
          criteria: [],
        });
        return true;
      }

      return false;
    };

    await installMockedRbacApp(page, {
      isAdmin: true,
      handlers: [handler],
    });

    await page.goto("/dynamic-agents?tab=agents", { waitUntil: "domcontentloaded" });

    await page.getByText("Ownership Transfer Agent").click();
    await expect(
      page.getByText(/Edit Agent - Ownership Transfer Agent/i),
    ).toBeVisible();

    await expect(
      page.getByRole("button", { name: /Transfer ownership/i }),
    ).toHaveCount(0);
    await expect(page.getByLabel(/Owner Team/i)).toBeEnabled();
    await expect(
      page.getByText(/Changing this team transfers management when you save/i),
    ).toBeVisible();

    await page.getByLabel(/Owner Team/i).click();
    const ownerList = page.getByRole("listbox", { name: /Select a team that will own this agent/i });
    await ownerList.getByRole("option", { name: /Data Eng.*team:data-eng/i }).click();

    await page.getByRole("button", { name: /Pick one or more teams to share with/i }).click();
    await page.getByRole("option", { name: /Security.*team:security/i }).click();

    const updateRequest = page.waitForRequest((request) => {
      const url = new URL(request.url());
      return url.pathname === "/api/dynamic-agents" && request.method() === "PUT";
    });
    await page.getByRole("button", { name: /Save Changes/i }).click();
    await updateRequest;

    await expect.poll(() => updateBody).toMatchObject({
      owner_team_slug: "data-eng",
      confirm_not_member: false,
      shared_with_teams: ["security"],
    });
  });
});
