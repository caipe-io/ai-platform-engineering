// assisted-by Codex Codex-sonnet-4-6

import { expect, test, type Page } from "@playwright/test";

import { chooseSearchablePickerOption } from "./_helpers";
import {
  fulfillJson,
  installMockedRbacApp,
  mockedRbacEnabled,
  postJson,
  type MockRouteHandler,
} from "./_mocked-rbac";

const adminSession = {
  email: "rbac-admin@example.com",
  name: "RBAC Admin",
  role: "admin" as const,
  canViewAdmin: true,
};

type ServiceAccountItem = {
  id: string;
  name: string;
  description?: string;
  owning_team_id: string;
  created_by: string;
  created_at: string;
  status: "active" | "revoked";
  scope_counts: { agents: number; tools: number };
};

type ScopeRef = { type: "agent" | "tool"; ref: string };

type GrantableItem = { ref: string; name: string };

type ServiceAccountCredential = {
  id: string;
  provider: string;
  status: "connected" | "revoked";
  connectedAt?: string;
  requestedScopes?: string[];
};

function counts(scopes: ScopeRef[]) {
  return {
    agents: scopes.filter((scope) => scope.type === "agent").length,
    tools: scopes.filter((scope) => scope.type === "tool").length,
  };
}

async function forceCredentialClientConfig(page: Page) {
  await page.addInitScript(() => {
    let appConfig: Record<string, unknown> | undefined;
    Object.defineProperty(window, "__APP_CONFIG__", {
      configurable: true,
      get() {
        return appConfig;
      },
      set(next) {
        appConfig = {
          ...(typeof next === "object" && next !== null ? next : {}),
          credentialsEnabled: true,
          userConnectionsEnabled: true,
        };
      },
    });
  });
}

