import { expect, test } from "@playwright/test";
import { fulfillJson, installMockedRbacApp, mockedRbacEnabled } from "./_mocked-rbac";

for (const width of [390, 768, 1440]) {
  test(`header breadcrumb stays within its row at ${width}px`, async ({ page }, testInfo) => {
    test.skip(!mockedRbacEnabled(), "Requires the isolated mocked host.");
    await page.setViewportSize({ width, height: 900 });
    await installMockedRbacApp(page, {
      session: { email: "test-user@example.com", name: "Test User" },
      handlers: [async ({ path, route }) => {
        if (path !== "/api/auth/my-roles") return false;
        await fulfillJson(route, { email: "test-user@example.com", name: "Test User", idp_source: "playwright", role: "user", realm_roles: ["user"], teams: [], per_agent_roles: [], per_kb_roles: [], slack_linked: false, webex_linked: false });
        return true;
      }],
    });
    await page.goto("/settings/account-and-access");
    const breadcrumb = page.getByRole("navigation", { name: "Breadcrumb" });
    await expect(breadcrumb).toHaveCount(1);
    await expect(breadcrumb).toContainText("Account & access");
    const bounds = await breadcrumb.evaluate((nav) => {
      const header = nav.closest("header")!;
      const current = nav.querySelector('[aria-current="page"]')!;
      const n = nav.getBoundingClientRect();
      const h = header.getBoundingClientRect();
      const c = current.getBoundingClientRect();
      return { height: n.height, headerTop: h.top, headerBottom: h.bottom, currentTop: c.top, currentBottom: c.bottom, currentWidth: c.width, documentWidth: document.documentElement.scrollWidth };
    });
    expect(bounds.height).toBeLessThanOrEqual(24);
    expect(bounds.currentTop).toBeGreaterThanOrEqual(bounds.headerTop);
    expect(bounds.currentBottom).toBeLessThanOrEqual(bounds.headerBottom);
    expect(bounds.currentWidth).toBeGreaterThan(80);
    expect(bounds.documentWidth).toBeLessThanOrEqual(width);
    await page.screenshot({ path: testInfo.outputPath(`header-breadcrumb-${width}.png`), fullPage: true });
  });
}
