// assisted-by Codex Codex-sonnet-4-6

import { expect, test, type Page } from "@playwright/test";

import { openAddMcpServerEditor } from "./_mcp-browser-fixtures";
import {
  fulfillJson,
  installMockedRbacApp,
  mockedRbacEnabled,
} from "./_mocked-rbac";

type McpServerFixture = {
  _id: string;
  name: string;
  description?: string;
  transport: string;
  endpoint: string;
  enabled: boolean;
  config_driven?: boolean;
  permissions?: {
    can_manage: boolean;
    can_invoke: boolean;
  };
};

const memberSession = {
  email: "member@caipe.local",
  name: "Team Member",
  role: "user" as const,
  canViewAdmin: false,
};

const FULL_ROW_PERMISSIONS = { can_manage: true, can_invoke: true, can_discover: true };
const READ_ONLY_ROW_PERMISSIONS = { can_manage: false, can_invoke: false, can_discover: false };
const INVOKE_ONLY_ROW_PERMISSIONS = { can_manage: false, can_invoke: true, can_discover: true };
const DEFAULT_PLATFORM_ROW_PERMISSIONS = { can_manage: false, can_invoke: false, can_discover: true };
const OWNER_CREATED_ROW_PERMISSIONS = { can_manage: true, can_invoke: true, can_discover: true };

function mcpListResponse(
  items: McpServerFixture[],
  capabilities: { repair_agentgateway: boolean },
) {
  return {
    success: true,
    data: {
      items: items.map((item) => ({
        ...item,
        permissions: item.permissions ?? FULL_ROW_PERMISSIONS,
      })),
      capabilities,
      total: items.length,
      page: 1,
      page_size: 100,
      has_more: false,
    },
  };
}

async function installMcpPermissionMocks(
  page: Page,
  options: {
    servers: McpServerFixture[];
    capabilities?: { repair_agentgateway: boolean };
    isAdmin?: boolean;
    probeErrors?: Record<string, string>;
  },
): Promise<void> {
  const capabilities = options.capabilities ?? { repair_agentgateway: false };

  await installMockedRbacApp(page, {
    isAdmin: options.isAdmin ?? false,
    session: memberSession,
    handlers: [
      async ({ route, path, method }) => {
        if (path === "/api/mcp-servers/agentgateway/discover" && method === "GET") {
          await fulfillJson(route, { success: true, data: { targets: [] } });
          return true;
        }

        if (path === "/api/mcp-servers" && method === "GET") {
          await fulfillJson(route, mcpListResponse(options.servers, capabilities));
          return true;
        }

        if (path === "/api/mcp-servers/probe" && method === "POST") {
          const serverId = new URL(route.request().url()).searchParams.get("id") ?? "";
          const probeError = options.probeErrors?.[serverId];
          if (probeError) {
            await fulfillJson(route, {
              success: true,
              data: {
                server_id: serverId,
                success: false,
                error: probeError,
                tools: [],
              },
            });
            return true;
          }
          await fulfillJson(route, {
            success: true,
            data: {
              server_id: serverId,
              success: true,
              tools: [{ name: "version", namespaced_name: "version", description: "Version" }],
            },
          });
          return true;
        }

        if (path === "/api/mcp-servers/test-tool" && method === "POST") {
          await fulfillJson(route, {
            success: true,
            data: { success: true, status: 200, result: { content: [{ type: "text", text: "ok" }] } },
          });
          return true;
        }

        if (path === "/api/mcp-servers/agentgateway/sync" && method === "POST") {
          await fulfillJson(route, {
            success: true,
            data: { added: [], migrated: [], refreshed: [], summary: { added: 0, migrated: 0 } },
          });
          return true;
        }

        return false;
      },
    ],
  });
}

