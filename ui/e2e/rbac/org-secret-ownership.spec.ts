// assisted-by claude code claude-sonnet-4-6

import { expect, test, type Page } from "@playwright/test";

import {
  CREDENTIALS_ADMIN_SESSION,
  forceCredentialsFeatureFlags,
  gotoPersonalCredentialsSecrets,
  installCredentialsBrowserMocks,
  type CredentialSecretFixture,
} from "./_credentials-browser-fixtures";
import { installTestSession } from "./_helpers";
import { mockedRbacEnabled } from "./_mocked-rbac";

const MEMBER_SESSION = {
  email: "member@example.test",
  name: "Example Member",
  role: "user" as const,
  canViewAdmin: false,
};

const ORG_SECRET: CredentialSecretFixture = {
  id: "secret-org-monitoring",
  name: "Monitoring API token",
  type: "bearer_token",
  owner: {
    type: "organization",
    id: "example-org",
  },
  maskedPreview: "mon_...abcd",
  sharedWithTeams: [],
};

type Session = typeof CREDENTIALS_ADMIN_SESSION | typeof MEMBER_SESSION;

type SecretRequestFailure = {
  method: "GET" | "POST" | "PATCH" | "DELETE";
  pathname: string;
  error?: string;
  status?: number;
  abort?: boolean;
};

test.beforeEach(() => {
  if (!mockedRbacEnabled()) test.skip();
});

// Personal /credentials is SSR-gated: the API mocks do not satisfy the
// page's server-side session check, so each navigation also needs a signed
// NextAuth session cookie.
function minimalSessionEnv(email: string) {
  return {
    baseUrl: process.env.CAIPE_UI_BASE_URL ?? "http://localhost:3000",
    keycloakUrl: process.env.KEYCLOAK_URL ?? "http://localhost:7080",
    keycloakRealm: process.env.KEYCLOAK_REALM ?? "caipe",
    user: { email, password: "" },
  };
}

async function installPersonalCredentialsSession(
  page: Page,
  session: Session = CREDENTIALS_ADMIN_SESSION,
): Promise<void> {
  test.skip(!process.env.NEXTAUTH_SECRET, "NEXTAUTH_SECRET required for personal /credentials SSR.");
  await installTestSession(page, minimalSessionEnv(session.email), {
    email: session.email,
    subject: session.role === "admin" ? "playwright-admin-sub" : "playwright-member-sub",
    role: session.role,
  });
}

async function failSecretRequest(page: Page, failure: SecretRequestFailure): Promise<void> {
  await page.route("**/api/credentials/secrets**", async (route) => {
    const request = route.request();
    const pathname = new URL(request.url()).pathname;
    if (request.method() !== failure.method || pathname !== failure.pathname) {
      await route.fallback();
      return;
    }

    if (failure.abort) {
      await route.abort("failed");
      return;
    }

    await route.fulfill({
      status: failure.status ?? 500,
      contentType: "application/json",
      body: JSON.stringify({ success: false, error: failure.error }),
    });
  });
}

async function openAndFillCreateDialog(
  page: Page,
  { name, value, organization = false }: { name: string; value: string; organization?: boolean },
): Promise<void> {
  await page.getByRole("button", { name: /add secret/i }).click();
  const dialog = page.getByRole("dialog", { name: "Add Secret" });
  await dialog.getByLabel("Name").fill(name);
  await dialog.getByRole("textbox", { name: "Secret value", exact: true }).fill(value);
  if (organization) {
    await dialog.getByLabel(/Save as organization secret/i).check();
  }
}

function errorToast(page: Page, message: string) {
  return page.getByRole("alert").filter({ hasText: message }).first();
}

function inlineError(page: Page, message: string) {
  return page.locator("p.text-destructive").filter({ hasText: message });
}

