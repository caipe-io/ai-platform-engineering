// assisted-by Codex Codex-sonnet-4-6

import { expect, test, type Page } from "@playwright/test";

import {
  fulfillJson,
  installMockedRbacApp,
  mockedRbacEnabled,
  type MockRouteHandler,
} from "./_mocked-rbac";

const adminSession = {
  email: "sraradhy@cisco.com",
  name: "Sri Aradhyula",
  role: "admin" as const,
  canViewAdmin: true,
};

// The `running` run a manual trigger records. Served from both `/status`
// (summary cards + poller) and `/runs` (the paginated Sync History table) so
// the mock mirrors the real backend, where the freshly-triggered run is the
// newest row and lands on page 1 of history.
const runningRun = {
  id: "run-okta-manual",
  provider_id: "okta",
  status: "running",
  started_at: "2026-06-17T00:01:00.000Z",
  triggered_by: "manual",
  triggered_by_user: adminSession.email,
  group_filter: "",
  groups_fetched: 2,
  membership_sources_added: 0,
  membership_sources_removed: 0,
  progress_scanned: 1,
  progress_total: 2,
};

function identitySyncStatus(runs: unknown[] = []) {
  return {
    success: true,
    data: {
      provider: "okta",
      connectors: [{ id: "okta", label: "Okta", implemented: true }],
      provider_configured: true,
      health: { ok: true, mode: "api_token" },
      settings: {
        provider_id: "okta",
        enabled: true,
        schedule_mode: "interval",
        sync_interval_minutes: 60,
        sync_cron: "",
        group_filter: "",
        updated_at: "2026-06-17T00:00:00.000Z",
        updated_by: "playwright",
      },
      recent_runs: runs,
    },
  };
}

async function installIdentitySyncMock(page: Page) {
  const requests: Array<{ method: string; path: string; search: string }> = [];
  let statusCalls = 0;
  let triggered = false;

  const handler: MockRouteHandler = async ({ route, path, method, url }) => {
    if (!path.startsWith("/api/admin/identity-group-sync/directory-sync")) {
      return false;
    }

    requests.push({ method, path, search: url.search });

    if (path.endsWith("/status") && method === "GET") {
      statusCalls += 1;
      await fulfillJson(route, identitySyncStatus(triggered ? [runningRun] : []));
      return true;
    }

    // Paginated Sync History. The table renders from here (not `/status`), so
    // the triggered `running` run shows up on page 1 just like in production.
    if (path.endsWith("/runs") && method === "GET") {
      const runs = triggered ? [runningRun] : [];
      await fulfillJson(route, {
        success: true,
        data: {
          provider: "okta",
          runs,
          total: runs.length,
          page: 1,
          page_size: 10,
          has_more: false,
        },
      });
      return true;
    }

    if (path.endsWith("/trigger") && method === "POST") {
      triggered = true;
      await fulfillJson(route, { success: true, data: { run_id: "run-okta-manual" } });
      return true;
    }

    if (path.endsWith("/settings") && method === "PUT") {
      await fulfillJson(route, { success: true });
      return true;
    }

    return false;
  };

  await installMockedRbacApp(page, {
    isAdmin: true,
    session: adminSession,
    gates: { identity_group_sync: true },
    handlers: [handler],
  });

  return {
    requests,
    statusCalls: () => statusCalls,
  };
}

async function enableIdentitySyncTab(page: Page) {
  await page.addInitScript(() => {
    let appConfig: Record<string, unknown> | undefined;

    Object.defineProperty(window, "__APP_CONFIG__", {
      configurable: true,
      get() {
        return appConfig;
      },
      set(value) {
        appConfig = {
          ...(value as Record<string, unknown>),
          oktaSyncEnabled: true,
        };
      },
    });
  });
}

test.describe("mocked identity sync browser regression", () => {
  test.beforeEach(() => {
    test.skip(
      !mockedRbacEnabled(),
      "Set RUN_RBAC_REGRESSION=1 to run the mocked RBAC browser regression.",
    );
  });

  test("opens Identity Sync and triggers Okta sync through the admin surface", async ({ page }) => {
    await enableIdentitySyncTab(page);
    const mock = await installIdentitySyncMock(page);

    await page.goto("/admin/people/identity-sync", {
      waitUntil: "domcontentloaded",
    });

    await expect(page.getByRole("button", { name: "Teams & Users" })).toHaveAttribute("data-active", "true");
    await expect(
      page
        .getByRole("navigation",{ name: "Admin sections" })
        .getByRole("link", { name: "Identity Sync" }),
    ).toHaveAttribute(
      "aria-current",
      "page",
    );
    await expect(page.getByText("Okta Connector Status")).toBeVisible();
    await expect(page.getByText("Configured")).toBeVisible();
    await expect(page.getByText("Every hour").first()).toBeVisible();

    await page.getByRole("button", { name: "Run sync now" }).click();

    await expect(page.getByText("Running").first()).toBeVisible();
    await expect(page.getByText("Scanning members (1/2)")).toBeVisible();
    await expect
      .poll(() =>
        mock.requests.some(
          (request) =>
            request.method === "POST" &&
            request.path === "/api/admin/identity-group-sync/directory-sync/trigger" &&
            request.search === "?provider=okta",
        ),
      )
      .toBe(true);
    await expect.poll(() => mock.statusCalls()).toBeGreaterThanOrEqual(2);
  });
});
