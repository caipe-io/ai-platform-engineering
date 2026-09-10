
import { expect, test, type Page } from "@playwright/test";

import {
  DEFAULT_OAUTH_CONNECTOR,
  RAW_SECRET_VALUE,
  CREDENTIALS_ADMIN_SESSION,
  gotoAdminCredentialsTab,
  gotoPersonalCredentialsSecrets,
  installCredentialsBrowserMocks,
  type InstalledCredentialsBrowserMocks,
} from "./_credentials-browser-fixtures";
import {
  fillNewMcpServerBasics,
  gotoMcpServersTab,
  installMcpBrowserMocks,
  openAddMcpServerEditor,
} from "./_mcp-browser-fixtures";
import {
  chooseSearchablePickerOption,
  dismissReleaseUpgradeDialog,
  installTestSession,
} from "./_helpers";
import { mockedRbacEnabled } from "./_mocked-rbac";

function minimalSessionEnv() {
  return {
    baseUrl: process.env.CAIPE_UI_BASE_URL ?? "http://localhost:3000",
    keycloakUrl: process.env.KEYCLOAK_URL ?? "http://localhost:7080",
    keycloakRealm: process.env.KEYCLOAK_REALM ?? "caipe",
    user: { email: CREDENTIALS_ADMIN_SESSION.email, password: "" },
  };
}

async function assertPersonalCredentialsAvailable(page: Page): Promise<void> {
  await gotoPersonalCredentialsSecrets(page);
  await dismissReleaseUpgradeDialog(page);
  try {
    await expect(
      page
        .getByRole("navigation",{ name: "Breadcrumb" })
        .getByRole("link",{ name: "Credentials",exact: true }),
    ).toBeVisible({ timeout: 10_000 });
  } catch {
    test.skip(
      true,
      "Personal /credentials requires SSR session and org FGA (run with full dev stack or RUN_RBAC_E2E).",
    );
  }
}

async function installPersonalCredentialsSession(page: Page): Promise<void> {
  test.skip(!process.env.NEXTAUTH_SECRET, "NEXTAUTH_SECRET required for personal /credentials SSR.");
  await installTestSession(page, minimalSessionEnv(), {
    email: CREDENTIALS_ADMIN_SESSION.email,
    subject: process.env.RBAC_USER_SUB?.trim() || "playwright-admin-sub",
    role: "admin",
  });
}

