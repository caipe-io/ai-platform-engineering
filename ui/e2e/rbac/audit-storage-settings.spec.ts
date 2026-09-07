// assisted-by claude code claude-sonnet-4-6
//
// E2E tests for issues #1980 and #1981:
//   #1980 — S3 retention controls and storage usage visibility in admin panel
//   #1981 — Configurable log verbosity with compliance-aligned presets
//
// These are mocked-regression tests: they run without a live backend stack and
// exercise all new UI behaviour introduced by the two features.

import { expect, test } from "@playwright/test";

import {
  fulfillJson,
  installMockedRbacApp,
  mockedRbacEnabled,
  type MockRouteHandler,
} from "./_mocked-rbac";

const adminSession = {
  email: "audit-admin@caipe.local",
  name: "Audit Admin",
  role: "admin" as const,
  canViewAdmin: true,
};

// ─── Mock payloads ────────────────────────────────────────────────────────────

const LOCAL_STORAGE_PAYLOAD = {
  storage: {
    backend: "local",
    audit_bytes: 4_718_592,
    audit_bytes_human: "4.5 MiB",
    local_path: "/var/lib/caipe-audit-service",
    retention_days: 3,
  },
  retention: {
    backend: "local",
    retention_days: 3,
    configurable: false,
    note: "Set AUDIT_SERVICE_LOCAL_RETENTION_DAYS and restart to change.",
  },
  verbosity: {
    verbosity: "minimal",
    label: "Minimal — policy changes only",
    description: "Records cas_grant and cas_reconcile only. Lowest volume; captures policy changes.",
    allowed_types: ["cas_grant", "cas_reconcile"],
    allow_all: false,
    available_presets: [
      { name: "minimal", label: "Minimal — policy changes only", description: "...", allowed_types: ["cas_grant", "cas_reconcile"], allow_all: false },
      { name: "standard", label: "Standard — policy + access decisions + auth", description: "...", allowed_types: ["auth", "cas_decision", "cas_grant", "cas_reconcile", "credential_action"], allow_all: false },
      { name: "verbose", label: "Verbose — all event types", description: "...", allowed_types: [], allow_all: true },
      { name: "il2", label: "IL2 — DoD Impact Level 2", description: "...", allowed_types: ["auth", "cas_decision", "cas_grant", "credential_action"], allow_all: false },
      { name: "il5", label: "IL5 — DoD Impact Level 5 (all events)", description: "...", allowed_types: [], allow_all: true },
      { name: "soc2", label: "SOC 2 — SOC 2 Type II compliance", description: "...", allowed_types: ["agent_delegation", "auth", "cas_decision", "cas_grant", "credential_action"], allow_all: false },
    ],
  },
  errors: [],
};

const S3_STORAGE_PAYLOAD = {
  storage: {
    backend: "s3",
    object_count: 1_842,
    total_bytes: 94_371_840,
    total_bytes_human: "90.0 MiB",
    capped: false,
    bucket: "my-audit-bucket",
    prefix: "audit",
  },
  retention: {
    backend: "s3",
    retention_days: 30,
    configurable: true,
    bucket: "my-audit-bucket",
    prefix: "audit",
  },
  verbosity: {
    verbosity: "soc2",
    label: "SOC 2 — SOC 2 Type II compliance",
    description: "Captures auth, policy changes, access decisions, credentials, and agent delegation for SOC 2.",
    allowed_types: ["agent_delegation", "auth", "cas_decision", "cas_grant", "credential_action"],
    allow_all: false,
    available_presets: LOCAL_STORAGE_PAYLOAD.verbosity.available_presets,
  },
  errors: [],
};

const EMPTY_AUDIT_EVENTS = { records: [], total: 0, page: 1, limit: 30 };

// ─── Route handler factories ──────────────────────────────────────────────────

function makeAuditConfigHandler(storageBackend = "local"): MockRouteHandler {
  return async ({ route, path }) => {
    if (path !== "/api/audit/config") return false;
    await fulfillJson(route, {
      backend: "service",
      readsAvailable: true,
      storageBackend,
      storageLabel: storageBackend === "s3"
        ? "Storage: audit-service -> S3"
        : "Storage: audit-service -> local disk",
    });
    return true;
  };
}

