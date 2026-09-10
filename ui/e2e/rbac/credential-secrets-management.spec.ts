// assisted-by Codex Codex-sonnet-4-6

import { expect,test,type Route } from "@playwright/test";

import { rbacEnvOrSkip } from "./_env";
import { dismissReleaseUpgradeDialog,signIn } from "./_helpers";

const RAW_SECRET = "ghp_raw_token_value";

const secretFixture = {
  id: "secret-github",
  name: "GitHub token",
  description: "GitHub automation token",
  owner: {
    type: "user",
    id: "alice-sub",
    email: "alice@example.test",
    name: "Alice Example",
  },
  createdBy: {
    type: "user",
    id: "alice-sub",
    email: "alice@example.test",
    name: "Alice Example",
  },
  type: "bearer_token",
  maskedPreview: "ghp_...abcd",
  sharedWithTeams: ["platform-team", "security-team"],
  usage: [
    {
      type: "mcp_server",
      id: "mcp-github",
      name: "GitHub MCP",
      location: "Agents > Tools",
      detail: "env: GITHUB_TOKEN",
    },
    {
      type: "llm_provider",
      id: "openai",
      name: "OpenAI api key",
      location: "Agents > Model Providers",
      detail: "Resolved by provider credential naming convention",
    },
  ],
  storage: {
    metadataCollection: "credential_secret_refs",
    payloadCollection: "credential_encrypted_payloads",
    encryption: "AES-256-GCM envelope encryption",
    plaintextReadableByBrowser: false,
    valuePreviewAvailable: true,
  },
  createdAt: "2026-06-20T12:00:00.000Z",
  updatedAt: "2026-06-20T02:00:00.000Z",
  rotatedAt: "2026-06-20T02:00:00.000Z",
};

async function fulfillJson(route: Route, body: unknown, status = 200): Promise<void> {
  await route.fulfill({
    status,
    contentType: "application/json",
    body: JSON.stringify(body),
  });
}

