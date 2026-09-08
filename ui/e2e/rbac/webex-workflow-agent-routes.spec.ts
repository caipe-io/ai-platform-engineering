import { expect, test } from "@playwright/test";

import {
  fulfillJson,
  installMockedRbacApp,
  mockedRbacEnabled,
  postJson,
  type MockRouteHandler,
} from "./_mocked-rbac";
import { buildMcpWorkflowAgentFixture } from "./_workflow-browser-fixtures";

const adminSession = {
  email: "admin@caipe.local",
  name: "Platform Admin",
  role: "admin" as const,
  canViewAdmin: true,
};

const teamMemberSession = {
  email: "member@caipe.local",
  name: "Team Member",
  role: "user" as const,
  canViewAdmin: true,
};

const workflowAgent = buildMcpWorkflowAgentFixture();
const webexBot = { id: "primary", name: "Primary bot", available: true };

function webexHandler(state: {
  routeWrites: unknown[];
  onboardingRequests: unknown[];
  routes: unknown[];
}): MockRouteHandler {
  return async ({ route, path, method }) => {
    if (path === "/api/admin/webex/bots" && method === "GET") {
      await fulfillJson(route, { data: { bots: [webexBot] } });
      return true;
    }

    if (
      path === "/api/admin/webex/spaces" ||
      path === "/api/admin/webex/spaces?health=1"
    ) {
      await fulfillJson(route, {
        data: {
          spaces: [
            {
              bot_id: webexBot.id,
              workspace_id: "WEBEX-WORKSPACE",
              space_id: "space-incidents",
              space_name: "Incident Bridge",
              team_slug: "platform",
              active_grants: 1,
              can_manage: true,
            },
          ],
        },
      });
      return true;
    }

    if (
      path.startsWith("/api/admin/webex/available-spaces") &&
      method === "GET"
    ) {
      await fulfillJson(route, {
        data: {
          spaces: [
            {
              id: "space-incidents",
              name: "Incident Bridge",
              type: "group",
              is_locked: false,
              available_bot_ids: [webexBot.id],
            },
            {
              id: "space-onboard-new",
              name: "Workflow Alerts",
              type: "group",
              is_locked: false,
              available_bot_ids: [webexBot.id],
            },
          ],
          has_more: false,
          next_cursor: null,
        },
      });
      return true;
    }

    if (
      path === "/api/dynamic-agents?enabled_only=true" ||
      path === "/api/dynamic-agents"
    ) {
      await fulfillJson(route, {
        data: {
          items: [
            { _id: workflowAgent.id, name: workflowAgent.name },
            { _id: "support-agent", name: "Support Agent" },
          ],
        },
      });
      return true;
    }

    if (path === "/api/dynamic-agents/teams" && method === "GET") {
      await fulfillJson(route, {
        success: true,
        data: [
          { _id: "team-platform", slug: "platform", name: "Platform Team" },
        ],
      });
      return true;
    }

    if (path === "/api/admin/webex/spaces/defaults" && method === "GET") {
      await fulfillJson(route, {
        data: {
          defaults: {
            team_slug: "platform",
            agent_id: workflowAgent.id,
          },
        },
      });
      return true;
    }

    if (path === "/api/admin/webex/spaces/onboard" && method === "POST") {
      state.onboardingRequests.push(await postJson(route));
      await fulfillJson(route, {
        success: true,
        data: { pending_approval: false },
      });
      return true;
    }

    if (path === "/api/admin/webex/runtime/status" && method === "GET") {
      await fulfillJson(route, {
        data: {
          route_mode: "db_prefer",
          static_config: { spaces: 1, routes: 1 },
          route_cache: { ttl_seconds: 60, cache_size: 1 },
          thread_context: { enabled: true, max_messages: 10, max_chars: 4000 },
        },
      });
      return true;
    }

    if (
      path ===
        "/api/admin/webex/spaces/WEBEX-WORKSPACE/space-incidents/routes" &&
      method === "GET"
    ) {
      await fulfillJson(route, { data: { routes: state.routes } });
      return true;
    }

    if (
      path ===
        "/api/admin/webex/spaces/WEBEX-WORKSPACE/space-incidents/routes" &&
      method === "PUT"
    ) {
      const body = await postJson(route);
      state.routeWrites.push(body);
      state.routes = Array.isArray(
        (body as { routes?: unknown[] } | null)?.routes,
      )
        ? ((body as { routes: unknown[] }).routes ?? [])
        : [];
      await fulfillJson(route, { data: { routes: state.routes } });
      return true;
    }

    if (
      path ===
        "/api/admin/webex/spaces/WEBEX-WORKSPACE/space-incidents/diagnostics" &&
      method === "GET"
    ) {
      await fulfillJson(route, {
        data: {
          openfga: { reachable: true, tuple_count: 1 },
          warnings: [],
          routes: [
            {
              agent_id: workflowAgent.id,
              openfga_tuple: true,
              route_metadata: true,
              listen: "mention",
              runtime_matches: { mention: true, message: false },
              warnings: ["Mention-only listen mode blocks plain messages"],
            },
          ],
        },
      });
      return true;
    }

    return false;
  };
}

