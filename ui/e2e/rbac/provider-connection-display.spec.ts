// assisted-by Codex Codex-sonnet-4-6

import { expect, test } from "@playwright/test";

import {
  CREDENTIALS_ADMIN_SESSION,
  DEFAULT_OAUTH_CONNECTOR,
  gotoPersonalCredentialsConnections,
  installCredentialsBrowserMocks,
} from "./_credentials-browser-fixtures";
import {
  gotoMcpServersTab,
  installMcpBrowserMocks,
  openAddMcpServerEditor,
} from "./_mcp-browser-fixtures";
import {
  EXPIRED_ATLASSIAN_CONNECTION,
  NEW_ATLASSIAN_CONNECTION,
  NON_RENEWABLE_CO2_CONNECTION,
  OLD_ATLASSIAN_CONNECTION,
} from "./_provider-connection-fixtures";
import { dismissReleaseUpgradeDialog, installTestSession } from "./_helpers";
import { mockedRbacEnabled } from "./_mocked-rbac";

function minimalSessionEnv() {
  return {
    baseUrl: process.env.CAIPE_UI_BASE_URL ?? "http://localhost:3000",
    keycloakUrl: process.env.KEYCLOAK_URL ?? "http://localhost:7080",
    keycloakRealm: process.env.KEYCLOAK_REALM ?? "caipe",
    user: { email: CREDENTIALS_ADMIN_SESSION.email, password: "" },
  };
}

async function gotoConnectedAppsWorkspace(page: import("@playwright/test").Page): Promise<void> {
  if (!process.env.NEXTAUTH_SECRET) {
    test.skip(true, "NEXTAUTH_SECRET required for /credentials SSR.");
  }
  await installTestSession(page, minimalSessionEnv(), {
    email: CREDENTIALS_ADMIN_SESSION.email,
    subject: process.env.RBAC_USER_SUB?.trim() || "playwright-admin-sub",
    role: "admin",
  });
  await gotoPersonalCredentialsConnections(page);
  await dismissReleaseUpgradeDialog(page);
  try {
    await expect(page.getByRole("heading", { name: "Connected Apps" })).toBeVisible({
      timeout: 10_000,
    });
  } catch {
    test.skip(
      true,
      "Personal /credentials requires SSR session and org FGA (run with full dev stack or RUN_RBAC_E2E).",
    );
  }
}

const CO2_OAUTH_CONNECTOR = {
  id: "co2-dev-connector",
  name: "CO2 Dev",
  provider: "co2-dev",
  enabled: true,
  scopes: ["openid"],
};