test.describe("RBAC e2e — credential secrets management", () => {
  const shareRequests: Array<{ action?: string; teamId?: string }> = [];
  const rotateRequests: Array<{ action?: string; value?: string }> = [];
  const deleteRequests: string[] = [];

  test.beforeEach(async ({ page }) => {
    shareRequests.length = 0;
    rotateRequests.length = 0;
    deleteRequests.length = 0;

    await page.route("**/api/rbac/admin-tab-gates", async (route) => {
      await fulfillJson(route, {
        gates: {
          credentials: true,
          teams: true,
          users: true,
          health: true,
          metrics: true,
          migrations: true,
          openfga: true,
          service_accounts: true,
        },
      });
    });

    await page.route("**/api/admin/platform-config", async (route) => {
      await fulfillJson(route, {
        success: true,
        data: {
          release_notes: {
            enabled: false,
            release_version: "0.5.16",
          },
        },
      });
    });

    await page.route("**/api/admin/credentials/secrets**", async (route) => {
      const request = route.request();
      const path = new URL(request.url()).pathname;
      if (path === "/api/admin/credentials/secrets" && request.method() === "GET") {
        await fulfillJson(route, { success: true, data: [secretFixture] });
        return;
      }
      await route.continue();
    });

    await page.route("**/api/admin/credentials/oauth-connectors", async (route) => {
      await fulfillJson(route, { success: true, data: [] });
    });

    await page.route("**/api/admin/credentials/audit", async (route) => {
      await fulfillJson(route, {
        success: true,
        data: [
          {
            action: "credential.create",
            result: "success",
            ts: "2026-06-20T01:00:00.000Z",
            actor: {
              type: "user",
              id: "alice-sub",
              email: "alice@example.test",
              name: "Alice Example",
            },
            resource: { type: "secret_ref", id: "secret-github" },
          },
          {
            action: "credential.rotate",
            result: "success",
            ts: "2026-06-20T02:00:00.000Z",
            actor: { type: "user", id: "mallory-sub", email: "mallory@example.test" },
            resource_ref: "secret_ref:secret-other",
          },
        ],
      });
    });

    await page.route("**/api/admin/teams**", async (route) => {
      const request = route.request();
      if (request.method() === "GET") {
        await fulfillJson(route, {
          success: true,
          data: {
            teams: [
              { _id: "team-1", slug: "platform-team", name: "Platform Team" },
              { _id: "team-2", slug: "security-team", name: "Security Team" },
              { _id: "team-3", slug: "ops-team", name: "Ops Team" },
            ],
          },
        });
        return;
      }
      await route.continue();
    });

    await page.route("**/api/credentials/secrets**", async (route) => {
      const request = route.request();
      const path = new URL(request.url()).pathname;
      if (path === "/api/credentials/secrets" && request.method() === "GET") {
        await fulfillJson(route, { success: true, data: [secretFixture] });
        return;
      }
      if (path === "/api/credentials/secrets" && request.method() === "POST") {
        const body = request.postDataJSON() as { name?: string; type?: string };
        await fulfillJson(route, {
          success: true,
          data: {
            id: "secret-new",
            name: body.name ?? "New secret",
            type: body.type ?? "bearer_token",
            maskedPreview: "e2e_...alue",
            sharedWithTeams: [],
          },
        });
        return;
      }
      if (path === "/api/credentials/secrets/secret-github" && request.method() === "PATCH") {
        const body = request.postDataJSON() as { action?: string; teamId?: string; value?: string };
        if (body.action === "rotate") {
          rotateRequests.push(body);
          await fulfillJson(route, {
            success: true,
            data: {
              ...secretFixture,
              maskedPreview: "rot_...ated",
              rotatedAt: "2026-06-21T18:30:00.000Z",
            },
          });
          return;
        }
        shareRequests.push(body);
        await fulfillJson(route, { success: true, data: { ok: true } });
        return;
      }
      if (path === "/api/credentials/secrets/secret-github" && request.method() === "DELETE") {
        deleteRequests.push("secret-github");
        await fulfillJson(route, { success: true, data: { deleted: true } });
        return;
      }
      await route.continue();
    });
  });

  test("shows global creator, sharing, usage, and protection details without raw values", async ({ page }) => {
    const env = rbacEnvOrSkip();
    await signIn(page, env);

    await page.goto("/admin/platform/credentials", { waitUntil: "domcontentloaded" });
    await dismissReleaseUpgradeDialog(page);

    await expect(page.getByRole("heading", { name: "Secrets" })).toBeVisible({
      timeout: 30_000,
    });
    await expect(page.getByRole("tab", { name: /credential audit/i })).toHaveCount(0);
    await expect(page.getByText("GitHub token")).toBeVisible();
    await expect(page.getByText("Alice Example").first()).toBeVisible();
    await expect(page.getByText("user:alice-sub")).toHaveCount(0);
    await expect(page.getByText("Shared with 2 teams")).toBeVisible();
    await expect(page.getByText("Used in 2 places")).toBeVisible();
    await expect(page.getByText("platform-team")).toHaveCount(0);
    await expect(page.getByText("security-team")).toHaveCount(0);
    await expect(page.getByText(/GitHub MCP/)).toHaveCount(0);
    await expect(page.getByText(/OpenAI api key/)).toHaveCount(0);
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
    await expect(page.getByText("credential.rotate")).toHaveCount(0);
    await expect(page.getByText(RAW_SECRET)).toHaveCount(0);
  });

  test("lets users peek at a new secret before saving", async ({ page }) => {
    const env = rbacEnvOrSkip();
    await signIn(page, env);

    await page.goto("/credentials/secrets", { waitUntil: "domcontentloaded" });
    await dismissReleaseUpgradeDialog(page);

    await expect(page.getByRole("heading", { name: "Saved Secrets" })).toBeVisible({
      timeout: 30_000,
    });
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

  test("shows a personal masked preview with no raw secret preview control", async ({ page }) => {
    const env = rbacEnvOrSkip();
    await signIn(page, env);

    await page.goto("/credentials/secrets", { waitUntil: "domcontentloaded" });
    await dismissReleaseUpgradeDialog(page);

    await expect(page.getByRole("heading", { name: "Saved Secrets" })).toBeVisible({
      timeout: 30_000,
    });
    await page.getByRole("button", { name: /view details for github token/i }).click();

    const dialog = page.getByRole("dialog", { name: /github token details/i });
    await expect(dialog).toBeVisible();
    await dismissReleaseUpgradeDialog(page);
    await expect(dialog).toBeVisible();
    await expect(page.getByText("Preview ghp_...abcd")).toBeVisible();
    await expect(dialog.getByText(/saved value stays protected; this preview is masked/i)).toBeVisible();
    await expect(dialog.getByText(/Masked preview/)).toBeVisible();
    await expect(dialog.getByText("ghp_...abcd")).toBeVisible();
    await expect(dialog.getByText("Alice Example")).toBeVisible();
    await expect(dialog.getByText("user:alice-sub")).toHaveCount(0);
    await expect(dialog.getByText(/Shared with/)).toBeVisible();
    await expect(dialog.getByText("platform-team")).toBeVisible();
    await expect(dialog.getByText("security-team")).toBeVisible();
    await expect(dialog.getByText(/GitHub MCP/)).toBeVisible();
    await expect(dialog.getByText(/credential_secret_refs/)).toHaveCount(0);
    await expect(dialog.getByText(/credential_encrypted_payloads/)).toHaveCount(0);
    await dialog.getByRole("button", { name: /secret protection details/i }).hover();
    await expect(page.getByText(/masked preview is a protected hint/i)).toBeVisible();
    await expect(page.getByText(/never shown in the browser/i)).toBeVisible();
    await expect(page.getByText(/Saved record: credential_secret_refs/)).toHaveCount(0);
    await expect(page.getByText(/Protected value: credential_encrypted_payloads/)).toHaveCount(0);
    await expect(page.getByText(/AES-256-GCM envelope encryption/)).toHaveCount(0);
    await expect(dialog.getByText(RAW_SECRET)).toHaveCount(0);
    await expect(dialog.getByRole("button", { name: /preview|reveal|copy secret/i })).toHaveCount(0);

  });

  test("shares and deletes saved secrets with explicit user actions", async ({ page }) => {
    const env = rbacEnvOrSkip();
    await signIn(page, env);

    await page.goto("/credentials/secrets", { waitUntil: "domcontentloaded" });
    await dismissReleaseUpgradeDialog(page);
    await expect(page.getByText("GitHub token")).toBeVisible({ timeout: 30_000 });

    await page.getByRole("button", { name: /share github token/i }).click();
    const panel = page.getByRole("region", { name: /github token team access/i });
    await expect(panel).toBeVisible();
    await panel.getByRole("combobox", { name: /team access/i }).click();
    await page.getByRole("option", { name: /Ops Team/ }).click();
    await panel.getByRole("button", { name: /grant access/i }).click();
    await expect.poll(() => shareRequests.length).toBe(1);
    expect(shareRequests[0]).toMatchObject({ action: "share", teamId: "ops-team" });

    await page.getByRole("button", { name: /delete github token/i }).click();
    await expect(page.getByText("Delete GitHub token?")).toBeVisible();
    await expect.poll(() => deleteRequests.length).toBe(0);
    await page.getByRole("button", { name: /confirm delete github token/i }).click();
    await expect.poll(() => deleteRequests).toEqual(["secret-github"]);
    await expect(page.getByText("GitHub token")).toHaveCount(0);
  });

  test("rotates a saved secret with a pre-save peek and updates the masked preview", async ({ page }) => {
    const env = rbacEnvOrSkip();
    await signIn(page, env);

    await page.goto("/credentials/secrets", { waitUntil: "domcontentloaded" });
    await dismissReleaseUpgradeDialog(page);
    await expect(page.getByText("GitHub token")).toBeVisible({ timeout: 30_000 });

    await page.getByRole("button", { name: /rotate github token/i }).click();
    const panel = page.getByRole("region", { name: /github token rotation/i });
    await expect(panel).toBeVisible();
    const newValue = panel.locator('input[id^="rotate-secret-value"]');
    await expect(newValue).toHaveAttribute("type", "password");
    await newValue.fill("rotated-secret-value");
    await panel.getByRole("button", { name: /show new secret value before saving/i }).click();
    await expect(newValue).toHaveAttribute("type", "text");
    await expect(newValue).toHaveValue("rotated-secret-value");

    await panel.getByRole("button", { name: /save new value/i }).click();

    await expect.poll(() => rotateRequests).toEqual([
      { action: "rotate", value: "rotated-secret-value" },
    ]);
    await expect(panel).toHaveCount(0);
    await expect(page.getByText("Preview rot_...ated")).toBeVisible();
    await expect(page.getByText("rotated-secret-value")).toHaveCount(0);
  });

  test("returns OAuth relinks to Connected Apps and tests the newest Atlassian connection", async ({ context, page }) => {
    const env = rbacEnvOrSkip();
    const profileChecks: string[] = [];

    await context.route("**/oauth-callback-relay", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "text/html; charset=utf-8",
        body: `<!doctype html>
<html>
  <body>
    <script>
      const message = { type: "caipe.oauth.connection", status: "success", provider: "atlassian" };
      if ("BroadcastChannel" in window) {
        const channel = new BroadcastChannel("caipe.oauth.connection");
        channel.postMessage(message);
        channel.close();
      }
      window.opener?.postMessage(message, window.location.origin);
    </script>
  </body>
</html>`,
      });
    });

    await page.route("**/api/credentials/oauth-connectors", async (route) => {
      await fulfillJson(route, {
        success: true,
        data: [
          {
            id: "atlassian-connector",
            name: "Atlassian Cloud",
            provider: "atlassian",
            enabled: true,
            scopes: [
              "offline_access",
              "read:me",
              "read:jira-work",
              "read:jira-user",
              "write:jira-work",
              "read:confluence-content.all",
              "write:confluence-content",
            ],
          },
        ],
      });
    });

    await page.route("**/api/credentials/connections", async (route) => {
      await fulfillJson(route, {
        success: true,
        data: [
          {
            id: "new-atlassian-connection",
            connectorId: "atlassian-connector",
            provider: "atlassian",
            status: "connected",
            expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
            updatedAt: "2026-06-21T04:44:00.000Z",
            grantedScopes: ["offline_access", "read:me", "read:jira-work", "read:jira-user"],
          },
          {
            id: "old-atlassian-connection",
            connectorId: "atlassian-connector",
            provider: "atlassian",
            status: "connected",
            expiresAt: new Date(Date.now() - 60_000).toISOString(),
            updatedAt: "2026-06-01T04:44:00.000Z",
            grantedScopes: ["offline_access", "read:me", "read:jira-work"],
          },
        ],
      });
    });

    await page.route("**/api/credentials/connections/*/refresh", async (route) => {
      await fulfillJson(route, { success: false, data: { ok: false } }, 404);
    });

    await page.route("**/api/credentials/connections/*/profile", async (route) => {
      const connectionId = new URL(route.request().url()).pathname.split("/").at(-2) ?? "";
      profileChecks.push(connectionId);
      await fulfillJson(route, {
        success: true,
        data: {
          ok: true,
          provider: "atlassian",
          accessible_resources: [{ name: "CAIPE Jira", scopes: ["read:jira-user"] }],
          diagnostics: [
            {
              id: "atlassian_accessible_resources",
              label: "Accessible Atlassian sites",
              status: "passed",
              detail: "CAIPE Jira is accessible.",
              action: "No action needed.",
            },
          ],
        },
      });
    });

    await signIn(page, env);
    await page.goto("/credentials/secrets", { waitUntil: "domcontentloaded" });
    await dismissReleaseUpgradeDialog(page);
    await expect(page.getByRole("heading", { name: "Saved Secrets" })).toBeVisible({
      timeout: 30_000,
    });

    const relayPagePromise = context.waitForEvent("page");
    await page.evaluate(() => {
      window.open("/oauth-callback-relay", "_blank");
    });
    const relayPage = await relayPagePromise;
    await relayPage.waitForLoadState("domcontentloaded");
    await relayPage.close().catch(() => undefined);

    await expect(page).toHaveURL(/\/credentials\/connections$/,{ timeout: 15_000 });
    await expect(page.getByRole("heading", { name: "Connected Apps" })).toBeVisible();
    await expect(page.getByText("Atlassian Cloud")).toBeVisible();
    await expect(page.getByText("healthy")).toBeVisible();
    await expect(page.getByText("expired")).toHaveCount(0);

    await page.getByRole("button", { name: /permissions/i }).click();
    await expect(page.getByRole("checkbox", { name: /read:jira-user/i })).toBeChecked();
    await expect(page.getByRole("checkbox", { name: /write:jira-work/i })).toBeChecked();

    await page.getByRole("button", { name: /test atlassian connection/i }).click();
    await expect(page.getByText(/Atlassian access check passed: CAIPE Jira/i)).toBeVisible();
    expect(profileChecks).toEqual(["new-atlassian-connection"]);
  });

  test("uses end-user-friendly migration copy without release version in the title", async ({ page }) => {
    const env = rbacEnvOrSkip();

    await page.route("**/api/admin/rebac/migrations", async (route) => {
      await fulfillJson(route, {
        success: true,
        data: {
          release: "0.5.8",
          runtime: { migration_release: "0.5.8", manifest_count: 1 },
          schema_versions: [
            { schema_area: "conversations", current_version: 1, target_version: 2, status: "behind" },
          ],
          migrations: [
            {
              id: "conversation_owner_identity_v1",
              title: "Conversation owner identity",
              description: "Normalize conversations",
              kind: "implicit",
              schema_area: "conversations",
              current_version: 1,
              target_version: 2,
              status: "not_started",
              implemented: true,
              confirmation: "MIGRATE conversations TO v2",
              required: true,
            },
          ],
          completed_migrations: [],
        },
      });
    });

    await page.route("**/api/admin/rebac/migrations/status", async (route) => {
      await fulfillJson(route, {
        success: true,
        data: {
          release: "0.5.8",
          runtime: { migration_release: "0.5.8", manifest_count: 1 },
          schema_versions: [
            { schema_area: "conversations", current_version: 1, target_version: 2, status: "behind" },
          ],
          pending_required_count: 1,
          blocking_required_count: 1,
          is_blocking: true,
          override_active: false,
        },
      });
    });

    await signIn(page, env);
    await page.goto("/admin/security/migrations", { waitUntil: "domcontentloaded" });
    await dismissReleaseUpgradeDialog(page);

    await expect(page.getByRole("heading", { name: "Platform Data Updates" })).toBeVisible({
      timeout: 30_000,
    });
    await expect(page.getByRole("heading", { name: /0\.5\.8/i })).toHaveCount(0);
    await expect(page.getByText(/0\.5\.8 Schema Migrations/i)).toHaveCount(0);
    await expect(page.getByText(/Review and apply required data updates/i)).toBeVisible();
    await expect(page.getByText("Update Status")).toBeVisible();
  });
});
