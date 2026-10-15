import { expect, test } from "@playwright/test";
import { readFile } from "node:fs/promises";
import JSZip from "jszip";
import type { UnifiedAuditEvent } from "@/lib/rbac/types";
import { auditPage } from "./_audit-pages";

import {
  fulfillJson,
  installMockedRbacApp,
  mockedRbacEnabled,
  type MockRouteHandler,
} from "./_mocked-rbac";

const BASE_URL = process.env.E2E_UI_URL ?? "http://localhost:3000";

type AuditRecord = {
  ts: string;
  type: string;
  tenant_id: string;
  subject_hash: string;
  actor_hash?: string;
  actor_ref?: string;
  actor_display?: string;
  subject_display?: string;
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
  duration_ms?: number;
  subject_ref?: string;
  decision_id?: string;
  failed_gate?: string;
  agent_ref?: string;
  gateway_operation?: string;
  count?: number;
  gateway_policy?: string;
  gateway_checks?: UnifiedAuditEvent["gateway_checks"];
};

function baseAuditRecords(): AuditRecord[] {
  return [
    {
      ts: "2026-06-20T13:05:01.000Z",
      type: "cas_decision",
      tenant_id: "default",
      subject_hash: "sha256:alice",
      actor_hash: "sha256:alice",
      subject_display: "alice@example.test",
      actor_display: "alice@example.test",
      user_email: "alice@example.test",
      action: "discover",
      outcome: "deny",
      reason_code: "NO_CAPABILITY",
      correlation_id: "corr-denied-conversation",
      source: "cas",
      component: "cas",
      pdp: "openfga",
      decision_via: "openfga",
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
      actor_display: "admin@example.test",
      subject_display: "admin@example.test",
      user_email: "admin@example.test",
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
      duration_ms: 31,
    },
    {
      ts: "2026-06-20T13:03:12.000Z",
      type: "tool_action",
      tenant_id: "default",
      subject_hash: "sha256:bob",
      actor_hash: "sha256:bob",
      subject_display: "bob@example.test",
      actor_display: "bob@example.test",
      user_email: "bob@example.test",
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

function filterAuditRecords(records: AuditRecord[], url: URL): AuditRecord[] {
  let filtered = records;
  const type = url.searchParams.get("type");
  const outcome = url.searchParams.get("outcome");
  const userEmail = url.searchParams.get("user_email");
  const agentName = url.searchParams.get("agent_name");

  if (type) filtered = filtered.filter((record) => record.type === type);
  if (outcome) filtered = filtered.filter((record) => record.outcome === outcome);
  if (userEmail) filtered = filtered.filter((record) => record.user_email === userEmail);
  if (agentName) filtered = filtered.filter((record) => record.agent_name === agentName);
  for (const field of ["subject_ref", "decision_id", "correlation_id", "resource_ref"] as const) {
    const expected = url.searchParams.get(field);
    if (expected) filtered = filtered.filter((record) => record[field] === expected);
  }
  return filtered;
}

function makeAuditEventsHandler(records: AuditRecord[], queries: URL[]): MockRouteHandler {
  return async ({ route, path, method, url }) => {
    if (path !== "/api/admin/audit-events" || method !== "GET") return false;

    queries.push(new URL(url.toString()));
    const filtered = filterAuditRecords(records, url);
    await fulfillJson(route, auditPage(filtered, url));
    return true;
  };
}

function makeAuditConfigHandler(
  config = {
    backend: "service",
    readsAvailable: true,
    storageBackend: "s3",
    storageLabel: "Storage: S3 s3://caipe-audit/audit",
  },
): MockRouteHandler {
  return async ({ route, path, method }) => {
    if (path !== "/api/audit/config" || method !== "GET") return false;
    await fulfillJson(route, config);
    return true;
  };
}

test.describe("audit log — mocked regression", () => {
  test.beforeEach(() => {
    test.skip(!mockedRbacEnabled(), "Set RUN_RBAC_REGRESSION=1");
  });

  test("sign-in flow completes normally regardless of audit backend", async ({ page }) => {
    const auditErrors: string[] = [];
    page.on("console", (msg) => {
      if (msg.type() === "error" && msg.text().toLowerCase().includes("audit")) {
        auditErrors.push(msg.text());
      }
    });

    await installMockedRbacApp(page);
    await page.goto("/", { waitUntil: "domcontentloaded" });

    await expect(page).not.toHaveURL(/error/);
    expect(auditErrors).toHaveLength(0);
  });

  test("admin page renders without audit errors", async ({ page }) => {
    const auditErrors: string[] = [];
    page.on("console", (msg) => {
      if (msg.type() === "error" && msg.text().toLowerCase().includes("audit")) {
        auditErrors.push(msg.text());
      }
    });

    await installMockedRbacApp(page, { isAdmin: true });
    await page.goto("/admin", { waitUntil: "domcontentloaded" });

    await expect(page).not.toHaveURL(/error/);
    expect(auditErrors).toHaveLength(0);
  });

  test("audit write errors do not surface as UI errors", async ({ page }) => {
    const auditErrors: string[] = [];
    page.on("console", (msg) => {
      if (msg.type() === "error" && msg.text().toLowerCase().includes("audit")) {
        auditErrors.push(msg.text());
      }
    });

    await installMockedRbacApp(page, {
      handlers: [
        async ({ route, path, method }) => {
          if (path === "/api/authz/check" && method === "POST") {
            await route.fulfill({
              status: 200,
              contentType: "application/json",
              body: JSON.stringify({ allowed: true }),
            });
            return true;
          }
          return false;
        },
      ],
    });

    await page.goto("/", { waitUntil: "domcontentloaded" });

    const errorBanner = page.getByRole("alert").filter({ hasText: /error/i });
    await expect(errorBanner).toHaveCount(0);
    expect(auditErrors).toHaveLength(0);
  });

  test("protected route access does not stall waiting for audit write", async ({ page }) => {
    await installMockedRbacApp(page);

    const start = Date.now();
    await page.goto("/", { waitUntil: "domcontentloaded" });
    const elapsed = Date.now() - start;

    expect(elapsed).toBeLessThan(5000);
  });

  test("admin audit reader shows storage source, readable identities, and expanded service event details", async ({
    page,
  }) => {
    const queries: URL[] = [];
    await installMockedRbacApp(page, {
      isAdmin: true,
      handlers: [makeAuditConfigHandler(), makeAuditEventsHandler(baseAuditRecords(), queries)],
    });

    await page.goto("/admin/security/audit?auditTab=decisions", { waitUntil: "domcontentloaded" });
    await page.getByLabel("Audit event type").selectOption("");
    await page.getByLabel("Audit time range").selectOption("5m");

    await expect(page.getByRole("heading", { name: "Security audit", exact: true })).toBeVisible();
    await expect(page.getByText("Storage: S3 s3://caipe-audit/audit")).toBeVisible();
    await expect(page.getByText("3 events on this page")).toBeVisible();
    await expect(page.getByText("alice@example.test").first()).toBeVisible();
    await expect(page.getByText("Denied to discover conversation conv-001")).toBeVisible();
    await expect(page.getByText("Granted use on agent platform-engineer")).toBeVisible();
    await expect(page.getByText("Allowed to invoke MCP tool argocd_list_applications")).toBeVisible();

    await page.getByText("Denied to discover conversation conv-001").click();
    await expect(page.getByText(/Correlation ID:\s*corr-denied-conversation/)).toBeVisible();
    await expect(page.getByText(/Decision Path:\s*Openfga/)).toBeVisible();
    await expect(page.getByText(/Subject:\s*alice@example.test/)).toBeVisible();

    const initialQuery = queries.at(-1)!;
    expect(initialQuery.searchParams.get("window")).toBe("5m");
    expect(initialQuery.searchParams.get("time_resolution")).toBeNull();
    expect(initialQuery.searchParams.get("page")).toBeNull();
    expect(initialQuery.searchParams.get("limit")).toBe("30");
  });

  test("access decisions separate permission denial, unavailable checks and one-count rollups", async ({ page }, testInfo) => {
    const queries: URL[] = [];
    const base: AuditRecord = {
      ts: new Date().toISOString(), type: "cas_decision", tenant_id: "default", subject_hash: "sha256:test-user",
      subject_ref: "user:test-user", subject_display: "test-user@example.com", action: "call", outcome: "deny",
      source: "cas", component: "cas", resource_ref: "tool:example/list", correlation_id: "request-1",
      reason_code: "NO_CAPABILITY", decision_id: "decision-1", failed_gate: "caller_tool", agent_ref: "agent:example",
      gateway_operation: "tools/call",
      actor_ref: "workload:agentgateway",
      gateway_policy: "Caller can use the agent AND agent can call the tool AND caller can call the tool.",
      gateway_checks: [
        { gate: "context", subject_ref: "user:test-user", decision: "ALLOW", reason: "OK" },
        { gate: "gateway", subject_ref: "user:test-user", relation: "can_call", resource_ref: "mcp_gateway:list", decision: "ALLOW", reason: "OK" },
        { gate: "agent", subject_ref: "user:test-user", relation: "can_use", resource_ref: "agent:example", decision: "ALLOW", reason: "OK" },
        { gate: "agent_tool", subject_ref: "agent:example", relation: "can_call", resource_ref: "tool:example/list", decision: "ALLOW", reason: "OK" },
        { gate: "caller_tool", subject_ref: "user:test-user", relation: "can_call", resource_ref: "tool:example/list", decision: "DENY", reason: "NO_CAPABILITY" },
      ],
    };
    await installMockedRbacApp(page, { isAdmin: true, handlers: [makeAuditConfigHandler({ backend: "service", readsAvailable: true, storageBackend: "s3", storageLabel: "Storage: audit-service → S3" }), makeAuditEventsHandler([
      base,
      { ...base, correlation_id: "request-2", decision_id: "decision-2", reason_code: "AUTHZ_UNAVAILABLE", gateway_checks: base.gateway_checks!.map((check, index) => index === 4 ? { ...check, reason: "AUTHZ_UNAVAILABLE" } : check) },
      { ...base, correlation_id: "rollup:example", decision_id: undefined, failed_gate: undefined, outcome: "allow", reason_code: "OK", count: 1 },
    ], queries)] });
    await page.goto("/admin/security/audit?auditTab=decisions&subject_ref=user%3Atest-user");
    await expect(page.getByText("3 events on this page")).toBeVisible();
    await expect(page.getByText("Authorization unavailable: call tool example/list")).toBeVisible();
    await expect(page.getByText("Allowed (rollup): call tool example/list")).toBeVisible();
    await expect(page.getByText("Authorization unavailable", { exact: true })).toHaveClass(/bg-amber-500\/10/);
    await expect(page.getByText("Allowed (rollup)", { exact: true })).toHaveClass(/bg-sky-500\/10/);
    await page.getByText("Denied: call tool example/list").click();
    await expect(page.getByText("decision-1", { exact: true })).toBeVisible();
    await expect(page.getByText(/does not identify a missing team or grant/)).toBeVisible();
    await expect(page.getByText(/Starting principal:/).locator("..")).toHaveText(/user:test-user → agent:example → tool:example\/list/);
    await expect(page.getByText(/Rule at the time:/).locator("..")).toContainText("AND");
    await expect(page.getByText(/Stopped at Caller/)).toBeVisible();
    const checks = page.getByRole("region", { name: "Recorded access chain" }).getByRole("listitem");
    await expect(checks.first()).toHaveClass(/bg-green-500\/10/);
    await expect(checks.last()).toHaveClass(/bg-red-500\/10/);
    await expect(checks.last()).toContainText("Denied");
    await expect(checks.last().getByLabel("Principal: user:test-user", { exact: true })).toHaveClass(/bg-violet-500\/15/);
    await expect(checks.last().getByLabel("Resource: tool:example/list", { exact: true })).toHaveClass(/bg-cyan-500\/10/);
    await expect(checks.last().getByLabel("Action / relation: can_call", { exact: true })).toHaveClass(/bg-muted\/50/);
    await page.getByLabel("Decision ID", { exact: true }).fill("decision-1");
    await page.getByRole("button", { name: "Search", exact: true }).click();
    await expect(page.getByText("1 event on this page")).toBeVisible();
    expect(queries.at(-1)?.searchParams.get("decision_id")).toBe("decision-1");
    expect(queries.at(-1)?.searchParams.get("subject_ref")).toBe("user:test-user");
    await expect(page.getByText(/Authentication failures before CAS/)).toBeVisible();
    await page.getByText("Denied: call tool example/list").click();
    await page.screenshot({ path: testInfo.outputPath("access-decisions-preview.png"), fullPage: true });
    await page.getByText(/does not identify a missing team or grant/).scrollIntoViewIfNeeded();
    await page.screenshot({ path: testInfo.outputPath("access-decisions-detail.png") });
    const chain = page.getByRole("region", { name: "Recorded access chain" });
    await chain.screenshot({ path: testInfo.outputPath("access-decisions-chain-dark.png") });
    const darkText = await checks.first().evaluate((element) => getComputedStyle(element).color);
    await page.evaluate(() => localStorage.setItem("theme", "light"));
    await page.reload({ waitUntil: "domcontentloaded" });
    await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
    await page.getByText("Denied: call tool example/list").click();
    expect(await checks.first().evaluate((element) => getComputedStyle(element).color)).not.toBe(darkText);
    await expect(checks.last()).toContainText("Denied");
    await chain.screenshot({ path: testInfo.outputPath("access-decisions-chain-light.png") });
  });

  test("audit reader sends preset and custom time resolution filters to audit service", async ({
    page,
  }) => {
    const queries: URL[] = [];
    await installMockedRbacApp(page, {
      isAdmin: true,
      handlers: [makeAuditConfigHandler(), makeAuditEventsHandler(baseAuditRecords(), queries)],
    });

    await page.goto("/admin/security/audit?auditTab=decisions", { waitUntil: "domcontentloaded" });
    await page.getByLabel("Audit event type").selectOption("");
    await page.getByLabel("Audit time range").selectOption("5m");
    await expect(page.getByText("3 events on this page")).toBeVisible();

    await page.getByLabel("Audit time range").selectOption("6h");
    await page.getByLabel("Audit event type").selectOption("cas_decision");
    await page.getByLabel("Audit outcome").selectOption("deny");
    await page.getByPlaceholder("User email...").fill("alice@example.test");
    await page.getByRole("button", { name: /^Search$/ }).click();

    await expect(page.getByText("1 event on this page")).toBeVisible();
    const presetQuery = queries.at(-1);
    expect(presetQuery?.searchParams.get("window")).toBe("6h");
    expect(presetQuery?.searchParams.get("time_resolution")).toBeNull();
    expect(presetQuery?.searchParams.get("type")).toBe("cas_decision");
    expect(presetQuery?.searchParams.get("outcome")).toBe("deny");
    expect(presetQuery?.searchParams.get("user_email")).toBe("alice@example.test");

    await page.getByLabel("Audit time range").selectOption("custom");
    await page.locator('input[type="datetime-local"]').first().fill("2026-06-20T08:00");
    await page.locator('input[type="datetime-local"]').nth(1).fill("2026-06-20T14:00");
    await page.getByRole("button", { name: /^Search$/ }).click();

    const customQuery = queries.at(-1);
    expect(customQuery?.searchParams.get("window")).toBeNull();
    expect(customQuery?.searchParams.get("time_resolution")).toBeNull();
    expect(Number.isFinite(Date.parse(customQuery?.searchParams.get("from") ?? ""))).toBe(true);
    expect(Number.isFinite(Date.parse(customQuery?.searchParams.get("to") ?? ""))).toBe(true);
  });

  test("download ZIP exports every filtered audit-service page with manifest metadata", async ({
    page,
  }) => {
    const records = Array.from({ length: 205 }, (_, index): AuditRecord => ({
      ts: new Date(Date.UTC(2026, 5, 20, 12, 0, index % 60)).toISOString(),
      type: index % 2 === 0 ? "cas_grant" : "cas_decision",
      tenant_id: "default",
      subject_hash: `sha256:bulk-${index}`,
      actor_hash: `sha256:bulk-${index}`,
      actor_display: "bulk-auditor@example.test",
      subject_display: "bulk-auditor@example.test",
      user_email: "bulk-auditor@example.test",
      action: index % 2 === 0 ? "use" : "read",
      outcome: index % 2 === 0 ? "success" : "allow",
      correlation_id: `corr-bulk-${index}`,
      source: "cas",
      component: "cas",
      pdp: "openfga",
      resource_ref: `agent:bulk-${index}`,
      resource_type: "agent",
      resource_id: `bulk-${index}`,
    }));
    const queries: URL[] = [];

    await installMockedRbacApp(page, {
      isAdmin: true,
      handlers: [makeAuditConfigHandler(), makeAuditEventsHandler(records, queries)],
    });

    await page.goto("/admin/security/audit?auditTab=decisions", { waitUntil: "domcontentloaded" });
    await page.getByLabel("Audit event type").selectOption("");
    await page.getByLabel("Audit time range").selectOption("5m");
    await expect(page.getByText("30 events on this page")).toBeVisible();

    const downloadPromise = page.waitForEvent("download");
    await page.getByRole("button", { name: /download audit log/i }).click();
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toMatch(/^security-audit-log-.*\.zip$/);

    const downloadPath = await download.path();
    expect(downloadPath).toBeTruthy();
    const zip = await JSZip.loadAsync(await readFile(downloadPath!));
    const auditEvents = JSON.parse(await zip.file("audit-events.json")!.async("string"));
    const manifest = JSON.parse(await zip.file("manifest.json")!.async("string"));

    expect(auditEvents).toHaveLength(205);
    expect(auditEvents[0].correlation_id).toBe("corr-bulk-0");
    expect(auditEvents[204].correlation_id).toBe("corr-bulk-204");
    expect(manifest.format).toBe("raw-json-zip");
    expect(manifest.files).toEqual(["audit-events.json", "manifest.json"]);
    expect(manifest.record_count).toBe(205);
    expect(manifest.record_count).toBe(205);
    expect(manifest.filters.window).toBe("5m");

    const exportQueries = queries.filter((url) => url.searchParams.get("limit") === "200");
    expect(exportQueries.map((url) => url.searchParams.get("cursor"))).toEqual([null, "offset:200"]);
  });

  test("storage outage badge is non-blocking when cached audit reads still return rows", async ({
    page,
  }) => {
    const queries: URL[] = [];
    await installMockedRbacApp(page, {
      isAdmin: true,
      handlers: [
        makeAuditConfigHandler({
          backend: "service",
          readsAvailable: false,
          storageBackend: "unavailable",
          storageLabel: "Storage: audit-service unavailable",
          readsWarning: "audit-service health check failed",
        }),
        makeAuditEventsHandler(baseAuditRecords().slice(0, 1), queries),
      ],
    });

    await page.goto("/admin/security/audit?auditTab=decisions", { waitUntil: "domcontentloaded" });
    await page.getByLabel("Audit event type").selectOption("");
    await page.getByLabel("Audit time range").selectOption("5m");

    await expect(page.getByText("Storage: audit-service unavailable")).toBeVisible();
    await expect(page.getByText("1 event on this page")).toBeVisible();
    await expect(page.getByText("Denied to discover conversation conv-001")).toBeVisible();
    expect(queries.at(-1)?.searchParams.get("limit")).toBe("30");
  });
});

test.describe("audit log — live audit-service e2e", () => {
  test.beforeEach(() => {
    test.skip(
      process.env.RUN_RBAC_E2E !== "1" || process.env.AUDIT_TEST_MODE !== "1",
      "Set RUN_RBAC_E2E=1 and AUDIT_TEST_MODE=1",
    );
  });

  test("drain endpoint is reachable and returns events array", async ({ request }) => {
    const res = await request.get(`${BASE_URL}/api/_test/audit`);
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body).toHaveProperty("events");
    expect(Array.isArray(body.events)).toBe(true);
  });

  test("written events are readable via drain endpoint", async ({ request }) => {
    const ts = new Date().toISOString();
    const tenantId = `playwright-tenant-${Date.now()}`;
    const testEvent = {
      ts,
      type: "auth",
      action: "sign_in",
      outcome: "allow",
      tenant_id: tenantId,
    };

    const postRes = await request.post(`${BASE_URL}/api/_test/audit`, { data: testEvent });
    expect(postRes.status()).toBe(200);

    await new Promise((resolve) => setTimeout(resolve, 500));

    const getRes = await request.get(`${BASE_URL}/api/_test/audit`);
    expect(getRes.status()).toBe(200);
    const body = await getRes.json();
    expect(body.events.length).toBeGreaterThanOrEqual(1);

    const found = body.events.find(
      (e: Record<string, unknown>) =>
        e.type === testEvent.type &&
        e.action === testEvent.action &&
        e.outcome === testEvent.outcome &&
        e.tenant_id === tenantId,
    );
    expect(found).toBeDefined();
  });

  test("multiple event types are written", async ({ request }) => {
    const ts = new Date().toISOString();
    const tenantId = `t1-${Date.now()}`;
    await request.post(`${BASE_URL}/api/_test/audit`, {
      data: { ts, type: "auth", action: "sign_in", outcome: "allow", tenant_id: tenantId },
    });
    await request.post(`${BASE_URL}/api/_test/audit`, {
      data: {
        ts,
        type: "credential_action",
        action: "create",
        outcome: "success",
        tenant_id: tenantId,
      },
    });

    await new Promise((resolve) => setTimeout(resolve, 500));

    const res = await request.get(`${BASE_URL}/api/_test/audit`);
    const body = await res.json();

    const types = body.events
      .filter((e: Record<string, unknown>) => e.tenant_id === tenantId)
      .map((e: Record<string, unknown>) => e.type);
    expect(types).toContain("auth");
    expect(types).toContain("credential_action");
  });

  test("event timestamp is preserved", async ({ request }) => {
    const ts = new Date().toISOString();
    const tenantId = `t1-${Date.now()}`;
    await request.post(`${BASE_URL}/api/_test/audit`, {
      data: { ts, type: "auth", action: "check", outcome: "allow", tenant_id: tenantId },
    });

    await new Promise((resolve) => setTimeout(resolve, 500));

    const res = await request.get(`${BASE_URL}/api/_test/audit`);
    const body = await res.json();

    const found = body.events.find(
      (e: Record<string, unknown>) => e.ts === ts && e.tenant_id === tenantId,
    );
    expect(found).toBeDefined();
    expect(found.ts).toBe(ts);
  });

  test("write errors do not cause 500 on drain endpoint", async ({ request }) => {
    const res = await request.get(`${BASE_URL}/api/_test/audit`);
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body).toHaveProperty("events");
    expect(Array.isArray(body.events)).toBe(true);
  });

  test("concurrent writes do not corrupt the log", async ({ request }) => {
    const ts = new Date().toISOString();
    const action = `concurrent_check_${Date.now()}`;
    const writes = Array.from({ length: 10 }, (_, i) =>
      request.post(`${BASE_URL}/api/_test/audit`, {
        data: {
          ts,
          type: "auth",
          action,
          outcome: "allow",
          tenant_id: `tenant-${i}`,
          index: i,
        },
      }),
    );

    await Promise.all(writes);
    await new Promise((resolve) => setTimeout(resolve, 1000));

    const res = await request.get(`${BASE_URL}/api/_test/audit`);
    const body = await res.json();

    const concurrentEvents = body.events.filter(
      (e: Record<string, unknown>) => e.action === action,
    );
    expect(concurrentEvents).toHaveLength(10);
  });

  test("drain endpoint correctly filters to today's events", async ({ request }) => {
    const ts = new Date().toISOString();
    const action = `today_check_${Date.now()}`;
    await request.post(`${BASE_URL}/api/_test/audit`, {
      data: { ts, type: "auth", action, outcome: "allow", tenant_id: "t1" },
    });

    await new Promise((resolve) => setTimeout(resolve, 500));

    const res = await request.get(`${BASE_URL}/api/_test/audit`);
    const body = await res.json();

    const found = body.events.find(
      (e: Record<string, unknown>) => e.action === action,
    );
    expect(found).toBeDefined();
  });
});
