// assisted-by Codex Codex-sonnet-4-6

import { expect, type Page } from "@playwright/test";

import {
  chooseSearchablePickerOption,
  dismissReleaseUpgradeDialog,
} from "./_helpers";
import {
  fulfillJson,
  installMockedRbacApp,
  postJson,
} from "./_mocked-rbac";

export const MCP_BROWSER_ADMIN_SESSION = {
  email: "admin@caipe.local",
  name: "Platform Admin",
  role: "admin" as const,
  canViewAdmin: true,
};

export const MCP_BROWSER_MEMBER_SESSION = {
  email: "member@caipe.local",
  name: "Team Member",
  role: "user" as const,
  canViewAdmin: false,
};

export const FULL_MCP_ROW_PERMISSIONS = {
  can_manage: true,
  can_invoke: true,
  can_discover: true,
};

export type McpServerRow = {
  _id: string;
  name: string;
  description?: string;
  transport: string;
  endpoint: string;
  enabled: boolean;
  config_driven?: boolean;
  source?: string;
  agentgateway_target_endpoint?: string;
  credential_sources?: Array<Record<string, unknown>>;
  permissions?: {
    can_manage: boolean;
    can_invoke: boolean;
    can_discover: boolean;
  };
};

export type AgentGatewayTargetFixture = {
  id: string;
  name: string;
  endpoint: string;
  target_endpoint?: string;
};

export type McpToolFixture = {
  name: string;
  namespaced_name?: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  input_schema?: Record<string, unknown>;
};

export type TestToolRequestBody = {
  serverId?: string;
  toolName?: string;
  params?: Record<string, unknown>;
};

export type TestToolResponseBody = {
  success: boolean;
  application_success?: boolean;
  status?: number;
  result?: unknown;
  error?: string;
  credential_resolution?: Array<{
    name: string;
    kind: string;
    origin: string;
    provider?: string;
    provider_connection_id?: string;
  }>;
};

export const DEFAULT_AGENTGATEWAY_TARGETS: AgentGatewayTargetFixture[] = [
  {
    id: "jira",
    name: "Jira",
    endpoint: "http://agentgateway:4000/mcp/jira",
    target_endpoint: "http://mcp-jira:8000/mcp",
  },
  {
    id: "argocd",
    name: "ArgoCD",
    endpoint: "http://agentgateway:4000/mcp/argocd",
    target_endpoint: "http://mcp-argocd:8000/mcp",
  },
  {
    id: "mcp-test-github",
    name: "GitHub",
    endpoint: "http://agentgateway:4000/mcp/mcp-test-github",
    target_endpoint: "http://mcp-github:8000/mcp",
  },
];

export const JIRA_MCP_PROBE_TOOLS: McpToolFixture[] = [
  {
    name: "version",
    namespaced_name: "jira-version",
    description: "Return MCP server version metadata",
  },
  {
    name: "search",
    namespaced_name: "jira-search",
    description: "Search Jira issues with JQL",
    inputSchema: {
      type: "object",
      properties: {
        jql: {
          type: "string",
          description: "JQL query string",
        },
        max_results: {
          type: "integer",
          description: "Maximum issues to return",
          default: 10,
        },
      },
      required: ["jql"],
    },
  },
  {
    name: "get_issue",
    namespaced_name: "jira-get_issue",
    description: "Fetch a single issue by key",
    inputSchema: {
      type: "object",
      properties: {
        issue_key: {
          type: "string",
          description: "Issue key such as SRE-10109",
        },
      },
      required: ["issue_key"],
    },
  },
  {
    name: "get_current_user_account_id",
    namespaced_name: "jira-get_current_user_account_id",
    description: "Resolve the current Atlassian account id",
  },
];

export const GITHUB_MCP_GET_ME_TOOLS: McpToolFixture[] = [
  {
    name: "get_me",
    namespaced_name: "github-get_me",
    description: "Return the authenticated GitHub user",
  },
];