test.describe("organization-level secret ownership", () => {
  test("create dialog explains that organization secrets require admin access", async ({ page }) => {
    await forceCredentialsFeatureFlags(page);
    await installCredentialsBrowserMocks(page);
    await installPersonalCredentialsSession(page);
    await gotoPersonalCredentialsSecrets(page);

    await page.getByRole("button", { name: /add secret/i }).click();
    await expect(page.getByLabel(/Save as organization secret/i)).toBeVisible();
    await expect(page.getByText(/available to all org members, requires admin/i)).toBeVisible();
  });

  test("admin creates an organization secret and sees its ownership badge", async ({ page }) => {
    const mocks = await installCredentialsBrowserMocks(page);
    await installPersonalCredentialsSession(page);
    await gotoPersonalCredentialsSecrets(page);

    await openAndFillCreateDialog(page, {
      name: "Organization test secret",
      value: "raw-organization-token",
      organization: true,
    });
    await page.getByRole("dialog", { name: "Add Secret" }).getByRole("button", { name: /save/i }).click();

    await expect.poll(() => mocks.personalCreateRequests).toHaveLength(1);
    expect(mocks.personalCreateRequests[0]).toMatchObject({
      name: "Organization test secret",
      ownerType: "organization",
    });
    await expect(page.getByRole("dialog", { name: "Add Secret" })).toHaveCount(0);
    await expect(page.getByText("Organization test secret")).toBeVisible();
    await expect(page.getByText("Organization", { exact: true })).toBeVisible();
    await expect(page.getByText("raw-organization-token")).toHaveCount(0);
  });

  test("organization-owned secrets show an Organization badge in the list", async ({ page }) => {
    await installCredentialsBrowserMocks(page, {
      secrets: [ORG_SECRET],
    });
    await installPersonalCredentialsSession(page);
    await gotoPersonalCredentialsSecrets(page);

    await expect(page.getByText("Monitoring API token")).toBeVisible();
    await expect(page.getByText("Organization", { exact: true })).toBeVisible();
  });

  test("personal secret creation omits organization ownership", async ({ page }) => {
    const mocks = await installCredentialsBrowserMocks(page);
    await installPersonalCredentialsSession(page);
    await gotoPersonalCredentialsSecrets(page);

    await openAndFillCreateDialog(page, {
      name: "Personal test secret",
      value: "raw-personal-token",
    });
    await page.getByRole("dialog", { name: "Add Secret" }).getByRole("button", { name: /save/i }).click();

    await expect.poll(() => mocks.personalCreateRequests).toHaveLength(1);
    expect(mocks.personalCreateRequests[0]?.ownerType).toBeUndefined();
    await expect(page.getByText("Personal test secret")).toBeVisible();
    await expect(page.getByText("Organization", { exact: true })).toHaveCount(0);
  });

  test("member denial shows an accessible toast and preserves the create form", async ({ page }) => {
    const denial = "Only organization admins can create organization secrets.";
    const mocks = await installCredentialsBrowserMocks(page, {
      isAdmin: false,
      session: MEMBER_SESSION,
    });
    await failSecretRequest(page, {
      method: "POST",
      pathname: "/api/credentials/secrets",
      status: 403,
      error: denial,
    });
    await installPersonalCredentialsSession(page, MEMBER_SESSION);
    await gotoPersonalCredentialsSecrets(page);

    await openAndFillCreateDialog(page, {
      name: "Denied organization secret",
      value: "keep-this-value",
      organization: true,
    });
    const dialog = page.getByRole("dialog", { name: "Add Secret" });
    await dialog.getByRole("button", { name: /save/i }).click();

    await expect(errorToast(page, denial)).toBeVisible();
    await expect(inlineError(page, denial)).toBeVisible();
    await expect(dialog).toBeVisible();
    await expect(dialog.getByLabel("Name")).toHaveValue("Denied organization secret");
    await expect(dialog.getByRole("textbox", { name: "Secret value", exact: true })).toHaveValue(
      "keep-this-value",
    );
    await expect(dialog.getByLabel(/Save as organization secret/i)).toBeChecked();
    expect(mocks.personalCreateRequests).toHaveLength(0);

    await errorToast(page, denial).getByRole("button", { name: "Dismiss notification" }).click();
    await expect(errorToast(page, denial)).toHaveCount(0);
    await expect(inlineError(page, denial)).toBeVisible();
  });

  test("network failure uses a clear fallback and preserves the create form", async ({ page }) => {
    await installCredentialsBrowserMocks(page);
    await failSecretRequest(page, {
      method: "POST",
      pathname: "/api/credentials/secrets",
      abort: true,
    });
    await installPersonalCredentialsSession(page);
    await gotoPersonalCredentialsSecrets(page);

    await openAndFillCreateDialog(page, {
      name: "Retryable secret",
      value: "retry-token-value",
      organization: true,
    });
    const dialog = page.getByRole("dialog", { name: "Add Secret" });
    await dialog.getByRole("button", { name: /save/i }).click();

    await expect(errorToast(page, "Could not save secret")).toBeVisible();
    await expect(inlineError(page, "Could not save secret")).toBeVisible();
    await expect(dialog.getByLabel("Name")).toHaveValue("Retryable secret");
    await expect(dialog.getByRole("textbox", { name: "Secret value", exact: true })).toHaveValue(
      "retry-token-value",
    );
    await expect(dialog.getByLabel(/Save as organization secret/i)).toBeChecked();
  });

  test("initial load failure reports the API error in a toast and inline", async ({ page }) => {
    const message = "Credential service unavailable.";
    await installCredentialsBrowserMocks(page);
    await failSecretRequest(page, {
      method: "GET",
      pathname: "/api/credentials/secrets",
      status: 503,
      error: message,
    });
    await installPersonalCredentialsSession(page);
    await gotoPersonalCredentialsSecrets(page);

    await expect(errorToast(page, message)).toBeVisible();
    await expect(inlineError(page, message)).toBeVisible();
    await expect(page.getByText("Loading secrets...")).toHaveCount(0);
  });

  test("rotate failure keeps the panel and entered replacement value", async ({ page }) => {
    const message = "Credential store rejected the rotation.";
    await installCredentialsBrowserMocks(page);
    await failSecretRequest(page, {
      method: "PATCH",
      pathname: "/api/credentials/secrets/secret-github",
      status: 500,
      error: message,
    });
    await installPersonalCredentialsSession(page);
    await gotoPersonalCredentialsSecrets(page);

    await page.getByRole("button", { name: "Rotate GitHub token" }).click();
    const panel = page.getByRole("region", { name: "GitHub token rotation" });
    await panel
      .getByRole("textbox", { name: "New secret value", exact: true })
      .fill("replacement-token-value");
    await panel.getByRole("button", { name: "Save new value" }).click();

    await expect(errorToast(page, message)).toBeVisible();
    await expect(inlineError(page, message)).toBeVisible();
    await expect(panel).toBeVisible();
    await expect(
      panel.getByRole("textbox", { name: "New secret value", exact: true }),
    ).toHaveValue("replacement-token-value");
    await expect(page.getByText("Preview ghp_...abcd")).toBeVisible();
  });

  test("delete failure keeps the secret and confirmation available for retry", async ({ page }) => {
    const message = "Credential store unavailable; secret was not deleted.";
    await installCredentialsBrowserMocks(page);
    await failSecretRequest(page, {
      method: "DELETE",
      pathname: "/api/credentials/secrets/secret-github",
      status: 503,
      error: message,
    });
    await installPersonalCredentialsSession(page);
    await gotoPersonalCredentialsSecrets(page);

    await page.getByRole("button", { name: "Delete GitHub token" }).click();
    await page.getByRole("button", { name: "Confirm delete GitHub token" }).click();

    await expect(errorToast(page, message)).toBeVisible();
    await expect(inlineError(page, message)).toBeVisible();
    await expect(page.getByText("GitHub token", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Confirm delete GitHub token" })).toBeVisible();
  });
});