test.describe("mocked credentials workspace browser regression", () => {
  test.beforeEach(() => {
    test.skip(
      !mockedRbacEnabled(),
      "Set RUN_RBAC_REGRESSION=1 to run the mocked credentials browser regression.",
    );
  });

  test.describe("admin credentials — secrets protection and usage", () => {
    test("shows creator, sharing, usage summaries and expands inline protection without raw values", async ({
      page,
    }) => {
      await installCredentialsBrowserMocks(page);
      await gotoAdminCredentialsTab(page);
      await dismissReleaseUpgradeDialog(page);

      await expect(page.getByRole("heading", { name: "Secrets" })).toBeVisible({
        timeout: 30_000,
      });
      await expect(page.getByRole("tab", { name: /credential audit/i })).toHaveCount(0);
      await expect(page.getByText("GitHub token")).toBeVisible();
      await expect(page.getByText("Workspace Owner").first()).toBeVisible();
      await expect(page.getByText("user:owner-sub")).toHaveCount(0);
      await expect(page.getByText("Shared with 2 teams")).toBeVisible();
      await expect(page.getByText("Used in 2 places")).toBeVisible();
      await expect(page.getByText("platform-team")).toHaveCount(0);
      await expect(page.getByText("security-team")).toHaveCount(0);
      await expect(page.getByText(/GitHub MCP/)).toHaveCount(0);
      await expect(page.getByText("Recent activity", { exact: true })).toHaveCount(0);

      await page.getByRole("button", { name: /more details/i }).click();

      await expect(page.getByText("platform-team")).toBeVisible();
      await expect(page.getByText("security-team")).toBeVisible();
      await expect(page.getByText(/GitHub MCP/)).toBeVisible();
      await expect(page.getByText(/OpenAI api key/)).toBeVisible();
      await expect(page.getByText(/credential_secret_refs/)).toHaveCount(0);
      await expect(page.getByText(/credential_encrypted_payloads/)).toHaveCount(0);
      await page.getByRole("button", { name: /secret protection details/i }).first().hover();
      await expect(page.getByText(/masked preview is a protected hint/i)).toBeVisible();
      await expect(page.getByText(/never shown in the browser/i)).toBeVisible();
      await expect(page.getByText(/Saved record: credential_secret_refs/)).toHaveCount(0);
      await expect(page.getByText(/Protected value: credential_encrypted_payloads/)).toHaveCount(0);
      await expect(page.getByText(/AES-256-GCM envelope encryption/)).toHaveCount(0);
      await expect(page.getByText("Recent activity", { exact: true })).toBeVisible();
      await expect(page.getByText("Secret added")).toBeVisible();
      await expect(page.getByText("credential.create")).toHaveCount(0);
      await expect(page.getByText(RAW_SECRET_VALUE)).toHaveCount(0);
    });

    test("edits secret metadata without exposing the protected value", async ({ page }) => {
      const mocks = await installCredentialsBrowserMocks(page);
      await gotoAdminCredentialsTab(page);
      await dismissReleaseUpgradeDialog(page);
      await expect(page.getByText("GitHub token")).toBeVisible({ timeout: 30_000 });

      await page.getByRole("button", { name: "Edit" }).click();
      const dialog = page.getByRole("dialog", { name: /edit secret/i });
      await expect(dialog).toBeVisible();
      const inputs = dialog.locator("input");
      await inputs.nth(0).fill("GitHub automation");
      await inputs.nth(1).fill("Rotates quarterly");
      await dialog.getByRole("button", { name: /save/i }).click();

      await expect.poll(() => mocks.adminPatchRequests.length).toBe(1);
      expect(mocks.adminPatchRequests[0]).toMatchObject({
        id: "secret-github",
        body: { name: "GitHub automation", description: "Rotates quarterly" },
      });
      await expect(page.getByText("GitHub automation")).toBeVisible();
      await expect(page.getByText(RAW_SECRET_VALUE)).toHaveCount(0);
    });

    test("deletes a secret after explicit confirmation", async ({ page }) => {
      const mocks = await installCredentialsBrowserMocks(page);
      await gotoAdminCredentialsTab(page);
      await dismissReleaseUpgradeDialog(page);
      await expect(page.getByText("GitHub token")).toBeVisible({ timeout: 30_000 });

      await page.getByRole("button", { name: "Delete" }).click();
      await page.getByRole("button", { name: /confirm delete github token/i }).click();

      await expect.poll(() => mocks.adminDeleteRequests).toEqual(["secret-github"]);
      await expect(page.getByText("GitHub token")).toHaveCount(0);
    });

    test("shows only audit events that match the expanded secret", async ({ page }) => {
      await installCredentialsBrowserMocks(page);
      await gotoAdminCredentialsTab(page);
      await dismissReleaseUpgradeDialog(page);
      await expect(page.getByText("GitHub token")).toBeVisible({ timeout: 30_000 });

      await page.getByRole("button", { name: /more details/i }).click();
      await expect(page.getByText("Secret added")).toBeVisible();
      await expect(page.getByText("other@example.com")).toHaveCount(0);
    });
  });

  test.describe("admin credentials — connected apps", () => {
    test("lists OAuth connectors on the Connected Apps admin tab", async ({ page }) => {
      await installCredentialsBrowserMocks(page);
      await gotoAdminCredentialsTab(page);
      await dismissReleaseUpgradeDialog(page);

      await page.getByRole("tab", { name: /connected apps/i }).click();
      await expect(page.getByText("Atlassian Cloud")).toBeVisible({ timeout: 30_000 });
      await expect(page.getByText("atlassian /")).toBeVisible();
    });
  });

  test.describe("personal credentials workspace", () => {
    let credentialsMocks: InstalledCredentialsBrowserMocks;

    test.beforeEach(async ({ page }) => {
      credentialsMocks = await installCredentialsBrowserMocks(page, {
        providerConnections: [
          {
            id: "new-atlassian-connection",
            connectorId: DEFAULT_OAUTH_CONNECTOR.id,
            provider: "atlassian",
            status: "connected",
            expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
            updatedAt: "2026-06-21T04:44:00.000Z",
            grantedScopes: ["offline_access", "read:me", "read:jira-work", "read:jira-user"],
          },
          {
            id: "old-atlassian-connection",
            connectorId: DEFAULT_OAUTH_CONNECTOR.id,
            provider: "atlassian",
            status: "connected",
            expiresAt: new Date(Date.now() - 60_000).toISOString(),
            updatedAt: "2026-06-01T04:44:00.000Z",
            grantedScopes: ["offline_access", "read:me", "read:jira-work"],
          },
        ],
      });
      await installPersonalCredentialsSession(page);
    });

    test("lets users peek at a new secret before saving", async ({ page }) => {
      await assertPersonalCredentialsAvailable(page);

      await expect(page.getByRole("heading", { name: "Saved Secrets" })).toBeVisible();
      await page.getByRole("button", { name: /add secret/i }).click();

      const dialog = page.getByRole("dialog", { name: /add secret/i });
      await expect(dialog).toBeVisible();
      await dialog.getByLabel("Name").fill("Temporary token");
      const secretValue = dialog.locator("#new-secret-value");
      await secretValue.fill("temporary-secret-value");
      await expect(secretValue).toHaveAttribute("type", "password");

      await dialog.getByRole("button", { name: /show secret value before saving/i }).click();
      await expect(secretValue).toHaveAttribute("type", "text");
      await expect(secretValue).toHaveValue("temporary-secret-value");

      await dialog.getByRole("button", { name: /hide secret value before saving/i }).click();
      await expect(secretValue).toHaveAttribute("type", "password");
      await dialog.getByRole("button", { name: /save secret/i }).click();

      await expect(dialog).toHaveCount(0);
      await expect(page.getByText("Temporary token")).toBeVisible();
      await expect(page.getByText("temporary-secret-value")).toHaveCount(0);
    });

    test("shows masked preview in details with no reveal control", async ({ page }) => {
      await assertPersonalCredentialsAvailable(page);

      await page.getByRole("button", { name: /view details for github token/i }).click();
      const dialog = page.getByRole("dialog", { name: /github token details/i });
      await expect(dialog).toBeVisible();
      await expect(page.getByText("Preview ghp_...abcd")).toBeVisible();
      await expect(dialog.getByText(/saved value stays protected; this preview is masked/i)).toBeVisible();
      await expect(dialog.getByText("Workspace Owner")).toBeVisible();
      await expect(dialog.getByText(/GitHub MCP/)).toBeVisible();
      await expect(dialog.getByText(RAW_SECRET_VALUE)).toHaveCount(0);
      await expect(dialog.getByRole("button", { name: /preview|reveal|copy secret/i })).toHaveCount(0);
    });

    test("shares, rotates, and deletes secrets with explicit actions", async ({ page }) => {
      await assertPersonalCredentialsAvailable(page);
      await expect(page.getByText("GitHub token")).toBeVisible();

      await page.getByRole("button", { name: /share github token/i }).click();
      const sharePanel = page.getByRole("region", { name: /github token team access/i });
      await expect(sharePanel).toBeVisible();
      await sharePanel.getByRole("combobox", { name: /team access/i }).click();
      await page.getByRole("option", { name: /Ops Team/ }).click();
      await sharePanel.getByRole("button", { name: /grant access/i }).click();
      await expect.poll(() => credentialsMocks.shareRequests.length).toBe(1);
      expect(credentialsMocks.shareRequests[0]).toMatchObject({
        action: "share",
        teamId: "ops-team",
      });

      await page.getByRole("button", { name: /rotate github token/i }).click();
      const rotatePanel = page.getByRole("region", { name: /github token rotation/i });
      const newValue = rotatePanel.locator('input[id^="rotate-secret-value"]');
      await newValue.fill("rotated-secret-value");
      await rotatePanel.getByRole("button", { name: /show new secret value before saving/i }).click();
      await rotatePanel.getByRole("button", { name: /save new value/i }).click();
      await expect.poll(() => credentialsMocks.rotateRequests).toEqual([
        { action: "rotate", value: "rotated-secret-value" },
      ]);
      await expect(page.getByText("Preview rot_...ated")).toBeVisible();

      await page.getByRole("button", { name: /delete github token/i }).click();
      await page.getByRole("button", { name: /confirm delete github token/i }).click();
      await expect.poll(() => credentialsMocks.deleteRequests).toEqual(["secret-github"]);
      await expect(page.getByText("GitHub token")).toHaveCount(0);
    });

    test("returns OAuth relinks to Connected Apps and tests the newest connection", async ({
      context,
      page,
    }) => {
      const profileChecks: string[] = [];
      await context.route("**/oauth-callback-relay", async (route) => {
        await route.fulfill({
          status: 200,
          contentType: "text/html; charset=utf-8",
          body: `<!doctype html>
<html><body><script>
  const message = { type: "caipe.oauth.connection", status: "success", provider: "atlassian" };
  if ("BroadcastChannel" in window) {
    const channel = new BroadcastChannel("caipe.oauth.connection");
    channel.postMessage(message);
    channel.close();
  }
  window.opener?.postMessage(message, window.location.origin);
</script></body></html>`,
        });
      });

      await page.route("**/api/credentials/connections/*/profile", async (route) => {
        const connectionId = new URL(route.request().url()).pathname.split("/").at(-2) ?? "";
        profileChecks.push(connectionId);
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            success: true,
            data: {
              ok: true,
              provider: "atlassian",
              accessible_resources: [{ name: "Example Site", scopes: ["read:jira-user"] }],
              diagnostics: [
                {
                  id: "atlassian_accessible_resources",
                  label: "Accessible Atlassian sites",
                  status: "passed",
                  detail: "Example Site is accessible.",
                  action: "No action needed.",
                },
              ],
            },
          }),
        });
      });

      await assertPersonalCredentialsAvailable(page);

      const relayPagePromise = context.waitForEvent("page");
      await page.evaluate(() => {
        window.open("/oauth-callback-relay", "_blank");
      });
      const relayPage = await relayPagePromise;
      await relayPage.waitForLoadState("domcontentloaded");
      await relayPage.close().catch(() => undefined);

      await expect(page).toHaveURL(/\/credentials\/connections$/);
      await expect(page.getByRole("heading", { name: "Connected Apps" })).toBeVisible();
      await expect(page.getByText("Atlassian Cloud")).toBeVisible();
      await expect(page.getByText("healthy")).toBeVisible();
      await expect(page.getByText("expired")).toHaveCount(0);

      await page.getByRole("button", { name: /test atlassian connection/i }).click();
      await expect(page.getByText(/Atlassian access check passed: Example Site/i)).toBeVisible();
      expect(profileChecks).toEqual(["new-atlassian-connection"]);
    });
  });

  test.describe("MCP editor credential binding", () => {
    test("creates an MCP server with a saved secret header binding", async ({ page }) => {
      const mocks = await installMcpBrowserMocks(page, {
        servers: [],
        secrets: [
          {
            id: "secret-jira-token",
            name: "Jira API token",
            type: "bearer_token",
            maskedPreview: "jira_...oken",
          },
        ],
      });

      await gotoMcpServersTab(page);
      await openAddMcpServerEditor(page);
      await fillNewMcpServerBasics(page, {
        displayName: "Jira Bound MCP",
        serverId: "mcp-jira-bound",
        endpoint: "http://agentgateway:4000/mcp/mcp-jira-bound",
      });

      await page.getByRole("button", { name: "Add Credential" }).click();
      await page.getByLabel(/Credential header/i).selectOption("Authorization");
      await chooseSearchablePickerOption(
        page,
        page.getByLabel(/^Secret$/),
        "Jira API token",
      );

      await page.getByRole("button", { name: "Create Server" }).click();

      await expect.poll(() => mocks.createRequests.length).toBe(1);
      expect(mocks.createRequests[0].credential_sources).toEqual([
        expect.objectContaining({
          kind: "secret_ref",
          secret_ref: "secret-jira-token",
        }),
      ]);
    });

    test("selects a connected app for MCP provider credentials", async ({ page }) => {
      const mocks = await installMcpBrowserMocks(page, {
        servers: [],
        providerConnections: [
          {
            id: "conn-atlassian",
            connectorId: "atlassian-connector",
            provider: "atlassian",
            status: "connected",
          },
        ],
        oauthConnectors: [
          {
            id: "atlassian-connector",
            name: "Atlassian Cloud",
            provider: "atlassian",
          },
        ],
      });

      await gotoMcpServersTab(page);
      await openAddMcpServerEditor(page);
      await fillNewMcpServerBasics(page, {
        displayName: "Atlassian MCP",
        serverId: "mcp-atlassian",
        endpoint: "http://agentgateway:4000/mcp/atlassian",
      });

      await page.getByRole("button", { name: "Add Credential" }).click();
      await page.getByLabel(/Credential kind/i).selectOption("provider_connection");
      await page.getByLabel(/^Provider$/i).selectOption("atlassian");

      await page.getByRole("button", { name: "Create Server" }).click();

      await expect.poll(() => mocks.createRequests.length).toBe(1);
      expect(mocks.createRequests[0].credential_sources).toEqual([
        {
          kind: "provider_connection",
          target: "header",
          name: "X-CAIPE-Provider-Token",
          connection_scope: "caller",
          provider: "atlassian",
        },
      ]);
    });
  });
});