export const MCP_BROWSER_GENERIC_USER_SESSION = {
  email: "generic-user@caipe.local",
  name: "Generic User",
  role: "user" as const,
  canViewAdmin: false,
};

export const DEFAULT_GITHUB_MCP_SERVER: McpServerRow = {
  _id: "mcp-github",
  name: "GitHub MCP",
  description: "GitHub via AgentGateway with team-shared PAT",
  transport: "http",
  endpoint: "http://agentgateway:4000/mcp/mcp-test-github",
  enabled: true,
  source: "agentgateway",
  agentgateway_target_endpoint: "http://mcp-github:8000/mcp",
  credential_sources: [
    {
      kind: "secret_ref",
      target: "header",
      name: "Authorization",
      secret_ref: "secret-github-shared",
    },
  ],
  permissions: {
    can_manage: false,
    can_invoke: true,
    can_discover: true,
  },
};

export const DEFAULT_JIRA_MCP_SERVER: McpServerRow = {
  _id: "mcp-jira",
  name: "Jira MCP",
  description: "Atlassian Jira via AgentGateway",
  transport: "http",
  endpoint: "http://agentgateway:4000/mcp/jira",
  enabled: true,
  source: "agentgateway",
  agentgateway_target_endpoint: "http://mcp-jira:8000/mcp",
  credential_sources: [
    {
      kind: "provider_connection",
      target: "header",
      name: "Authorization",
      provider: "atlassian",
      provider_connection_id: "conn-atlassian",
    },
  ],
  permissions: FULL_MCP_ROW_PERMISSIONS,
};

/** Jira MCP server with operator-cleared credentials — upstream pod/env auth only. */
export const JIRA_MCP_UPSTREAM_ONLY_SERVER: McpServerRow = {
  ...DEFAULT_JIRA_MCP_SERVER,
  credential_sources: [],
};

export function mcpServersListPayload(
  items: McpServerRow[],
  capabilities: { repair_agentgateway: boolean } = { repair_agentgateway: false },
) {
  return {
    success: true,
    data: {
      items: items.map((item) => ({
        ...item,
        permissions: item.permissions ?? FULL_MCP_ROW_PERMISSIONS,
      })),
      capabilities,
      total: items.length,
      page: 1,
      page_size: 100,
      has_more: false,
    },
  };
}

/**
 * "Add Server" opens the provider-catalog picker first. Click through its
 * "Blank form" tile to reach the plain create form. No-op when the picker
 * was already dismissed (e.g. a provider tile was just selected, or this
 * runs a second time after the form is already showing).
 */
async function skipCatalogPickerToBlankForm(page: Page): Promise<void> {
  const blankFormTile = page.getByRole("button", { name: /blank form/i });
  const displayNameField = page.getByLabel(/Display Name/i);
  await Promise.race([
    blankFormTile.waitFor({ state: "visible", timeout: 15_000 }),
    displayNameField.waitFor({ state: "visible", timeout: 15_000 }),
  ]);
  if (await blankFormTile.isVisible().catch(() => false)) {
    await blankFormTile.click();
  }
}

export async function waitForAddMcpServerFormReady(page: Page): Promise<void> {
  await dismissReleaseUpgradeDialog(page);
  await expect(page.getByText(/add mcp server/i)).toBeVisible({ timeout: 15_000 });
  await dismissReleaseUpgradeDialog(page);
  await skipCatalogPickerToBlankForm(page);
  await expect(page.getByLabel(/Display Name/i)).toBeVisible({ timeout: 15_000 });
}

export async function fillNewMcpServerBasics(
  page: Page,
  options: { displayName: string; serverId?: string; endpoint?: string },
): Promise<void> {
  await waitForAddMcpServerFormReady(page);
  await page.getByLabel(/Display Name/i).fill(options.displayName);
  if (options.serverId) {
    await page.getByRole("button", { name: /Edit generated name/i }).click({ force: true });
    await page.getByLabel(/Generated name/i).fill(options.serverId);
  }
  if (options.endpoint) {
    await page.getByLabel(/Endpoint URL/i).fill(options.endpoint);
  }
}

