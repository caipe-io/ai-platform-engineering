// assisted-by Codex Codex-sonnet-4-6
import { test, expect, type Page } from "@playwright/test";
import {
  fulfillJson,
  installMockedRbacApp,
  mockedRbacEnabled,
} from "./_mocked-rbac";
import { dismissReleaseUpgradeDialog } from "./_helpers";

type CapabilityStatus = "healthy" | "degraded" | "down" | "disabled";

type Capability = {
  id: string;
  label: string;
  group: "runtime" | "knowledge" | "identity" | "observability" | "messaging";
  status: CapabilityStatus;
  required: boolean;
  description: string;
  detail: string;
  latency_ms: number | null;
};

type DiagnosticProbe = {
  id: string;
  label: string;
  group: "runtime" | "identity" | "storage" | "knowledge" | "bootstrap" | "observability";
  status: "healthy" | "warning" | "down";
  detail: string;
  target: string;
  latency_ms: number | null;
  remediation?: {
    label: string;
    href: string;
    description: string;
  };
};

const HEALTHY_CAPABILITIES: Capability[] = [
  {
    id: "chat-runtime",
    label: "Chat Runtime",
    group: "runtime",
    status: "healthy",
    required: true,
    description: "Checks the runtime health endpoint used by the chat experience.",
    detail: "Chat runtime reachable",
    latency_ms: 12,
  },
  {
    id: "dynamic-agents",
    label: "Dynamic Agents",
    group: "runtime",
    status: "healthy",
    required: true,
    description: "Checks Dynamic Agents when custom agent runtime is enabled.",
    detail: "Runtime reachable",
    latency_ms: 14,
  },
  {
    id: "knowledge-bases",
    label: "Knowledge Bases",
    group: "knowledge",
    status: "healthy",
    required: false,
    description: "Checks the RAG API used by Knowledge Bases.",
    detail: "RAG API reachable",
    latency_ms: 18,
  },
  {
    id: "authentication",
    label: "Authentication",
    group: "identity",
    status: "healthy",
    required: false,
    description: "Reads the UI SSO configuration.",
    detail: "SSO enabled",
    latency_ms: null,
  },
  {
    id: "metrics",
    label: "Metrics",
    group: "observability",
    status: "disabled",
    required: false,
    description: "Reads the UI Prometheus configuration.",
    detail: "Prometheus not configured",
    latency_ms: null,
  },
  {
    id: "audit-service",
    label: "Audit Service",
    group: "observability",
    status: "healthy",
    required: false,
    description: "Collects and serves durable audit events.",
    detail: "backend=local; queue 0/10000; failed_flushes=0; rejected_events=0; last_flush=2026-06-25T12:00:00Z",
    latency_ms: 16,
  },
];

const HEALTHY_PROBES: DiagnosticProbe[] = [
  {
    id: "keycloak",
    label: "Keycloak",
    group: "identity",
    status: "healthy",
    detail: "HTTP 200",
    target: "http://keycloak:7080/realms/caipe/protocol/openid-connect/certs",
    latency_ms: 25,
  },
  {
    id: "openfga",
    label: "OpenFGA",
    group: "identity",
    status: "healthy",
    detail: "HTTP 200",
    target: "http://openfga:8080/healthz",
    latency_ms: 16,
  },
  {
    id: "openfga-authz-bridge",
    label: "OpenFGA Bridge",
    group: "identity",
    status: "healthy",
    detail: "TCP connection accepted",
    target: "openfga-authz-bridge:9100",
    latency_ms: 14,
  },
  {
    id: "rag-server",
    label: "RAG Server",
    group: "knowledge",
    status: "healthy",
    detail: "HTTP 200",
    target: "http://rag-server:9446/healthz",
    latency_ms: 20,
  },
  {
    id: "audit-service",
    label: "Audit Service",
    group: "observability",
    status: "healthy",
    detail: "HTTP 200",
    target: "http://audit-service:8010/v1/audit/status",
    latency_ms: 16,
  },
];

