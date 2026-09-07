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
  email: "audit-admin@caipe.local",
  name: "Audit Admin",
  role: "admin" as const,
  canViewAdmin: true,
};

type AuditRecord = {
  ts: string;
  type: string;
  tenant_id: string;
  subject_hash: string;
  user_email?: string;
  action: string;
  outcome: string;
  correlation_id: string;
  source: string;
  component?: string;
  pdp?: string;
  reason_code?: string;
  decision_via?: string;
  resource_ref?: string;
  resource_type?: string;
  resource_id?: string;
  agent_name?: string;
  tool_name?: string;
  actor_hash?: string;
  caller_ref?: string;
  grantee_ref?: string;
  operation?: "grant" | "revoke";
  duration_ms?: number;
};

function serviceAuditRecords(): AuditRecord[] {
  return [
    {
      ts: "2026-06-20T13:05:01.000Z",
      type: "cas_decision",
      tenant_id: "default",
      subject_hash: "sha256:alice",
      user_email: "alice@caipe.local",
      action: "discover",
      outcome: "deny",
      reason_code: "NO_CAPABILITY",
      correlation_id: "corr-denied-conversation",
      source: "cas",
      component: "cas",
      pdp: "openfga",
      decision_via: "tuple",
      resource_ref: "conversation:conv-001",
      resource_type: "conversation",
      resource_id: "conv-001",
      duration_ms: 17,
    },
    {
      ts: "2026-06-20T13:04:43.000Z",
      type: "cas_grant",
      tenant_id: "default",
      subject_hash: "sha256:admin",
      actor_hash: "sha256:admin",
      user_email: adminSession.email,
      action: "use",
      outcome: "success",
      reason_code: "OK",
      correlation_id: "corr-grant-agent",
      source: "cas",
      component: "cas",
      pdp: "openfga",
      resource_ref: "agent:platform-engineer",
      resource_type: "agent",
      resource_id: "platform-engineer",
      caller_ref: `user:${adminSession.email}`,
      grantee_ref: "team:platform",
      operation: "grant",
      duration_ms: 31,
    },
    {
      ts: "2026-06-20T13:03:12.000Z",
      type: "tool_action",
      tenant_id: "default",
      subject_hash: "sha256:bob",
      user_email: "bob@caipe.local",
      action: "invoke",
      outcome: "success",
      correlation_id: "corr-tool-action",
      source: "dynamic_agents",
      component: "dynamic_agents",
      agent_name: "argocd-agent",
      tool_name: "argocd_list_applications",
      resource_ref: "mcp_tool:argocd_list_applications",
      resource_type: "mcp_tool",
      resource_id: "argocd_list_applications",
      duration_ms: 74,
    },
  ];
}

function filterRecords(records: AuditRecord[], url: URL): AuditRecord[] {
  let filtered = records;
  const type = url.searchParams.get("type");
  const outcome = url.searchParams.get("outcome");
  const userEmail = url.searchParams.get("user_email");
  const agentName = url.searchParams.get("agent_name");

  if (type) filtered = filtered.filter((record) => record.type === type);
  if (outcome) filtered = filtered.filter((record) => record.outcome === outcome);
  if (userEmail) filtered = filtered.filter((record) => record.user_email === userEmail);
  if (agentName) filtered = filtered.filter((record) => record.agent_name === agentName);
  return filtered;
}

function makeAuditHandler(records: AuditRecord[], queries: URL[]): MockRouteHandler {
  return async ({ route, path, method, url }) => {
    if (path !== "/api/admin/audit-events" || method !== "GET") {
      return false;
    }

    queries.push(url);
    const page = Number(url.searchParams.get("page") ?? "1");
    const limit = Number(url.searchParams.get("limit") ?? "30");
    const filtered = filterRecords(records, url);
    const start = (page - 1) * limit;
    await fulfillJson(route, {
      records: filtered.slice(start, start + limit),
      total: filtered.length,
      page,
      limit,
    });
    return true;
  };
}

