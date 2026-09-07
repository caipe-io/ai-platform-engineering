import { expect,test } from "@playwright/test";

import {
  DEFAULT_ADMIN_GATES,
  installMockedRbacApp,
  mockedRbacEnabled,
} from "./_mocked-rbac";

const adminSession = {
  email: "admin@example.com",
  name: "Example Admin",
  role: "admin" as const,
  canViewAdmin: true,
};

test.describe("mocked Admin workspace browser regression",() => {
  test.beforeEach(() => {
    test.skip(
      !mockedRbacEnabled(),
      "Set RUN_RBAC_REGRESSION=1 to run the mocked RBAC browser regression.",
    );
  });

  test("opens bare Admin at the canonical Users destination",async ({ page }) => {
    await installMockedRbacApp(page,{
      isAdmin: true,
      session: adminSession,
    });

    await page.goto("/admin",{ waitUntil: "domcontentloaded" });

    await expect(page).toHaveURL(/\/admin\/people\/users$/);
    await expect(page.getByRole("heading",{ level: 1,name: "Users" })).toBeVisible();
    await expect(
      page
        .getByRole("navigation",{ name: "Application navigation" })
        .getByRole("button",{ name: "Admin",exact: true }),
    ).toHaveAttribute(
      "aria-current",
      "page",
    );
    const breadcrumb = page.getByRole("navigation",{ name: "Breadcrumb" });
    await expect(breadcrumb.getByRole("link",{ name: "Home" })).toHaveAttribute("href","/");
    await expect(breadcrumb.getByRole("link",{ name: "Admin" })).toHaveAttribute(
      "href",
      "/admin/people/users",
    );
    await expect(
      breadcrumb.getByRole("link",{ name: "Teams & Users",exact: true }),
    ).toHaveAttribute(
      "href",
      "/admin/people/users",
    );
    await expect(breadcrumb.getByRole("link",{ name: "Users",exact: true })).toHaveAttribute(
      "aria-current",
      "page",
    );
    await expect(
      page.getByText("Review people, roles, memberships, and resource access."),
    ).toBeVisible();
    await expect(
      page
        .getByRole("navigation",{ name: "Admin sections" })
        .getByRole("link",{ name: "Users",exact: true }),
    ).toHaveAttribute("aria-current","page");
  });

  test("discloses categories and exposes them from the collapsed rail",async ({ page }) => {
    await installMockedRbacApp(page,{
      gates: {
        ...DEFAULT_ADMIN_GATES,
        feedback: true,
        slack: true,
        stats: true,
        webex: true,
      },
      isAdmin: true,
      session: adminSession,
    });
    await page.goto("/admin/people/users",{ waitUntil: "domcontentloaded" });

    const navigation = page.getByRole("navigation",{ name: "Admin sections" });
    for (const category of [
      "Teams & Users",
      "Resources",
      "Integrations",
      "Insights",
      "Metrics & Health",
      "Security & Policy",
    ]) {
      await expect(navigation.getByRole("button",{ name: category,exact: true })).toBeVisible();
    }

    const resources = navigation.getByRole("button",{ name: "Resources",exact: true });
    await resources.click();

    await expect(resources).toHaveAttribute("aria-expanded","true");
    await expect(
      navigation.getByRole("button",{ name: "Teams & Users",exact: true }),
    ).toHaveAttribute("aria-expanded","true");
    await expect(navigation.getByRole("link",{ name: "Agent configuration" })).toBeVisible();
    await expect(navigation.getByRole("link",{ name: "Skill Hubs" })).toBeVisible();
    await expect(navigation.getByRole("link",{ name: "Users",exact: true })).toBeVisible();
    await expect(page).toHaveURL(/\/admin\/people\/users$/);
    await expect(page.getByRole("heading",{ level: 1,name: "Users" })).toBeVisible();

    await page.getByRole("button",{ name: "Collapse sidebar",exact: true }).click();
    await expect(page.getByRole("button",{ name: "Expand sidebar",exact: true })).toBeVisible();
    await expect.poll(async () => page.context().cookies()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "caipe-application-navigation-collapsed",
          value: "true",
        }),
      ]),
    );
    await page.reload({ waitUntil: "domcontentloaded" });
    await expect(page.getByRole("button",{ name: "Expand sidebar",exact: true })).toBeVisible();
    await page.getByRole("button",{ name: "Admin",exact: true }).hover();
    const flyoutNavigation = page.getByRole("navigation",{ name: "Admin sections" });
    const flyoutResources = flyoutNavigation.getByRole("button",{
      name: "Resources",
      exact: true,
    });
    if (await flyoutResources.getAttribute("aria-expanded") !== "true") {
      await flyoutResources.click();
    }
    await flyoutNavigation.getByRole("link",{ name: "Agent configuration" }).click();
    await expect(page).toHaveURL(/\/admin\/platform\/agents$/);
    await expect(page.getByRole("heading",{ level: 1,name: "Agent configuration" })).toBeVisible();
  });

  test("uses the application drawer when the rail would crowd content",async ({ page }) => {
    await page.setViewportSize({ height: 768,width: 1024 });
    await installMockedRbacApp(page,{
      isAdmin: true,
      session: adminSession,
    });
    await page.goto("/admin/people/users",{ waitUntil: "domcontentloaded" });

    const drawerTrigger = page.getByRole("button",{ name: "Open navigation",exact: true });
    await expect(drawerTrigger).toBeVisible();
    await drawerTrigger.click();

    const drawer = page.getByRole("dialog",{ name: "Navigation" });
    await expect(drawer).toBeVisible();
    const navigation = drawer.getByRole("navigation",{ name: "Admin sections" });
    await navigation.getByRole("button",{ name: "Metrics & Health",exact: true }).click();
    await navigation.getByRole("link",{ name: "Health",exact: true }).click();

    await expect(page).toHaveURL(/\/admin\/operations\/health$/);
    await expect(drawer).toBeHidden();
    await expect(page.getByRole("heading",{ level: 1,name: "Health" })).toBeVisible();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
      ),
    ).toBe(true);
  });

});
