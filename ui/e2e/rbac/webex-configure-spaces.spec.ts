// assisted-by Codex Codex-sonnet-4-6
/**
 * Mocked Playwright coverage for Admin > Integrations > Webex > Configure spaces.
 *
 * The Configure spaces surface is intentionally a single workflow now. These
 * tests drive every admin option in that workflow: discovery cache settings,
 * Webex refresh, discovery search, pagination, select/clear, personal DM rows,
 * bulk team/agent apply, per-row overrides, and setup payload grouping.
 */

import { expect, test, type Page } from "@playwright/test";

import {
  fulfillJson,
  installMockedRbacApp,
  mockedRbacEnabled,
  postJson,
  type MockRouteHandler,
} from "./_mocked-rbac";

const adminSession = {
  email: "admin@caipe.local",
  name: "Platform Admin",
  role: "admin" as const,
  canViewAdmin: true,
};

const teams = [
  { _id: "team-platform", slug: "platform", name: "Platform Team" },
  { _id: "team-ops", slug: "ops", name: "Operations Team" },
];

const agents = [
  { _id: "agent-sre", name: "SRE Agent" },
  { _id: "agent-kb", name: "KB Agent" },
];

const webexBot = { id: "primary", name: "Primary bot", available: true };

type WebexSpace = {
  id: string;
  name: string;
  type?: "group" | "direct";
  is_locked?: boolean;
  available_bot_ids?: string[];
};

type WebexConfigureState = {
  ttl: number;
  platformConfigPatches: unknown[];
  discoveryRequests: URL[];
  onboardingRequests: unknown[];
  configuredSpaces: Array<{
    bot_id: string;
    workspace_id: string;
    space_id: string;
    space_name: string;
    team_slug?: string;
    primary_agent_id?: string;
    active_grants?: number;
    can_manage?: boolean;
  }>;
};

function pageOneSpaces(): WebexSpace[] {
  return [
    {
      id: "space-incidents",
      name: "Incident Bridge",
      type: "group",
      is_locked: false,
      available_bot_ids: [webexBot.id],
    },
    {
      id: "space-alerts",
      name: "Workflow Alerts",
      type: "group",
      is_locked: false,
      available_bot_ids: [webexBot.id],
    },
    {
      id: "direct-sri",
      name: "Sri Aradhyula",
      type: "direct",
      is_locked: false,
      available_bot_ids: [webexBot.id],
    },
  ];
}

function pageTwoSpaces(): WebexSpace[] {
  return [
    {
      id: "space-night-ops",
      name: "Night Ops",
      type: "group",
      is_locked: false,
      available_bot_ids: [webexBot.id],
    },
  ];
}

function defaultState(): WebexConfigureState {
  return {
    ttl: 45,
    platformConfigPatches: [],
    discoveryRequests: [],
    onboardingRequests: [],
    configuredSpaces: [
      {
        bot_id: webexBot.id,
        workspace_id: "WEBEX-WORKSPACE",
        space_id: "space-incidents",
        space_name: "Incident Bridge",
        team_slug: "platform",
        primary_agent_id: "agent-sre",
        active_grants: 1,
        can_manage: true,
      },
    ],
  };
}

function visibleSpacesForSearch(query: string): WebexSpace[] {
  const normalized = query.trim().toLowerCase();
  if (!normalized) return pageOneSpaces();
  return [...pageOneSpaces(), ...pageTwoSpaces()].filter((space) =>
    `${space.name} ${space.id}`.toLowerCase().includes(normalized),
  );
}

