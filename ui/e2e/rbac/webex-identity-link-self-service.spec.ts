import { expect, test, type Page } from "@playwright/test";

import {
  fulfillJson,
  installMockedRbacApp,
  mockedRbacEnabled,
  type MockRouteHandler,
} from "./_mocked-rbac";

const USER_SESSION = {
  email: "person-1@example.com",
  name: "Person One",
  role: "user" as const,
  canViewAdmin: false,
};

function myRolesBody(overrides: { webex_link_available?: boolean; webex_linked?: boolean } = {}) {
  return {
    email: USER_SESSION.email,
    idp_source: "playwright",
    name: USER_SESSION.name,
    per_agent_roles: [],
    per_kb_roles: [],
    realm_roles: ["user"],
    role: "user",
    slack_linked: false,
    teams: [],
    webex_link_available: overrides.webex_link_available ?? false,
    webex_linked: overrides.webex_linked ?? false,
  };
}

async function installAccessSettingsMocks(
  page: Page,
  myRolesOverrides: { webex_link_available?: boolean; webex_linked?: boolean } = {},
): Promise<void> {
  const handler: MockRouteHandler = async ({ method, path, route }) => {
    if (path === "/api/auth/my-roles" && method === "GET") {
      await fulfillJson(route, myRolesBody(myRolesOverrides));
      return true;
    }
    return false;
  };

  await installMockedRbacApp(page, { handlers: [handler], isAdmin: false, session: USER_SESSION });
}

async function openAccountAndAccess(page: Page) {
  await page.goto("/settings/account-and-access", { waitUntil: "domcontentloaded" });
  const main = page.getByRole("main");
  await expect(main.getByRole("heading", { level: 1, name: "Account & access" })).toBeVisible();
  return main;
}

test.describe("mocked routed Webex self-service identity linking", () => {
  test.beforeEach(() => {
    test.skip(
      !mockedRbacEnabled(),
      "Set RUN_RBAC_REGRESSION=1 to run the mocked routed Webex identity link regression.",
    );
  });

  test("hides the Webex link control when linking is not configured", async ({ page }) => {
    await installAccessSettingsMocks(page, { webex_link_available: false });
    const main = await openAccountAndAccess(page);

    await expect(main.getByText(/Webex account:/)).toHaveCount(0);
    await expect(main.getByRole("button", { name: /Link Webex account|Relink/ })).toHaveCount(0);
  });

  test("shows a Link Webex account button when available and unlinked", async ({ page }) => {
    await installAccessSettingsMocks(page, { webex_link_available: true, webex_linked: false });
    const main = await openAccountAndAccess(page);

    await expect(main.getByText("Webex account: Not linked")).toBeVisible();
    await expect(main.getByRole("button", { name: "Link Webex account" })).toBeVisible();
  });

  test("shows a Relink button and Linked status when already linked", async ({ page }) => {
    await installAccessSettingsMocks(page, { webex_link_available: true, webex_linked: true });
    const main = await openAccountAndAccess(page);

    await expect(main.getByText("Webex account: Linked")).toBeVisible();
    await expect(main.getByRole("button", { name: "Relink" })).toBeVisible();
  });

  test("clicking the link button navigates to the start OAuth route", async ({ page }) => {
    await installAccessSettingsMocks(page, { webex_link_available: true, webex_linked: false });
    await page.route("**/api/auth/webex-link/start", async (route) => {
      await route.fulfill({
        status: 302,
        headers: { location: "/settings/account-and-access?webex_link=success" },
      });
    });
    const main = await openAccountAndAccess(page);

    await main.getByRole("button", { name: "Link Webex account" }).click();
    await expect(page).toHaveURL(/\/settings\/account-and-access\?webex_link=success/);
  });

  test("shows a success banner and refreshes posture after a successful grant", async ({ page }) => {
    await installAccessSettingsMocks(page, { webex_link_available: true, webex_linked: true });
    await page.goto("/settings/account-and-access?webex_link=success", {
      waitUntil: "domcontentloaded",
    });
    const main = page.getByRole("main");

    await expect(main.getByText("Your Webex account has been linked.")).toBeVisible();
    await expect(main.getByText("Webex account: Linked")).toBeVisible();
  });

  test("shows a mapped error banner for a known failure reason", async ({ page }) => {
    await installAccessSettingsMocks(page, { webex_link_available: true });
    await page.goto("/settings/account-and-access?webex_link=error&reason=WEBEX_ORG_MISMATCH", {
      waitUntil: "domcontentloaded",
    });
    const main = page.getByRole("main");

    await expect(main.getByRole("alert")).toContainText(
      "That Webex account does not belong to this organization.",
    );
  });

  test("falls back to a generic error banner for an unknown failure reason", async ({ page }) => {
    await installAccessSettingsMocks(page, { webex_link_available: true });
    await page.goto("/settings/account-and-access?webex_link=error&reason=SOMETHING_UNKNOWN", {
      waitUntil: "domcontentloaded",
    });
    const main = page.getByRole("main");

    await expect(main.getByRole("alert")).toContainText(
      "Could not link your Webex account. Please try again.",
    );
  });
});
