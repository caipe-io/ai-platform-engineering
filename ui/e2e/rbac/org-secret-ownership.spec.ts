// assisted-by claude code claude-sonnet-4-6

import { expect, test, type Page } from "@playwright/test";

import { CREDENTIALS_ADMIN_SESSION, forceCredentialsFeatureFlags, gotoPersonalCredentialsSecrets, installCredentialsBrowserMocks } from "./_credentials-browser-fixtures";
import type { CredentialSecretFixture } from "./_credentials-browser-fixtures";
import { installTestSession } from "./_helpers";
import { mockedRbacEnabled } from "./_mocked-rbac";

test.beforeEach(() => {
  if (!mockedRbacEnabled()) test.skip();
});

// Personal /credentials is SSR-gated: installCredentialsBrowserMocks() only
// mocks client-side API fetches, not the page's server-side session check.
// Every gotoPersonalCredentialsSecrets() call needs a real signed session
// cookie first — mirrors installPersonalCredentialsSession() in
// credentials-workspace-regression.spec.ts.
function minimalSessionEnv() {
  return {
    baseUrl: process.env.CAIPE_UI_BASE_URL ?? "http://localhost:3000",
    keycloakUrl: process.env.KEYCLOAK_URL ?? "http://localhost:7080",
    keycloakRealm: process.env.KEYCLOAK_REALM ?? "caipe",
    user: { email: CREDENTIALS_ADMIN_SESSION.email, password: "" },
  };
}

async function installPersonalCredentialsSession(page: Page): Promise<void> {
  test.skip(!process.env.NEXTAUTH_SECRET, "NEXTAUTH_SECRET required for personal /credentials SSR.");
  await installTestSession(page, minimalSessionEnv(), {
    email: CREDENTIALS_ADMIN_SESSION.email,
    subject: process.env.RBAC_USER_SUB?.trim() || "playwright-admin-sub",
    role: "admin",
  });
}

const ORG_SECRET: CredentialSecretFixture = {
  id: "secret-org-thousandeyes",
  name: "ThousandEyes API token",
  type: "bearer_token",
  owner: {
    type: "organization",
    id: "example-org",
  },
  maskedPreview: "eye_...abcd",
  sharedWithTeams: [],
};

test.describe("org-level secret ownership", () => {
  test("create dialog shows Save as organization secret checkbox", async ({ page }) => {
    await forceCredentialsFeatureFlags(page);
    await installCredentialsBrowserMocks(page);
    await installPersonalCredentialsSession(page);
    await gotoPersonalCredentialsSecrets(page);

    await page.getByRole("button", { name: /add secret/i }).click();
    await expect(page.getByText(/Save as organization secret/i)).toBeVisible();
  });

  test("checking org checkbox sends ownerType=organization in POST body", async ({ page }) => {
    const mocks = await installCredentialsBrowserMocks(page);
    await installPersonalCredentialsSession(page);
    await gotoPersonalCredentialsSecrets(page);

    const createRequests: Array<Record<string, unknown>> = [];
    await page.route("**/api/credentials/secrets", async (route) => {
      if (route.request().method() === "POST") {
        const body = route.request().postDataJSON();
        createRequests.push(body as Record<string, unknown>);
      }
      await route.fallback();
    });

    await page.getByRole("button", { name: /add secret/i }).click();
    await page.getByLabel(/name/i).fill("Org-level test secret");
    await page.getByRole("textbox", { name: "Secret value" }).fill("raw-token-value");
    await page.getByLabel(/Save as organization secret/i).check();
    await page.getByRole("button", { name: /save/i }).click();

    await expect(async () => {
      expect(createRequests.some((r) => r.ownerType === "organization")).toBe(true);
    }).toPass({ timeout: 5_000 });
    expect(mocks.personalCreateRequests.length).toBeGreaterThanOrEqual(1);
  });

  test("org-owned secrets show Organization badge in the list", async ({ page }) => {
    await installCredentialsBrowserMocks(page, {
      secrets: [ORG_SECRET],
    });
    await installPersonalCredentialsSession(page);
    await gotoPersonalCredentialsSecrets(page);

    await expect(page.getByText("ThousandEyes API token")).toBeVisible();
    await expect(page.getByText("Organization")).toBeVisible();
  });

  test("personal secret creation (unchecked) does not send ownerType", async ({ page }) => {
    await installCredentialsBrowserMocks(page);
    await installPersonalCredentialsSession(page);
    await gotoPersonalCredentialsSecrets(page);

    const createRequests: Array<Record<string, unknown>> = [];
    await page.route("**/api/credentials/secrets", async (route) => {
      if (route.request().method() === "POST") {
        const body = route.request().postDataJSON();
        createRequests.push(body as Record<string, unknown>);
      }
      await route.fallback();
    });

    await page.getByRole("button", { name: /add secret/i }).click();
    await page.getByLabel(/name/i).fill("Personal test secret");
    await page.getByRole("textbox", { name: "Secret value" }).fill("raw-token-value");
    // intentionally leave the org checkbox unchecked
    await page.getByRole("button", { name: /save/i }).click();

    await expect(async () => {
      expect(createRequests.length).toBeGreaterThan(0);
    }).toPass({ timeout: 5_000 });
    expect(createRequests.every((r) => !r.ownerType || r.ownerType === "user")).toBe(true);
  });

  test("org badge absent on user-owned secrets", async ({ page }) => {
    await installCredentialsBrowserMocks(page); // default secret is user-owned
    await installPersonalCredentialsSession(page);
    await gotoPersonalCredentialsSecrets(page);

    await expect(page.getByText("GitHub token")).toBeVisible();
    // The blue "Organization" badge should not appear for a user-owned secret
    await expect(page.locator("text=Organization").first()).not.toBeVisible();
  });
});
