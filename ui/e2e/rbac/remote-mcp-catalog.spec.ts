// assisted-by claude code claude-sonnet-4-6

import { expect, test } from "@playwright/test";

import {
  gotoMcpServersTab,
  installMcpBrowserMocks,
  openAddMcpServerEditor,
  waitForAddMcpServerFormReady,
} from "./_mcp-browser-fixtures";
import { fulfillJson, mockedRbacEnabled, postJson } from "./_mocked-rbac";

test.beforeEach(() => {
  if (!mockedRbacEnabled()) test.skip();
});

/** Inject a platform-config mock that includes a permissive remote_mcp_catalog config. */
async function installCatalogPlatformConfig(page: import("@playwright/test").Page): Promise<void> {
  await page.route("**/api/admin/platform-config", async (route) => {
    if (route.request().method() === "GET") {
      await fulfillJson(route, {
        success: true,
        data: {
          release_notes: { enabled: false },
          remote_mcp_catalog: {
            enabled_providers: null, // null = all built-in providers enabled
            custom_entries: [],
          },
        },
      });
      return;
    }
    await route.continue();
  });
}

test.describe("remote MCP catalog dialog", () => {
  test("Add Server button opens the catalog dialog", async ({ page }) => {
    await installMcpBrowserMocks(page);
    await installCatalogPlatformConfig(page);
    await gotoMcpServersTab(page);

    await page.getByRole("button", { name: "Add Server" }).first().click();
    await expect(page.getByText("Add MCP Server")).toBeVisible({ timeout: 10_000 });
  });

  test("catalog dialog shows built-in provider tiles", async ({ page }) => {
    await installMcpBrowserMocks(page);
    await installCatalogPlatformConfig(page);
    await gotoMcpServersTab(page);

    await page.getByRole("button", { name: "Add Server" }).first().click();
    await expect(page.getByText("Add MCP Server")).toBeVisible({ timeout: 10_000 });

    // Verify known providers appear as tiles. Exact match avoids a strict-mode
    // clash with tile subtitles/descriptions that substring-match the name
    // (e.g. "mcp.amplitude.com", or "...teams in Linear").
    await expect(page.getByText("Amplitude", { exact: true })).toBeVisible();
    await expect(page.getByText("Linear", { exact: true })).toBeVisible();
    await expect(page.getByText("ThousandEyes", { exact: true })).toBeVisible();
  });

  test("catalog dialog does not offer Zapier", async ({ page }) => {
    // Zapier's MCP endpoint (mcp.zapier.com/api/mcp) rejects every
    // server-to-server request — OAuth Bearer included — with a CSRF
    // check, so the provider_connection credential flow can never
    // reach it. The tile must stay out of the catalog.
    await installMcpBrowserMocks(page);
    await installCatalogPlatformConfig(page);
    await gotoMcpServersTab(page);

    await page.getByRole("button", { name: "Add Server" }).first().click();
    await expect(page.getByText("Add MCP Server")).toBeVisible({ timeout: 10_000 });

    // Sanity check the dialog actually rendered its tiles before asserting
    // the negative, so a broken dialog can't produce a false pass. Exact
    // match avoids a strict-mode clash with tile subtitles like
    // "mcp.amplitude.com", which otherwise substring-match "Amplitude".
    await expect(page.getByText("Amplitude", { exact: true })).toBeVisible();
    await expect(page.getByText("Zapier", { exact: true })).toHaveCount(0);

    await page.screenshot({
      path: "test-results/screenshots/remote-mcp-catalog-no-zapier-dialog.png",
      fullPage: true,
    });
  });

  test("clicking a provider pre-fills the MCP server form", async ({ page }) => {
    await installMcpBrowserMocks(page);
    await installCatalogPlatformConfig(page);
    await gotoMcpServersTab(page);

    await page.getByRole("button", { name: "Add Server" }).first().click();
    await expect(page.getByText("Add MCP Server")).toBeVisible({ timeout: 10_000 });

    // Click the Linear provider tile (exact match — the tile's own
    // description text substring-matches "Linear" too).
    await page.getByText("Linear", { exact: true }).click();

    // Catalog dialog closes; form should be pre-filled with Linear endpoint
    await waitForAddMcpServerFormReady(page);
    const endpointInput = page.getByLabel(/Endpoint URL/i);
    await expect(endpointInput).toHaveValue(/mcp\.linear\.app/, { timeout: 8_000 });
  });
});