test.describe("RBAC e2e — MCP server permission gating", () => {
  test.beforeEach(({}, testInfo) => {
    test.skip(
      !mockedRbacEnabled(),
      "Set RUN_RBAC_REGRESSION=1 to run the mocked MCP permission gating regression.",
    );
    void testInfo;
  });

  test("opens the create editor from Add Server without crashing", async ({ page }) => {
    await installMcpPermissionMocks(page, {
      servers: [],
      capabilities: { repair_agentgateway: false },
    });

    await page.goto("/dynamic-agents?tab=mcp-servers", { waitUntil: "domcontentloaded" });
    await expect(page.getByText("No MCP Servers Yet")).toBeVisible();
    await openAddMcpServerEditor(page);
    await expect(page.getByRole("button", { name: "Create Server" })).toBeVisible();
  });

  test("hides repair, probe, test, and delete actions for read-only MCP rows", async ({ page }) => {
    await installMcpPermissionMocks(page, {
      servers: [
        {
          _id: "mcp-read-only",
          name: "Read Only MCP",
          transport: "http",
          endpoint: "http://mcp-read-only:8000/mcp",
          enabled: true,
          permissions: READ_ONLY_ROW_PERMISSIONS,
        },
      ],
      capabilities: { repair_agentgateway: false },
    });

    await page.goto("/dynamic-agents?tab=mcp-servers", { waitUntil: "domcontentloaded" });
    await expect(page.getByText("Read Only MCP")).toBeVisible();
    await expect(page.getByRole("button", { name: /Repair AgentGateway/i })).toHaveCount(0);
    await expect(page.getByRole("button", { name: /Test MCP tools for Read Only MCP/i })).toHaveCount(0);
    await expect(page.getByRole("button", { name: /Delete Read Only MCP/i })).toHaveCount(0);
    await expect(page.getByRole("button", { name: /Probe tools for Read Only MCP/i })).toHaveCount(0);
  });

  test("shows probe but hides test when only can_discover is granted", async ({ page }) => {
    await installMcpPermissionMocks(page, {
      servers: [
        {
          _id: "mcp-discover-only",
          name: "Discover Only MCP",
          transport: "http",
          endpoint: "http://mcp-discover-only:8000/mcp",
          enabled: true,
          permissions: { can_manage: false, can_invoke: false, can_discover: true },
        },
      ],
    });

    await page.goto("/dynamic-agents?tab=mcp-servers", { waitUntil: "domcontentloaded" });
    await expect(page.getByText("Discover Only MCP")).toBeVisible();
    await expect(page.getByRole("button", { name: /Probe tools for Discover Only MCP/i })).toBeVisible();
    await expect(page.getByRole("button", { name: /Test MCP tools for Discover Only MCP/i })).toHaveCount(0);
  });

  test("shows green and amber tool health indicators after probing MCP rows", async ({ page }) => {
    await installMcpPermissionMocks(page, {
      servers: [
        {
          _id: "mcp-healthy",
          name: "Healthy MCP",
          transport: "http",
          endpoint: "http://mcp-healthy:8000/mcp",
          enabled: true,
          permissions: { can_manage: false, can_invoke: false, can_discover: true },
        },
        {
          _id: "mcp-degraded",
          name: "Degraded MCP",
          transport: "http",
          endpoint: "http://mcp-degraded:8000/mcp",
          enabled: true,
          permissions: { can_manage: false, can_invoke: false, can_discover: true },
        },
      ],
      probeErrors: {
        "mcp-degraded": "MCP initialize failed with HTTP 500",
      },
    });

    await page.goto("/dynamic-agents?tab=mcp-servers", { waitUntil: "domcontentloaded" });
    const healthyServer = page.getByRole("group",{ name: "MCP server Healthy MCP" });
    const degradedServer = page.getByRole("group",{ name: "MCP server Degraded MCP" });
    await expect(page.getByText("Healthy MCP")).toBeVisible();
    await expect(page.getByText("Degraded MCP")).toBeVisible();

    await page.getByRole("button", { name: /Probe tools for Healthy MCP/i }).click();
    await expect(healthyServer.getByText("Healthy",{ exact: true })).toBeVisible();
    await expect(page.getByText("1 tool(s) available")).toBeVisible();

    await page.getByRole("button", { name: /Probe tools for Degraded MCP/i }).click();
    await expect(degradedServer.getByText("Degraded",{ exact: true })).toBeVisible();
    await expect(page.getByText("Tool Scan Degraded")).toBeVisible();
    await expect(page.getByText("MCP initialize failed with HTTP 500")).toBeVisible();
  });

  test("shows test action only when can_invoke is granted", async ({ page }) => {
    await installMcpPermissionMocks(page, {
      servers: [
        {
          _id: "mcp-invoke-only",
          name: "Invoke Only MCP",
          transport: "http",
          endpoint: "http://mcp-invoke-only:8000/mcp",
          enabled: true,
          permissions: INVOKE_ONLY_ROW_PERMISSIONS,
        },
      ],
    });

    await page.goto("/dynamic-agents?tab=mcp-servers", { waitUntil: "domcontentloaded" });
    await expect(page.getByText("Invoke Only MCP")).toBeVisible();
    await expect(page.getByRole("button", { name: /Test MCP tools for Invoke Only MCP/i })).toBeVisible();
    await expect(page.getByRole("button", { name: /Probe tools for Invoke Only MCP/i })).toBeVisible();
    await expect(page.getByRole("button", { name: /Delete Invoke Only MCP/i })).toHaveCount(0);
  });

  test("hides test on default platform servers for org members but keeps probe", async ({ page }) => {
    await installMcpPermissionMocks(page, {
      servers: [
        {
          _id: "argocd",
          name: "Argocd",
          transport: "http",
          endpoint: "http://agentgateway:4000/mcp/argocd",
          enabled: true,
          config_driven: true,
          permissions: DEFAULT_PLATFORM_ROW_PERMISSIONS,
        },
      ],
    });

    await page.goto("/dynamic-agents?tab=mcp-servers", { waitUntil: "domcontentloaded" });
    await expect(page.getByText("Argocd", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: /Probe tools for Argocd/i })).toBeVisible();
    await expect(page.getByRole("button", { name: /Test MCP tools for Argocd/i })).toHaveCount(0);
  });

  test("shows test on user-created servers the member owns", async ({ page }) => {
    await installMcpPermissionMocks(page, {
      servers: [
        {
          _id: "mcp-user-created",
          name: "My ArgoCD",
          transport: "http",
          endpoint: "http://mcp-user-created:8000/mcp",
          enabled: true,
          permissions: OWNER_CREATED_ROW_PERMISSIONS,
        },
      ],
    });

    await page.goto("/dynamic-agents?tab=mcp-servers", { waitUntil: "domcontentloaded" });
    await expect(page.getByText("My ArgoCD")).toBeVisible();
    await expect(page.getByRole("button", { name: /Test MCP tools for My ArgoCD/i })).toBeVisible();
    await expect(page.getByRole("button", { name: /Delete My ArgoCD/i })).toBeVisible();
  });

  test("org admin retains test on default platform servers", async ({ page }) => {
    await installMcpPermissionMocks(page, {
      servers: [
        {
          _id: "argocd",
          name: "Argocd",
          transport: "http",
          endpoint: "http://agentgateway:4000/mcp/argocd",
          enabled: true,
          config_driven: true,
          permissions: FULL_ROW_PERMISSIONS,
        },
      ],
      isAdmin: true,
    });

    await page.goto("/dynamic-agents?tab=mcp-servers", { waitUntil: "domcontentloaded" });
    await expect(page.getByText("Argocd", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: /Test MCP tools for Argocd/i })).toBeVisible();
    await expect(page.getByRole("button", { name: /Probe tools for Argocd/i })).toBeVisible();
  });

  test("shows repair AgentGateway only when list capability is granted", async ({ page }) => {
    await installMcpPermissionMocks(page, {
      servers: [
        {
          _id: "mcp-managed",
          name: "Managed MCP",
          transport: "http",
          endpoint: "http://mcp-managed:8000/mcp",
          enabled: true,
          permissions: FULL_ROW_PERMISSIONS,
        },
      ],
      capabilities: { repair_agentgateway: true },
    });

    await page.goto("/dynamic-agents?tab=mcp-servers", { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("button", { name: /Repair AgentGateway/i })).toBeVisible();
    await expect(page.getByRole("button", { name: /Delete Managed MCP/i })).toBeVisible();
  });

  test("opens read-only server details when can_manage is denied", async ({ page }) => {
    await installMcpPermissionMocks(page, {
      servers: [
        {
          _id: "mcp-view-only",
          name: "View Only MCP",
          transport: "http",
          endpoint: "http://mcp-view-only:8000/mcp",
          enabled: true,
          permissions: INVOKE_ONLY_ROW_PERMISSIONS,
        },
      ],
    });

    await page.goto("/dynamic-agents?tab=mcp-servers", { waitUntil: "domcontentloaded" });
    await page.getByText("View Only MCP").click();
    await expect(page.getByText("View MCP Server")).toBeVisible();
    await expect(page.getByRole("button", { name: "Close" })).toBeVisible();
    await expect(page.getByRole("button", { name: /Create Server|Save Changes/i })).toHaveCount(0);
  });
});