function webexConfigureHandler(state: WebexConfigureState): MockRouteHandler {
  return async ({ route, path, method, url }) => {
    if (path === "/api/admin/webex/bots" && method === "GET") {
      await fulfillJson(route, {
        success: true,
        data: { bots: [webexBot] },
      });
      return true;
    }

    if (path === "/api/admin/webex/spaces" && method === "GET") {
      await fulfillJson(route, {
        success: true,
        data: { spaces: state.configuredSpaces },
      });
      return true;
    }

    if (path === "/api/admin/platform-config" && method === "GET") {
      await fulfillJson(route, {
        success: true,
        data: {
          webex_discovery_cache_ttl_minutes: state.ttl,
          release_notes: { enabled: false },
        },
      });
      return true;
    }

    if (path === "/api/admin/platform-config" && method === "PATCH") {
      const body = await postJson(route);
      state.platformConfigPatches.push(body);
      const nextTtl = Number(
        (body as { webex_discovery_cache_ttl_minutes?: unknown } | null)
          ?.webex_discovery_cache_ttl_minutes,
      );
      if (Number.isFinite(nextTtl)) state.ttl = nextTtl;
      await fulfillJson(route, {
        success: true,
        data: { webex_discovery_cache_ttl_minutes: state.ttl },
      });
      return true;
    }

    if (path === "/api/admin/webex/available-spaces" && method === "GET") {
      state.discoveryRequests.push(url);
      if (url.searchParams.get("refresh") === "1") {
        await fulfillJson(route, {
          success: true,
          data: {
            spaces: pageOneSpaces().slice(0, 1),
            has_more: false,
            next_cursor: null,
            total_matches: 1,
          },
        });
        return true;
      }

      const query = url.searchParams.get("q") ?? "";
      const cursor = url.searchParams.get("cursor");
      if (query.trim()) {
        const spaces = visibleSpacesForSearch(query);
        await fulfillJson(route, {
          success: true,
          data: {
            spaces,
            has_more: false,
            next_cursor: null,
            total_matches: spaces.length,
          },
        });
        return true;
      }

      if (cursor === "page-2") {
        await fulfillJson(route, {
          success: true,
          data: {
            spaces: pageTwoSpaces(),
            has_more: false,
            next_cursor: null,
            total_matches: 4,
          },
        });
        return true;
      }

      await fulfillJson(route, {
        success: true,
        data: {
          spaces: pageOneSpaces(),
          has_more: true,
          next_cursor: "page-2",
          total_matches: 4,
        },
      });
      return true;
    }

    if (path === "/api/dynamic-agents" && method === "GET") {
      await fulfillJson(route, {
        success: true,
        data: {
          items: agents,
          total: agents.length,
          page: 1,
          page_size: 100,
          has_more: false,
        },
      });
      return true;
    }

    if (path === "/api/admin/webex/direct-users" && method === "GET") {
      await fulfillJson(route, {
        success: true,
        data: {
          users: [
            {
              keycloak_user_id: "user-1",
              email: "user@example.com",
              display_name: "Example User",
              linked: false,
              enabled: false,
              configured: false,
              inherited: false,
              state: "not_allowed",
              agent_id: "",
            },
          ],
          bot_id: webexBot.id,
          dm_access_mode: "allowlist",
          default_agent_id: null,
        },
      });
      return true;
    }

    if (path === "/api/dynamic-agents/teams" && method === "GET") {
      await fulfillJson(route, { success: true, data: teams });
      return true;
    }

    if (path === "/api/admin/webex/spaces/defaults" && method === "GET") {
      await fulfillJson(route, {
        success: true,
        data: { defaults: { team_slug: "", agent_id: "" } },
      });
      return true;
    }

    if (path === "/api/admin/webex/spaces/onboard" && method === "POST") {
      const body = await postJson(route);
      state.onboardingRequests.push(body);
      const request = body as {
        bot_id?: string;
        workspace_id?: string;
        space_id?: string;
        space_name?: string;
        team_slug?: string;
        agent_id?: string;
      } | null;
      if (request?.space_id) {
        state.configuredSpaces.push({
          bot_id: request.bot_id ?? webexBot.id,
          workspace_id: request.workspace_id || "WEBEX-WORKSPACE",
          space_id: request.space_id,
          space_name: request.space_name ?? request.space_id,
          team_slug: request?.team_slug,
          primary_agent_id: request?.agent_id,
          active_grants: 1,
          can_manage: true,
        });
      }
      await fulfillJson(route, {
        success: true,
        data: { pending_approval: false },
      });
      return true;
    }

    return false;
  };
}

async function installWebexConfigureApp(
  page: Page,
  state = defaultState(),
): Promise<WebexConfigureState> {
  await installMockedRbacApp(page, {
    isAdmin: true,
    session: adminSession,
    gates: { webex: true },
    handlers: [webexConfigureHandler(state)],
  });
  return state;
}

async function gotoConfigureSpaces(page: Page) {
  await page.goto("/admin/integrations/webex", {
    waitUntil: "domcontentloaded",
  });
  // Default landing tab is "Configured spaces" (matches Slack's tab order);
  // switch to "Configure spaces" for onboarding coverage.
  await page.getByRole("tab", { name: "Configure spaces" }).click();
  await expect(
    page.getByRole("region", { name: "Configure spaces" }),
  ).toBeVisible();
}