test.describe("mocked service accounts browser regression", () => {
  test.beforeEach(() => {
    test.skip(
      !mockedRbacEnabled(),
      "Set RUN_RBAC_REGRESSION=1 to run the mocked RBAC browser regression.",
    );
  });

  test("creates, reveals once, manages scopes, rotates, and revokes service accounts", async ({
    page,
  }) => {
    const requests: Array<{ method: string; path: string; body: unknown }> = [];
    const scopes: ScopeRef[] = [
      { type: "agent", ref: "incident-resolver" },
      { type: "tool", ref: "jira/search" },
    ];
    const createScopes: ScopeRef[] = [{ type: "agent", ref: "incident-resolver" }];
    let items: ServiceAccountItem[] = [];
    let deleted = false;

    const serviceAccountHandler: MockRouteHandler = async ({ route, path, method }) => {
      if (path === "/api/auth/my-roles" && method === "GET") {
        await fulfillJson(route, {
          teams: [{ _id: "team-1", slug: "team-sre", name: "SRE Team" }],
        });
        return true;
      }

      if (path === "/api/admin/service-accounts/grantable" && method === "GET") {
        await fulfillJson(route, {
          success: true,
          data: {
            agents: [
              { ref: "incident-resolver", name: "Incident Resolver" },
              { ref: "runbook-agent", name: "Runbook Agent" },
            ],
            tools: [
              { ref: "jira/search", name: "jira: search" },
              { ref: "jira/*", name: "jira: all tools" },
            ],
          },
        });
        return true;
      }

      if (
        path === "/api/admin/service-accounts/sa-sub-playwright/credentials" &&
        method === "GET"
      ) {
        await fulfillJson(route, { success: true, data: [] });
        return true;
      }

      if (path === "/api/admin/service-accounts/token-providers" && method === "GET") {
        await fulfillJson(route, {
          success: true,
          data: [
            { provider: "jira", name: "Jira" },
            { provider: "github", name: "GitHub" },
          ],
        });
        return true;
      }

      if (path === "/api/admin/service-accounts" && method === "GET") {
        await fulfillJson(route, { success: true, data: { items } });
        return true;
      }

      if (path === "/api/admin/service-accounts" && method === "POST") {
        const body = await postJson(route);
        requests.push({ method, path, body });
        items = [
          {
            id: "sa-sub-playwright",
            name: "incident-bot",
            description: "PagerDuty integration",
            owning_team_id: "team-sre",
            created_by: "user-admin",
            created_at: "2026-06-15T12:00:00.000Z",
            status: "active",
            scope_counts: counts(scopes),
          },
        ];
        await fulfillJson(
          route,
          {
            success: true,
            data: {
              id: "sa-sub-playwright",
              name: "incident-bot",
              owning_team_id: "team-sre",
              credential: {
                client_id: "caipe-sa-incident-bot-a1b2c3",
                client_secret: "created-secret",
                token_url: "http://localhost:7080/realms/caipe/protocol/openid-connect/token",
              },
              granted_scopes: createScopes,
              rejected_scopes: [],
            },
          },
          201,
        );
        return true;
      }

      if (path === "/api/admin/service-accounts/sa-sub-playwright" && method === "GET") {
        await fulfillJson(route, {
          success: true,
          data: {
            id: "sa-sub-playwright",
            name: "incident-bot",
            description: "PagerDuty integration",
            owning_team_id: "team-sre",
            created_by: "user-admin",
            created_at: "2026-06-15T12:00:00.000Z",
            status: deleted ? "revoked" : "active",
            scopes,
          },
        });
        return true;
      }

      if (path === "/api/admin/service-accounts/sa-sub-playwright/scopes") {
        const body = (await postJson(route)) as ScopeRef;
        requests.push({ method, path, body });
        if (method === "POST") {
          scopes.push(body);
          items = items.map((item) => ({
            ...item,
            scope_counts: counts(scopes),
          }));
          await fulfillJson(route, { success: true, data: { added: body } });
          return true;
        }
        if (method === "DELETE") {
          const index = scopes.findIndex(
            (scope) => scope.type === body.type && scope.ref === body.ref,
          );
          if (index >= 0) scopes.splice(index, 1);
          items = items.map((item) => ({
            ...item,
            scope_counts: counts(scopes),
          }));
          await fulfillJson(route, { success: true, data: { removed: body } });
          return true;
        }
      }

      if (path === "/api/admin/service-accounts/sa-sub-playwright/rotate" && method === "POST") {
        requests.push({ method, path, body: null });
        await fulfillJson(route, {
          success: true,
          data: {
            credential: {
              client_id: "caipe-sa-incident-bot-a1b2c3",
              client_secret: "rotated-secret",
              token_url: "http://localhost:7080/realms/caipe/protocol/openid-connect/token",
            },
          },
        });
        return true;
      }

      if (path === "/api/admin/service-accounts/sa-sub-playwright" && method === "DELETE") {
        requests.push({ method, path, body: null });
        deleted = true;
        items = [];
        await fulfillJson(route, { success: true, data: { id: "sa-sub-playwright", status: "revoked" } });
        return true;
      }

      return false;
    };

    await installMockedRbacApp(page, {
      isAdmin: true,
      session: adminSession,
      handlers: [serviceAccountHandler],
    });

    await page.goto("/admin/platform/service-accounts", {
      waitUntil: "domcontentloaded",
    });

    await expect(page.getByRole("heading", { name: "Service Accounts", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Create Service Account" }).click();

    const createDialog = page.getByRole("dialog", { name: "Create Service Account" });
    await createDialog.getByLabel("Name").fill("incident-bot");
    await createDialog.getByLabel(/Description/).fill("PagerDuty integration");
    await createDialog.getByLabel("Owning team").click();
    await page.getByRole("option", { name: /SRE Team/ }).click();
    await createDialog.getByRole("button", { name: "Grant agents you hold..." }).click();
    await page.getByRole("button", { name: "Incident Resolver" }).first().click({ force: true });
    await createDialog.getByRole("button", { name: "Create" }).click({ force: true });

    await expect.poll(() => requests.some((request) => request.method === "POST" && request.path === "/api/admin/service-accounts")).toBe(true);
    expect(
      requests.find((request) => request.method === "POST" && request.path === "/api/admin/service-accounts")?.body,
    ).toMatchObject({
      name: "incident-bot",
      description: "PagerDuty integration",
      owning_team_id: "team-sre",
      scopes: createScopes,
    });

    const revealDialog = page.getByRole("dialog", { name: "Service account created" });
    await expect(revealDialog.getByText("created-secret", { exact: true })).toBeVisible();
    await expect(revealDialog.getByRole("button", { name: "Done" })).toBeDisabled();
    await revealDialog
      .getByLabel("I have copied the client secret and understand it won't be shown again.")
      .check();
    await revealDialog.getByRole("button", { name: "Done" }).click();

    const createdRow = page.getByRole("row", { name: /incident-bot/ });
    await expect(createdRow).toContainText("incident-bot");
    await expect(createdRow).toContainText("team-sre");
    await page.getByRole("button", { name: "Manage" }).click();

    const manageDialog = page.getByRole("dialog", { name: "incident-bot" });
    await expect(manageDialog.getByRole("button", { name: "Remove tool jira/search" })).toBeVisible();
    await manageDialog.getByRole("button", { name: /Add agents/ }).click();
    await page.getByRole("button", { name: "Runbook Agent" }).first().click({ force: true });
    await manageDialog.getByRole("button", { name: "Add", exact: true }).first().click({ force: true });
    await expect.poll(() => requests.some((request) => request.method === "POST" && request.path.endsWith("/scopes"))).toBe(true);
    expect(
      requests.find((request) => request.method === "POST" && request.path.endsWith("/scopes"))?.body,
    ).toEqual({ type: "agent", ref: "runbook-agent" });
    await expect(manageDialog.getByText("runbook-agent")).toBeVisible();

    await manageDialog.getByRole("button", { name: "Remove tool jira/search" }).click();
    await manageDialog.getByRole("button", { name: "Confirm" }).click();
    await expect.poll(() => requests.some((request) => request.method === "DELETE" && request.path.endsWith("/scopes"))).toBe(true);
    expect(
      requests.find((request) => request.method === "DELETE" && request.path.endsWith("/scopes"))?.body,
    ).toEqual({ type: "tool", ref: "jira/search" });
    await expect(manageDialog.getByRole("button", { name: "Remove tool jira/search" })).toHaveCount(0);

    await manageDialog.getByRole("button", { name: "Rotate credential" }).click();
    await manageDialog.getByRole("button", { name: "Confirm rotate" }).click();
    await expect(
      page
        .getByRole("dialog", { name: "Service account created" })
        .getByText("rotated-secret", { exact: true }),
    ).toBeVisible();
    await page
      .getByRole("dialog", { name: "Service account created" })
      .getByLabel("I have copied the client secret and understand it won't be shown again.")
      .check();
    await page.getByRole("dialog", { name: "Service account created" }).getByRole("button", { name: "Done" }).click();

    await page.getByRole("button", { name: "Manage" }).click();
    await page.getByRole("dialog", { name: "incident-bot" }).getByRole("button", { name: "Delete service account" }).click();
    await page.getByRole("button", { name: "Confirm delete" }).click();
    await expect.poll(() => requests.some((request) => request.method === "DELETE" && request.path === "/api/admin/service-accounts/sa-sub-playwright")).toBe(true);
    await expect(page.getByText("No service accounts yet")).toBeVisible();
  });

  test("super admin picker shows individual MCP tools, filters search, hides granted scopes, and posts exact refs", async ({
    page,
  }) => {
    const requests: Array<{ method: string; path: string; body: unknown }> = [];
    const scopes: ScopeRef[] = [
      { type: "agent", ref: "private-agent" },
      { type: "tool", ref: "argocd/*" },
    ];
    const grantableTools: GrantableItem[] = [
      { ref: "argocd/*", name: "argocd: all tools" },
      { ref: "backstage/catalog", name: "backstage: catalog" },
      { ref: "github/*", name: "github: all tools" },
      { ref: "jira/create_issue", name: "jira: create issue" },
      { ref: "jira/search", name: "jira: search" },
      { ref: "knowledge-base/query", name: "knowledge-base: query" },
    ];

    const handler: MockRouteHandler = async ({ route, path, method }) => {
      if (path === "/api/auth/my-roles" && method === "GET") {
        await fulfillJson(route, {
          teams: [{ _id: "team-1", slug: "team-platform", name: "Platform Team" }],
        });
        return true;
      }

      if (path === "/api/admin/service-accounts" && method === "GET") {
        await fulfillJson(route, {
          success: true,
          data: {
            items: [
              {
                id: "sa-sub-full-catalog",
                name: "catalog-bot",
                description: "Platform catalog test",
                owning_team_id: "team-platform",
                created_by: "user-admin",
                created_at: "2026-06-17T12:00:00.000Z",
                status: "active",
                scope_counts: counts(scopes),
              },
            ],
          },
        });
        return true;
      }

      if (path === "/api/admin/service-accounts/sa-sub-full-catalog" && method === "GET") {
        await fulfillJson(route, {
          success: true,
          data: {
            id: "sa-sub-full-catalog",
            name: "catalog-bot",
            description: "Platform catalog test",
            owning_team_id: "team-platform",
            created_by: "user-admin",
            created_at: "2026-06-17T12:00:00.000Z",
            status: "active",
            scopes,
          },
        });
        return true;
      }

      if (path === "/api/admin/service-accounts/grantable" && method === "GET") {
        await fulfillJson(route, {
          success: true,
          data: {
            agents: [{ ref: "private-agent", name: "Private Agent" }],
            tools: grantableTools,
          },
        });
        return true;
      }

      if (path === "/api/admin/service-accounts/token-providers" && method === "GET") {
        await fulfillJson(route, { success: true, data: [] });
        return true;
      }

      if (path === "/api/admin/service-accounts/sa-sub-full-catalog/credentials" && method === "GET") {
        await fulfillJson(route, { success: true, data: [] });
        return true;
      }

      if (path === "/api/admin/service-accounts/sa-sub-full-catalog/scopes" && method === "POST") {
        const body = (await postJson(route)) as ScopeRef;
        requests.push({ method, path, body });
        if (body.ref === "github/*") {
          await fulfillJson(route, { success: false, error: "Backend rejected github wildcard" }, 403);
          return true;
        }
        scopes.push(body);
        await fulfillJson(route, { success: true, data: { added: body } });
        return true;
      }

      return false;
    };

    await installMockedRbacApp(page, {
      isAdmin: true,
      session: adminSession,
      handlers: [handler],
    });

    await page.goto("/admin/platform/service-accounts", {
      waitUntil: "domcontentloaded",
    });

    await page.getByRole("row", { name: /catalog-bot/ }).getByRole("button", { name: "Manage" }).click();
    const dialog = page.getByRole("dialog", { name: "catalog-bot" });
    await expect(dialog.getByText("argocd/*")).toBeVisible();

    await dialog.getByRole("button", { name: /Add tools/ }).click();
    await expect(page.getByRole("button", { name: "argocd: all tools" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "jira: search" })).toBeVisible();
    await expect(page.getByRole("button", { name: "jira: create issue" })).toBeVisible();
    await expect(page.getByRole("button", { name: "github: all tools" })).toBeVisible();

    const search = page.getByTestId("multi-select-search");
    await search.click();
    await page.keyboard.type("jira");
    await expect(search).toHaveValue("jira");
    await expect(page.getByRole("button", { name: "jira: search" })).toBeVisible();
    await expect(page.getByRole("button", { name: "jira: create issue" })).toBeVisible();
    await expect(page.getByRole("button", { name: "backstage: catalog" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "github: all tools" })).toHaveCount(0);

    await page.getByRole("button", { name: "jira: search" }).click({ force: true });
    await dialog.getByRole("button", { name: "Add", exact: true }).first().click({ force: true });
    await expect.poll(() => requests.some((request) => request.method === "POST")).toBe(true);
    expect(requests.at(-1)?.body).toEqual({ type: "tool", ref: "jira/search" });
    await expect(dialog.getByText("jira/search")).toBeVisible();

    await dialog.getByRole("button", { name: /Add tools/ }).click();
    await expect(page.getByRole("button", { name: "jira: search" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "github: all tools" })).toBeVisible();
    await page.getByRole("button", { name: "github: all tools" }).click({ force: true });
    await expect(dialog.getByRole("button", { name: "github: all tools" }).first()).toBeVisible();

    const requestCount = requests.length;
    const scopeAdd = dialog.getByRole("button", { name: "Add", exact: true }).first();
    await expect(scopeAdd).toBeEnabled();
    await scopeAdd.click({ force: true });
    await expect.poll(() => requests.length).toBe(requestCount + 1);
    expect(requests.at(-1)?.body).toEqual({ type: "tool", ref: "github/*" });
    await expect(dialog.getByText("Backend rejected github wildcard")).toBeVisible();
    await expect(dialog.getByText("github/*")).toHaveCount(0);
  });

  test("non-super-admin picker only renders caller-held service account tools", async ({
    page,
  }) => {
    const scopes: ScopeRef[] = [{ type: "agent", ref: "agent-private" }];

    const heldOnlyHandler: MockRouteHandler = async ({ route, path, method }) => {
      if (path === "/api/auth/my-roles" && method === "GET") {
        await fulfillJson(route, {
          teams: [{ _id: "team-1", slug: "team-dev", name: "Dev Team" }],
        });
        return true;
      }

      if (path === "/api/admin/service-accounts" && method === "GET") {
        await fulfillJson(route, {
          success: true,
          data: {
            items: [
              {
                id: "sa-sub-held-only",
                name: "held-only-bot",
                owning_team_id: "team-dev",
                created_by: "user-dev",
                created_at: "2026-06-17T12:00:00.000Z",
                status: "active",
                scope_counts: counts(scopes),
              },
            ],
          },
        });
        return true;
      }

      if (path === "/api/admin/service-accounts/sa-sub-held-only" && method === "GET") {
        await fulfillJson(route, {
          success: true,
          data: {
            id: "sa-sub-held-only",
            name: "held-only-bot",
            owning_team_id: "team-dev",
            created_by: "user-dev",
            created_at: "2026-06-17T12:00:00.000Z",
            status: "active",
            scopes,
          },
        });
        return true;
      }

      if (path === "/api/admin/service-accounts/grantable" && method === "GET") {
        await fulfillJson(route, {
          success: true,
          data: {
            agents: [{ ref: "agent-private", name: "Private Agent" }],
            tools: [{ ref: "mcp-meraki/*", name: "mcp-meraki: all tools" }],
          },
        });
        return true;
      }

      if (path === "/api/admin/service-accounts/token-providers" && method === "GET") {
        await fulfillJson(route, { success: true, data: [] });
        return true;
      }

      if (path === "/api/admin/service-accounts/sa-sub-held-only/credentials" && method === "GET") {
        await fulfillJson(route, { success: true, data: [] });
        return true;
      }

      return false;
    };

    await installMockedRbacApp(page, {
      isAdmin: false,
      session: {
        email: "dev-user@example.com",
        name: "Dev User",
        role: "user",
        canViewAdmin: true,
      },
      handlers: [heldOnlyHandler],
    });

    await page.goto("/admin/platform/service-accounts", {
      waitUntil: "domcontentloaded",
    });

    await page.getByRole("row", { name: /held-only-bot/ }).getByRole("button", { name: "Manage" }).click();
    const dialog = page.getByRole("dialog", { name: "held-only-bot" });
    await dialog.getByRole("button", { name: /Add tools/ }).click();

    await expect(page.getByRole("button", { name: "mcp-meraki: all tools" })).toBeVisible();
    await expect(page.getByRole("button", { name: "jira: search" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "github: all tools" })).toHaveCount(0);
  });

  test("adds, validates, lists, de-duplicates, and removes service account provider tokens", async ({
    page,
  }) => {
    const requests: Array<{ method: string; path: string; body: unknown }> = [];
    const items: ServiceAccountItem[] = [
      {
        id: "sa-sub-token-bot",
        name: "token-bot",
        description: "Uses provider tokens",
        owning_team_id: "team-sre",
        created_by: "user-admin",
        created_at: "2026-06-15T12:00:00.000Z",
        status: "active",
        scope_counts: { agents: 1, tools: 1 },
      },
    ];
    const credentials: ServiceAccountCredential[] = [];
    let failNextAdd = true;

    const tokenHandler: MockRouteHandler = async ({ route, path, method }) => {
      if (path === "/api/auth/my-roles" && method === "GET") {
        await fulfillJson(route, {
          teams: [{ _id: "team-1", slug: "team-sre", name: "SRE Team" }],
        });
        return true;
      }

      if (path === "/api/admin/service-accounts/grantable" && method === "GET") {
        await fulfillJson(route, {
          success: true,
          data: {
            agents: [{ ref: "incident-resolver", name: "Incident Resolver" }],
            tools: [{ ref: "gitlab/projects", name: "gitlab: projects" }],
          },
        });
        return true;
      }

      if (path === "/api/admin/service-accounts" && method === "GET") {
        await fulfillJson(route, { success: true, data: { items } });
        return true;
      }

      if (path === "/api/admin/service-accounts/sa-sub-token-bot" && method === "GET") {
        await fulfillJson(route, {
          success: true,
          data: {
            id: "sa-sub-token-bot",
            name: "token-bot",
            description: "Uses provider tokens",
            owning_team_id: "team-sre",
            created_by: "user-admin",
            created_at: "2026-06-15T12:00:00.000Z",
            status: "active",
            scopes: [
              { type: "agent", ref: "incident-resolver" },
              { type: "tool", ref: "gitlab/projects" },
            ],
          },
        });
        return true;
      }

      if (path === "/api/admin/service-accounts/token-providers" && method === "GET") {
        await fulfillJson(route, {
          success: true,
          data: [
            { provider: "github", name: "GitHub" },
            { provider: "gitlab", name: "GitLab" },
          ],
        });
        return true;
      }

      if (path === "/api/admin/service-accounts/sa-sub-token-bot/credentials") {
        if (method === "GET") {
          await fulfillJson(route, { success: true, data: credentials });
          return true;
        }

        if (method === "POST") {
          const body = await postJson(route);
          requests.push({ method, path, body });
          if (failNextAdd) {
            failNextAdd = false;
            await fulfillJson(route, { success: false, error: "Token already exists" }, 409);
            return true;
          }
          credentials.push({
            id: "conn-gitlab",
            provider: "gitlab",
            status: "connected",
            connectedAt: "2026-06-15T12:34:00.000Z",
            requestedScopes: ["api"],
          });
          await fulfillJson(
            route,
            {
              success: true,
              data: {
                id: "conn-gitlab",
                provider: "gitlab",
                status: "connected",
                connectedAt: "2026-06-15T12:34:00.000Z",
                requestedScopes: ["api"],
              },
            },
            201,
          );
          return true;
        }

        if (method === "DELETE") {
          const body = (await postJson(route)) as { connection_id?: string } | null;
          requests.push({ method, path, body });
          const index = credentials.findIndex((credential) => credential.id === body?.connection_id);
          if (index >= 0) credentials.splice(index, 1);
          await fulfillJson(route, { success: true, data: { deleted: body?.connection_id } });
          return true;
        }
      }

      return false;
    };

    await installMockedRbacApp(page, {
      isAdmin: true,
      session: adminSession,
      gates: { credentials: true },
      handlers: [tokenHandler],
    });
    await forceCredentialClientConfig(page);

    await page.goto("/admin/platform/service-accounts", {
      waitUntil: "domcontentloaded",
    });

    await expect(page.getByRole("heading", { name: "Service Accounts", exact: true })).toBeVisible();
    await page.getByRole("row", { name: /token-bot/ }).getByRole("button", { name: "Manage" }).click();

    const manageDialog = page.getByRole("dialog", { name: "token-bot" });
    await expect(manageDialog.getByText("Tokens", { exact: true })).toBeVisible();
    await expect(manageDialog.getByText(/No tokens added/)).toBeVisible();
    await expect(manageDialog.getByText("Add a token")).toBeVisible();

    const providerSelect = manageDialog.getByRole("combobox", {
      name: "Token provider",
    });
    await providerSelect.selectOption("gitlab");
    const tokenInput = manageDialog.getByLabel("Access token");
    await expect(tokenInput).toHaveAttribute("autocomplete", "off");
    await expect(tokenInput).toHaveAttribute("data-1p-ignore", "true");
    await expect(tokenInput).toHaveAttribute("data-lpignore", "true");
    await tokenInput.fill("glpat-playwright-secret");

    await manageDialog.getByRole("button", { name: "Add", exact: true }).last().click();
    await expect(manageDialog.getByText("Token already exists")).toBeVisible();
    await expect(tokenInput).toHaveValue("glpat-playwright-secret");

    await tokenInput.press("Enter");
    await expect.poll(() => credentials.length).toBe(1);
    const addRequests = requests.filter(
      (request) => request.method === "POST" && request.path.endsWith("/credentials"),
    );
    expect(addRequests).toHaveLength(2);
    expect(addRequests[0].body).toEqual({
      provider: "gitlab",
      token: "glpat-playwright-secret",
    });
    expect(addRequests[1].body).toEqual({
      provider: "gitlab",
      token: "glpat-playwright-secret",
    });

    await expect(manageDialog.getByText("Token already exists")).toHaveCount(0);
    await expect(tokenInput).toHaveValue("");
    await expect(manageDialog.getByText("GitLab", { exact: true })).toBeVisible();
    await expect(manageDialog.getByText("connected")).toBeVisible();
    await expect(manageDialog.getByText("glpat-playwright-secret")).toHaveCount(0);

    await expect(providerSelect.locator('option[value="gitlab"]')).toHaveCount(0);
    await expect(providerSelect.locator('option[value="github"]')).toHaveCount(1);
    await providerSelect.selectOption("github");

    await manageDialog.getByRole("button", { name: "Remove GitLab credential" }).click();
    await expect(manageDialog.getByText("Remove?")).toBeVisible();
    await manageDialog.getByRole("button", { name: "Cancel" }).click();
    await expect(manageDialog.getByText("GitLab", { exact: true })).toBeVisible();
    await expect.poll(() => credentials.length).toBe(1);

    await manageDialog.getByRole("button", { name: "Remove GitLab credential" }).click();
    await manageDialog.getByRole("button", { name: "Confirm" }).click();
    await expect.poll(() => credentials.length).toBe(0);
    expect(
      requests.find((request) => request.method === "DELETE" && request.path.endsWith("/credentials"))?.body,
    ).toEqual({ connection_id: "conn-gitlab" });
    await expect(manageDialog.getByText(/No tokens added/)).toBeVisible();

    await expect(providerSelect.locator('option[value="gitlab"]')).toHaveCount(1);
    await providerSelect.selectOption("gitlab");
  });

  test("hides the Tokens section when service account token passthrough is disabled", async ({
    page,
  }) => {
    const items: ServiceAccountItem[] = [
      {
        id: "sa-sub-no-tokens",
        name: "no-tokens-bot",
        owning_team_id: "team-sre",
        created_by: "user-admin",
        created_at: "2026-06-15T12:00:00.000Z",
        status: "active",
        scope_counts: { agents: 0, tools: 0 },
      },
    ];

    const disabledTokensHandler: MockRouteHandler = async ({ route, path, method }) => {
      if (path === "/api/auth/my-roles" && method === "GET") {
        await fulfillJson(route, {
          teams: [{ _id: "team-1", slug: "team-sre", name: "SRE Team" }],
        });
        return true;
      }

      if (path === "/api/admin/service-accounts" && method === "GET") {
        await fulfillJson(route, { success: true, data: { items } });
        return true;
      }

      if (path === "/api/admin/service-accounts/sa-sub-no-tokens" && method === "GET") {
        await fulfillJson(route, {
          success: true,
          data: {
            id: "sa-sub-no-tokens",
            name: "no-tokens-bot",
            owning_team_id: "team-sre",
            created_by: "user-admin",
            created_at: "2026-06-15T12:00:00.000Z",
            status: "active",
            scopes: [],
          },
        });
        return true;
      }

      if (path === "/api/admin/service-accounts/grantable" && method === "GET") {
        await fulfillJson(route, { success: true, data: { agents: [], tools: [] } });
        return true;
      }

      if (path === "/api/admin/service-accounts/token-providers" && method === "GET") {
        await fulfillJson(route, { success: false, code: "CREDENTIALS_DISABLED" }, 404);
        return true;
      }

      if (path === "/api/admin/service-accounts/sa-sub-no-tokens/credentials" && method === "GET") {
        await fulfillJson(route, { success: true, data: [] });
        return true;
      }

      return false;
    };

    await installMockedRbacApp(page, {
      isAdmin: true,
      session: adminSession,
      handlers: [disabledTokensHandler],
    });

    await page.goto("/admin/platform/service-accounts", {
      waitUntil: "domcontentloaded",
    });

    await page.getByRole("row", { name: /no-tokens-bot/ }).getByRole("button", { name: "Manage" }).click();
    const manageDialog = page.getByRole("dialog", { name: "no-tokens-bot" });
    await expect(manageDialog.getByText("Current scopes")).toBeVisible();
    await expect(manageDialog.getByText("Tokens", { exact: true })).toHaveCount(0);
    await expect(manageDialog.getByText("Add a token", { exact: true })).toHaveCount(0);
    await expect(manageDialog.getByLabel("Access token")).toHaveCount(0);
  });

  test("grants full-catalog tool scopes to the unlinked service account", async ({ page }) => {
    const requests: Array<{ method: string; path: string; search: string; body: unknown }> = [];
    const scopes: ScopeRef[] = [];

    const unlinkedHandler: MockRouteHandler = async ({ route, path, method, url }) => {
      if (path === "/api/admin/platform-config" && method === "GET") {
        await fulfillJson(route, {
          data: {
            default_agent_id: "incident-resolver",
            release_notes: { enabled: false },
          },
        });
        return true;
      }

      if (path === "/api/dynamic-agents" && method === "GET") {
        await fulfillJson(route, {
          data: [{ _id: "incident-resolver", name: "Incident Resolver", enabled: true }],
        });
        return true;
      }

      if (path === "/api/admin/service-accounts/unlinked" && method === "GET") {
        await fulfillJson(route, {
          success: true,
          data: {
            id: "sa-unlinked-platform",
            name: "platform-unlinked",
            scopes,
          },
        });
        return true;
      }

      if (path === "/api/admin/service-accounts/grantable" && method === "GET") {
        requests.push({ method, path, search: url.search, body: null });
        if (url.searchParams.get("context") === "unlinked") {
          await fulfillJson(route, {
            success: true,
            data: {
              agents: [{ ref: "incident-resolver", name: "Incident Resolver" }],
              tools: [
                { ref: "jira/search", name: "jira: search" },
                { ref: "jira/create_issue", name: "jira: create issue" },
                { ref: "github/*", name: "github: all tools" },
              ],
            },
          });
          return true;
        }
        await fulfillJson(route, { success: true, data: { agents: [], tools: [] } });
        return true;
      }

      if (path === "/api/admin/service-accounts/sa-unlinked-platform/scopes" && method === "POST") {
        const body = (await postJson(route)) as ScopeRef;
        requests.push({ method, path, search: url.search, body });
        scopes.push(body);
        await fulfillJson(route, { success: true, data: { added: body } });
        return true;
      }

      return false;
    };

    await installMockedRbacApp(page, {
      isAdmin: true,
      session: adminSession,
      handlers: [unlinkedHandler],
    });

    await page.goto("/admin/security/access-before-sign-in", {
      waitUntil: "domcontentloaded",
    });

    await page.getByRole("button", { name: "Review unlinked access" }).click();
    const dialog = page.getByRole("dialog", { name: "Unlinked Access" });
    await expect(dialog).toBeVisible();

    await dialog.getByLabel("Scope type").selectOption("tool");
    await expect(dialog.getByTestId("unlinked-modal-grantable-empty-note")).toHaveCount(0);

    await chooseSearchablePickerOption(
      page,
      dialog.getByLabel("Scope ref"),
      "jira: search",
    );
    await dialog.getByRole("button", { name: "Add" }).click();

    await expect
      .poll(() =>
        requests.some(
          (request) =>
            request.method === "GET" &&
            request.path === "/api/admin/service-accounts/grantable" &&
            request.search === "?context=unlinked",
        ),
      )
      .toBe(true);
    await expect
      .poll(() =>
        requests.some(
          (request) =>
            request.method === "POST" &&
            request.path === "/api/admin/service-accounts/sa-unlinked-platform/scopes",
        ),
      )
      .toBe(true);
    expect(
      requests.find(
        (request) =>
          request.method === "POST" &&
          request.path === "/api/admin/service-accounts/sa-unlinked-platform/scopes",
      )?.body,
    ).toEqual({ type: "tool", ref: "jira/search" });
    await expect(dialog.getByText("tool/jira/search")).toBeVisible();
  });

  test("shows no tool choices for unlinked access when catalog discovery found no tools", async ({
    page,
  }) => {
    const requests: Array<{ method: string; path: string; search: string; body: unknown }> = [];

    const unlinkedEmptyToolsHandler: MockRouteHandler = async ({ route, path, method, url }) => {
      if (path === "/api/admin/platform-config" && method === "GET") {
        await fulfillJson(route, {
          data: {
            default_agent_id: "incident-resolver",
            release_notes: { enabled: false },
          },
        });
        return true;
      }

      if (path === "/api/dynamic-agents" && method === "GET") {
        await fulfillJson(route, {
          data: [{ _id: "incident-resolver", name: "Incident Resolver", enabled: true }],
        });
        return true;
      }

      if (path === "/api/admin/service-accounts/unlinked" && method === "GET") {
        await fulfillJson(route, {
          success: true,
          data: {
            id: "sa-unlinked-platform",
            name: "platform-unlinked",
            scopes: [],
          },
        });
        return true;
      }

      if (path === "/api/admin/service-accounts/grantable" && method === "GET") {
        requests.push({ method, path, search: url.search, body: null });
        if (url.searchParams.get("context") === "unlinked") {
          await fulfillJson(route, {
            success: true,
            data: {
              agents: [{ ref: "incident-resolver", name: "Incident Resolver" }],
              tools: [],
            },
          });
          return true;
        }
        await fulfillJson(route, { success: true, data: { agents: [], tools: [] } });
        return true;
      }

      return false;
    };

    await installMockedRbacApp(page, {
      isAdmin: true,
      session: adminSession,
      handlers: [unlinkedEmptyToolsHandler],
    });

    await page.goto("/admin/security/access-before-sign-in", {
      waitUntil: "domcontentloaded",
    });

    await page.getByRole("button", { name: "Review unlinked access" }).click();
    const dialog = page.getByRole("dialog", { name: "Unlinked Access" });
    await expect(dialog).toBeVisible();

    await dialog.getByLabel("Scope type").selectOption("tool");
    await expect(dialog.getByTestId("unlinked-modal-grantable-empty-note")).toHaveText(
      /No tools available to grant/i,
    );
    await expect(dialog.getByLabel("Scope ref")).toContainText("No more tools available");
    await expect(dialog.getByLabel("Scope ref")).not.toContainText("jira: all tools");
    await expect(dialog.getByRole("button", { name: "Add" })).toBeDisabled();
    await expect
      .poll(() =>
        requests.some(
          (request) =>
            request.method === "GET" &&
            request.path === "/api/admin/service-accounts/grantable" &&
            request.search === "?context=unlinked",
        ),
      )
      .toBe(true);
  });

  test("admin without a team filter sees service accounts across every team", async ({ page }) => {
    const handler: MockRouteHandler = async ({ route, path, method }) => {
      if (path === "/api/auth/my-roles" && method === "GET") {
        await fulfillJson(route, {
          teams: [{ _id: "team-1", slug: "team-sre", name: "SRE Team" }],
        });
        return true;
      }

      if (path === "/api/admin/service-accounts" && method === "GET") {
        await fulfillJson(route, {
          success: true,
          data: {
            items: [
              {
                id: "sa-sre",
                name: "sre-bot",
                owning_team_id: "team-sre",
                created_by: "user-sre",
                created_at: "2026-06-15T12:00:00.000Z",
                status: "active",
                scope_counts: { agents: 0, tools: 0 },
              },
              {
                id: "sa-platform",
                name: "platform-bot",
                owning_team_id: "team-platform",
                created_by: "user-platform",
                created_at: "2026-06-16T12:00:00.000Z",
                status: "active",
                scope_counts: { agents: 0, tools: 0 },
              },
            ],
          },
        });
        return true;
      }

      return false;
    };

    await installMockedRbacApp(page, {
      isAdmin: true,
      session: adminSession,
      handlers: [handler],
    });

    await page.goto("/admin/platform/service-accounts", {
      waitUntil: "domcontentloaded",
    });

    await expect(page.getByRole("heading", { name: "Service Accounts", exact: true })).toBeVisible();
    const sreRow = page.getByRole("row", { name: /sre-bot/ });
    const platformRow = page.getByRole("row", { name: /platform-bot/ });
    await expect(sreRow).toContainText("team-sre");
    await expect(platformRow).toContainText("team-platform");
  });

  test("search input filters the service accounts list", async ({ page }) => {
    const allItems: ServiceAccountItem[] = [
      {
        id: "sa-incident",
        name: "incident-bot",
        owning_team_id: "team-sre",
        created_by: "user-admin",
        created_at: "2026-06-15T12:00:00.000Z",
        status: "active",
        scope_counts: { agents: 0, tools: 0 },
      },
      {
        id: "sa-pager",
        name: "pager-bot",
        owning_team_id: "team-sre",
        created_by: "user-admin",
        created_at: "2026-06-15T12:00:00.000Z",
        status: "active",
        scope_counts: { agents: 0, tools: 0 },
      },
      {
        id: "sa-deploy",
        name: "deploy-bot",
        owning_team_id: "team-sre",
        created_by: "user-admin",
        created_at: "2026-06-15T12:00:00.000Z",
        status: "active",
        scope_counts: { agents: 0, tools: 0 },
      },
    ];

    const searchHandler: MockRouteHandler = async ({ route, path, method, url }) => {
      if (path === "/api/auth/my-roles" && method === "GET") {
        await fulfillJson(route, {
          teams: [{ _id: "team-1", slug: "team-sre", name: "SRE Team" }],
        });
        return true;
      }

      if (path === "/api/admin/service-accounts" && method === "GET") {
        const search = (url.searchParams.get("search") || "").toLowerCase();
        const items = allItems.filter(
          (item) => !search || item.name.toLowerCase().includes(search),
        );
        await fulfillJson(route, {
          success: true,
          data: { items, total: items.length, page: 1, page_size: 24 },
        });
        return true;
      }

      return false;
    };

    await installMockedRbacApp(page, {
      isAdmin: true,
      session: adminSession,
      handlers: [searchHandler],
    });

    await page.goto("/admin/platform/service-accounts", {
      waitUntil: "domcontentloaded",
    });

    await expect(page.getByRole("row", { name: /incident-bot/ })).toBeVisible();
    await expect(page.getByRole("row", { name: /pager-bot/ })).toBeVisible();
    await expect(page.getByRole("row", { name: /deploy-bot/ })).toBeVisible();

    await page.getByLabel("Search service accounts").fill("pager");
    await expect(page.getByRole("row", { name: /pager-bot/ })).toBeVisible();
    await expect(page.getByRole("row", { name: /incident-bot/ })).toHaveCount(0);
    await expect(page.getByRole("row", { name: /deploy-bot/ })).toHaveCount(0);

    await page.getByLabel("Search service accounts").fill("no-such-bot");
    await expect(
      page.getByRole("heading", { name: "No matching service accounts" }),
    ).toBeVisible();
    await expect(page.getByText(/No service accounts match/)).toBeVisible();
  });

  test("paginates service accounts with working prev/next controls", async ({ page }) => {
    const PAGE_SIZE = 24;
    const allItems: ServiceAccountItem[] = Array.from({ length: 50 }, (_, index) => ({
      id: `sa-page-${index + 1}`,
      name: `bot-${String(index + 1).padStart(2, "0")}`,
      owning_team_id: "team-sre",
      created_by: "user-admin",
      created_at: "2026-06-15T12:00:00.000Z",
      status: "active",
      scope_counts: { agents: 0, tools: 0 },
    }));

    const paginationHandler: MockRouteHandler = async ({ route, path, method, url }) => {
      if (path === "/api/auth/my-roles" && method === "GET") {
        await fulfillJson(route, {
          teams: [{ _id: "team-1", slug: "team-sre", name: "SRE Team" }],
        });
        return true;
      }

      if (path === "/api/admin/service-accounts" && method === "GET") {
        const page = Number(url.searchParams.get("page") || "1");
        const pageSize = Number(url.searchParams.get("page_size") || String(PAGE_SIZE));
        const start = (page - 1) * pageSize;
        const items = allItems.slice(start, start + pageSize);
        await fulfillJson(route, {
          success: true,
          data: { items, total: allItems.length, page, page_size: pageSize },
        });
        return true;
      }

      return false;
    };

    await installMockedRbacApp(page, {
      isAdmin: true,
      session: adminSession,
      handlers: [paginationHandler],
    });

    await page.goto("/admin/platform/service-accounts", {
      waitUntil: "domcontentloaded",
    });

    await expect(page.getByRole("heading", { name: "Service Accounts", exact: true })).toBeVisible();
    await expect(page.getByText("Page 1 of 3 (50 total)")).toBeVisible();
    await expect(page.getByRole("row", { name: /bot-01/ })).toBeVisible();
    await expect(page.getByRole("row", { name: /bot-24/ })).toBeVisible();
    await expect(page.getByRole("row", { name: /bot-25/ })).toHaveCount(0);

    const prevButton = page.getByRole("button", { name: "Previous page" });
    const nextButton = page.getByRole("button", { name: "Next page" });
    await expect(prevButton).toBeDisabled();
    await expect(nextButton).toBeEnabled();

    await nextButton.click();
    await expect(page.getByText("Page 2 of 3 (50 total)")).toBeVisible();
    await expect(page.getByRole("row", { name: /bot-25/ })).toBeVisible();
    await expect(prevButton).toBeEnabled();

    await prevButton.click();
    await expect(page.getByText("Page 1 of 3 (50 total)")).toBeVisible();
    await expect(page.getByRole("row", { name: /bot-01/ })).toBeVisible();
  });
});
