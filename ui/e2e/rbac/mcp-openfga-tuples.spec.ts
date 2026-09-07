// assisted-by Codex Codex-sonnet-4-6

import { expect, test, type Page } from "@playwright/test";

import { chooseSearchablePickerOption } from "./_helpers";
import { openAddMcpServerEditor } from "./_mcp-browser-fixtures";
import {
  fulfillJson,
  installMockedRbacApp,
  mockedRbacEnabled,
  postJson,
} from "./_mocked-rbac";

const adminSession = {
  email: "user@example.com",
  name: "Example User",
  role: "admin" as const,
  canViewAdmin: true,
};

const DEFAULT_MCP_ROW_PERMISSIONS = { can_manage: true, can_invoke: true, can_discover: true };

async function fillNewMcpServerBasics(
  page: Page,
  options: { displayName: string; serverId?: string; endpoint?: string },
): Promise<void> {
  await page.getByLabel(/Display Name/i).fill(options.displayName);
  if (options.serverId) {
    await page.getByRole("button", { name: /Edit generated name/i }).click();
    await page.getByLabel(/Generated name/i).fill(options.serverId);
  }
  if (options.endpoint) {
    await page.getByLabel(/Endpoint URL/i).fill(options.endpoint);
  }
}

function mcpServersListPayload(
  items: Array<Record<string, unknown>>,
  capabilities: { repair_agentgateway: boolean } = { repair_agentgateway: true },
) {
  return {
    success: true,
    data: {
      items: items.map((item) => ({
        ...item,
        permissions: (item.permissions as typeof DEFAULT_MCP_ROW_PERMISSIONS | undefined) ?? DEFAULT_MCP_ROW_PERMISSIONS,
      })),
      capabilities,
      total: items.length,
      page: 1,
      page_size: 100,
      has_more: false,
    },
  };
}

const platformTeam = {
  _id: "team-platform",
  name: "Platform Engineering",
  slug: "platform-engineering",
  owner_id: adminSession.email,
  description: "Platform team fixture",
  member_count: 2,
  // The team-card chips read server-decorated counts (OpenFGA-sourced) now that
  // the legacy `resources` array is gone. The grant lists themselves come from
  // the per-team resources GET below.
  agent_count: 1,
  tool_count: 1,
  tool_wildcard: false,
  can_manage: true,
};

const visibilityTeam = {
  _id: "team-visibility",
  name: "Visibility Team",
  slug: "visibility-team",
  owner_id: adminSession.email,
  description: "OpenFGA-backed team visibility fixture",
  member_count: 4,
  agent_count: 2,
  skill_count: 1,
  workflow_count: 1,
  kb_count: 3,
  tool_count: 2,
  tool_wildcard: false,
  can_manage: true,
};

const wildcardTeam = {
  _id: "team-wildcard",
  name: "Wildcard Team",
  slug: "wildcard-team",
  owner_id: adminSession.email,
  description: "OpenFGA wildcard fixture",
  member_count: 1,
  agent_count: 1,
  skill_count: 0,
  workflow_count: 0,
  kb_count: 0,
  tool_count: 0,
  tool_wildcard: true,
  can_manage: true,
};

type TeamResourcePutBody = {
  agents?: string[];
  agent_admins?: string[];
  tools?: string[];
  tool_wildcard?: boolean;
};

type InstalledTeamMocks = {
  resourcePutBodies: TeamResourcePutBody[];
};

type TeamResourceMockOptions = {
  getResourcesStatus?: number;
  getResourcesError?: string;
  putResourcesStatus?: number;
  putResourcesError?: string;
  putResourcesData?: {
    members_updated?: string[];
    members_skipped?: string[];
  };
};

type TeamResourceFixture = {
  team: typeof platformTeam;
  resources: {
    agents: string[];
    agent_admins: string[];
    tools: string[];
    tool_wildcard: boolean;
    skills?: Array<{ id: string; name: string; description?: string }>;
    workflows?: Array<{ id: string; name: string; description?: string }>;
  };
  available: {
    agents: Array<{ id: string; name: string; description?: string }>;
    tools: Array<{ id: string; name: string; description?: string }>;
  };
};

async function installTeamResourceMocks(
  page: Page,
  fixtures: TeamResourceFixture[] = [
    {
      team: platformTeam,
      resources: {
        agents: ["agent-keep"],
        agent_admins: [],
        tools: ["mcp-confluence-mcp_*"],
        tool_wildcard: false,
      },
      available: {
        agents: [{ id: "agent-keep", name: "Keep Agent", description: "" }],
        tools: [
          {
            id: "mcp-confluence-mcp_*",
            name: "mcp-confluence-mcp_*",
            description: "Confluence MCP",
          },
        ],
      },
    },
  ],
  options: TeamResourceMockOptions = {},
): Promise<InstalledTeamMocks> {
  const resourcePutBodies: TeamResourcePutBody[] = [];
  const fixturesById = new Map(fixtures.map((fixture) => [fixture.team._id, fixture]));

  await installMockedRbacApp(page, {
    isAdmin: true,
    session: adminSession,
    handlers: [
      async ({ route, path, method }) => {
        if (path.startsWith("/api/admin/teams") && method === "GET" && !path.includes("/resources")) {
          await fulfillJson(route, { success: true, data: { teams: fixtures.map((fixture) => fixture.team) } });
          return true;
        }

        if (method === "GET" && /\/api\/admin\/teams\/[^/]+\/resources$/.test(path)) {
          if (options.getResourcesStatus && options.getResourcesStatus >= 400) {
            await fulfillJson(
              route,
              { success: false, error: options.getResourcesError ?? "OpenFGA list-objects failed" },
              options.getResourcesStatus,
            );
            return true;
          }
          const teamId = path.match(/\/api\/admin\/teams\/([^/]+)\/resources$/)?.[1] ?? "";
          const fixture = fixturesById.get(teamId) ?? fixtures[0];
          await fulfillJson(route, {
            success: true,
            data: {
              team_id: fixture.team._id,
              resources: fixture.resources,
              available: fixture.available,
            },
          });
          return true;
        }

        if (method === "PUT" && /\/api\/admin\/teams\/[^/]+\/resources$/.test(path)) {
          resourcePutBodies.push((await postJson(route)) as TeamResourcePutBody);
          if (options.putResourcesStatus && options.putResourcesStatus >= 400) {
            await fulfillJson(
              route,
              { success: false, error: options.putResourcesError ?? "OpenFGA reconcile failed" },
              options.putResourcesStatus,
            );
            return true;
          }
          await fulfillJson(route, {
            success: true,
            data: options.putResourcesData ?? {
              members_updated: ["alice@example.com"],
              members_skipped: [],
            },
          });
          return true;
        }

        return false;
      },
    ],
  });

  return { resourcePutBodies };
}

