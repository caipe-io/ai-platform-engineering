import { expect, test } from "@playwright/test";

import { fulfillJson, installMockedRbacApp, mockedRbacEnabled, type MockRouteHandler } from "./_mocked-rbac";

test.describe("Preprovisioned Claude sandbox setup", () => {
  test.skip(!mockedRbacEnabled(), "Enable the mocked browser regression suite");

  for (const width of [1440, 390]) {
    test(`shows provisioning, registration and management at ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 1000 });
      const requests: string[] = [];
      const sandbox = { instance_id: "sandbox-1", display_name: "Private coding workspace", portal_url: "https://sandbox.example.test/environments/1",
        policy_revision: "approved-1", policy_summary: "Private files; operator-managed network policy", status: "configured" };
      const handler: MockRouteHandler = async ({ path, method, route }) => {
        if (path === "/api/harness-engine/harnesses") {
          requests.push(method);
          await fulfillJson(route, { success: true, data: { catalog_revision: "catalog-1", harnesses: [{
            id: "claude_code_acp", display_name: "Claude (ACP)", adapter_version: "1", contract_version: 2,
            execution_mode: "remote_worker", availability: "available", certification: "experimental",
            profiles: [{ id: "primary", harness_id: "claude_code_acp", display_name: "Private sandbox profile", description: "", available: true, sandbox }],
            capabilities: { "tools.broker": { level: "emulated", explanation: "Selected MCP tools", constraints: {} } },
            options_schema: { type: "object", properties: {} }, ui_schema: { sandbox_portal_url: "https://sandbox.example.test" },
          }] } });
          return true;
        }
        if (path === "/api/dynamic-agents/models") {
          await fulfillJson(route, { success: true, data: [{ model_id: "example-model", name: "Example model", provider: "openai" }] });
          return true;
        }
        if (path === "/api/dynamic-agents" && method === "GET") {
          await fulfillJson(route, { success: true, data: { items: [], total: 0, page: 1, page_size: 10 } });
          return true;
        }
        return false;
      };
      await installMockedRbacApp(page, { isAdmin: true, session: { email: "owner@example.test", name: "Example owner" }, handlers: [handler] });
      await page.goto("/dynamic-agents?tab=agents", { waitUntil: "domcontentloaded" });
      await page.getByRole("button", { name: "New Agent", exact: true }).click();
      await page.getByText("Set up a Claude Code sandbox", { exact: true }).click();
      await expect(page.getByRole("link", { name: "Open the sandbox application" })).toHaveAttribute("href", "https://sandbox.example.test/");
      await expect(page.getByText(/Creating the sandbox alone does not connect it/)).toBeVisible();
      await page.getByRole("button", { name: "Refresh sandbox connections" }).click();
      await expect(page.getByRole("status").filter({ hasText: "Connections refreshed" })).toBeVisible();
      await page.getByLabel("Execution harness", { exact: true }).selectOption("claude_code_acp");
      await expect(page.getByLabel("Operator profile", { exact: true })).toHaveValue("primary");
      await expect(page.getByRole("region", { name: "Sandbox connection" })).toContainText("Configured");
      await expect(page.getByRole("link", { name: "Manage sandbox" })).toHaveAttribute("href", sandbox.portal_url);
      await expect(page.getByText("Profile revision: approved-1")).toBeVisible();
      expect(requests.length).toBeGreaterThanOrEqual(2);
      expect(new Set(requests)).toEqual(new Set(["GET"]));
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth);
      expect(overflow).toBe(false);
      await page.screenshot({ path: test.info().outputPath(`sandbox-setup-${width}.png`), fullPage: true });
    });
  }
});