async function pickTeam(page: Page, buttonName: RegExp, optionName: RegExp) {
  await page.getByRole("combobox", { name: buttonName }).click();
  await page.getByRole("option", { name: optionName }).click();
}

async function pickAgent(page: Page, triggerName: RegExp, optionName: RegExp) {
  await page.getByRole("combobox", { name: triggerName }).click();
  await page.getByRole("option", { name: optionName }).click();
}

test.describe("mocked Webex Configure spaces UI", () => {
  test.beforeEach(() => {
    test.skip(
      !mockedRbacEnabled(),
      "Set RUN_RBAC_REGRESSION=1 to run mocked Webex Configure spaces coverage.",
    );
  });

  test("saves discovery cache TTL and force-refreshes Webex discovery", async ({
    page,
  }) => {
    const state = await installWebexConfigureApp(page);
    await gotoConfigureSpaces(page);

    await page.getByTestId("discovery-cache-controls-trigger-webex").click();
    const ttlInput = page.getByTestId("discovery-cache-ttl-input-webex");
    await expect(ttlInput).toHaveValue("45");

    await ttlInput.fill("30");
    await page.getByTestId("discovery-cache-ttl-save-webex").click();
    await expect(page.getByText("Saved", { exact: true })).toBeVisible();
    expect(state.platformConfigPatches).toContainEqual({
      webex_discovery_cache_ttl_minutes: 30,
    });

    await page.getByTestId("discovery-cache-refresh-webex").click();
    await expect(page.getByText("Refreshed")).toBeVisible();
    await expect
      .poll(() =>
        state.discoveryRequests.some(
          (request) => request.searchParams.get("refresh") === "1",
        ),
      )
      .toBe(true);
    await expect
      .poll(() =>
        state.discoveryRequests.some(
          (request) => request.searchParams.get("limit") === "200",
        ),
      )
      .toBe(true);
  });

  test("uses every Configure spaces option to discover, filter, select, bulk-apply, override, and set up spaces", async ({
    page,
  }) => {
    const state = await installWebexConfigureApp(page);
    await gotoConfigureSpaces(page);

    // Webex admin uses the single-panel switcher: two tabs ("Configure spaces"
    // ↔ "Configured spaces"), not the full three-view tab bar.
    // gotoConfigureSpaces already switched to Configure spaces above.
    const adminViews = page.getByRole("tablist", { name: "Webex admin views" });
    await expect(adminViews.getByRole("tab", { name: "Configure spaces" })).toBeVisible();
    await expect(adminViews.getByRole("tab", { name: "Configured spaces" })).toBeVisible();
    await expect(page.getByText("Incident Bridge")).toBeVisible();
    await expect(
      page.getByRole("status", { name: /Discovered: 1 .* Configured: 1/i }),
    ).toBeVisible();
    await expect(page.getByText(/^Discovered: 1$/)).toHaveCount(0);
    await expect(page.getByText(/^Configured: 1$/)).toHaveCount(0);

    const search = page.getByRole("searchbox", { name: "Search spaces" });
    await search.fill("Incident");
    await expect(page.getByText("Incident Bridge")).toBeVisible();
    await expect(page.getByText("No spaces match")).toHaveCount(0);
    await page.getByRole("button", { name: "Clear spaces search" }).click();

    await page.getByRole("button", { name: "Find spaces" }).click();
    await expect(page.getByText("Workflow Alerts")).toBeVisible();
    await expect(page.getByText("Sri Aradhyula")).toHaveCount(0);
    await expect(
      page.getByRole("status", {
        name: /Discovered: 2 .* Configured: 1 .* New: 1/i,
      }),
    ).toBeVisible();
    await expect(page.getByText(/^Discovered: 2$/)).toHaveCount(0);
    await expect(page.getByText(/^Configured: 1$/)).toHaveCount(0);
    await expect(page.getByText("New: 1", { exact: true })).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Load more spaces" }),
    ).toBeVisible();

    await search.fill("Alerts");
    await expect
      .poll(() =>
        state.discoveryRequests.some(
          (request) => request.searchParams.get("q") === "Alerts",
        ),
      )
      .toBe(true);
    await expect(page.getByText("Workflow Alerts")).toBeVisible();
    await expect(page.getByText("Incident Bridge")).toHaveCount(0);
    await expect(page.getByText("1 shown · 1 match")).toBeVisible();

    await page.getByRole("button", { name: "Clear spaces search" }).click();
    await expect(page.getByText("Incident Bridge")).toBeVisible();
    await page.getByRole("button", { name: "Load more spaces" }).click();
    await expect(page.getByText("Night Ops")).toBeVisible();
    await expect
      .poll(() =>
        state.discoveryRequests.some(
          (request) => request.searchParams.get("cursor") === "page-2",
        ),
      )
      .toBe(true);

    await page.getByRole("button", { name: "Clear selection" }).click();
    await expect(
      page.getByRole("checkbox", { name: "Import Workflow Alerts" }),
    ).not.toBeChecked();
    await expect(
      page.getByRole("button", { name: /^Submit 0 spaces$/ }),
    ).toBeDisabled();

    await pickAgent(
      page,
      /Dynamic Agent for Workflow Alerts/i,
      /SRE Agent.*agent:agent-sre/,
    );
    await expect(
      page.getByRole("checkbox", { name: "Import Workflow Alerts" }),
    ).toBeChecked();
    await expect(
      page.getByRole("button", { name: /^Submit 0 spaces$/ }),
    ).toBeDisabled();
    await pickTeam(
      page,
      /Team for Workflow Alerts/i,
      /Platform Team.*team:platform/,
    );
    await expect(
      page.getByRole("checkbox", { name: "Import Workflow Alerts" }),
    ).toBeChecked();
    await expect(
      page.getByRole("button", { name: /^Submit 1 space$/ }),
    ).toBeEnabled();

    await page.getByRole("button", { name: "Clear selection" }).click();
    await expect(
      page.getByRole("checkbox", { name: "Import Workflow Alerts" }),
    ).not.toBeChecked();

    await page.getByRole("button", { name: "Select all" }).click();
    await expect(
      page.getByRole("checkbox", { name: "Import Workflow Alerts" }),
    ).toBeChecked();
    await expect(
      page.getByRole("checkbox", { name: "Import Night Ops" }),
    ).toBeChecked();

    await page.getByRole("button", { name: "Clear selection" }).click();
    await page
      .getByRole("checkbox", { name: "Import Workflow Alerts" })
      .check();
    await page.getByRole("checkbox", { name: "Import Night Ops" }).check();

    await pickTeam(
      page,
      /Bulk team for selected rows/,
      /Platform Team.*team:platform/,
    );
    await pickAgent(
      page,
      /Bulk Dynamic Agent for selected rows/,
      /SRE Agent.*agent:agent-sre/,
    );
    await page
      .getByRole("button", { name: "Apply to 2 selected rows" })
      .click();

    await expect(
      page.getByRole("combobox", { name: /Team for Workflow Alerts/i }),
    ).toContainText("Platform Team");
    await expect(
      page.getByRole("combobox", { name: /Dynamic Agent for Workflow Alerts/i }),
    ).toContainText("SRE Agent");
    await expect(
      page.getByRole("combobox", { name: /Team for Night Ops/i }),
    ).toContainText("Platform Team");
    await expect(
      page.getByRole("combobox", { name: /Dynamic Agent for Night Ops/i }),
    ).toContainText("SRE Agent");

    await pickTeam(page, /Team for Night Ops/i, /Operations Team.*team:ops/);
    await pickAgent(
      page,
      /Dynamic Agent for Night Ops/i,
      /KB Agent.*agent:agent-kb/,
    );
    await expect(
      page.getByRole("combobox", { name: /Team for Night Ops/i }),
    ).toContainText("Operations Team");
    await expect(
      page.getByRole("combobox", { name: /Dynamic Agent for Night Ops/i }),
    ).toContainText("KB Agent");

    await page.getByRole("button", { name: /^Submit 2 spaces$/ }).click();
    await expect.poll(() => state.onboardingRequests.length).toBe(2);
    expect(state.onboardingRequests).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          bot_id: webexBot.id,
          space_id: "space-alerts",
          space_name: "Workflow Alerts",
          team_slug: "platform",
          agent_id: "agent-sre",
          listen: "mention",
          create_route: true,
        }),
        expect.objectContaining({
          bot_id: webexBot.id,
          space_id: "space-night-ops",
          space_name: "Night Ops",
          team_slug: "ops",
          agent_id: "agent-kb",
          listen: "mention",
          create_route: true,
        }),
      ]),
    );
    expect(JSON.stringify(state.onboardingRequests)).not.toContain("direct-sri");
  });

});
