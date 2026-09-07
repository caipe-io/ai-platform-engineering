// assisted-by Codex Codex-sonnet-4-6

import { expect, test } from "@playwright/test";
import { readFile } from "node:fs/promises";
import JSZip from "jszip";

import {
  fulfillJson,
  installMockedRbacApp,
  mockedRbacEnabled,
  type MockRouteHandler,
} from "./_mocked-rbac";

const adminSession = {
  email: "sraradhy@cisco.com",
  name: "Sri Aradhyula",
  role: "admin" as const,
  canViewAdmin: true,
};

function auditRecords() {
  return [
    {
      ts: "2026-06-12T16:28:11.000Z",
      type: "cas_grant",
      outcome: "success",
      user_email: adminSession.email,
      action: "use",
      resource_ref: "agent:agent-private",
      resource_type: "agent",
      resource_id: "agent-private",
      operation: "grant",
      grantee_ref: "user:*",
      caller_ref: `user:${adminSession.email}`,
      component: "cas",
      source: "cas",
      pdp: "openfga",
      decision_via: "tuple",
      reason_code: "OK",
      correlation_id: "corr-grant",
      tenant_id: "default",
      duration_ms: 18,
    },
    {
      ts: "2026-06-12T16:27:54.000Z",
      type: "cas_decision",
      outcome: "deny",
      user_email: "non-manager@caipe.local",
      action: "manage",
      resource_ref: "agent:agent-private",
      resource_type: "agent",
      resource_id: "agent-private",
      component: "cas",
      source: "cas",
      pdp: "openfga",
      decision_via: "openfga",
      reason_code: "NO_CAPABILITY",
      correlation_id: "corr-deny",
      tenant_id: "default",
    },
  ];
}

test.describe("mocked RBAC admin browser regression", () => {
  test.beforeEach(() => {
    test.skip(
      !mockedRbacEnabled(),
      "Set RUN_RBAC_REGRESSION=1 to run the mocked RBAC browser regression.",
    );
  });

  test("audit log expands policy details and downloads the filtered ZIP payload", async ({
    page,
  }) => {
    const records = auditRecords();
    const auditQueries: string[] = [];

    const auditHandler: MockRouteHandler = async ({ route, path, method, url }) => {
      if (path !== "/api/admin/audit-events" || method !== "GET") {
        return false;
      }

      auditQueries.push(url.search);
      const typeFilter = url.searchParams.get("type");
      const filtered = typeFilter
        ? records.filter((record) => record.type === typeFilter)
        : records;

      await fulfillJson(route, {
        records: filtered,
        total: filtered.length,
        page: Number(url.searchParams.get("page") ?? "1"),
        limit: Number(url.searchParams.get("limit") ?? "30"),
      });
      return true;
    };

    await installMockedRbacApp(page, {
      isAdmin: true,
      session: adminSession,
      handlers: [auditHandler],
    });

    await page.goto("/admin/security/rbac-audit", {
      waitUntil: "domcontentloaded",
    });

    await expect(page.getByText("RBAC Audit Log", { exact: true })).toBeVisible();
    await expect(page.getByText("2 events found")).toBeVisible();
    await expect(page.getByText("Granted use on agent agent-private")).toBeVisible();
    await expect(page.getByText("Denied to manage agent agent-private")).toBeVisible();

    await page.getByText("Granted use on agent agent-private").click();
    await expect(page.getByText(/Grantee:\s*user:\*/)).toBeVisible();
    await expect(page.getByText(/Correlation ID:\s*corr-grant/)).toBeVisible();

    const downloadPromise = page.waitForEvent("download");
    await page.getByRole("button", { name: /download audit log/i }).click();
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toMatch(/^rbac-audit-log-.*\.zip$/);

    const downloadPath = await download.path();
    expect(downloadPath).toBeTruthy();
    const zip = await JSZip.loadAsync(await readFile(downloadPath!));
    const auditEvents = JSON.parse(await zip.file("audit-events.json")!.async("string"));
    const manifest = JSON.parse(await zip.file("manifest.json")!.async("string"));
    expect(manifest.record_count).toBe(2);
    expect(auditEvents[0].correlation_id).toBe("corr-grant");

    await page.getByLabel("Audit event type").selectOption("cas_grant");
    await page.getByRole("button", { name: /^Search$/ }).click();

    await expect.poll(() => auditQueries.some((query) => query.includes("type=cas_grant"))).toBe(true);
    await expect(page.getByText("1 event found")).toBeVisible();
    await expect(page.getByText("Denied to manage agent agent-private")).toHaveCount(0);
  });
});
