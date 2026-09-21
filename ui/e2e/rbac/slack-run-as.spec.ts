// assisted-by Codex codex-gpt-5-5

import { expect, test } from "@playwright/test";

import {
  fulfillJson,
  installMockedRbacApp,
  mockedRbacEnabled,
  postJson,
  type MockRouteHandler,
} from "./_mocked-rbac";

const adminSession = {
  email: "sraradhy@cisco.com",
  name: "Sri Aradhyula",
  role: "admin" as const,
  canViewAdmin: true,
};

const genericTeamMemberSession = {
  email: "eti-sre-cicd.gen@cisco.com",
  name: "Generic User",
  role: "user" as const,
  canViewAdmin: true,
};

test.describe("mocked Slack Run as browser regression", () => {
  test.beforeEach(() => {
    test.skip(
      !mockedRbacEnabled(),
      "Set RUN_RBAC_REGRESSION=1 to run the mocked RBAC browser regression.",
    );
  });

  test("loads configured channel health through the batched list request", async ({ page }) => {
    const listRequests: string[] = [];

    const slackHandler: MockRouteHandler = async ({ route, path, method, url }) => {
      if (path === "/api/admin/slack/channels" && method === "GET") {
        listRequests.push(url.search);
        await fulfillJson(route, {
          data: {
            channels: [
              {
                workspace_id: "CAIPE",
                channel_id: "C0INCIDENTS",
                channel_name: "incidents",
                team_slug: "platform-engineering",
                primary_agent_id: "incident-agent",
                active_grants: 1,
                can_manage: true,
                health: {
                  warnings_count: 1,
                  openfga_reachable: true,
                  last_runtime_error_ts: "2026-06-25T18:00:00.000Z",
                },
              },
              {
                workspace_id: "CAIPE",
                channel_id: "C0SUPPORT",
                channel_name: "support",
                team_slug: "platform-engineering",
                primary_agent_id: "support-agent",
                active_grants: 1,
                can_manage: true,
                health: {
                  warnings_count: 0,
                  openfga_reachable: true,
                  last_runtime_error_ts: null,
                },
              },
            ],
          },
        });
        return true;
      }

      if (path === "/api/dynamic-agents" && method === "GET") {
        await fulfillJson(route, {
          data: {
            items: [
              { _id: "incident-agent", name: "Incident Agent" },
              { _id: "support-agent", name: "Support Agent" },
            ],
          },
        });
        return true;
      }

      if (path === "/api/admin/teams" && method === "GET") {
        await fulfillJson(route, {
          data: {
            teams: [
              { _id: "team-platform", slug: "platform-engineering", name: "Platform Engineering" },
            ],
          },
        });
        return true;
      }

      // ConnectorAdminPanel's team picker loads /api/dynamic-agents/teams
      // ({ success, data: TeamOption[] }), not /api/admin/teams.
      if (path === "/api/dynamic-agents/teams" && method === "GET") {
        await fulfillJson(route, {
          success: true,
          data: [
            { _id: "team-platform", slug: "platform-engineering", name: "Platform Engineering" },
          ],
        });
        return true;
      }

      if (path === "/api/admin/slack/runtime/status" && method === "GET") {
        await fulfillJson(route, {
          data: {
            route_mode: "db_prefer",
            static_config: { channels: 2, routes: 2 },
            route_cache: { ttl_seconds: 60, cache_size: 2 },
          },
        });
        return true;
      }

      return false;
    };

    await installMockedRbacApp(page, {
      isAdmin: true,
      session: adminSession,
      gates: { slack: true },
      handlers: [slackHandler],
    });

    await page.goto("/admin/integrations/slack", {
      waitUntil: "domcontentloaded",
    });

    await expect(page.getByRole("tab", { name: "Configured channels" })).toBeVisible();
    await expect(page.getByRole("button", { name: /#incidents/ })).toBeVisible();
    await expect(page.getByRole("button", { name: /#support/ })).toBeVisible();
    await expect(page.getByText("1 issue")).toBeVisible();
    await expect(page.getByText("healthy")).toBeVisible();
    expect(listRequests.length).toBeGreaterThan(0);
    expect(new Set(listRequests)).toEqual(new Set(["?health=1"]));
  });

  test("saves a Slack route that runs as a selected service account", async ({ page }) => {
    const routeWrites: unknown[] = [];
    let routes: unknown[] = [];

    const slackHandler: MockRouteHandler = async ({ route, path, method, url }) => {
      if (path === "/api/admin/platform-config") {
        await fulfillJson(route, { data: { release_notes: { enabled: false } } });
        return true;
      }

      if (path === "/api/admin/slack/channels" && method === "GET") {
        await fulfillJson(route, {
          data: {
            channels: [
              {
                workspace_id: "T123456789",
                channel_id: "C123456789",
                channel_name: "incidents",
                team_slug: "platform-engineering",
                active_grants: 1,
                can_manage: true,
              },
            ],
          },
        });
        return true;
      }

      if (path === "/api/dynamic-agents" && method === "GET") {
        await fulfillJson(route, {
          data: {
            items: [
              { _id: "incident-agent", name: "Incident Agent" },
              { _id: "support-agent", name: "Support Agent" },
            ],
          },
        });
        return true;
      }

      if (path === "/api/admin/teams" && method === "GET") {
        await fulfillJson(route, {
          data: {
            teams: [
              { _id: "team-1", slug: "platform-engineering", name: "Platform Engineering" },
            ],
          },
        });
        return true;
      }

      // ConnectorAdminPanel's team picker loads /api/dynamic-agents/teams
      // ({ success, data: TeamOption[] }), not /api/admin/teams.
      if (path === "/api/dynamic-agents/teams" && method === "GET") {
        await fulfillJson(route, {
          success: true,
          data: [
            { _id: "team-1", slug: "platform-engineering", name: "Platform Engineering" },
          ],
        });
        return true;
      }

      if (path === "/api/admin/slack/runtime/status" && method === "GET") {
        await fulfillJson(route, {
          data: {
            route_mode: "db_prefer",
            static_config: { channels: 1, routes: 0 },
            route_cache: { ttl_seconds: 60, cache_size: 0 },
          },
        });
        return true;
      }

      if (path === "/api/admin/slack/channels/T123456789/C123456789/routes") {
        if (method === "GET") {
          await fulfillJson(route, { data: { routes } });
          return true;
        }

        if (method === "PUT") {
          const body = (await postJson(route)) as { routes?: unknown[] } | null;
          routeWrites.push(body);
          routes = Array.isArray(body?.routes) ? body.routes : [];
          await fulfillJson(route, { data: { routes } });
          return true;
        }
      }

      if (path === "/api/admin/slack/channels/T123456789/C123456789/diagnostics") {
        await fulfillJson(route, {
          data: {
            openfga: { reachable: true, tuple_count: 1 },
            routes: [],
            warnings: [],
          },
        });
        return true;
      }

      if (path === "/api/admin/service-accounts" && method === "GET") {
        expect(url.searchParams.get("team")).toBe("platform-engineering");
        await fulfillJson(route, {
          success: true,
          data: {
            items: [
              { id: "sa-sub-slack-runner", name: "slack-runner", status: "active" },
              { id: "sa-sub-breakglass", name: "breakglass-bot", status: "active" },
            ],
          },
        });
        return true;
      }

      return false;
    };

    await installMockedRbacApp(page, {
      isAdmin: true,
      session: adminSession,
      gates: { slack: true },
      handlers: [slackHandler],
    });

    await page.goto("/admin/integrations/slack", {
      waitUntil: "domcontentloaded",
    });

    await expect(page.getByRole("tab", { name: "Configured channels" })).toBeVisible();
    await page.getByRole("button", { name: /#incidents/ }).click();
    await expect(page.getByRole("combobox", { name: "Team for #incidents" })).toContainText(
      "team:platform-engineering",
    );

    await page.getByRole("button", { name: "Add Agent" }).click();
    const dialog = page.getByRole("dialog", { name: /Add Agent to #incidents/ });
    await expect(dialog.getByText("Run as")).toBeVisible();
    await expect(dialog.getByLabel("Dynamic Agent")).toBeVisible();

    await dialog.getByLabel("Dynamic Agent").click();
    await page.getByRole("option", { name: /Incident Agent/ }).click();

    await dialog.getByLabel("Service Account").check();
    await expect(dialog.getByText(/No active service accounts found/)).not.toBeVisible();
    await dialog.getByRole("combobox", { name: "Service account" }).click();
    await page.getByRole("option", { name: "slack-runner" }).click();

    await dialog.getByRole("button", { name: "Add Agent" }).click();

    await expect.poll(() => routeWrites.length).toBe(1);
    expect(routeWrites[0]).toMatchObject({
      routes: [
        {
          agent_id: "incident-agent",
          execution_identity: {
            mode: "service_account",
            service_account_sub: "sa-sub-slack-runner",
            service_account_name: "slack-runner",
          },
        },
      ],
    });
    await expect(page.getByText("sa:slack-runner")).toBeVisible();
  });

  test("lets team-member non-admins manage team-shared Slack channel routing", async ({
    page,
  }) => {
    const routeWrites: unknown[] = [];
    let routes: unknown[] = [
      {
        agent_id: "jenkins-agent",
        enabled: true,
        priority: 100,
        users: { enabled: true, listen: "all" },
      },
    ];
    const nonAdminSession = {
      email: "generic-user@caipe.local",
      name: "Generic User",
      role: "user" as const,
      canViewAdmin: true,
    };

    const slackHandler: MockRouteHandler = async ({ route, path, method }) => {
      if (path === "/api/admin/slack/channels" && method === "GET") {
        await fulfillJson(route, {
          data: {
            channels: [
              {
                workspace_id: "CAIPE",
                channel_id: "C0B4QFN4Q21",
                channel_name: "grid-test-4",
                team_slug: "eti-sre-admin-jenkins",
                active_grants: 1,
                can_manage: true,
              },
            ],
          },
        });
        return true;
      }

      if (path === "/api/dynamic-agents" && method === "GET") {
        await fulfillJson(route, {
          data: {
            items: [
              { _id: "jenkins-agent", name: "Jenkins Agent" },
              { _id: "meriki-docs", name: "Meriki Docs" },
            ],
          },
        });
        return true;
      }

      if (path === "/api/admin/teams" && method === "GET") {
        await fulfillJson(route, {
          data: {
            teams: [
              { _id: "team-jenkins", slug: "eti-sre-admin-jenkins", name: "ETI SRE Admin Jenkins" },
            ],
          },
        });
        return true;
      }

      // ConnectorAdminPanel's team picker loads /api/dynamic-agents/teams
      // ({ success, data: TeamOption[] }), not /api/admin/teams.
      if (path === "/api/dynamic-agents/teams" && method === "GET") {
        await fulfillJson(route, {
          success: true,
          data: [
            { _id: "team-jenkins", slug: "eti-sre-admin-jenkins", name: "ETI SRE Admin Jenkins" },
          ],
        });
        return true;
      }

      if (path === "/api/admin/slack/channels/CAIPE/C0B4QFN4Q21/routes" && method === "GET") {
        await fulfillJson(route, {
          data: { routes },
        });
        return true;
      }

      if (path === "/api/admin/slack/channels/CAIPE/C0B4QFN4Q21/routes" && method === "PUT") {
        const body = (await postJson(route)) as { routes?: unknown[] } | null;
        routeWrites.push(body);
        routes = Array.isArray(body?.routes) ? body.routes : [];
        await fulfillJson(route, { data: { routes } });
        return true;
      }

      if (path === "/api/admin/slack/channels/CAIPE/C0B4QFN4Q21/diagnostics" && method === "GET") {
        await fulfillJson(route, {
          data: {
            openfga: { reachable: true, tuple_count: 3 },
            routes: [],
            warnings: [],
          },
        });
        return true;
      }

      return false;
    };

    await installMockedRbacApp(page, {
      isAdmin: false,
      session: nonAdminSession,
      gates: {
        settings: false,
        teams: false,
        users: false,
        metrics: false,
        health: false,
        slack: true,
      },
      handlers: [slackHandler],
    });

    await page.goto("/admin/integrations/slack", {
      waitUntil: "domcontentloaded",
    });

    // assisted-by Codex Codex-sonnet-4-6
    // A team-shared Slack channel should show the non-admin configured view and
    // allow route edits when the selected team grants channel manage.
    await expect(page.getByRole("button", { name: "Integrations" })).toHaveAttribute("data-active", "true");
    await expect(
      page
        .getByRole("navigation",{ name: "Admin sections" })
        .getByRole("link", { name: "Slack" }),
    ).toHaveAttribute("aria-current","page");
    await expect(page.getByText("Slack channels", { exact: true })).toBeVisible();
    await expect(
      page.getByText(
        "Manage existing Slack integrations or request onboarding for a channel your team uses.",
      ),
    ).toBeVisible();
    await expect(page.getByText("1 configured channels")).toBeVisible();
    await expect(page.getByText("#grid-test-4")).toBeVisible();
    await expect(page.getByText("team:eti-sre-admin-jenkins")).toBeVisible();
    await expect(page.getByRole("tab", { name: "Onboard channels" })).toBeVisible();
    await expect(page.getByRole("tab", { name: "Advanced" })).toHaveCount(0);
    await page.getByRole("button", { name: /#grid-test-4/ }).click();
    await expect(page.getByRole("button", { name: "Add Agent" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Add Agent" })).toBeEnabled();
    await expect(page.getByRole("button", { name: "Edit" })).toBeEnabled();
    await expect(page.getByRole("button", { name: "Delete agent:jenkins-agent" })).toBeEnabled();
    await page.getByRole("button", { name: "Edit" }).click();

    const dialog = page.getByRole("dialog", { name: /Edit agent:jenkins-agent/ });
    await expect(dialog).toBeVisible();
    await dialog.getByLabel("Dynamic Agent").click();
    await page.getByRole("option", { name: /Meriki Docs/ }).click();
    await dialog.getByRole("button", { name: "Update Agent" }).click();

    await expect.poll(() => routeWrites.length).toBe(1);
    expect(routeWrites[0]).toMatchObject({
      routes: [
        {
          agent_id: "meriki-docs",
          users: { enabled: true, listen: "all" },
        },
      ],
    });
  });

  test("keeps team-member Slack route controls locked when channel manage is denied", async ({
    page,
  }) => {
    const routeWrites: unknown[] = [];
    const nonAdminSession = {
      email: "generic-user@caipe.local",
      name: "Generic User",
      role: "user" as const,
      canViewAdmin: true,
    };

    const slackHandler: MockRouteHandler = async ({ route, path, method }) => {
      if (path === "/api/admin/slack/channels" && method === "GET") {
        await fulfillJson(route, {
          data: {
            channels: [
              {
                workspace_id: "CAIPE",
                channel_id: "C0LOCKED",
                channel_name: "locked-shared-channel",
                team_slug: "eti-sre-admin-jenkins",
                active_grants: 1,
                can_manage: false,
              },
            ],
          },
        });
        return true;
      }

      if (path === "/api/dynamic-agents" && method === "GET") {
        await fulfillJson(route, {
          data: {
            items: [
              { _id: "jenkins-agent", name: "Jenkins Agent" },
              { _id: "meriki-docs", name: "Meriki Docs" },
            ],
          },
        });
        return true;
      }

      if (path === "/api/admin/teams" && method === "GET") {
        await fulfillJson(route, {
          data: {
            teams: [
              { _id: "team-jenkins", slug: "eti-sre-admin-jenkins", name: "ETI SRE Admin Jenkins" },
            ],
          },
        });
        return true;
      }

      // ConnectorAdminPanel's team picker loads /api/dynamic-agents/teams
      // ({ success, data: TeamOption[] }), not /api/admin/teams.
      if (path === "/api/dynamic-agents/teams" && method === "GET") {
        await fulfillJson(route, {
          success: true,
          data: [
            { _id: "team-jenkins", slug: "eti-sre-admin-jenkins", name: "ETI SRE Admin Jenkins" },
          ],
        });
        return true;
      }

      if (path === "/api/admin/slack/channels/CAIPE/C0LOCKED/routes" && method === "GET") {
        await fulfillJson(route, {
          data: {
            routes: [
              {
                agent_id: "jenkins-agent",
                enabled: true,
                priority: 100,
                users: { enabled: true, listen: "all" },
              },
            ],
          },
        });
        return true;
      }

      if (path === "/api/admin/slack/channels/CAIPE/C0LOCKED/routes" && method === "PUT") {
        routeWrites.push(await postJson(route));
        await fulfillJson(route, { error: "forbidden" }, 403);
        return true;
      }

      if (path === "/api/admin/slack/channels/CAIPE/C0LOCKED/diagnostics" && method === "GET") {
        await fulfillJson(route, {
          data: {
            openfga: { reachable: true, tuple_count: 1 },
            routes: [],
            warnings: [],
          },
        });
        return true;
      }

      return false;
    };

    await installMockedRbacApp(page, {
      isAdmin: false,
      session: nonAdminSession,
      gates: {
        settings: false,
        teams: false,
        users: false,
        metrics: false,
        health: false,
        slack: true,
      },
      handlers: [slackHandler],
    });

    await page.goto("/admin/integrations/slack", {
      waitUntil: "domcontentloaded",
    });

    // assisted-by Codex Codex-sonnet-4-6
    // Visibility alone is not enough. If the channel row is returned without
    // can_manage, non-admin users may inspect it but cannot mutate routes.
    await expect(page.getByText("Slack channels", { exact: true })).toBeVisible();
    await expect(page.getByText("#locked-shared-channel")).toBeVisible();
    await page.getByRole("button", { name: /#locked-shared-channel/ }).click();

    await expect(page.getByRole("button", { name: "Add Agent" })).toBeDisabled();
    await expect(page.getByRole("button", { name: "Edit" })).toBeDisabled();
    await expect(page.getByRole("button", { name: "Delete agent:jenkins-agent" })).toBeDisabled();
    await expect(page.getByRole("button", { name: /Delete channel/ })).toBeDisabled();
    await expect.poll(() => routeWrites.length).toBe(0);
  });

  test("applies team-member manage per channel without leaking admin-only Slack surfaces", async ({
    page,
  }) => {
    const routeWrites: unknown[] = [];
    const routesByChannel: Record<string, unknown[]> = {
      C0EDITABLE: [
        {
          agent_id: "jenkins-agent",
          enabled: true,
          priority: 100,
          users: { enabled: true, listen: "all" },
        },
      ],
      C0USEONLY: [
        {
          agent_id: "read-only-agent",
          enabled: true,
          priority: 100,
          users: { enabled: true, listen: "mention" },
        },
      ],
    };

    const slackHandler: MockRouteHandler = async ({ route, path, method }) => {
      if (path === "/api/admin/slack/channels" && method === "GET") {
        await fulfillJson(route, {
          data: {
            channels: [
              {
                workspace_id: "CAIPE",
                channel_id: "C0EDITABLE",
                channel_name: "editable-channel",
                team_slug: "eti-sre-admin-jenkins",
                active_grants: 1,
                can_manage: true,
              },
              {
                workspace_id: "CAIPE",
                channel_id: "C0USEONLY",
                channel_name: "use-only-channel",
                team_slug: "eti-sre-admin-jenkins",
                active_grants: 1,
                can_manage: false,
              },
            ],
          },
        });
        return true;
      }

      if (path === "/api/dynamic-agents" && method === "GET") {
        await fulfillJson(route, {
          data: {
            items: [
              { _id: "jenkins-agent", name: "Jenkins Agent" },
              { _id: "read-only-agent", name: "Read Only Agent" },
              { _id: "meriki-docs", name: "Meriki Docs" },
            ],
          },
        });
        return true;
      }

      if (path === "/api/admin/teams" && method === "GET") {
        await fulfillJson(route, {
          data: {
            teams: [
              { _id: "team-jenkins", slug: "eti-sre-admin-jenkins", name: "ETI SRE Admin Jenkins" },
            ],
          },
        });
        return true;
      }

      // ConnectorAdminPanel's team picker loads /api/dynamic-agents/teams
      // ({ success, data: TeamOption[] }), not /api/admin/teams.
      if (path === "/api/dynamic-agents/teams" && method === "GET") {
        await fulfillJson(route, {
          success: true,
          data: [
            { _id: "team-jenkins", slug: "eti-sre-admin-jenkins", name: "ETI SRE Admin Jenkins" },
          ],
        });
        return true;
      }

      const routeMatch = path.match(/^\/api\/admin\/slack\/channels\/CAIPE\/([^/]+)\/routes$/);
      if (routeMatch) {
        const channelId = routeMatch[1];
        if (method === "GET") {
          await fulfillJson(route, { data: { routes: routesByChannel[channelId] ?? [] } });
          return true;
        }
        if (method === "PUT") {
          const body = (await postJson(route)) as { routes?: unknown[] } | null;
          routeWrites.push({ channelId, body });
          routesByChannel[channelId] = Array.isArray(body?.routes) ? body.routes : [];
          await fulfillJson(route, { data: { routes: routesByChannel[channelId] } });
          return true;
        }
      }

      if (path.match(/^\/api\/admin\/slack\/channels\/CAIPE\/[^/]+\/diagnostics$/)) {
        await fulfillJson(route, {
          data: {
            openfga: { reachable: true, tuple_count: 3 },
            routes: [],
            warnings: [],
          },
        });
        return true;
      }

      return false;
    };

    await installMockedRbacApp(page, {
      isAdmin: false,
      session: genericTeamMemberSession,
      gates: {
        settings: false,
        teams: false,
        users: false,
        metrics: false,
        health: false,
        slack: true,
      },
      handlers: [slackHandler],
    });

    await page.goto("/admin/integrations/slack", {
      waitUntil: "domcontentloaded",
    });

    // assisted-by Codex Codex-sonnet-4-6
    // The generic team member can request onboarding from the self-service view,
    // while platform-wide Advanced controls remain hidden. Existing-channel
    // editability is still decided per channel.
    await expect(page.getByText("Slack channels", { exact: true })).toBeVisible();
    await expect(page.getByRole("tab", { name: "Onboard channels" })).toBeVisible();
    await expect(page.getByRole("tab", { name: "Advanced" })).toHaveCount(0);
    await expect(page.getByText("Discover channels")).toHaveCount(0);
    await expect(page.getByText("#editable-channel")).toBeVisible();
    await expect(page.getByText("#use-only-channel")).toBeVisible();

    await page.getByRole("button", { name: /#editable-channel/ }).click();
    await expect(page.getByRole("button", { name: "Add Agent" })).toBeEnabled();
    await expect(page.getByRole("button", { name: "Edit agent:jenkins-agent" })).toBeEnabled();
    await expect(page.getByRole("button", { name: "Delete agent:jenkins-agent" })).toBeEnabled();

    await page.getByRole("button", { name: "Edit agent:jenkins-agent" }).click();
    const dialog = page.getByRole("dialog", { name: /Edit agent:jenkins-agent/ });
    await dialog.getByLabel("Dynamic Agent").click();
    await page.getByRole("option", { name: /Meriki Docs/ }).click();
    await dialog.getByRole("button", { name: "Update Agent" }).click();
    await expect.poll(() => routeWrites.length).toBe(1);
    expect(routeWrites[0]).toMatchObject({
      channelId: "C0EDITABLE",
      body: {
        routes: [
          {
            agent_id: "meriki-docs",
          },
        ],
      },
    });

    await page.getByRole("button", { name: /#use-only-channel/ }).click();
    await expect(page.getByRole("button", { name: "Add Agent" })).toBeDisabled();
    await expect(page.getByRole("button", { name: "Edit agent:read-only-agent" })).toBeDisabled();
    await expect(page.getByRole("button", { name: "Delete agent:read-only-agent" })).toBeDisabled();
    await expect.poll(() => routeWrites.length).toBe(1);
  });

  test("shows no Slack channel controls to non-admins when no shared integrations are returned", async ({
    page,
  }) => {
    const slackHandler: MockRouteHandler = async ({ route, path, method }) => {
      if (path === "/api/admin/slack/channels" && method === "GET") {
        await fulfillJson(route, { data: { channels: [] } });
        return true;
      }

      if (path === "/api/dynamic-agents" && method === "GET") {
        await fulfillJson(route, { data: { items: [{ _id: "hidden-agent", name: "Hidden Agent" }] } });
        return true;
      }

      return false;
    };

    await installMockedRbacApp(page, {
      isAdmin: false,
      session: genericTeamMemberSession,
      gates: {
        settings: false,
        teams: false,
        users: false,
        metrics: false,
        health: false,
        slack: true,
      },
      handlers: [slackHandler],
    });

    await page.goto("/admin/integrations/slack", {
      waitUntil: "domcontentloaded",
    });

    await expect(page.getByText("Slack channels", { exact: true })).toBeVisible();
    await expect(page.getByText("#hidden-channel")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Add Agent" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: /Edit agent:/ })).toHaveCount(0);
    await expect(page.getByRole("button", { name: /Delete channel/ })).toHaveCount(0);
  });

  test("lets platform admins manage Slack channels even when row-level team manage is absent", async ({
    page,
  }) => {
    const routeWrites: unknown[] = [];
    let routes: unknown[] = [
      {
        agent_id: "locked-agent",
        enabled: true,
        priority: 100,
        users: { enabled: true, listen: "all" },
      },
    ];

    const slackHandler: MockRouteHandler = async ({ route, path, method }) => {
      if (path === "/api/admin/slack/channels" && method === "GET") {
        await fulfillJson(route, {
          data: {
            channels: [
              {
                workspace_id: "CAIPE",
                channel_id: "C0ADMIN",
                channel_name: "admin-overrides-channel",
                team_slug: "eti-sre-admin-jenkins",
                active_grants: 1,
                can_manage: false,
              },
            ],
          },
        });
        return true;
      }

      if (path === "/api/dynamic-agents" && method === "GET") {
        await fulfillJson(route, {
          data: {
            items: [
              { _id: "locked-agent", name: "Locked Agent" },
              { _id: "meriki-docs", name: "Meriki Docs" },
            ],
          },
        });
        return true;
      }

      if (path === "/api/admin/teams" && method === "GET") {
        await fulfillJson(route, {
          data: {
            teams: [
              { _id: "team-jenkins", slug: "eti-sre-admin-jenkins", name: "ETI SRE Admin Jenkins" },
            ],
          },
        });
        return true;
      }

      // ConnectorAdminPanel's team picker loads /api/dynamic-agents/teams
      // ({ success, data: TeamOption[] }), not /api/admin/teams.
      if (path === "/api/dynamic-agents/teams" && method === "GET") {
        await fulfillJson(route, {
          success: true,
          data: [
            { _id: "team-jenkins", slug: "eti-sre-admin-jenkins", name: "ETI SRE Admin Jenkins" },
          ],
        });
        return true;
      }

      if (path === "/api/admin/slack/runtime/status" && method === "GET") {
        await fulfillJson(route, {
          data: {
            route_mode: "db_prefer",
            static_config: { channels: 1, routes: 1 },
            route_cache: { ttl_seconds: 60, cache_size: 1 },
          },
        });
        return true;
      }

      if (path === "/api/admin/slack/channels/CAIPE/C0ADMIN/routes") {
        if (method === "GET") {
          await fulfillJson(route, { data: { routes } });
          return true;
        }
        if (method === "PUT") {
          const body = (await postJson(route)) as { routes?: unknown[] } | null;
          routeWrites.push(body);
          routes = Array.isArray(body?.routes) ? body.routes : [];
          await fulfillJson(route, { data: { routes } });
          return true;
        }
      }

      if (path === "/api/admin/slack/channels/CAIPE/C0ADMIN/diagnostics" && method === "GET") {
        await fulfillJson(route, {
          data: {
            openfga: { reachable: true, tuple_count: 1 },
            routes: [],
            warnings: [],
          },
        });
        return true;
      }

      return false;
    };

    await installMockedRbacApp(page, {
      isAdmin: true,
      session: adminSession,
      gates: { slack: true },
      handlers: [slackHandler],
    });

    await page.goto("/admin/integrations/slack", {
      waitUntil: "domcontentloaded",
    });

    await expect(page.getByRole("tab", { name: "Configured channels" })).toBeVisible();
    await expect(page.getByRole("tab", { name: "Onboard channels" })).toBeVisible();
    await expect(page.getByRole("tab", { name: "Advanced" })).toBeVisible();
    await page.getByRole("button", { name: /#admin-overrides-channel/ }).click();
    await expect(page.getByRole("combobox", { name: "Team for #admin-overrides-channel" })).toBeEnabled();
    await expect(page.getByRole("button", { name: "Add Agent" })).toBeEnabled();
    await expect(page.getByRole("button", { name: "Edit agent:locked-agent" })).toBeEnabled();

    await page.getByRole("button", { name: "Edit agent:locked-agent" }).click();
    const dialog = page.getByRole("dialog", { name: /Edit agent:locked-agent/ });
    await dialog.getByLabel("Dynamic Agent").click();
    await page.getByRole("option", { name: /Meriki Docs/ }).click();
    await dialog.getByRole("button", { name: "Update Agent" }).click();

    await expect.poll(() => routeWrites.length).toBe(1);
    expect(routeWrites[0]).toMatchObject({
      routes: [
        {
          agent_id: "meriki-docs",
        },
      ],
    });
  });

  test("surfaces backend authorization denial even if a stale row says can_manage", async ({
    page,
  }) => {
    const routeWrites: unknown[] = [];

    const slackHandler: MockRouteHandler = async ({ route, path, method }) => {
      if (path === "/api/admin/slack/channels" && method === "GET") {
        await fulfillJson(route, {
          data: {
            channels: [
              {
                workspace_id: "CAIPE",
                channel_id: "C0STALE",
                channel_name: "stale-manage-channel",
                team_slug: "eti-sre-admin-jenkins",
                active_grants: 1,
                can_manage: true,
              },
            ],
          },
        });
        return true;
      }

      if (path === "/api/dynamic-agents" && method === "GET") {
        await fulfillJson(route, {
          data: {
            items: [
              { _id: "jenkins-agent", name: "Jenkins Agent" },
              { _id: "meriki-docs", name: "Meriki Docs" },
            ],
          },
        });
        return true;
      }

      if (path === "/api/admin/slack/channels/CAIPE/C0STALE/routes") {
        if (method === "GET") {
          await fulfillJson(route, {
            data: {
              routes: [
                {
                  agent_id: "jenkins-agent",
                  enabled: true,
                  priority: 100,
                  users: { enabled: true, listen: "all" },
                },
              ],
            },
          });
          return true;
        }

        if (method === "PUT") {
          routeWrites.push(await postJson(route));
          await fulfillJson(route, { error: "channel manage denied by policy" }, 403);
          return true;
        }
      }

      if (path === "/api/admin/slack/channels/CAIPE/C0STALE/diagnostics" && method === "GET") {
        await fulfillJson(route, {
          data: {
            openfga: { reachable: true, tuple_count: 3 },
            routes: [],
            warnings: [],
          },
        });
        return true;
      }

      return false;
    };

    await installMockedRbacApp(page, {
      isAdmin: false,
      session: genericTeamMemberSession,
      gates: {
        settings: false,
        teams: false,
        users: false,
        metrics: false,
        health: false,
        slack: true,
      },
      handlers: [slackHandler],
    });

    await page.goto("/admin/integrations/slack", {
      waitUntil: "domcontentloaded",
    });

    await page.getByRole("button", { name: /#stale-manage-channel/ }).click();
    await expect(page.getByRole("button", { name: "Edit agent:jenkins-agent" })).toBeEnabled();
    await page.getByRole("button", { name: "Edit agent:jenkins-agent" }).click();
    const dialog = page.getByRole("dialog", { name: /Edit agent:jenkins-agent/ });
    await dialog.getByLabel("Dynamic Agent").click();
    await page.getByRole("option", { name: /Meriki Docs/ }).click();
    await dialog.getByRole("button", { name: "Update Agent" }).click();

    await expect.poll(() => routeWrites.length).toBe(1);
    await expect(page.getByText(/channel manage denied by policy/)).toBeVisible();
  });
});