test.describe("MCP server credential probe (Test Connection)", () => {
  test("Test Connection button sends POST to credential-probe and shows result", async ({ page }) => {
    const credProbeRequests: Array<{ url?: string; credential_sources?: unknown[] }> = [];

    await installMcpBrowserMocks(page, {
      secrets: [
        {
          id: "secret-example-token",
          name: "Example API token",
          type: "bearer_token",
          maskedPreview: "tok_...abcd",
        },
      ],
    });
    await installCatalogPlatformConfig(page);
    await page.route("**/api/mcp-servers/credential-probe", async (route) => {
      if (route.request().method() === "POST") {
        const body = (await postJson(route)) as {
          url?: string;
          credential_sources?: unknown[];
        };
        credProbeRequests.push(body);
        await fulfillJson(route, {
          success: true,
          data: {
            ok: true,
            status: 200,
            credentialOrigins: [
              { name: "Authorization", origin: "secret_ref", provider: undefined },
            ],
            missingCredentials: [],
          },
        });
        return;
      }
      await route.continue();
    });

    await gotoMcpServersTab(page);
    await openAddMcpServerEditor(page);

    // Fill endpoint and add a credential row — Test Connection only renders
    // once credentialSources.length > 0.
    await page.getByLabel(/Endpoint URL/i).fill("https://api.example.test/mcp");
    await page.getByRole("button", { name: "Add Credential" }).click();

    await page.getByRole("button", { name: /Test Connection/i }).click();

    // Wait for the probe to complete and the status indicator to appear.
    // Exact text — a loose /Connected|.../ regex also matches unrelated page
    // text like the "Connected app" credential-kind option.
    await expect(page.getByText("Connected (HTTP 200)")).toBeVisible({ timeout: 10_000 });

    expect(credProbeRequests).toHaveLength(1);
    expect(credProbeRequests[0]?.url).toMatch(/api\.example\.test\/mcp/);
  });

  test("Test Connection shows degraded indicator when credentials are missing", async ({ page }) => {
    await installMcpBrowserMocks(page);
    await installCatalogPlatformConfig(page);
    await page.route("**/api/mcp-servers/credential-probe", async (route) => {
      if (route.request().method() === "POST") {
        await fulfillJson(route, {
          success: true,
          data: {
            ok: true,
            status: 200,
            credentialOrigins: [],
            missingCredentials: ["Authorization"],
          },
        });
        return;
      }
      await route.continue();
    });

    await gotoMcpServersTab(page);
    await openAddMcpServerEditor(page);
    await page.getByLabel(/Endpoint URL/i).fill("https://api.example.test/mcp");
    await page.getByRole("button", { name: "Add Credential" }).click();
    await page.getByRole("button", { name: /Test Connection/i }).click();

    // "Reachable but credentials not resolved" copy appears. Exact text — a
    // loose /credential/i regex also matches the "Add Credential" button and
    // "Credentials" section heading.
    await expect(
      page.getByText("Reachable (HTTP 200) — credentials not resolved"),
    ).toBeVisible({ timeout: 10_000 });
  });
});

test.describe("admin MCP catalog", () => {
  test("renders the catalog settings card", async ({ page }) => {
    await installMcpBrowserMocks(page, { isAdmin: true });
    await installCatalogPlatformConfig(page);

    // Override admin-tab-gates to enable the MCP catalog destination.
    await page.route("**/api/rbac/admin-tab-gates", async (route) => {
      await fulfillJson(route, {
        gates: {
          credentials: true,
          teams: true,
          users: true,
          health: true,
          metrics: true,
          migrations: false,
          openfga: true,
          service_accounts: true,
          agents: true,
          mcp: true,
        },
      });
    });

    await page.goto("/admin/platform/mcp-catalog", { waitUntil: "domcontentloaded" });

    await expect(
      page.getByRole("heading", { level: 1, name: "MCP Catalog", exact: true }),
    ).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText("Built-in providers", { exact: true })).toBeVisible();
  });

  test("lists built-in providers with toggle controls", async ({ page }) => {
    await installMcpBrowserMocks(page, { isAdmin: true });

    await page.route("**/api/rbac/admin-tab-gates", async (route) => {
      await fulfillJson(route, {
        gates: {
          credentials: false,
          teams: true,
          users: true,
          health: true,
          metrics: true,
          migrations: false,
          openfga: true,
          service_accounts: true,
          agents: true,
          mcp: true,
        },
      });
    });

    await page.route("**/api/admin/platform-config", async (route) => {
      if (route.request().method() === "GET") {
        await fulfillJson(route, {
          success: true,
          data: {
            release_notes: { enabled: false },
            remote_mcp_catalog: {
              enabled_providers: ["amplitude", "linear", "thousandeyes"],
              custom_entries: [],
            },
          },
        });
        return;
      }
      await route.continue();
    });

    await page.goto("/admin/platform/mcp-catalog", { waitUntil: "domcontentloaded" });
    await expect(
      page.getByRole("heading", { level: 1, name: "MCP Catalog", exact: true }),
    ).toBeVisible({ timeout: 10_000 });

    // Provider checkboxes should be present
    await expect(page.getByText("Amplitude")).toBeVisible();
    await expect(page.getByText("ThousandEyes")).toBeVisible();
  });

  test("does not list Zapier as a built-in provider", async ({ page }) => {
    await installMcpBrowserMocks(page, { isAdmin: true });

    await page.route("**/api/rbac/admin-tab-gates", async (route) => {
      await fulfillJson(route, {
        gates: {
          credentials: false,
          teams: true,
          users: true,
          health: true,
          metrics: true,
          migrations: false,
          openfga: true,
          service_accounts: true,
          agents: true,
          mcp: true,
        },
      });
    });

    await page.route("**/api/admin/platform-config", async (route) => {
      if (route.request().method() === "GET") {
        await fulfillJson(route, {
          success: true,
          data: {
            release_notes: { enabled: false },
            remote_mcp_catalog: {
              enabled_providers: null, // null = all built-in providers enabled
              custom_entries: [],
            },
          },
        });
        return;
      }
      await route.continue();
    });

    await page.goto("/admin/platform/mcp-catalog", { waitUntil: "domcontentloaded" });
    await expect(
      page.getByRole("heading", { level: 1, name: "MCP Catalog", exact: true }),
    ).toBeVisible({ timeout: 10_000 });

    // Sanity check the list actually rendered before asserting the negative.
    await expect(page.getByText("Amplitude", { exact: true })).toBeVisible();
    await expect(page.getByText("Zapier", { exact: true })).toHaveCount(0);

    await page.screenshot({
      path: "test-results/screenshots/remote-mcp-catalog-no-zapier-admin-settings.png",
      fullPage: true,
    });
  });
});