test.describe("RBAC e2e — provider connection display and cleanup", () => {
  test.beforeEach(() => {
    test.skip(
      !mockedRbacEnabled(),
      "Set RUN_RBAC_REGRESSION=1 to run the mocked provider connection display regression.",
    );
  });

  test.describe("Connected Apps workspace", () => {
    test("shows profile summary, health, and relative refresh for the newest connection", async ({
      page,
    }) => {
      await installCredentialsBrowserMocks(page, {
        providerConnections: [NEW_ATLASSIAN_CONNECTION, OLD_ATLASSIAN_CONNECTION],
      });
      await gotoConnectedAppsWorkspace(page);
      await expect(page.getByText("Atlassian Cloud")).toBeVisible();
      await expect(page.getByText("cisco-eti")).toBeVisible();
      await expect(page.getByText("healthy")).toBeVisible();
      await expect(page.getByText(/refreshed \d+m ago/i)).toBeVisible();
      await expect(page.getByText("legacy-site")).toHaveCount(0);
      await expect(page.getByText("expired")).toHaveCount(0);
    });

    test("falls back to owner email when profile summary is absent", async ({ page }) => {
      const connectionWithoutSummary = {
        ...NEW_ATLASSIAN_CONNECTION,
        profileSummary: undefined,
      };
      await installCredentialsBrowserMocks(page, {
        providerConnections: [connectionWithoutSummary],
      });
      await gotoConnectedAppsWorkspace(page);

      await expect(page.getByText("sraradhy@cisco.com")).toBeVisible();
      await expect(page.getByText("cisco-eti")).toHaveCount(0);
    });

    test("surfaces expired health when the active connection token is expired", async ({ page }) => {
      await installCredentialsBrowserMocks(page, {
        providerConnections: [EXPIRED_ATLASSIAN_CONNECTION],
      });
      await gotoConnectedAppsWorkspace(page);

      await expect(page.locator("table").getByText("expired", { exact: true })).toBeVisible();
      await expect(page.getByText(/Atlassian connection expired/i)).toBeVisible();
    });

    test("surfaces non-renewable (no refresh token) connections as connected-but-expiring", async ({
      page,
    }) => {
      await installCredentialsBrowserMocks(page, {
        providerConnections: [NON_RENEWABLE_CO2_CONNECTION],
        oauthConnectors: [CO2_OAUTH_CONNECTOR],
      });
      await gotoConnectedAppsWorkspace(page);

      await expect(page.getByText("CO2 Dev", { exact: true })).toBeVisible();
      // Health pill stays green (usable now), not the amber "expiring soon".
      await expect(
        page.locator("table").getByText("no auto-renew", { exact: true }),
      ).toBeVisible();
      await expect(page.locator("table").getByText("expiring soon")).toHaveCount(0);
      await expect(page.locator("table").getByText("expired", { exact: true })).toHaveCount(0);
      // A countdown to expiry replaces the "refreshed Xm ago" label.
      await expect(page.getByText(/expires in 1[01]h/i)).toBeVisible();
      // No profile endpoint exists for a custom MCP OAuth provider, so the
      // "Test connection" button must not render (it would always 400).
      await expect(page.getByRole("button", { name: /test co2 dev connection/i })).toHaveCount(0);
    });

    test("runs profile checks against the selected connection id", async ({ page }) => {
      const profileChecks: string[] = [];

      await installCredentialsBrowserMocks(page, {
        providerConnections: [NEW_ATLASSIAN_CONNECTION],
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
              accessible_resources: [{ name: "cisco-eti", scopes: ["read:jira-user"] }],
              diagnostics: [
                {
                  id: "atlassian_accessible_resources",
                  label: "Accessible Atlassian sites",
                  status: "passed",
                  detail: "cisco-eti is accessible.",
                  action: "No action needed.",
                },
              ],
            },
          }),
        });
      });
      await gotoConnectedAppsWorkspace(page);

      await page.getByRole("button", { name: /test atlassian connection/i }).click();
      await expect(page.getByText(/Atlassian access check passed: cisco-eti/i)).toBeVisible();
      expect(profileChecks).toEqual([NEW_ATLASSIAN_CONNECTION.id]);
    });

    test("lists a single active row after simulated stale-connection prune", async ({ page }) => {
      await installCredentialsBrowserMocks(page, {
        providerConnections: [NEW_ATLASSIAN_CONNECTION],
      });
      await gotoConnectedAppsWorkspace(page);

      await expect(page.getByText("Atlassian Cloud")).toHaveCount(1);
      await expect(page.getByText("cisco-eti")).toBeVisible();
      await expect(page.getByText("legacy-site")).toHaveCount(0);
    });
  });

  test.describe("MCP credential editor", () => {
    test("persists the caller-scoped provider on save", async ({ page }) => {
      const mocks = await installMcpBrowserMocks(page, {
        servers: [],
        providerConnections: [NEW_ATLASSIAN_CONNECTION],
        oauthConnectors: [DEFAULT_OAUTH_CONNECTOR],
      });

      await gotoMcpServersTab(page);
      await openAddMcpServerEditor(page);
      await page.getByLabel(/Display Name/i).fill("Atlassian MCP");
      await page.getByLabel(/Endpoint URL/i).fill("http://agentgateway:4000/mcp/atlassian");
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
      expect(mocks.createRequests[0].credential_sources?.[0]).not.toHaveProperty(
        "provider_connection_id",
      );
    });
  });

  test.describe("connection revoke API", () => {
    test("marks revoked connections disabled in the mock store", async ({ page }) => {
      const mocks = await installCredentialsBrowserMocks(page, {
        providerConnections: [NEW_ATLASSIAN_CONNECTION, OLD_ATLASSIAN_CONNECTION],
      });
      await gotoMcpServersTab(page);
      await dismissReleaseUpgradeDialog(page);

      const response = await page.evaluate(async (connectionId) => {
        const result = await fetch(`/api/credentials/connections/${connectionId}`, {
          method: "DELETE",
        });
        return { ok: result.ok, status: result.status };
      }, OLD_ATLASSIAN_CONNECTION.id);

      expect(response.ok).toBe(true);
      expect(mocks.connectionRevokeRequests).toEqual([OLD_ATLASSIAN_CONNECTION.id]);
      expect(
        mocks.providerConnections.find((connection) => connection.id === OLD_ATLASSIAN_CONNECTION.id),
      ).toBeUndefined();
      expect(
        mocks.providerConnections.filter((connection) => connection.status === "connected"),
      ).toHaveLength(1);
    });
  });
});