function teamCard(page: Page, teamName: string) {
  return page
    .locator("div", { hasText: teamName })
    .filter({ has: page.getByRole("button", { name: /Manage team/i }) })
    .first();
}

function resourceRow(page: Page, text: string) {
  return page.getByRole("dialog").locator("li", { hasText: text }).first();
}

async function openTeamDialogFromChip(page: Page, teamName: string, chipLabel: string | RegExp) {
  const card = teamCard(page, teamName);
  await expect(card).toBeVisible();
  await card.getByRole("button", { name: chipLabel }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  // Match the dialog heading specifically: the team name also appears in
  // capability-toggle descriptions (e.g. AutomationCapabilityToggle), so a
  // plain getByText(teamName) resolves to >1 element and trips strict mode.
  await expect(
    page.getByRole("dialog").getByRole("heading", { name: teamName }),
  ).toBeVisible();
  return card;
}

type InstalledMcpMocks = {
  createRequests: Array<Record<string, unknown>>;
  endpointProbeRequests: string[];
  toolProbeRequests: string[];
  secretCreateRequests: SecretCreateBody[];
  listRequests: number;
  addExternalServer: (server: {
    _id: string;
    name: string;
    description?: string;
    transport?: string;
    endpoint?: string;
    enabled?: boolean;
    config_driven?: boolean;
  }) => void;
};

type CredentialSecretFixture = {
  id: string;
  name: string;
  type: string;
  maskedPreview?: string;
};

type ProviderConnectionFixture = {
  id: string;
  connectorId?: string;
  provider: string;
  status?: string;
  updatedAt?: string;
};

type OAuthConnectorFixture = {
  id: string;
  name: string;
  provider: string;
};

type SecretCreateBody = {
  name?: string;
  type?: string;
  value?: string;
};

type InstallMcpServerMockOptions = {
  secrets?: CredentialSecretFixture[];
  providerConnections?: ProviderConnectionFixture[];
  oauthConnectors?: OAuthConnectorFixture[];
};

type InstalledRagFileMocks = {
  uploadRequests: Array<{
    contentType: string;
    body: string;
  }>;
};

function credentialFixtureId(name: string): string {
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
  return `secret-${slug || "saved-secret"}`;
}

async function installMcpServerMocks(
  page: Page,
  options: InstallMcpServerMockOptions = {},
): Promise<InstalledMcpMocks> {
  const createRequests: Array<Record<string, unknown>> = [];
  const endpointProbeRequests: string[] = [];
  const toolProbeRequests: string[] = [];
  const secretCreateRequests: SecretCreateBody[] = [];
  let listRequests = 0;
  type BrowserMcpServer = {
    _id: string;
    name: string;
    description: string;
    transport: string;
    endpoint: string;
    enabled: boolean;
    config_driven: boolean;
    source?: "manual" | "config" | "agentgateway";
    agentgateway_discovered?: boolean;
    agentgateway_endpoint?: string;
    agentgateway_target_endpoint?: string;
    credential_sources?: unknown[];
  };
  let servers: BrowserMcpServer[] = [];
  let secrets = [...(options.secrets ?? [])];
  const providerConnections = [...(options.providerConnections ?? [])];
  const oauthConnectors = [...(options.oauthConnectors ?? [])];

  await installMockedRbacApp(page, {
    isAdmin: true,
    session: adminSession,
    handlers: [
      async ({ route, path, method }) => {
        if (path === "/api/mcp-servers/agentgateway/discover" && method === "GET") {
          await fulfillJson(route, { success: true, data: { targets: [] } });
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
          await fulfillJson(route, {
            success: true,
            data: secrets,
          });
          return true;
        }

        if (path === "/api/credentials/secrets" && method === "POST") {
          const body = ((await postJson(route)) ?? {}) as SecretCreateBody;
          secretCreateRequests.push(body);
          const name = String(body.name ?? `Saved secret ${secrets.length + 1}`);
          const secret = {
            id: credentialFixtureId(name),
            name,
            type: String(body.type ?? "api_key"),
            maskedPreview: "***",
          };
          secrets = [...secrets, secret];
          await fulfillJson(route, { success: true, data: secret }, 201);
          return true;
        }

        if (path === "/api/credentials/connections" && method === "GET") {
          await fulfillJson(route, {
            success: true,
            data: providerConnections,
          });
          return true;
        }

        if (path === "/api/credentials/oauth-connectors" && method === "GET") {
          await fulfillJson(route, {
            success: true,
            data: oauthConnectors,
          });
          return true;
        }

        if (path === "/api/mcp-servers" && method === "GET") {
          listRequests += 1;
          await fulfillJson(route, mcpServersListPayload(servers));
          return true;
        }

        if (path === "/api/mcp-servers" && method === "POST") {
          const body = (await postJson(route)) as Record<string, unknown>;
          createRequests.push(body);
          const serverId =
            typeof body.id === "string" && body.id.startsWith("mcp-")
              ? body.id
              : `mcp-${String(body.id ?? "ops-tools")}`;
          servers = [
            {
              _id: serverId,
              name: String(body.name ?? "Ops Tools"),
              description: String(body.description ?? ""),
              transport: String(body.transport ?? "sse"),
              endpoint: String(body.endpoint ?? ""),
              enabled: true,
              config_driven: false,
              ...(Array.isArray(body.credential_sources)
                ? { credential_sources: body.credential_sources }
                : {}),
            },
          ];
          await fulfillJson(route, { success: true, data: servers[0] }, 201);
          return true;
        }

        if (path === "/api/mcp-servers/probe" && method === "POST") {
          const serverId = new URL(route.request().url()).searchParams.get("id") ?? "";
          toolProbeRequests.push(serverId);
          await fulfillJson(route, {
            success: true,
            data: {
              server_id: serverId,
              success: true,
              tools: [
                {
                  name: "netutils_ping",
                  namespaced_name: `${serverId}-netutils_ping`,
                  description: "Ping a host",
                },
                {
                  name: "netutils_dns_lookup",
                  namespaced_name: `${serverId}-netutils_dns_lookup`,
                  description: "Resolve DNS",
                },
              ],
            },
          });
          return true;
        }

        if (path === "/api/mcp-servers" && method === "DELETE") {
          const id = new URL(route.request().url()).searchParams.get("id");
          servers = servers.filter((server) => server._id !== id);
          await fulfillJson(route, { success: true, data: { deleted: id } });
          return true;
        }

        return false;
      },
    ],
  });

  return {
    get createRequests() {
      return createRequests;
    },
    get endpointProbeRequests() {
      return endpointProbeRequests;
    },
    get toolProbeRequests() {
      return toolProbeRequests;
    },
    get secretCreateRequests() {
      return secretCreateRequests;
    },
    get listRequests() {
      return listRequests;
    },
    addExternalServer(server) {
      servers = [
        ...servers,
        {
          _id: server._id,
          name: server.name,
          description: server.description ?? "",
          transport: server.transport ?? "sse",
          endpoint: server.endpoint ?? "",
          enabled: server.enabled ?? true,
          config_driven: server.config_driven ?? false,
        },
      ];
    },
  };
}

async function installKnowledgeBaseMcpMocks(page: Page): Promise<void> {
  await installMockedRbacApp(page, {
    isAdmin: true,
    session: adminSession,
    handlers: [
      async ({ route, path, method }) => {
        if (path === "/api/mcp-servers" && method === "GET") {
          await fulfillJson(
            route,
            mcpServersListPayload([
              {
                _id: "mcp-knowledge-base",
                name: "knowledge-base",
                description: "Knowledge Base RAG MCP",
                transport: "http",
                endpoint: "http://agentgateway:8080/mcp/knowledge-base",
                enabled: true,
                config_driven: false,
                source: "agentgateway",
                agentgateway_target_endpoint: "http://rag-server:8000/mcp",
              },
            ]),
          );
          return true;
        }

        return false;
      },
    ],
  });
}

async function installRagFileIngestMocks(page: Page): Promise<InstalledRagFileMocks> {
  const uploadRequests: InstalledRagFileMocks["uploadRequests"] = [];

  await installMockedRbacApp(page, {
    isAdmin: true,
    session: adminSession,
    handlers: [
      async ({ route, path, method }) => {
        if (path === "/api/rbac/kb-tab-gates" && method === "GET") {
          await fulfillJson(route, {
            gates: {
              search: true,
              data_sources: true,
              graph: true,
              mcp_tools: true,
              has_any_kb: true,
              kb_count: 1,
              can_ingest: true,
              can_search: true,
            },
            org_admin_bypass: true,
          });
          return true;
        }

        if (path === "/api/rag/healthz" && method === "GET") {
          await fulfillJson(route, {
            status: "healthy",
            config: { graph_rag_enabled: true },
          });
          return true;
        }

        if (path === "/api/rbac/ingest-teams" && method === "GET") {
          await fulfillJson(route, { org_admin: true, teams: [] });
          return true;
        }

        if (path === "/api/rag/v1/ingestors" && method === "GET") {
          await fulfillJson(route, [
            {
              ingestor_id: "local-file-upload",
              ingestor_type: "local-file",
              ingestor_name: "Local file upload",
              description: "Upload Markdown, text, and PDF files",
            },
            {
              ingestor_id: "webloader:default_webloader",
              ingestor_type: "webloader",
              ingestor_name: "Webloader",
              description: "Web loader",
            },
          ]);
          return true;
        }

        if (path === "/api/rag/v1/datasources" && method === "GET") {
          await fulfillJson(route, { success: true, datasources: [], count: 0 });
          return true;
        }

        if (path === "/api/rag/v1/jobs/batch" && method === "POST") {
          await fulfillJson(route, { jobs: {}, total_jobs: 0, datasource_count: 0 });
          return true;
        }

        if (path === "/api/rag/v1/ingest/local-file" && method === "POST") {
          // assisted-by Codex Codex-sonnet-4-6
          // Keep this assertion at the browser boundary: the regression we care
          // about is that the UI sends multipart FormData, not JSON.
          const contentType = route.request().headers()["content-type"] ?? "";
          const body = route.request().postDataBuffer()?.toString("utf8") ?? "";
          uploadRequests.push({ contentType, body });
          await fulfillJson(route, {
            datasource_id: "local-file-playwright-fixture",
            job_id: "job-local-file-playwright-fixture",
            message: "Accepted local file",
          }, 202);
          return true;
        }

        if (path === "/api/rag/v1/jobs/datasource/local-file-playwright-fixture" && method === "GET") {
          await fulfillJson(route, [
            {
              job_id: "job-local-file-playwright-fixture",
              status: "completed",
              message: "Complete",
              progress_counter: 1,
              failed_counter: 0,
              total: 1,
              created_at: Math.floor(Date.now() / 1000),
            },
          ]);
          return true;
        }

        return false;
      },
    ],
  });

  return { uploadRequests };
}

test.describe("mocked MCP OpenFGA tuple browser regression", () => {
  test.beforeEach(() => {
    test.skip(
      !mockedRbacEnabled(),
      "Set RUN_RBAC_REGRESSION=1 to run the mocked MCP OpenFGA browser regression.",
    );
  });

  test("team cards and details use OpenFGA-derived resource counts instead of legacy team.resources", async ({
    page,
  }) => {
    await installTeamResourceMocks(page, [
      {
        team: {
          ...visibilityTeam,
          // Deliberately provide no `resources` field. The old UI path would
          // render zeros here; the branch must trust the server-decorated
          // OpenFGA counts instead.
        },
        resources: {
          agents: ["agent-sre", "agent-kb"],
          agent_admins: ["agent-sre"],
          tools: ["mcp-jira/*", "mcp-confluence/*"],
          tool_wildcard: false,
          skills: [
            {
              id: "skill-incident-summary",
              name: "Incident Summary",
              description: "Summarize active incidents",
            },
          ],
          workflows: [
            {
              id: "workflow-release-check",
              name: "Release Check",
              description: "Validate release readiness",
            },
          ],
        },
        available: {
          agents: [
            { id: "agent-sre", name: "SRE Agent", description: "Ops automation" },
            { id: "agent-kb", name: "KB Agent", description: "Knowledge search" },
          ],
          tools: [
            { id: "mcp-jira/*", name: "mcp-jira/*", description: "Jira" },
            { id: "mcp-confluence/*", name: "mcp-confluence/*", description: "Confluence" },
          ],
        },
      },
    ]);

    await page.goto("/admin/people/teams", { waitUntil: "domcontentloaded" });

    const card = teamCard(page, visibilityTeam.name);
    await expect(card).toBeVisible();
    await expect(card.getByRole("button", { name: /4\s+Members/i })).toBeVisible();
    await expect(card.getByRole("button", { name: /2\s+Agents/i })).toBeVisible();
    await expect(card.getByRole("button", { name: /2\s+MCPs/i })).toBeVisible();
    await expect(card.getByRole("button", { name: /3\s+KBs/i })).toBeVisible();

    await card.getByRole("button", { name: /2\s+Agents/i }).click();
    await expect(page.getByRole("dialog")).toBeVisible();
    await expect(page.getByText("Dynamic agents (2 / 2)")).toBeVisible();
    await expect(page.getByText("SRE Agent")).toBeVisible();
    await expect(page.getByText("KB Agent")).toBeVisible();

    await page.getByRole("button", { name: "MCPs", exact: true }).click();
    await expect(page.getByText("MCP servers (2 / 2)")).toBeVisible();
    await expect(page.getByText("mcp-jira/*")).toBeVisible();
    await expect(page.getByText("mcp-confluence/*")).toBeVisible();
  });

  test("team stat chips deep-link into resource tabs without refetching away unsaved OpenFGA state", async ({
    page,
  }) => {
    await installTeamResourceMocks(page, [
      {
        team: visibilityTeam,
        resources: {
          agents: ["agent-sre"],
          agent_admins: [],
          tools: ["mcp-jira/*"],
          tool_wildcard: false,
          skills: [],
          workflows: [],
        },
        available: {
          agents: [
            { id: "agent-sre", name: "SRE Agent", description: "Ops automation" },
            { id: "agent-kb", name: "KB Agent", description: "Knowledge search" },
          ],
          tools: [
            { id: "mcp-jira/*", name: "mcp-jira/*", description: "Jira" },
            { id: "mcp-confluence/*", name: "mcp-confluence/*", description: "Confluence" },
          ],
        },
      },
    ]);

    await page.goto("/admin/people/teams", { waitUntil: "domcontentloaded" });
    const resourcesResponses: string[] = [];
    page.on("response", (response) => {
      const url = new URL(response.url());
      if (/\/api\/admin\/teams\/[^/]+\/resources$/.test(url.pathname)) {
        resourcesResponses.push(url.pathname);
      }
    });

    const card = teamCard(page, visibilityTeam.name);
    await card.getByRole("button", { name: /2\s+Agents/i }).click();
    await expect(page.getByText("Dynamic agents (1 / 2)")).toBeVisible();
    await expect(resourceRow(page, "SRE Agent").locator("input").first()).toBeChecked();
    await expect(resourceRow(page, "KB Agent").locator("input").first()).not.toBeChecked();

    await page.getByRole("button", { name: "MCPs", exact: true }).click();
    await expect(page.getByText("MCP servers (1 / 2)")).toBeVisible();
    await expect(resourceRow(page, "mcp-jira/*").locator("input").first()).toBeChecked();
    await expect(resourceRow(page, "mcp-confluence/*").locator("input").first()).not.toBeChecked();

    await expect.poll(() => resourcesResponses.length).toBe(1);
  });

  test("agent manage implies use and one save preserves edited agents plus MCP choices across tabs", async ({
    page,
  }) => {
    const mocks = await installTeamResourceMocks(page, [
      {
        team: visibilityTeam,
        resources: {
          agents: ["agent-sre"],
          agent_admins: [],
          tools: ["mcp-jira/*"],
          tool_wildcard: false,
          skills: [],
          workflows: [],
        },
        available: {
          agents: [
            { id: "agent-sre", name: "SRE Agent", description: "Ops automation" },
            { id: "agent-kb", name: "KB Agent", description: "Knowledge search" },
          ],
          tools: [
            { id: "mcp-jira/*", name: "mcp-jira/*", description: "Jira" },
            { id: "mcp-confluence/*", name: "mcp-confluence/*", description: "Confluence" },
          ],
        },
      },
    ]);

    await page.goto("/admin/people/teams", { waitUntil: "domcontentloaded" });
    await openTeamDialogFromChip(page, visibilityTeam.name, /2\s+Agents/i);

    const kbAgentInputs = resourceRow(page, "KB Agent").locator("input");
    await kbAgentInputs.nth(1).check();
    await expect(kbAgentInputs.nth(0)).toBeChecked();
    await expect(kbAgentInputs.nth(0)).toBeDisabled();
    await expect(kbAgentInputs.nth(1)).toBeChecked();

    await page.getByRole("button", { name: "MCPs", exact: true }).click();
    await resourceRow(page, "mcp-confluence/*").locator("input").first().check();

    const putResponse = page.waitForResponse(
      (response) =>
        response.request().method() === "PUT" &&
        /\/api\/admin\/teams\/[^/]+\/resources$/.test(new URL(response.url()).pathname),
    );
    await page.getByRole("button", { name: "Save MCP access" }).click();
    await putResponse;

    await expect.poll(() => mocks.resourcePutBodies.length).toBe(1);
    expect(mocks.resourcePutBodies[0]).toEqual({
      agents: ["agent-sre", "agent-kb"],
      agent_admins: ["agent-kb"],
      tools: ["mcp-jira/*", "mcp-confluence/*"],
      tool_wildcard: false,
    });
  });

  test("team skills and workflows are visible from OpenFGA but read-only in the team dialog", async ({
    page,
  }) => {
    await installTeamResourceMocks(page, [
      {
        team: visibilityTeam,
        resources: {
          agents: [],
          agent_admins: [],
          tools: [],
          tool_wildcard: false,
          skills: [
            {
              id: "skill-incident-summary",
              name: "Incident Summary",
              description: "Summarize active incidents",
            },
          ],
          workflows: [
            {
              id: "workflow-release-check",
              name: "Release Check",
              description: "Validate release readiness",
            },
          ],
        },
        available: {
          agents: [],
          tools: [],
        },
      },
    ]);

    await page.goto("/admin/people/teams", { waitUntil: "domcontentloaded" });
    await openTeamDialogFromChip(page, visibilityTeam.name, /2\s+Agents/i);

    await page.getByRole("button", { name: "Skills", exact: true }).click();
    await expect(page.getByText("Skills shared with this team (owned + shared).")).toBeVisible();
    await expect(page.getByText("Incident Summary")).toBeVisible();
    await expect(page.getByText("Summarize active incidents")).toBeVisible();
    await expect(page.getByRole("button", { name: /Save skill/i })).toHaveCount(0);
    await expect(page.getByRole("checkbox")).toHaveCount(0);

    await page.getByRole("button", { name: "Workflows", exact: true }).click();
    await expect(page.getByText("Workflows shared with this team (owned + shared).")).toBeVisible();
    await expect(page.getByText("Release Check")).toBeVisible();
    await expect(page.getByText("Validate release readiness")).toBeVisible();
    await expect(page.getByRole("button", { name: /Save workflow/i })).toHaveCount(0);
    await expect(page.getByRole("checkbox")).toHaveCount(0);
  });

  test("read-only skill and workflow tabs show explicit empty states when OpenFGA returns no grants", async ({
    page,
  }) => {
    await installTeamResourceMocks(page, [
      {
        team: {
          ...visibilityTeam,
          skill_count: 0,
          workflow_count: 0,
        },
        resources: {
          agents: [],
          agent_admins: [],
          tools: [],
          tool_wildcard: false,
          skills: [],
          workflows: [],
        },
        available: {
          agents: [],
          tools: [],
        },
      },
    ]);

    await page.goto("/admin/people/teams", { waitUntil: "domcontentloaded" });
    await teamCard(page, visibilityTeam.name).getByRole("button", { name: /Manage team/i }).click();
    await expect(page.getByRole("dialog")).toBeVisible();

    await page.getByRole("button", { name: "Skills", exact: true }).click();
    await expect(page.getByText("No skills are shared with this team yet.")).toBeVisible();
    await expect(page.getByRole("checkbox")).toHaveCount(0);

    await page.getByRole("button", { name: "Workflows", exact: true }).click();
    await expect(page.getByText("No workflows are shared with this team yet.")).toBeVisible();
    await expect(page.getByRole("checkbox")).toHaveCount(0);
  });

  test("wildcard MCP grants show as star counts and save the wildcard intent with selected agents", async ({
    page,
  }) => {
    const mocks = await installTeamResourceMocks(page, [
      {
        team: wildcardTeam,
        resources: {
          agents: ["agent-sre"],
          agent_admins: [],
          tools: [],
          tool_wildcard: true,
          skills: [],
          workflows: [],
        },
        available: {
          agents: [{ id: "agent-sre", name: "SRE Agent", description: "" }],
          tools: [
            { id: "mcp-jira/*", name: "mcp-jira/*", description: "Jira" },
            { id: "mcp-confluence/*", name: "mcp-confluence/*", description: "Confluence" },
          ],
        },
      },
    ]);

    await page.goto("/admin/people/teams", { waitUntil: "domcontentloaded" });
    const card = teamCard(page, wildcardTeam.name);
    await expect(card.getByRole("button", { name: /\*\s+MCPs/i })).toBeVisible();

    await card.getByRole("button", { name: /\*\s+MCPs/i }).click();
    await expect(page.getByText("MCP servers (0 / 2)")).toBeVisible();
    await expect(page.getByText("wildcard", { exact: true })).toBeVisible();
    await expect(page.getByLabel(/All MCP servers \(wildcard\)/i)).toBeChecked();

    await page.getByLabel(/mcp-jira\/\*/i).check();
    const putResponse = page.waitForResponse(
      (response) =>
        response.request().method() === "PUT" &&
        /\/api\/admin\/teams\/[^/]+\/resources$/.test(new URL(response.url()).pathname),
    );
    await page.getByRole("button", { name: "Save MCP access" }).click();
    await putResponse;

    await expect.poll(() => mocks.resourcePutBodies.length).toBe(1);
    expect(mocks.resourcePutBodies[0]).toEqual({
      agents: ["agent-sre"],
      agent_admins: [],
      tools: ["mcp-jira/*"],
      tool_wildcard: true,
    });
  });

  test("turning off wildcard keeps explicit server grants and sends tool_wildcard false", async ({
    page,
  }) => {
    const mocks = await installTeamResourceMocks(page, [
      {
        team: wildcardTeam,
        resources: {
          agents: ["agent-sre"],
          agent_admins: [],
          tools: ["mcp-jira/*", "mcp-confluence/*"],
          tool_wildcard: true,
          skills: [],
          workflows: [],
        },
        available: {
          agents: [{ id: "agent-sre", name: "SRE Agent", description: "" }],
          tools: [
            { id: "mcp-jira/*", name: "mcp-jira/*", description: "Jira" },
            { id: "mcp-confluence/*", name: "mcp-confluence/*", description: "Confluence" },
          ],
        },
      },
    ]);

    await page.goto("/admin/people/teams", { waitUntil: "domcontentloaded" });
    await openTeamDialogFromChip(page, wildcardTeam.name, /\*\s+MCPs/i);

    await expect(page.getByLabel(/All MCP servers \(wildcard\)/i)).toBeChecked();
    await expect(resourceRow(page, "mcp-jira/*").locator("input").first()).toBeChecked();
    await expect(resourceRow(page, "mcp-confluence/*").locator("input").first()).toBeChecked();
    await page.getByLabel(/All MCP servers \(wildcard\)/i).uncheck();

    const putResponse = page.waitForResponse(
      (response) =>
        response.request().method() === "PUT" &&
        /\/api\/admin\/teams\/[^/]+\/resources$/.test(new URL(response.url()).pathname),
    );
    await page.getByRole("button", { name: "Save MCP access" }).click();
    await putResponse;

    await expect.poll(() => mocks.resourcePutBodies.length).toBe(1);
    expect(mocks.resourcePutBodies[0]).toEqual({
      agents: ["agent-sre"],
      agent_admins: [],
      tools: ["mcp-jira/*", "mcp-confluence/*"],
      tool_wildcard: false,
    });
  });

  test("resource load failures surface the OpenFGA error and do not show stale empty pickers", async ({
    page,
  }) => {
    await installTeamResourceMocks(
      page,
      [
        {
          team: visibilityTeam,
          resources: {
            agents: [],
            agent_admins: [],
            tools: [],
            tool_wildcard: false,
          },
          available: { agents: [], tools: [] },
        },
      ],
      {
        getResourcesStatus: 503,
        getResourcesError: "OpenFGA list-objects failed",
      },
    );

    await page.goto("/admin/people/teams", { waitUntil: "domcontentloaded" });
    await openTeamDialogFromChip(page, visibilityTeam.name, /2\s+Agents/i);

    await expect(page.getByText("OpenFGA list-objects failed")).toBeVisible();
    await expect(page.getByText("No agents available")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Save agent access" })).toBeDisabled();
  });

  test("resource save failures keep the dialog open, surface the error, and retain the attempted selection", async ({
    page,
  }) => {
    const mocks = await installTeamResourceMocks(
      page,
      [
        {
          team: visibilityTeam,
          resources: {
            agents: [],
            agent_admins: [],
            tools: [],
            tool_wildcard: false,
          },
          available: {
            agents: [{ id: "agent-sre", name: "SRE Agent", description: "" }],
            tools: [],
          },
        },
      ],
      {
        putResourcesStatus: 500,
        putResourcesError: "OpenFGA reconcile failed",
      },
    );

    await page.goto("/admin/people/teams", { waitUntil: "domcontentloaded" });
    await teamCard(page, visibilityTeam.name).getByRole("button", { name: /Manage team/i }).click();
    await expect(page.getByRole("dialog")).toBeVisible();
    await page.getByRole("button", { name: "Agents", exact: true }).click();
    await resourceRow(page, "SRE Agent").locator("input").first().check();

    const putResponse = page.waitForResponse(
      (response) =>
        response.request().method() === "PUT" &&
        /\/api\/admin\/teams\/[^/]+\/resources$/.test(new URL(response.url()).pathname),
    );
    await page.getByRole("button", { name: "Save agent access" }).click();
    await putResponse;

    await expect(page.getByText("OpenFGA reconcile failed")).toBeVisible();
    await expect(resourceRow(page, "SRE Agent").locator("input").first()).toBeChecked();
    await expect(page.getByRole("dialog")).toBeVisible();
    await expect.poll(() => mocks.resourcePutBodies.length).toBe(1);
  });

  test("save success shows Saved notice without dropping the selected grants", async ({
    page,
  }) => {
    const mocks = await installTeamResourceMocks(
      page,
      [
        {
          team: visibilityTeam,
          resources: {
            agents: [],
            agent_admins: [],
            tools: [],
            tool_wildcard: false,
          },
          available: {
            agents: [{ id: "agent-sre", name: "SRE Agent", description: "" }],
            tools: [],
          },
        },
      ],
    );

    await page.goto("/admin/people/teams", { waitUntil: "domcontentloaded" });
    await teamCard(page, visibilityTeam.name).getByRole("button", { name: /Manage team/i }).click();
    await expect(page.getByRole("dialog")).toBeVisible();
    await page.getByRole("button", { name: "Agents", exact: true }).click();
    await resourceRow(page, "SRE Agent").locator("input").first().check();

    const putResponse = page.waitForResponse(
      (response) =>
        response.request().method() === "PUT" &&
        /\/api\/admin\/teams\/[^/]+\/resources$/.test(new URL(response.url()).pathname),
    );
    await page.getByRole("button", { name: "Save agent access" }).click();
    await putResponse;

    await expect(page.getByText(/Saved\./)).toBeVisible();
    await expect.poll(() => mocks.resourcePutBodies.length).toBe(1);
    expect(mocks.resourcePutBodies[0]).toMatchObject({
      agents: ["agent-sre"],
      tools: [],
      tool_wildcard: false,
    });
  });

  test("team resources save sends the full selected MCP tool list for drift repair", async ({ page }) => {
    const mocks = await installTeamResourceMocks(page);

    await page.goto("/admin/people/teams", { waitUntil: "domcontentloaded" });
    await expect(page.getByText(platformTeam.name)).toBeVisible();

    await page.getByRole("button", { name: /1\s+MCPs/i }).click();
    await expect(page.getByRole("dialog")).toBeVisible();
    await expect(page.getByRole("button", { name: "MCPs", exact: true })).toBeVisible();
    await expect(page.getByText("mcp-confluence-mcp_*")).toBeVisible();

    const putResponse = page.waitForResponse(
      (response) =>
        response.request().method() === "PUT" &&
        /\/api\/admin\/teams\/[^/]+\/resources$/.test(new URL(response.url()).pathname),
    );
    await page.getByRole("button", { name: "Save MCP access" }).click();
    await putResponse;

    await expect.poll(() => mocks.resourcePutBodies.length).toBe(1);
    expect(mocks.resourcePutBodies[0]).toEqual({
      agents: ["agent-keep"],
      agent_admins: [],
      tools: ["mcp-confluence-mcp_*"],
      tool_wildcard: false,
    });
  });

  test("new MCP servers default to Streamable HTTP and remain visible after refresh", async ({ page }) => {
    const mocks = await installMcpServerMocks(page);

    await page.goto("/dynamic-agents?tab=mcp-servers", { waitUntil: "domcontentloaded" });
    await expect(page.getByText("No MCP Servers Yet")).toBeVisible();

    await openAddMcpServerEditor(page);
    await expect(page.getByRole("button", { name: /Streamable HTTP.*recommended/i })).toBeVisible();
    await expect(page.getByRole("button", { name: /SSE/i })).toHaveCount(0);
    await expect(page.getByLabel(/Endpoint URL/i)).toHaveAttribute(
      "placeholder",
      "e.g., http://localhost:3000/mcp",
    );

    await fillNewMcpServerBasics(page, {
      displayName: "Ops Tools",
      serverId: "ops-tools",
      endpoint: "https://mcp.example.test/mcp",
    });
    await page.getByRole("button", { name: "Create Server" }).click();

    await expect.poll(() => mocks.createRequests.length).toBe(1);
    expect(mocks.createRequests[0]).toMatchObject({
      id: "ops-tools",
      name: "Ops Tools",
      transport: "http",
      endpoint: "https://mcp.example.test/mcp",
    });

    await expect(page.getByText("Ops Tools")).toBeVisible();
    await expect.poll(() => mocks.listRequests).toBeGreaterThanOrEqual(2);
    await expect(page.getByText("No MCP Servers Yet")).toHaveCount(0);
  });

  test("creates secrets and selects them for MCP header and environment credentials", async ({
    page,
  }) => {
    const mocks = await installMcpServerMocks(page);

    await page.goto("/dynamic-agents?tab=mcp-servers", { waitUntil: "domcontentloaded" });
    await expect(page.getByText("No MCP Servers Yet")).toBeVisible();

    const secretIds = await page.evaluate(async () => {
      async function createSecret(name: string, type: string, value: string): Promise<string> {
        const response = await fetch("/api/credentials/secrets", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name, type, value }),
        });
        const payload = (await response.json()) as { data?: { id?: string } };
        return payload.data?.id ?? "";
      }

      return {
        jira: await createSecret("Jira token", "bearer_token", "jira-raw-token"),
        pagerduty: await createSecret("PagerDuty token", "api_key", "pd-raw-token"),
      };
    });

    expect(secretIds).toEqual({
      jira: "secret-jira-token",
      pagerduty: "secret-pagerduty-token",
    });

    await openAddMcpServerEditor(page);

    await fillNewMcpServerBasics(page, {
      displayName: "Jira Tools",
      serverId: "jira-tools",
      endpoint: "https://mcp.example.test/jira",
    });

    await page.getByRole("button", { name: "Add Credential" }).click();
    await expect(page.getByLabel(/Credential header/i).first()).toHaveValue("X-CAIPE-Provider-Token");
    await chooseSearchablePickerOption(
      page,
      page.getByLabel(/^Secret$/).first(),
      "Jira token",
    );

    await page.getByRole("button", { name: "Add Credential" }).click();
    await page.getByLabel(/Credential target/i).nth(1).selectOption("env");
    await page.getByLabel(/Credential name/i).fill("JIRA_TOKEN");
    await chooseSearchablePickerOption(
      page,
      page.getByLabel(/^Secret$/).nth(1),
      "PagerDuty token",
    );

    await page.getByRole("button", { name: "Create Server" }).click();

    await expect.poll(() => mocks.secretCreateRequests.length).toBe(2);
    expect(mocks.secretCreateRequests).toEqual([
      { name: "Jira token", type: "bearer_token", value: "jira-raw-token" },
      { name: "PagerDuty token", type: "api_key", value: "pd-raw-token" },
    ]);

    await expect.poll(() => mocks.createRequests.length).toBe(1);
    expect(mocks.createRequests[0].credential_sources).toEqual([
      {
        kind: "secret_ref",
        target: "header",
        name: "X-CAIPE-Provider-Token",
        secret_ref: "secret-jira-token",
      },
      {
        kind: "secret_ref",
        target: "env",
        name: "JIRA_TOKEN",
        secret_ref: "secret-pagerduty-token",
      },
    ]);
    expect(JSON.stringify(mocks.createRequests[0])).not.toContain("jira-raw-token");
    expect(JSON.stringify(mocks.createRequests[0])).not.toContain("pd-raw-token");
  });

  test("creates a Netutils MCP server with a saved secret, suggested /mcp URL, and probes tools", async ({
    page,
  }) => {
    const mocks = await installMcpServerMocks(page, {
      secrets: [
        {
          id: "secret-netutils-token",
          name: "Netutils token",
          type: "bearer_token",
          maskedPreview: "net_...oken",
        },
      ],
    });

    await page.goto("/dynamic-agents?tab=mcp-servers", { waitUntil: "domcontentloaded" });
    await expect(page.getByText("No MCP Servers Yet")).toBeVisible();

    await openAddMcpServerEditor(page);

    await fillNewMcpServerBasics(page, {
      displayName: "Test Netutils",
      serverId: "test-netutils",
    });
    await expect(page.getByRole("button", { name: /Streamable HTTP.*recommended/i })).toBeVisible();
    await page.getByLabel(/Endpoint URL/i).fill("http://mcp-netutils:8000");
    await page.getByRole("button", { name: /check url/i }).click();
    await expect(page.getByText(/http:\/\/mcp-netutils:8000\/mcp/i)).toBeVisible();
    await page.getByRole("button", { name: /use suggested url/i }).click();
    await expect(page.getByLabel(/Endpoint URL/i)).toHaveValue("http://mcp-netutils:8000/mcp");

    await page.getByRole("button", { name: "Add Credential" }).click();
    await page.getByLabel(/Credential header/i).selectOption("X-CAIPE-Provider-Token");
    await chooseSearchablePickerOption(
      page,
      page.getByLabel(/^Secret$/),
      "Netutils token",
    );
    await expect(page.getByText("Preview net_...oken")).toBeVisible();

    await page.getByRole("button", { name: "Create Server" }).click();

    await expect.poll(() => mocks.endpointProbeRequests).toEqual(["http://mcp-netutils:8000"]);
    await expect.poll(() => mocks.createRequests.length).toBe(1);
    expect(mocks.createRequests[0]).toMatchObject({
      id: "test-netutils",
      name: "Test Netutils",
      transport: "http",
      endpoint: "http://mcp-netutils:8000/mcp",
    });
    expect(mocks.createRequests[0].credential_sources).toEqual([
      {
        kind: "secret_ref",
        target: "header",
        name: "X-CAIPE-Provider-Token",
        secret_ref: "secret-netutils-token",
      },
    ]);

    await expect(page.getByText("Test Netutils")).toBeVisible();
    await page.locator('button[title="Probe for tools"]').click();
    await expect.poll(() => mocks.toolProbeRequests).toEqual(["mcp-test-netutils"]);
    await expect(page.getByText("2 tool(s) available")).toBeVisible();
    await expect(page.getByText("netutils_ping")).toBeVisible();
    await expect(page.getByText("netutils_dns_lookup")).toBeVisible();
  });

  test("selects a connected app for MCP provider credentials", async ({ page }) => {
    const mocks = await installMcpServerMocks(page, {
      providerConnections: [
        {
          id: "conn-atlassian",
          connectorId: "atlassian-connector",
          provider: "atlassian",
          status: "connected",
        },
      ],
      oauthConnectors: [
        {
          id: "atlassian-connector",
          name: "Atlassian Cloud",
          provider: "atlassian",
        },
      ],
    });

    await page.goto("/dynamic-agents?tab=mcp-servers", { waitUntil: "domcontentloaded" });
    await expect(page.getByText("No MCP Servers Yet")).toBeVisible();

    await openAddMcpServerEditor(page);

    await fillNewMcpServerBasics(page, {
      displayName: "Atlassian Tools",
      serverId: "atlassian-tools",
      endpoint: "https://mcp.example.test/atlassian",
    });

    await page.getByRole("button", { name: "Add Credential" }).click();
    await page.getByLabel(/Credential kind/i).selectOption("provider_connection");
    // Provider connections are always caller-scoped now: admins pick the OAuth
    // provider (by connector name) and each caller resolves their OWN
    // connection at runtime. The shared all-callers "pinned" scope and the
    // per-connection picker were removed because they enabled impersonation.
    await expect(page.getByLabel(/^Provider$/i)).toContainText("Atlassian Cloud");
    await page.getByLabel(/^Provider$/i).selectOption("atlassian");

    await page.getByRole("button", { name: "Create Server" }).click();

    await expect.poll(() => mocks.createRequests.length).toBe(1);
    expect(mocks.createRequests[0].credential_sources).toEqual([
      {
        kind: "provider_connection",
        target: "header",
        name: "X-CAIPE-Provider-Token",
        connection_scope: "caller",
        provider: "atlassian",
      },
    ]);
  });

  test("mounted MCP server list refreshes when servers change outside the tab", async ({ page }) => {
    const mocks = await installMcpServerMocks(page);

    await page.goto("/dynamic-agents?tab=mcp-servers", { waitUntil: "domcontentloaded" });
    await expect(page.getByText("No MCP Servers Yet")).toBeVisible();
    const initialListRequests = mocks.listRequests;

    mocks.addExternalServer({
      _id: "mcp-incident-tools",
      name: "Incident Tools",
      endpoint: "https://mcp.example.test/incidents",
    });

    await page.evaluate(() => window.dispatchEvent(new Event("focus")));

    await expect(page.getByText("Incident Tools")).toBeVisible();
    await expect(page.getByText("mcp-incident-tools")).toBeVisible();
    await expect.poll(() => mocks.listRequests).toBeGreaterThan(initialListRequests);
    await expect(page.getByText("No MCP Servers Yet")).toHaveCount(0);
  });

  test("shows AgentGateway-discovered knowledge-base MCP servers in the browser list", async ({
    page,
  }) => {
    await installKnowledgeBaseMcpMocks(page);

    await page.goto("/dynamic-agents?tab=mcp-servers", { waitUntil: "domcontentloaded" });

    await expect(page.getByText("knowledge-base", { exact: true })).toBeVisible();
    await expect(page.getByText("mcp-knowledge-base")).toBeVisible();
    await expect(page.getByTitle("Registered from AgentGateway discovery")).toBeVisible();
    await expect(page.getByText("No MCP Servers Yet")).toHaveCount(0);
  });

  test("uploads multiple local files as multipart FormData from the ingest UI", async ({ page }) => {
    const mocks = await installRagFileIngestMocks(page);

    await page.goto("/knowledge-bases/ingest", { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { name: "Data Sources", level: 1 })).toBeVisible();

    await page.getByTitle("Upload files").click();
    const fileInput = page.locator('input[type="file"]');
    await fileInput.setInputFiles([
      {
        name: "playwright-rbac.md",
        mimeType: "text/markdown",
        buffer: Buffer.from("# RBAC fixture\n\nUploaded by Playwright.\n"),
      },
      {
        name: "playwright-rbac-notes.txt",
        mimeType: "text/plain",
        buffer: Buffer.from("Second local file in the same datasource.\n"),
      },
    ]);

    const uploadResponse = page.waitForResponse(
      (response) =>
        response.request().method() === "POST" &&
        new URL(response.url()).pathname === "/api/rag/v1/ingest/local-file",
    );
    await page.getByRole("button", { name: /^Ingest 2 files$/ }).click();
    expect((await uploadResponse).status()).toBe(202);

    await expect.poll(() => mocks.uploadRequests.length).toBe(1);
    expect(mocks.uploadRequests[0].contentType).toContain("multipart/form-data");
    expect(mocks.uploadRequests[0].body).toContain('name="file"; filename="playwright-rbac.md"');
    expect(mocks.uploadRequests[0].body).toContain('name="file"; filename="playwright-rbac-notes.txt"');
    expect(mocks.uploadRequests[0].body).toContain("Uploaded by Playwright.");
    expect(mocks.uploadRequests[0].body).toContain("Second local file in the same datasource.");
    expect(mocks.uploadRequests[0].body).toContain('name="chunk_size"');
    expect(mocks.uploadRequests[0].body).toContain("10000");
    expect(mocks.uploadRequests[0].body).toContain('name="chunk_overlap"');
    expect(mocks.uploadRequests[0].body).toContain("2000");
  });

  test("uses the shared workspace navigation for Knowledge Bases", async ({ page }) => {
    await installRagFileIngestMocks(page);

    await page.goto("/knowledge-bases/ingest", { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { name: "Data Sources", level: 1 })).toBeVisible();

    const navigation = page.getByRole("navigation", { name: "Knowledge Base sections" });
    const activeItem = navigation.getByRole("link", { name: /Data Sources/ });
    await expect(navigation).toBeVisible();
    await expect(activeItem).toHaveAttribute("aria-current", "page");
    await expect(activeItem).toHaveClass(/workspace-navigation-active/);
    await expect(page.getByText("Navigation", { exact: true })).toHaveCount(0);

    const breadcrumb = page.getByRole("navigation",{ name: "Breadcrumb" });
    await expect(breadcrumb.getByRole("link",{ name: "Home" })).toHaveAttribute("href","/");
    await expect(breadcrumb.getByRole("link",{ name: "Knowledge Bases" })).toHaveAttribute(
      "href",
      "/knowledge-bases/search",
    );
    await expect(breadcrumb.getByRole("link",{ name: "Data Sources" })).toHaveAttribute(
      "aria-current",
      "page",
    );
    await expect(page.getByRole("button", { name: /Knowledge Base navigation/ })).toHaveCount(0);
  });
});