export type InstalledMcpBrowserMocks = {
  testToolRequests: TestToolRequestBody[];
  probeRequests: string[];
  createRequests: Array<Record<string, unknown>>;
  updateRequests: Array<{ serverId: string; body: Record<string, unknown> }>;
  endpointProbeRequests: string[];
  discoverRequests: number;
  setTestToolResponder: (responder: (body: TestToolRequestBody) => TestToolResponseBody) => void;
  setProbeTools: (tools: McpToolFixture[]) => void;
  setProbeError: (message: string | null) => void;
};

export type InstallMcpBrowserMocksOptions = {
  servers?: McpServerRow[];
  agentGatewayTargets?: AgentGatewayTargetFixture[];
  probeTools?: McpToolFixture[];
  probeError?: string | null;
  capabilities?: { repair_agentgateway: boolean };
  isAdmin?: boolean;
  session?: typeof MCP_BROWSER_ADMIN_SESSION | typeof MCP_BROWSER_MEMBER_SESSION;
  testToolResponder?: (body: TestToolRequestBody) => TestToolResponseBody;
  secrets?: Array<{ id: string; name: string; type: string; maskedPreview?: string }>;
  providerConnections?: Array<{
    id: string;
    connectorId?: string;
    provider: string;
    status?: string;
  }>;
  oauthConnectors?: Array<{ id: string; name: string; provider: string }>;
};

function defaultTestToolResponse(body: TestToolRequestBody): TestToolResponseBody {
  if (body.toolName === "search") {
    return {
      success: true,
      application_success: true,
      status: 200,
      result: {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              issues: [{ key: "SRE-10109", summary: "Playwright fixture issue" }],
            }),
          },
        ],
      },
      credential_resolution: [
        {
          name: "Authorization",
          kind: "provider_connection",
          origin: "provider_connection",
          provider: "atlassian",
          provider_connection_id: "conn-atlassian",
        },
      ],
    };
  }

  if (body.toolName === "get_issue") {
    return {
      success: true,
      application_success: true,
      status: 200,
      result: {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              key: String(body.params?.issue_key ?? "SRE-10109"),
              fields: { summary: "Fixture issue" },
            }),
          },
        ],
      },
      credential_resolution: [
        {
          name: "Authorization",
          kind: "provider_connection",
          origin: "provider_connection",
          provider: "atlassian",
        },
      ],
    };
  }

  return {
    success: true,
    application_success: true,
    status: 200,
    result: {
      content: [{ type: "text", text: "jira-mcp 1.0.0-playwright" }],
    },
    credential_resolution: [
      {
        name: "Authorization",
        kind: "provider_connection",
        origin: "provider_connection",
        provider: "atlassian",
        provider_connection_id: "conn-atlassian",
      },
    ],
  };
}

