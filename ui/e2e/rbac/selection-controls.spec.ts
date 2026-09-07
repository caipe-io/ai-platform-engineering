import { expect, test } from "@playwright/test";

import {
  fulfillJson,
  installMockedRbacApp,
  mockedRbacEnabled,
  type MockRouteHandler,
} from "./_mocked-rbac";

const adminSession = {
  email: "admin@example.com",
  name: "Example Admin",
  role: "admin" as const,
  canViewAdmin: true,
};

const agents = Array.from({ length: 24 }, (_, index) => ({
  _id: `agent-${String(index).padStart(2, "0")}`,
  name: `Agent ${String(index).padStart(2, "0")}`,
}));

function selectionControlHandler(): MockRouteHandler {
  return async ({ route, path, method }) => {
    if (path === "/api/admin/platform-config") {
      await fulfillJson(route, { data: { release_notes: { enabled: false } } });
      return true;
    }

    if (path === "/api/admin/slack/channels" && method === "GET") {
      await fulfillJson(route, {
        data: {
          channels: [
            {
              workspace_id: "workspace-primary",
              channel_id: "channel-primary",
              channel_name: "example-channel",
              team_slug: "primary",
              active_grants: 1,
              can_manage: true,
            },
          ],
        },
      });
      return true;
    }

    if (path === "/api/dynamic-agents" && method === "GET") {
      await fulfillJson(route, { data: { items: agents } });
      return true;
    }

    if (path === "/api/admin/teams" && method === "GET") {
      await fulfillJson(route, {
        data: {
          teams: [{ _id: "team-primary", slug: "primary", name: "Primary Team" }],
        },
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

    if (
      path ===
        "/api/admin/slack/channels/workspace-primary/channel-primary/routes" &&
      method === "GET"
    ) {
      await fulfillJson(route, { data: { routes: [] } });
      return true;
    }

    if (
      path ===
      "/api/admin/slack/channels/workspace-primary/channel-primary/diagnostics"
    ) {
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
}

test.describe("shared selection controls browser contract", () => {
  test.beforeEach(() => {
    test.skip(
      !mockedRbacEnabled(),
      "Set RUN_RBAC_REGRESSION=1 to run the selection-control regression.",
    );
  });

  test("searchable picker remains interactive when portalled inside a dialog", async ({
    page,
  }) => {
    await installMockedRbacApp(page, {
      isAdmin: true,
      session: adminSession,
      gates: { slack: true },
      handlers: [selectionControlHandler()],
    });

    await page.goto("/admin/integrations/slack", {
      waitUntil: "domcontentloaded",
    });
    await expect(
      page.getByRole("tab", { name: "Configured channels" }),
    ).toBeVisible();
    await page.getByRole("button", { name: /#example-channel/ }).click();
    await page.getByRole("button", { name: "Add Agent" }).click();

    const dialog = page.getByRole("dialog", {
      name: /Add Agent to #example-channel/,
    });
    const trigger = dialog.getByRole("combobox", { name: "Dynamic Agent" });
    await trigger.click();

    const popover = dialog.locator("[data-popover-content]");
    await expect(popover).toBeVisible();
    const search = popover.getByRole("searchbox", { name: "Search agents..." });
    const listbox = popover.getByRole("listbox", { name: "Dynamic Agent" });
    await expect(search).toBeFocused();
    await expect(listbox.getByRole("option")).toHaveCount(agents.length);

    await search.fill("Agent 17");
    await expect(listbox.getByRole("option")).toHaveCount(1);
    await expect(
      listbox.getByRole("option", { name: /Agent 17.*agent:agent-17/ }),
    ).toBeVisible();
    await listbox
      .getByRole("option", { name: /Agent 17.*agent:agent-17/ })
      .click();

    await expect(popover).toBeHidden();
    await expect(trigger).toBeFocused();
    await expect(trigger).toContainText("Agent 17");

    await trigger.click();
    await expect(listbox.getByRole("option")).toHaveCount(agents.length);
    const overflows = await listbox.evaluate(
      (element) => element.scrollHeight > element.clientHeight + 1,
    );
    expect(overflows).toBe(true);

    const lastOption = listbox.getByRole("option", {
      name: /Agent 23.*agent:agent-23/,
    });
    await listbox.evaluate((element) => {
      element.scrollTop = element.scrollHeight;
    });
    await expect(lastOption).toBeVisible();

    await search.press("Escape");
    await expect(popover).toBeHidden();
    await expect(trigger).toBeFocused();
  });
});