function healthResponse(capabilities: Capability[] = HEALTHY_CAPABILITIES, probes: DiagnosticProbe[] = HEALTHY_PROBES) {
  const healthy = capabilities.filter((capability) => capability.status === "healthy").length;
  const degraded = capabilities.filter((capability) => capability.status === "degraded").length;
  const down = capabilities.filter((capability) => capability.status === "down").length;
  const disabled = capabilities.filter((capability) => capability.status === "disabled").length;
  const probeWarning = probes.filter((probe) => probe.status === "warning").length;
  const probeDown = probes.filter((probe) => probe.status === "down").length;
  const requiredDown = capabilities.some(
    (capability) => capability.required && capability.status === "down",
  );

  return {
    status: requiredDown ? "down" : degraded > 0 ? "degraded" : "healthy",
    checked_at: new Date().toISOString(),
    summary: { total: capabilities.length, healthy, degraded, down, disabled },
    capabilities,
    probe_summary: {
      total: probes.length,
      healthy: probes.length - probeWarning - probeDown,
      warning: probeWarning,
      down: probeDown,
    },
    probes,
  };
}

async function setupWithHealth(page: Page, body = healthResponse()) {
  const requests = { health: 0 };
  await installMockedRbacApp(page, {
    isAdmin: true,
    handlers: [
      async ({ route, path }) => {
        if (path === "/api/platform/health") {
          requests.health += 1;
          await fulfillJson(route, body, body.status === "down" ? 503 : 200);
          return true;
        }
        if (path === "/api/admin/metrics") {
          await fulfillJson(route, {
            success: false,
            code: "PROMETHEUS_NOT_CONFIGURED",
            error: "Prometheus not configured",
          });
          return true;
        }
        if (path === "/api/rag/healthz" || path === "/api/rag/health") {
          await fulfillJson(route, {
            status: "healthy",
            config: {
              graph_rag_enabled: false,
              cleanup: {
                enabled: true,
                interval_seconds: 86400,
                last_cleanup: null,
              },
            },
          });
          return true;
        }
        return false;
      },
    ],
  });
  await page.goto("/");
  await dismissReleaseUpgradeDialog(page);
  await page.waitForLoadState("networkidle");
  return requests;
}