test.describe("audit-service-backed admin audit browser flows", () => {
  test.beforeEach(() => {
    test.skip(
      !mockedRbacEnabled(),
      "Set RUN_RBAC_REGRESSION=1 to run the mocked RBAC browser regression.",
    );
  });

  test("loads service audit events, filters by time/user/type/outcome, and never calls legacy audit endpoints", async ({
    page,
  }) => {
    const records = serviceAuditRecords();
    const auditQueries: URL[] = [];
    const legacyAuditRequests: string[] = [];

    const auditHandler: MockRouteHandler = async (context) => {
      if (
        context.path === "/api/admin/rbac-audit" ||
        context.path.startsWith("/api/admin/audit-logs")
      ) {
        legacyAuditRequests.push(context.path);
        await fulfillJson(context.route, { error: "legacy audit endpoint should not be used" }, 500);
        return true;
      }
      return makeAuditHandler(records, auditQueries)(context);
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
    await expect(page.getByText("3 events found")).toBeVisible();
    await expect(page.getByText("Denied to discover conversation conv-001").first()).toBeVisible();
    await expect(page.getByText("Granted use on agent platform-engineer")).toBeVisible();
    await expect(page.getByText("Allowed to invoke MCP tool argocd_list_applications")).toBeVisible();

    await page.getByText("Denied to discover conversation conv-001").first().click();
    await expect(page.getByText(/Correlation ID:\s*corr-denied-conversation/)).toBeVisible();
    await expect(page.getByText(/Decision Path:\s*OpenFGA tuple/i)).toBeVisible();
    await expect(page.getByText(/Source:\s*cas/)).toBeVisible();
    await expect(page.getByText(/Subject:\s*alice@caipe.local/i)).toBeVisible();

    await page.getByLabel("Audit event type").selectOption("cas_decision");
    await page.getByLabel("Audit outcome").selectOption("deny");
    await page.getByPlaceholder("User email...").fill("alice@caipe.local");
    await page.getByLabel("Audit time range").selectOption("custom");
    await page.locator('input[type="datetime-local"]').first().fill("2026-06-20T08:00");
    await page.locator('input[type="datetime-local"]').nth(1).fill("2026-06-20T14:00");
    await page.getByRole("button", { name: /^Search$/ }).click();

    await expect(page.getByText("1 event found")).toBeVisible();
    await expect(page.getByText("Denied to discover conversation conv-001").first()).toBeVisible();
    await expect(page.getByText("Granted use on agent platform-engineer")).toHaveCount(0);

    const filteredQuery = auditQueries.at(-1);
    expect(filteredQuery?.searchParams.get("type")).toBe("cas_decision");
    expect(filteredQuery?.searchParams.get("outcome")).toBe("deny");
    expect(filteredQuery?.searchParams.get("user_email")).toBe("alice@caipe.local");
    expect(filteredQuery?.searchParams.get("page")).toBe("1");
    expect(filteredQuery?.searchParams.get("limit")).toBe("30");
    expect(Number.isFinite(Date.parse(filteredQuery?.searchParams.get("from") ?? ""))).toBe(true);
    expect(Number.isFinite(Date.parse(filteredQuery?.searchParams.get("to") ?? ""))).toBe(true);
    expect(legacyAuditRequests).toEqual([]);
  });

  test("downloads all filtered audit events across service-backed pages", async ({ page }) => {
    const records = Array.from({ length: 205 }, (_, index): AuditRecord => ({
      ts: new Date(Date.UTC(2026, 5, 20, 12, 0, index % 60)).toISOString(),
      type: index % 2 === 0 ? "cas_grant" : "cas_decision",
      tenant_id: "default",
      subject_hash: `sha256:bulk-${index}`,
      user_email: "bulk-auditor@caipe.local",
      action: index % 2 === 0 ? "use" : "read",
      outcome: index % 2 === 0 ? "success" : "allow",
      correlation_id: `corr-bulk-${index}`,
      source: "cas",
      component: "cas",
      pdp: "openfga",
      resource_ref: `agent:bulk-${index}`,
      resource_type: "agent",
      resource_id: `bulk-${index}`,
      ...(index % 2 === 0 ? { operation: "grant" as const } : {}),
    }));
    const auditQueries: URL[] = [];

    await installMockedRbacApp(page, {
      isAdmin: true,
      session: adminSession,
      handlers: [makeAuditHandler(records, auditQueries)],
    });

    await page.goto("/admin/security/rbac-audit", {
      waitUntil: "domcontentloaded",
    });

    await expect(page.getByText("205 events found")).toBeVisible();

    const downloadPromise = page.waitForEvent("download");
    await page.getByRole("button", { name: /download audit log/i }).click();
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toMatch(/^rbac-audit-log-.*\.zip$/);

    const downloadPath = await download.path();
    expect(downloadPath).toBeTruthy();
    const zip = await JSZip.loadAsync(await readFile(downloadPath!));
    const exportedRecords = JSON.parse(await zip.file("audit-events.json")!.async("string"));
    const manifest = JSON.parse(await zip.file("manifest.json")!.async("string"));
    expect(manifest.total).toBe(205);
    expect(manifest.record_count).toBe(205);
    expect(exportedRecords).toHaveLength(205);
    expect(exportedRecords[0].correlation_id).toBe("corr-bulk-0");
    expect(exportedRecords[204].correlation_id).toBe("corr-bulk-204");

    const exportQueries = auditQueries.filter((url) => url.searchParams.get("limit") === "200");
    expect(exportQueries.map((url) => url.searchParams.get("page"))).toEqual(["1", "2"]);
  });

  test("surfaces audit-service outage as non-destructive UI error and recovers on refresh", async ({
    page,
  }) => {
    const auditQueries: URL[] = [];
    let failNextRead = true;

    const auditHandler: MockRouteHandler = async (context) => {
      if (context.path !== "/api/admin/audit-events" || context.method !== "GET") {
        return false;
      }
      auditQueries.push(context.url);
      if (failNextRead) {
        failNextRead = false;
        await fulfillJson(context.route, { error: "audit-service unavailable" }, 503);
        return true;
      }
      await fulfillJson(context.route, {
        records: serviceAuditRecords().slice(0, 1),
        total: 1,
        page: 1,
        limit: 30,
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

    await expect(page.getByText("audit-service unavailable")).toBeVisible();
    await expect(page.getByRole("button", { name: /^Refresh$/ })).toBeEnabled();

    await page.getByRole("button", { name: /^Refresh$/ }).click();
    await expect(page.getByText("1 event found")).toBeVisible();
    await expect(page.getByText("Denied to discover conversation conv-001").first()).toBeVisible();
    expect(auditQueries).toHaveLength(2);
  });
});