test.describe("mocked Webex workflow agent routing regression", () => {
  test.beforeEach(() => {
    test.skip(
      !mockedRbacEnabled(),
      "Set RUN_RBAC_REGRESSION=1 to run the mocked Webex workflow routing regression.",
    );
  });

  test("onboards a Webex space to the same MCP-backed agent used in workflows", async ({
    page,
  }) => {
    const onboardingRequests: unknown[] = [];
    const routeWrites: unknown[] = [];
    const routes: unknown[] = [];

    await installMockedRbacApp(page, {
      isAdmin: true,
      session: adminSession,
      gates: { webex: true },
      handlers: [webexHandler({ routeWrites, onboardingRequests, routes })],
    });

    await page.goto("/admin/integrations/webex", {
      waitUntil: "domcontentloaded",
    });
    // Default landing tab is "Configured spaces"; switch to "Configure
    // spaces" for onboarding.
    await page.getByRole("tab", { name: "Configure spaces" }).click();
    await expect(
      page.getByRole("region", { name: "Configure spaces" }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Find spaces" }).click();

    await expect(
      page.getByRole("status", { name: /Discovered: 2/i }),
    ).toBeVisible();
    await expect(
      page.getByRole("checkbox", { name: /Import Incident Bridge/i }),
    ).toBeDisabled();
    await expect(
      page.getByRole("checkbox", { name: /Import Workflow Alerts/i }),
    ).toBeChecked();
    await page
      .getByRole("combobox", { name: "Bulk team for selected rows" })
      .click();
    await page
      .getByRole("option", { name: /Platform Team.*team:platform/i })
      .click();
    await page
      .getByRole("combobox", { name: "Bulk Dynamic Agent for selected rows" })
      .click();
    await page
      .getByRole("option", { name: new RegExp(workflowAgent.name, "i") })
      .click();
    await page
      .getByRole("button", { name: /^Apply to 1 selected row$/i })
      .click();

    await expect(
      page.getByRole("checkbox", { name: /Import Workflow Alerts/i }),
    ).toBeChecked();
    await expect(
      page.getByRole("combobox", { name: /Team for Workflow Alerts/i }),
    ).toContainText("Platform Team");
    await expect(
      page.getByRole("combobox", { name: /Dynamic Agent for Workflow Alerts/i }),
    ).toContainText(workflowAgent.name);
    await page.getByRole("button", { name: /^Submit 1 space$/ }).click();

    await expect.poll(() => onboardingRequests.length).toBe(1);
    expect(onboardingRequests[0]).toMatchObject({
      bot_id: webexBot.id,
      space_id: "space-onboard-new",
      space_name: "Workflow Alerts",
      team_slug: "platform",
      agent_id: workflowAgent.id,
      listen: "mention",
      create_route: true,
    });
  });

  test("lets a non-org-admin team member manage Webex routing for a team-shared space", async ({
    page,
  }) => {
    const routeWrites: unknown[] = [];
    const routes: unknown[] = [
      {
        agent_id: workflowAgent.id,
        enabled: true,
        priority: 100,
        users: { enabled: true, listen: "all" },
      },
    ];

    await installMockedRbacApp(page, {
      isAdmin: false,
      session: teamMemberSession,
      gates: {
        webex: true,
        settings: false,
        teams: false,
        users: false,
        metrics: false,
        health: false,
      },
      handlers: [webexHandler({ routeWrites, onboardingRequests: [], routes })],
    });

    await page.goto("/admin/integrations/webex", {
      waitUntil: "domcontentloaded",
    });
    await expect(page.getByText("Webex spaces", { exact: true })).toBeVisible();
    await expect(
      page.getByText(
        "Manage existing Webex integrations or request onboarding for a space your team uses.",
      ),
    ).toBeVisible();
    await page.getByText("Incident Bridge").click();
    await expect(
      page.getByText(`agent:${workflowAgent.id}`, { exact: true }),
    ).toBeVisible();
    await expect(page.getByRole("tab", { name: "Onboard spaces" })).toHaveCount(
      0,
    );
    await expect(page.getByRole("tab", { name: "Advanced" })).toHaveCount(0);
  });
});