export async function installMcpBrowserMocks(
  page: Page,
  options: InstallMcpBrowserMocksOptions = {},
): Promise<InstalledMcpBrowserMocks> {
  const testToolRequests: TestToolRequestBody[] = [];
  const probeRequests: string[] = [];
  const createRequests: Array<Record<string, unknown>> = [];
  const updateRequests: Array<{ serverId: string; body: Record<string, unknown> }> = [];
  const endpointProbeRequests: string[] = [];
  let discoverRequests = 0;

  let servers = [...(options.servers ?? [DEFAULT_JIRA_MCP_SERVER])];
  const agentGatewayTargets = options.agentGatewayTargets ?? DEFAULT_AGENTGATEWAY_TARGETS;
  let probeTools = options.probeTools ?? JIRA_MCP_PROBE_TOOLS;
  let probeError = options.probeError ?? null;
  let testToolResponder = options.testToolResponder ?? defaultTestToolResponse;

  const secrets = [...(options.secrets ?? [])];
  const providerConnections = [...(options.providerConnections ?? [])];
  const oauthConnectors = [...(options.oauthConnectors ?? [])];

  await installMockedRbacApp(page, {
    isAdmin: options.isAdmin ?? true,
    session: options.session ?? MCP_BROWSER_ADMIN_SESSION,
    handlers: [
      async ({ route, path, method }) => {
        if (path === "/api/mcp-servers/agentgateway/discover" && method === "GET") {
          discoverRequests += 1;
          await fulfillJson(route, {
            success: true,
            data: { targets: agentGatewayTargets },
          });
          return true;
        }

        if (path === "/api/mcp-servers/endpoint-probe" && method === "POST") {
          const body = ((await postJson(route)) ?? {}) as { url?: string };
          const url = String(body.url ?? "");
          endpointProbeRequests.push(url);
          await fulfillJson(route, {
            success: true,
            data: {
              attempts: [
                { url, ok: false, status: 404 },
                { url: `${url.replace(/\/$/, "")}/mcp`, ok: true, status: 200 },
              ],
              suggestedUrl: `${url.replace(/\/$/, "")}/mcp`,
            },
          });
          return true;
        }

        if (path === "/api/credentials/secrets" && method === "GET") {
          await fulfillJson(route, { success: true, data: secrets });
          return true;
        }

        if (path === "/api/credentials/connections" && method === "GET") {
          await fulfillJson(route, { success: true, data: providerConnections });
          return true;
        }

        if (path === "/api/credentials/oauth-connectors" && method === "GET") {
          await fulfillJson(route, { success: true, data: oauthConnectors });
          return true;
        }

        if (path === "/api/mcp-servers" && method === "GET") {
          await fulfillJson(
            route,
            mcpServersListPayload(servers, options.capabilities ?? { repair_agentgateway: false }),
          );
          return true;
        }

        if (path === "/api/mcp-servers" && method === "POST") {
          const body = (await postJson(route)) as Record<string, unknown>;
          createRequests.push(body);
          const serverId =
            typeof body.id === "string" && body.id.startsWith("mcp-")
              ? body.id
              : `mcp-${String(body.id ?? "browser-fixture")}`;
          servers = [
            {
              _id: serverId,
              name: String(body.name ?? "Browser Fixture MCP"),
              description: String(body.description ?? ""),
              transport: String(body.transport ?? "http"),
              endpoint: String(body.endpoint ?? ""),
              enabled: true,
              config_driven: false,
              agentgateway_target_endpoint:
                typeof body.agentgateway_target_endpoint === "string"
                  ? body.agentgateway_target_endpoint
                  : undefined,
              credential_sources: Array.isArray(body.credential_sources)
                ? (body.credential_sources as Array<Record<string, unknown>>)
                : undefined,
            },
          ];
          await fulfillJson(route, { success: true, data: servers[0] }, 201);
          return true;
        }

        if (path === "/api/mcp-servers" && method === "PUT") {
          const serverId = new URL(route.request().url()).searchParams.get("id") ?? "";
          const body = (await postJson(route)) as Record<string, unknown>;
          updateRequests.push({ serverId, body });
          const existing = servers.find((server) => server._id === serverId);
          const updated: McpServerRow = {
            ...(existing ?? {
              _id: serverId,
              name: "Browser Fixture MCP",
              transport: "http",
              endpoint: "",
              enabled: true,
            }),
            name: typeof body.name === "string" ? body.name : (existing?.name ?? "Browser Fixture MCP"),
            description:
              typeof body.description === "string" ? body.description : existing?.description,
            transport:
              typeof body.transport === "string" ? body.transport : (existing?.transport ?? "http"),
            endpoint: typeof body.endpoint === "string" ? body.endpoint : (existing?.endpoint ?? ""),
            agentgateway_target_endpoint:
              typeof body.agentgateway_target_endpoint === "string"
                ? body.agentgateway_target_endpoint
                : existing?.agentgateway_target_endpoint,
            credential_sources: Array.isArray(body.credential_sources)
              ? (body.credential_sources as Array<Record<string, unknown>>)
              : body.credential_sources === undefined
                ? existing?.credential_sources
                : [],
          };
          servers = servers.map((server) => (server._id === serverId ? updated : server));
          await fulfillJson(route, { success: true, data: updated });
          return true;
        }

        if (path === "/api/mcp-servers/probe" && method === "POST") {
          const serverId = new URL(route.request().url()).searchParams.get("id") ?? "";
          probeRequests.push(serverId);
          if (probeError) {
            await fulfillJson(route, {
              success: true,
              data: {
                server_id: serverId,
                success: false,
                error: probeError,
              },
            });
            return true;
          }
          await fulfillJson(route, {
            success: true,
            data: {
              server_id: serverId,
              success: true,
              tools: probeTools,
            },
          });
          return true;
        }

        if (path === "/api/mcp-servers/test-tool" && method === "POST") {
          const body = ((await postJson(route)) ?? {}) as TestToolRequestBody;
          testToolRequests.push(body);
          const data = testToolResponder(body);
          await fulfillJson(route, { success: true, data });
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

  return {
    get testToolRequests() {
      return testToolRequests;
    },
    get probeRequests() {
      return probeRequests;
    },
    get createRequests() {
      return createRequests;
    },
    get updateRequests() {
      return updateRequests;
    },
    get endpointProbeRequests() {
      return endpointProbeRequests;
    },
    get discoverRequests() {
      return discoverRequests;
    },
    setTestToolResponder(responder) {
      testToolResponder = responder;
    },
    setProbeTools(tools) {
      probeTools = tools;
    },
    setProbeError(message) {
      probeError = message;
    },
  };
}

export async function gotoMcpServersTab(page: Page): Promise<void> {
  await page.goto("/dynamic-agents?tab=mcp-servers", { waitUntil: "domcontentloaded" });
}

export async function openAddMcpServerEditor(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Add Server" }).first().click();
  await page.getByText("Add MCP Server").waitFor({ state: "visible" });
  await skipCatalogPickerToBlankForm(page);
}

export async function openMcpServerEditor(page: Page, serverName: string): Promise<void> {
  await page.getByText(serverName, { exact: true }).click();
  await page.getByText(/Edit MCP Server|View MCP Server/).waitFor({ state: "visible" });
}

export async function openMcpTestModal(page: Page, serverName: string): Promise<void> {
  await page.getByRole("button", { name: new RegExp(`Test MCP tools for ${serverName}`, "i") }).click();
  await page.getByRole("dialog").waitFor({ state: "visible" });
  await page.getByText("Test MCP tools").waitFor({ state: "visible" });
}

export async function waitForMcpTestToolsLoaded(page: Page): Promise<void> {
  await page.getByText("Loading tools...").waitFor({ state: "hidden", timeout: 15_000 });
  await page.locator("#mcp-test-tool").waitFor({ state: "visible" });
}

export async function selectAgentGatewayTarget(page: Page, targetLabel: string | RegExp): Promise<void> {
  await chooseSearchablePickerOption(
    page,
    page.getByRole("combobox", { name: /agentgateway target/i }),
    targetLabel,
  );
}

/** Reads the currently-selected tool name off the `#mcp-test-tool` AgentPicker trigger. */
export async function mcpTestToolValue(page: Page): Promise<string> {
  return (await page.locator("#mcp-test-tool").innerText()).trim();
}

/** Opens the `#mcp-test-tool` AgentPicker, searches (if given), and picks the named tool. */
export async function selectMcpTestTool(
  page: Page,
  toolName: string,
  { search }: { search?: string } = {},
): Promise<void> {
  await page.locator("#mcp-test-tool").click();
  await page.getByLabel("Search tools...").fill(search ?? toolName);
  await page.getByRole("option", { name: toolName, exact: true }).click();
}
