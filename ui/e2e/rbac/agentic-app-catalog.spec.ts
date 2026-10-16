import { expect, test } from "@playwright/test";
import { fulfillJson, installMockedRbacApp, mockedRbacEnabled } from "./_mocked-rbac";
import type { PublicAgenticApp } from "../../src/types/agentic-app";

const apps: PublicAgenticApp[] = [
  { appId: "example", displayName: "Example workspace", description: "A hosted document workspace", href: "/apps/example", uiMode: "iframe", icon: "sparkles", canLaunch: true, blockedReasons: [], categories: ["engineering"], capabilities: ["document-search"] },
  { appId: "secondary", displayName: "Secondary workspace", description: "A native workspace requiring access", href: "/secondary", uiMode: "native-package", icon: "constructor", canLaunch: false, blockedReasons: ["unauthorized"], categories: ["research"], capabilities: [] },
];

test.beforeEach(() => {
  test.skip(!mockedRbacEnabled(), "Run with the isolated mocked-RBAC host, not a deployed environment.");
});

for (const scenario of [
  { theme: "dark", width: 1440 },
  { theme: "light", width: 1440 },
  { theme: "dark", width: 390 },
]) {
  test(`catalog layout, search, keyboard navigation: ${scenario.theme} ${scenario.width}`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width: scenario.width, height: 900 });
    await page.addInitScript((theme) => localStorage.setItem("theme", theme), scenario.theme);
    await installMockedRbacApp(page, {
      session: { email: "test-user@example.com", name: "Test User" },
      handlers: [async ({ path, route }) => {
        if (path === "/api/agentic-apps") {
          await fulfillJson(route, { items: apps });
          return true;
        }
        if (path === "/api/agentic-apps/example") {
          await fulfillJson(route, { item: apps[0] });
          return true;
        }
        return false;
      }],
    });
    // Serve only the mocked child's document, not the host's route or assets.
    await page.route("**/apps/example", async (route) => {
      if (route.request().frame().parentFrame()) {
        await route.fulfill({ contentType: "text/html", body: "<!doctype html><html><body><h1>Example app content</h1></body></html>" });
      } else await route.fallback();
    });
    await page.goto("/apps");
    await expect(page.getByRole("region", { name: "Available Apps" })).toBeVisible();
    await expect(page.locator("html")).toHaveAttribute("data-theme", scenario.theme);
    await expect(page.getByText("2 of 2 apps")).toBeVisible();
    await expect(page.getByRole("link", { name: "Secondary workspace", exact: true })).toHaveCount(0);
    await expect(page.getByText("Access required: unauthorized")).toBeVisible();
    const main = page.getByRole("main");
    expect(await main.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath(`catalog-${scenario.theme}-${scenario.width}.png`), fullPage: true });
    await page.getByRole("searchbox").fill("ENGINEERING document search");
    await expect(page.getByText("1 of 2 apps")).toBeVisible();
    await expect(page.getByText("Secondary workspace", { exact: true })).toHaveCount(0);
    await page.getByRole("searchbox").fill("");
    const launchRequests: string[] = [];
    page.on("request", (request) => {
      if (new URL(request.url()).pathname === "/apps/example" && request.frame() === page.mainFrame()) {
        launchRequests.push(request.resourceType());
      }
    });
    const link = page.getByRole("link", { name: "Example workspace", exact: true });
    await link.focus();
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(/\/apps\/example$/);
    await expect(page.frameLocator('iframe[title="Example workspace"]').getByRole("heading", { name: "Example app content" })).toBeVisible();
    // No speculative RSC fetch should be routed to the child runtime first.
    expect(launchRequests).toEqual(["document"]);
    await page.goBack();
    await expect(page.getByRole("link", { name: "Example workspace", exact: true })).toBeVisible();
  });
}