function makeAuditEventsHandler(): MockRouteHandler {
  return async ({ route, path, method }) => {
    if (path !== "/api/admin/audit-events" || method !== "GET") return false;
    await fulfillJson(route, EMPTY_AUDIT_EVENTS);
    return true;
  };
}

function makeStorageHandler(payload: typeof LOCAL_STORAGE_PAYLOAD): MockRouteHandler {
  return async ({ route, path, method }) => {
    if (path !== "/api/admin/audit-storage" || method !== "GET") return false;
    await fulfillJson(route, payload);
    return true;
  };
}

function makeRetentionPutHandler(
  onCalled: (days: number) => void,
  responseOverride?: { status?: number; body?: unknown },
): MockRouteHandler {
  return async ({ route, path, method }) => {
    if (path !== "/api/admin/audit-storage/retention" || method !== "PUT") return false;
    let body: { days?: number } | null = null;
    try {
      body = route.request().postDataJSON() as { days?: number };
    } catch {
      body = null;
    }
    if (body?.days !== undefined) onCalled(body.days);
    if (responseOverride?.status && responseOverride.status >= 400) {
      await fulfillJson(route, responseOverride.body ?? { error: "failed" }, responseOverride.status);
    } else {
      await fulfillJson(route, {
        backend: "s3",
        retention_days: body?.days ?? 0,
        bucket: "my-audit-bucket",
        prefix: "audit",
        note: "S3 lifecycle rule updated.",
      });
    }
    return true;
  };
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function navigateToAuditPage(page: import("@playwright/test").Page) {
  await page.goto("/admin/security/rbac-audit", { waitUntil: "domcontentloaded" });
  await expect(page.getByText("RBAC Audit Log", { exact: true })).toBeVisible();
}

async function openSettingsPanel(page: import("@playwright/test").Page) {
  const settingsBtn = page.getByTestId("audit-storage-settings-toggle");
  await expect(settingsBtn).toBeVisible();
  await settingsBtn.click();
}

// ─── Test suite ───────────────────────────────────────────────────────────────

test.describe("audit storage settings panel (#1980 + #1981)", () => {
  test.beforeEach(() => {
    test.skip(
      !mockedRbacEnabled(),
      "Set RUN_RBAC_REGRESSION=1 to run the mocked RBAC browser regression.",
    );
  });

  test("Settings button is visible in audit tab header", async ({ page }) => {
    await installMockedRbacApp(page, {
      isAdmin: true,
      session: adminSession,
      handlers: [
        makeAuditConfigHandler("local"),
        makeAuditEventsHandler(),
        makeStorageHandler(LOCAL_STORAGE_PAYLOAD),
      ],
    });

    await navigateToAuditPage(page);

    const settingsBtn = page.getByTestId("audit-storage-settings-toggle");
    await expect(settingsBtn).toBeVisible();

    await page.screenshot({
      path: "test-results/screenshots/audit-settings-button-visible.png",
      fullPage: false,
    });
  });

  test("Settings panel opens and shows local disk storage usage", async ({ page }) => {
    await installMockedRbacApp(page, {
      isAdmin: true,
      session: adminSession,
      handlers: [
        makeAuditConfigHandler("local"),
        makeAuditEventsHandler(),
        makeStorageHandler(LOCAL_STORAGE_PAYLOAD),
      ],
    });

    await navigateToAuditPage(page);
    await openSettingsPanel(page);

    // ── Storage Usage section ──
    await expect(page.getByText("Storage Usage", { exact: true })).toBeVisible();
    await expect(page.getByText(/^local$/i)).toBeVisible();
    await expect(page.getByText("4.5 MiB")).toBeVisible();
    await expect(page.getByText("/var/lib/caipe-audit-service")).toBeVisible();

    await page.screenshot({
      path: "test-results/screenshots/audit-storage-local-panel.png",
      fullPage: false,
    });
  });

  test("Settings panel shows local retention as read-only with env-var hint", async ({ page }) => {
    await installMockedRbacApp(page, {
      isAdmin: true,
      session: adminSession,
      handlers: [
        makeAuditConfigHandler("local"),
        makeAuditEventsHandler(),
        makeStorageHandler(LOCAL_STORAGE_PAYLOAD),
      ],
    });

    await navigateToAuditPage(page);
    await openSettingsPanel(page);

    // ── Retention section ──
    await expect(page.getByText("Retention", { exact: true })).toBeVisible();
    await expect(page.getByText("3 days")).toBeVisible();
    await expect(
      page.getByText(/AUDIT_SERVICE_LOCAL_RETENTION_DAYS/),
    ).toBeVisible();
    // No save input for local backend
    await expect(page.getByRole("button", { name: /^Save$/i })).not.toBeVisible();

    await page.screenshot({
      path: "test-results/screenshots/audit-retention-local-readonly.png",
      fullPage: false,
    });
  });

  test("Settings panel shows minimal verbosity preset with allowed types", async ({ page }) => {
    await installMockedRbacApp(page, {
      isAdmin: true,
      session: adminSession,
      handlers: [
        makeAuditConfigHandler("local"),
        makeAuditEventsHandler(),
        makeStorageHandler(LOCAL_STORAGE_PAYLOAD),
      ],
    });

    await navigateToAuditPage(page);
    await openSettingsPanel(page);

    // ── Verbosity section ──
    await expect(page.getByText("Log Verbosity", { exact: true })).toBeVisible();
    await expect(page.getByText("minimal")).toBeVisible();
    await expect(
      page.getByText("Records cas_grant and cas_reconcile only"),
    ).toBeVisible();
    await expect(page.locator("span.font-mono").filter({ hasText: "cas_grant" })).toBeVisible();
    await expect(page.locator("span.font-mono").filter({ hasText: "cas_reconcile" })).toBeVisible();
    await expect(page.getByText(/AUDIT_LOG_VERBOSITY/)).toBeVisible();

    await page.screenshot({
      path: "test-results/screenshots/audit-verbosity-minimal.png",
      fullPage: false,
    });
  });

  test("Settings panel shows S3 backend with object count and editable retention", async ({
    page,
  }) => {
    await installMockedRbacApp(page, {
      isAdmin: true,
      session: adminSession,
      handlers: [
        makeAuditConfigHandler("s3"),
        makeAuditEventsHandler(),
        makeStorageHandler(S3_STORAGE_PAYLOAD),
      ],
    });

    await navigateToAuditPage(page);
    await openSettingsPanel(page);

    // ── Storage Usage — S3 ──
    await expect(page.getByText("1,842")).toBeVisible();
    await expect(page.getByText("90.0 MiB")).toBeVisible();

    // ── Retention — S3 (editable) ──
    await expect(page.getByText("30 days")).toBeVisible();
    const retentionInput = page.getByPlaceholder("days (0 = off)");
    await expect(retentionInput).toBeVisible();
    await expect(page.getByRole("button", { name: /^Save$/i })).toBeVisible();

    await page.screenshot({
      path: "test-results/screenshots/audit-storage-s3-panel.png",
      fullPage: false,
    });
  });

  test("Settings panel shows SOC 2 verbosity preset on S3 config", async ({ page }) => {
    await installMockedRbacApp(page, {
      isAdmin: true,
      session: adminSession,
      handlers: [
        makeAuditConfigHandler("s3"),
        makeAuditEventsHandler(),
        makeStorageHandler(S3_STORAGE_PAYLOAD),
      ],
    });

    await navigateToAuditPage(page);
    await openSettingsPanel(page);

    await expect(page.getByText("soc2")).toBeVisible();
    await expect(
      page.getByText("Captures auth, policy changes, access decisions, credentials, and agent delegation"),
    ).toBeVisible();

    await page.screenshot({
      path: "test-results/screenshots/audit-verbosity-soc2.png",
      fullPage: false,
    });
  });

  test("S3 retention save — success path updates displayed value and shows confirmation", async ({
    page,
  }) => {
    const retentionCallArgs: number[] = [];

    await installMockedRbacApp(page, {
      isAdmin: true,
      session: adminSession,
      handlers: [
        makeAuditConfigHandler("s3"),
        makeAuditEventsHandler(),
        makeStorageHandler(S3_STORAGE_PAYLOAD),
        makeRetentionPutHandler((days) => retentionCallArgs.push(days)),
      ],
    });

    await navigateToAuditPage(page);
    await openSettingsPanel(page);

    await expect(page.getByText("30 days")).toBeVisible();

    const retentionInput = page.getByPlaceholder("days (0 = off)");
    await retentionInput.fill("90");

    const saveBtn = page.getByRole("button", { name: /^Save$/i });
    await expect(saveBtn).toBeEnabled();
    await saveBtn.click();

    await expect(
      page.getByText(/Saved — lifecycle rule set to 90 days/),
    ).toBeVisible();

    expect(retentionCallArgs).toEqual([90]);

    await page.screenshot({
      path: "test-results/screenshots/audit-retention-save-success.png",
      fullPage: false,
    });
  });

  test("S3 retention save — disabling lifecycle rule (days=0)", async ({ page }) => {
    const retentionCallArgs: number[] = [];

    await installMockedRbacApp(page, {
      isAdmin: true,
      session: adminSession,
      handlers: [
        makeAuditConfigHandler("s3"),
        makeAuditEventsHandler(),
        makeStorageHandler(S3_STORAGE_PAYLOAD),
        makeRetentionPutHandler((days) => retentionCallArgs.push(days)),
      ],
    });

    await navigateToAuditPage(page);
    await openSettingsPanel(page);

    const retentionInput = page.getByPlaceholder("days (0 = off)");
    await retentionInput.fill("0");
    await page.getByRole("button", { name: /^Save$/i }).click();

    await expect(
      page.getByText(/Saved — lifecycle rule set to 0 days/),
    ).toBeVisible();

    expect(retentionCallArgs).toEqual([0]);

    await page.screenshot({
      path: "test-results/screenshots/audit-retention-disable.png",
      fullPage: false,
    });
  });

  test("S3 retention save — API error is surfaced in the panel", async ({ page }) => {
    const retentionCallArgs: number[] = [];

    await installMockedRbacApp(page, {
      isAdmin: true,
      session: adminSession,
      handlers: [
        makeAuditConfigHandler("s3"),
        makeAuditEventsHandler(),
        makeStorageHandler(S3_STORAGE_PAYLOAD),
        makeRetentionPutHandler((days) => retentionCallArgs.push(days), {
          status: 400,
          body: { error: "Retention can only be updated for the S3 backend" },
        }),
      ],
    });

    await navigateToAuditPage(page);
    await openSettingsPanel(page);

    const retentionInput = page.getByPlaceholder("days (0 = off)");
    await retentionInput.fill("45");
    await page.getByRole("button", { name: /^Save$/i }).click();

    await expect(page.getByText(/Error:/)).toBeVisible();

    await page.screenshot({
      path: "test-results/screenshots/audit-retention-save-error.png",
      fullPage: false,
    });
  });

  test("Settings panel shows 'Loading…' while audit-storage request is in-flight", async ({
    page,
  }) => {
    let resolveStorage!: (value: unknown) => void;
    const storageGate = new Promise((resolve) => {
      resolveStorage = resolve;
    });

    const slowStorageHandler: MockRouteHandler = async ({ route, path, method }) => {
      if (path !== "/api/admin/audit-storage" || method !== "GET") return false;
      await storageGate;
      await fulfillJson(route, LOCAL_STORAGE_PAYLOAD);
      return true;
    };

    await installMockedRbacApp(page, {
      isAdmin: true,
      session: adminSession,
      handlers: [
        makeAuditConfigHandler("local"),
        makeAuditEventsHandler(),
        slowStorageHandler,
      ],
    });

    await navigateToAuditPage(page);
    await openSettingsPanel(page);

    await expect(page.getByText("Loading…").first()).toBeVisible();

    await page.screenshot({
      path: "test-results/screenshots/audit-storage-loading.png",
      fullPage: false,
    });

    // Unblock the response and verify content appears
    resolveStorage(undefined);
    await expect(page.getByText("4.5 MiB")).toBeVisible();
  });

  test("Settings panel handles audit-storage outage — shows Unavailable for all three sections", async ({
    page,
  }) => {
    // The real BFF returns 200 with null fields + errors[] when audit-service is down.
    const outageStorageHandler: MockRouteHandler = async ({ route, path, method }) => {
      if (path !== "/api/admin/audit-storage" || method !== "GET") return false;
      await fulfillJson(route, {
        storage: null,
        retention: null,
        verbosity: null,
        errors: [
          "storage: audit-service unavailable",
          "retention: audit-service unavailable",
          "verbosity: audit-service unavailable",
        ],
      });
      return true;
    };

    await installMockedRbacApp(page, {
      isAdmin: true,
      session: adminSession,
      handlers: [
        makeAuditConfigHandler("local"),
        makeAuditEventsHandler(),
        outageStorageHandler,
      ],
    });

    await navigateToAuditPage(page);
    await openSettingsPanel(page);

    // All three sections should show "Unavailable" (storageInfo is set but fields are null)
    const unavailableItems = page.getByText("Unavailable");
    await expect(unavailableItems.first()).toBeVisible();
    await expect(unavailableItems).toHaveCount(3);

    await page.screenshot({
      path: "test-results/screenshots/audit-storage-unavailable.png",
      fullPage: false,
    });
  });

  test("Settings panel toggles closed when Settings button is clicked again", async ({ page }) => {
    await installMockedRbacApp(page, {
      isAdmin: true,
      session: adminSession,
      handlers: [
        makeAuditConfigHandler("local"),
        makeAuditEventsHandler(),
        makeStorageHandler(LOCAL_STORAGE_PAYLOAD),
      ],
    });

    await navigateToAuditPage(page);
    await openSettingsPanel(page);

    await expect(page.getByText("Storage Usage", { exact: true })).toBeVisible();

    await page.getByTestId("audit-storage-settings-toggle").click();
    await expect(page.getByText("Storage Usage", { exact: true })).not.toBeVisible();

    await page.screenshot({
      path: "test-results/screenshots/audit-settings-panel-closed.png",
      fullPage: false,
    });
  });

  test("S3 capped scan shows '+ (partial scan)' annotation", async ({ page }) => {
    const cappedPayload = {
      ...S3_STORAGE_PAYLOAD,
      storage: { ...S3_STORAGE_PAYLOAD.storage, object_count: 10_000, capped: true },
    };

    await installMockedRbacApp(page, {
      isAdmin: true,
      session: adminSession,
      handlers: [
        makeAuditConfigHandler("s3"),
        makeAuditEventsHandler(),
        makeStorageHandler(cappedPayload),
      ],
    });

    await navigateToAuditPage(page);
    await openSettingsPanel(page);

    await expect(page.getByText("10,000+")).toBeVisible();
    await expect(page.getByText("partial scan")).toBeVisible();

    await page.screenshot({
      path: "test-results/screenshots/audit-s3-capped-scan.png",
      fullPage: false,
    });
  });

  test("verbose verbosity shows 'all event types' with no type chips", async ({ page }) => {
    const verbosePayload = {
      ...LOCAL_STORAGE_PAYLOAD,
      verbosity: {
        verbosity: "verbose",
        label: "Verbose — all event types",
        description: "Records all event types. Equivalent to the historic default.",
        allowed_types: [],
        allow_all: true,
        available_presets: LOCAL_STORAGE_PAYLOAD.verbosity.available_presets,
      },
    };

    await installMockedRbacApp(page, {
      isAdmin: true,
      session: adminSession,
      handlers: [
        makeAuditConfigHandler("local"),
        makeAuditEventsHandler(),
        makeStorageHandler(verbosePayload),
      ],
    });

    await navigateToAuditPage(page);
    await openSettingsPanel(page);

    await expect(page.getByText("verbose")).toBeVisible();
    await expect(page.getByText("Records all event types")).toBeVisible();
    await expect(page.locator("span.font-mono").filter({ hasText: "cas_grant" })).not.toBeVisible();

    await page.screenshot({
      path: "test-results/screenshots/audit-verbosity-verbose.png",
      fullPage: false,
    });
  });

  test("full panel screenshot — S3 backend with all sections visible", async ({ page }) => {
    await installMockedRbacApp(page, {
      isAdmin: true,
      session: adminSession,
      handlers: [
        makeAuditConfigHandler("s3"),
        makeAuditEventsHandler(),
        makeStorageHandler(S3_STORAGE_PAYLOAD),
      ],
    });

    await navigateToAuditPage(page);
    await openSettingsPanel(page);

    await expect(page.getByText("Storage Usage", { exact: true })).toBeVisible();
    await expect(page.getByText("Retention", { exact: true })).toBeVisible();
    await expect(page.getByText("Log Verbosity", { exact: true })).toBeVisible();

    await page.screenshot({
      path: "test-results/screenshots/audit-full-settings-panel-s3.png",
      fullPage: false,
    });
  });
});