test.describe("Platform Health page", () => {
  test.beforeEach(() => {
    if (!mockedRbacEnabled()) {
      test.skip(true, "Set RUN_RBAC_E2E=1 to run platform health e2e tests.");
    }
  });

  test("checks platform health only on the admin Health page", async ({ page }) => {
    const requests = await setupWithHealth(page);

    await expect(
      page.getByRole("button", { name: /system status:/i }),
    ).toHaveCount(0);
    expect(requests.health).toBe(0);

    await page.goto("/admin/operations/health");
    await dismissReleaseUpgradeDialog(page);
    await expect(page).toHaveURL(/\/admin\/operations\/health$/);
    await expect.poll(() => requests.health).toBeGreaterThan(0);
    await expect(page.getByText("System Status: Healthy")).toBeVisible();
    await expect(page.getByText("Chat Runtime", { exact: true })).toBeVisible();
    await expect(page.getByText("Audit Service")).toBeVisible();
    await expect(
      page
        .getByRole("navigation",{ name: "Admin sections" })
        .getByRole("link",{ exact: true,name: "Health" }),
    ).toHaveAttribute("aria-current","page");
  });

  test("audit-service capability degradation is visible but non-blocking", async ({ page }) => {
    const capabilities = HEALTHY_CAPABILITIES.map((capability) =>
      capability.id === "audit-service"
        ? {
            ...capability,
            status: "degraded" as const,
            detail:
              "queue worker is not running; last error: S3 write failed; backend=s3; queue 9000/10000; failed_flushes=2; rejected_events=0; last_flush=never",
          }
        : capability,
    );
    await setupWithHealth(page, healthResponse(capabilities));

    await page.goto("/admin/operations/health");
    await dismissReleaseUpgradeDialog(page);
    await expect(page.getByText("Platform Capabilities", { exact: true })).toBeVisible();
    await expect(page.getByText("Audit Service")).toBeVisible();
    await expect(page.getByText(/last error: S3 write failed/)).toBeVisible();
    await expect(page.getByText("System Status: Degraded")).toBeVisible();
  });

  test("audit-service local disk pressure is visible in Admin Health", async ({ page }) => {
    const capabilities = HEALTHY_CAPABILITIES.map((capability) =>
      capability.id === "audit-service"
        ? {
            ...capability,
            status: "degraded" as const,
            detail:
              "storage warning: local disk 92.0% used (8.0 GiB free); backend=local; queue 0/10000; storage=local disk 92.0% used (8.0 GiB free); failed_flushes=0; rejected_events=0; last_flush=2026-06-25T12:00:00Z",
          }
        : capability,
    );
    await setupWithHealth(page, healthResponse(capabilities));

    await page.goto("/admin/operations/health");
    await dismissReleaseUpgradeDialog(page);

    await expect(page.getByText("System Status: Degraded")).toBeVisible();
    await expect(page.getByText("Audit Service")).toBeVisible();
    await expect(page.getByText(/local disk 92\.0% used/)).toBeVisible();
  });

  test("optional capability failure degrades without marking the platform down", async ({ page }) => {
    const capabilities = HEALTHY_CAPABILITIES.map((capability) =>
      capability.id === "knowledge-bases"
        ? {
            ...capability,
            status: "degraded" as const,
            detail: "Knowledge Bases health check returned HTTP 503",
          }
        : capability,
    );
    await setupWithHealth(page, healthResponse(capabilities));

    await page.goto("/admin/operations/health");
    await dismissReleaseUpgradeDialog(page);
    await expect(page.getByText("System Status: Degraded")).toBeVisible();
    await expect(
      page.getByRole("button", {
        name: "Inspect Knowledge Bases health details",
      }),
    ).toBeVisible();
    await expect(page.getByText("Knowledge Bases health check returned HTTP 503")).toBeVisible();
    await expect(page.getByText(/need attention/i)).toHaveCount(0);
  });

  test("required chat runtime failure marks the platform down", async ({ page }) => {
    const capabilities = HEALTHY_CAPABILITIES.map((capability) =>
      capability.id === "chat-runtime"
        ? {
            ...capability,
            status: "down" as const,
            detail: "Chat runtime health check returned HTTP 503",
          }
        : capability,
    );
    await setupWithHealth(page, healthResponse(capabilities));

    await page.goto("/admin/operations/health");
    await dismissReleaseUpgradeDialog(page);
    await expect(page.getByText("System Status: Down")).toBeVisible();
    await expect(page.getByText("Chat Runtime", { exact: true })).toBeVisible();
    await expect(page.getByText("Chat runtime health check returned HTTP 503")).toBeVisible();
  });

  test("admin Health tab shows capabilities, not integration diagnostics", async ({ page }) => {
    await setupWithHealth(page);

    await page.goto("/admin/operations/health");
    await dismissReleaseUpgradeDialog(page);

    await expect(
      page
        .getByRole("navigation",{ name: "Admin sections" })
        .getByRole("link",{ exact: true,name: "Health" }),
    ).toHaveAttribute("aria-current","page");
    await expect(page.getByText("Platform Capabilities", { exact: true })).toBeVisible();
    await expect(page.getByText("Chat Runtime", { exact: true })).toBeVisible();
    await expect(page.getByText("Checks the runtime health endpoint used by the chat experience.")).toBeVisible();
    await page.getByRole("button", { name: /inspect authentication health details/i }).click();
    await expect(page.getByRole("dialog", { name: "Authentication" })).toBeVisible();
    await expect(page.getByText("Upstream Probes", { exact: true })).toBeVisible();
    await expect(page.getByText("Keycloak", { exact: true })).toBeVisible();
    await expect(page.getByText("OpenFGA", { exact: true })).toBeVisible();
    await expect(page.getByText("OpenFGA Bridge", { exact: true })).toBeVisible();
    await expect(page.getByText("Slack Integration")).toHaveCount(0);
    await expect(page.getByText("Webex Integration")).toHaveCount(0);
    await expect(page.getByText("All dependency checks are passing.")).toHaveCount(0);
  });
});
