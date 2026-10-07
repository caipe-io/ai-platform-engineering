// assisted-by Codex Codex-sonnet-4-6

import { expect, test } from "@playwright/test";

import {
  fulfillJson,
  installMockedRbacApp,
  mockedRbacEnabled,
  type MockRouteHandler,
} from "./_mocked-rbac";

const adminSession = {
  email: "user@example.com",
  name: "Example User",
  role: "admin" as const,
  canViewAdmin: true,
};

const agents = [
  {
    _id: "agent-incident",
    name: "Incident Commander",
    ui: {
      avatar: {
        type: "icon",
        icon: "bot",
        bgColor: "#0f766e",
        textColor: "#ffffff",
      },
    },
  },
  {
    _id: "agent-finops",
    name: "FinOps Analyst",
  },
];

const conversations = [
  {
    id: "conv-slack-incident",
    title: "Slack incident bridge",
    owner_id: "slack-user@example.com",
    agent_id: "agent-incident",
    created_at: "2026-06-15T13:20:00.000Z",
    updated_at: "2026-06-16T18:30:00.000Z",
    checkpoint_count: 7,
    file_count: 2,
    client_type: "slack",
    idempotency_key: "slack:T123:C456:1718562600.000000",
    metadata: {
      workspace_url: "https://example.slack.com",
      channel_id: "C456",
      channel_name: "incidents",
      thread_ts: "1718562600.000000",
    },
    is_archived: false,
    deleted_at: null,
  },
  {
    id: "conv-web-finops",
    title: "Web cost review",
    owner_id: adminSession.email,
    agent_id: "agent-finops",
    created_at: "2026-06-14T12:00:00.000Z",
    updated_at: "2026-06-16T16:00:00.000Z",
    checkpoint_count: 3,
    message_count: 8,
    file_count: 0,
    client_type: "webui",
    is_archived: false,
    deleted_at: null,
  },
  {
    id: "conv-archived",
    title: "Archived audit trail",
    owner_id: "ops@example.com",
    agent_id: "agent-incident",
    created_at: "2026-06-10T09:00:00.000Z",
    updated_at: "2026-06-11T09:00:00.000Z",
    checkpoint_count: 1,
    file_count: 0,
    client_type: "webui",
    is_archived: true,
    deleted_at: null,
  },
];

function paginated(items: unknown[], total = items.length, page = 1, pageSize = 10) {
  return {
    success: true,
    data: {
      items,
      total,
      page,
      page_size: pageSize,
      has_more: page * pageSize < total,
    },
  };
}

function installConversationRoutes(options: {
  denyConversations?: boolean;
  onConversationRequest?: (url: URL) => void;
  onDeleteRequest?: (conversationId: string) => void;
} = {}): MockRouteHandler {
  return async ({ route, path, method, url }) => {
    if (path === "/api/dynamic-agents" && method === "GET") {
      await fulfillJson(route, paginated(agents, agents.length, 1, 100));
      return true;
    }

    if (path === "/api/dynamic-agents/conversations" && method === "GET") {
      options.onConversationRequest?.(url);
      if (options.denyConversations) {
        await fulfillJson(
          route,
          {
            success: false,
            error: "You do not have permission to access this resource.",
            code: "audit_log#read",
          },
          403,
        );
        return true;
      }

      const search = url.searchParams.get("search")?.trim().toLowerCase();
      const agentId = url.searchParams.get("agent_id")?.trim();
      const page = Number(url.searchParams.get("page") ?? "1");
      const pageSize = Number(url.searchParams.get("page_size") ?? "10");
      let filtered = conversations;

      if (search) {
        filtered = filtered.filter((conversation) =>
          [conversation.id, conversation.title, conversation.owner_id].some((value) =>
            value.toLowerCase().includes(search),
          ),
        );
      }

      if (agentId) {
        filtered = filtered.filter((conversation) => conversation.agent_id === agentId);
      }

      const start = (page - 1) * pageSize;
      await fulfillJson(route, paginated(filtered.slice(start, start + pageSize), filtered.length, page, pageSize));
      return true;
    }

    if (path.startsWith("/api/admin/audit-logs/") && method === "DELETE") {
      options.onDeleteRequest?.(decodeURIComponent(path.split("/").pop() ?? ""));
      await fulfillJson(route, { success: true });
      return true;
    }

    return false;
  };
}

test.describe("mocked RBAC Dynamic Agents workspace", () => {
  test.beforeEach(() => {
    test.skip(
      !mockedRbacEnabled(),
      "Set RUN_RBAC_REGRESSION=1 to run the mocked RBAC browser regression.",
    );
  });

  test("superadmin can open and manage the Conversations tab without a permission error", async ({
    page,
  }) => {
    const conversationRequests: URL[] = [];
    const deleteRequests: string[] = [];

    await installMockedRbacApp(page, {
      isAdmin: true,
      session: adminSession,
      gates: { audit_logs: false, dynamic_agent_conversations: true },
      handlers: [
        installConversationRoutes({
          onConversationRequest: (url) => conversationRequests.push(new URL(url.toString())),
          onDeleteRequest: (conversationId) => deleteRequests.push(conversationId),
        }),
      ],
    });

    await page.goto("/dynamic-agents?tab=conversations", { waitUntil: "domcontentloaded" });

    await expect(page).toHaveURL(/\/dynamic-agents\?tab=conversations/);
    const navigation = page.getByRole("navigation", { name: "Agent sections" });
    await expect(navigation.getByRole("button", { name: /Conversations/ })).toHaveAttribute(
      "aria-current",
      "page",
    );
    await expect(
      page.getByText("Review agent conversations and manage their checkpoint history."),
    ).toBeVisible();
    await expect(page.getByText("You do not have permission to access this resource.")).toHaveCount(0);
    await expect(page.getByText("3 conversations found")).toBeVisible();

    await expect(page.getByText("Slack incident bridge")).toBeVisible();
    await expect(page.getByText("Incident Commander")).toHaveCount(2);
    await expect(page.getByText("Slack", { exact: true })).toBeVisible();
    await expect(page.getByText("Web cost review")).toBeVisible();
    await expect(page.getByText("FinOps Analyst")).toHaveCount(1);
    await expect(page.getByText("Archived audit trail")).toBeVisible();
    await expect(page.getByText("Archived", { exact: true })).toBeVisible();
    await expect(page.getByText("Showing 1–3 of 3")).toBeVisible();

    await page.getByText("Slack incident bridge").click();
    const dialog = page.getByRole("dialog");
    await expect(dialog.getByRole("heading", { name: "Slack incident bridge" })).toBeVisible();
    await expect(dialog.getByText("conv-slack-incident")).toBeVisible();
    await expect(dialog.getByText("slack-user@example.com")).toBeVisible();
    await expect(dialog.getByText("Incident Commander")).toBeVisible();
    await expect(dialog.getByText("View Slack thread")).toHaveAttribute(
      "href",
      "https://example.slack.com/archives/C456/p1718562600000000",
    );
    await expect(dialog.getByText("Checkpoints")).toBeVisible();
    await expect(dialog.getByText("Files")).toBeVisible();

    page.once("dialog", async (nativeDialog) => {
      expect(nativeDialog.message()).toContain("permanently remove");
      await nativeDialog.accept();
    });
    await dialog.getByRole("button", { name: "Delete All" }).click();
    await expect.poll(() => deleteRequests).toEqual(["conv-slack-incident"]);

    await expect.poll(() => conversationRequests.length).toBeGreaterThanOrEqual(2);
    expect(conversationRequests[0].searchParams.get("page")).toBe("1");
    expect(conversationRequests[0].searchParams.get("page_size")).toBe("10");
  });

  test("discloses separate Model Providers and LLM Models views", async ({ page }) => {
    const modelRoutes: MockRouteHandler = async ({ method,path,route }) => {
      if (path === "/api/llm-models" && method === "GET") {
        await fulfillJson(route,{ success: true,data: { items: [] } });
        return true;
      }
      if (path === "/api/credentials/secrets" && method === "GET") {
        await fulfillJson(route,{ data: [] });
        return true;
      }
      return false;
    };

    await installMockedRbacApp(page,{
      handlers: [modelRoutes],
      isAdmin: true,
      session: adminSession,
    });
    await page.goto("/dynamic-agents?tab=agents",{ waitUntil: "domcontentloaded" });

    const navigation = page.getByRole("navigation",{ name: "Agent sections" });
    const modelsDisclosure = navigation.locator("button[aria-controls]",{
      hasText: /^Models$/,
    });
    await expect(modelsDisclosure).toHaveAttribute("aria-expanded","false");
    await modelsDisclosure.click();
    await expect(modelsDisclosure).toHaveAttribute("aria-expanded","true");

    await navigation.getByRole("button",{ name: "Model Providers" }).click();
    await expect(page).toHaveURL(/tab=model-providers/);
    await expect(page.getByText("Model Providers",{ exact: true }).last()).toBeVisible();
    const breadcrumb = page.getByRole("navigation",{ name: "Breadcrumb" });
    await expect(breadcrumb.getByRole("link",{ name: "Agents" })).toHaveAttribute(
      "href",
      "/dynamic-agents?tab=agents",
    );
    await expect(breadcrumb.getByRole("link",{ name: "Models" })).toHaveAttribute(
      "href",
      "/dynamic-agents?tab=model-providers",
    );
    await expect(breadcrumb.getByRole("link",{ name: "Model Providers" })).toHaveAttribute(
      "aria-current",
      "page",
    );

    const childrenId = await modelsDisclosure.getAttribute("aria-controls");
    const modelChildren = page.locator(`#${childrenId}`);
    await modelChildren.getByRole("button",{ exact: true,name: "LLM Models" }).click();
    await expect(page).toHaveURL(/tab=llm-models/);
    await expect(
      modelChildren.getByRole("button",{ exact: true,name: "LLM Models" }),
    ).toHaveAttribute("aria-current","page");
  });

  test("search, agent filter, refresh, and page size use the Conversations API parameters", async ({
    page,
  }) => {
    const conversationRequests: URL[] = [];

    await installMockedRbacApp(page, {
      isAdmin: true,
      session: adminSession,
      gates: { audit_logs: false, dynamic_agent_conversations: true },
      handlers: [
        installConversationRoutes({
          onConversationRequest: (url) => conversationRequests.push(new URL(url.toString())),
        }),
      ],
    });

    await page.goto("/dynamic-agents?tab=conversations", { waitUntil: "domcontentloaded" });
    await expect(page.getByText("3 conversations found")).toBeVisible();

    await page.getByPlaceholder("Search by ID, title, or owner...").fill("cost");
    await page.getByRole("button", { exact: true, name: "Search" }).click();
    await expect(page.getByText("1 conversation found")).toBeVisible();
    await expect(page.getByText("Web cost review")).toBeVisible();
    await expect(page.getByText("Slack incident bridge")).toHaveCount(0);

    const agentPicker = page.getByRole("combobox", { name: "Filter conversations by agent" });
    await agentPicker.click();
    await page.getByRole("option", { name: /FinOps Analyst/ }).click();
    await expect(page.getByText("1 conversation found")).toBeVisible();

    const rowsSelect = page.getByLabel("Rows per page");
    await rowsSelect.selectOption("20");
    await expect(page.getByText("Showing 1–1 of 1")).toBeVisible();

    await page.getByRole("button", { name: "Refresh" }).click();
    await expect.poll(() => conversationRequests.length).toBeGreaterThanOrEqual(5);

    const lastRequest = conversationRequests.at(-1);
    expect(lastRequest?.searchParams.get("search")).toBe("cost");
    expect(lastRequest?.searchParams.get("agent_id")).toBe("agent-finops");
    expect(lastRequest?.searchParams.get("page")).toBe("1");
    expect(lastRequest?.searchParams.get("page_size")).toBe("20");
  });

  test("non-authorized audit response still renders the explicit permission error and retry path", async ({
    page,
  }) => {
    let requests = 0;

    await installMockedRbacApp(page, {
      isAdmin: true,
      session: adminSession,
      gates: { audit_logs: false, dynamic_agent_conversations: true },
      handlers: [
        installConversationRoutes({
          denyConversations: true,
          onConversationRequest: () => {
            requests += 1;
          },
        }),
      ],
    });

    await page.goto("/dynamic-agents?tab=conversations", { waitUntil: "domcontentloaded" });

    await expect(page.getByText("You do not have permission to access this resource.")).toBeVisible();
    await expect(page.getByRole("button", { name: "Retry" })).toBeVisible();
    await expect(page.getByText("Slack incident bridge")).toHaveCount(0);

    await page.unroute("**/api/**");
    await installMockedRbacApp(page, {
      isAdmin: true,
      session: adminSession,
      gates: { audit_logs: false, dynamic_agent_conversations: true },
      handlers: [
        async ({ route, path, method }) => {
          if (path === "/api/dynamic-agents" && method === "GET") {
            await fulfillJson(route, paginated(agents, agents.length, 1, 100));
            return true;
          }
          if (path === "/api/dynamic-agents/conversations" && method === "GET") {
            requests += 1;
            await fulfillJson(route, paginated([conversations[0]]));
            return true;
          }
          return false;
        },
      ],
    });
    await page.getByRole("button", { name: "Retry" }).click();

    await expect(page.getByText("You do not have permission to access this resource.")).toHaveCount(0);
    await expect(page.getByText("Slack incident bridge")).toBeVisible();
    await expect.poll(() => requests).toBeGreaterThanOrEqual(2);
  });

  test("hides the Conversations tab when the Dynamic Agent conversation gate is disabled", async ({ page }) => {
    await installMockedRbacApp(page, {
      isAdmin: true,
      session: adminSession,
      gates: { audit_logs: true, dynamic_agent_conversations: false },
      handlers: [installConversationRoutes()],
    });

    await page.goto("/dynamic-agents?tab=conversations", { waitUntil: "domcontentloaded" });

    const navigation = page.getByRole("navigation", { name: "Agent sections" });
    await expect(navigation.getByRole("button", { name: /Conversations/ })).toHaveCount(0);
    await expect(navigation.getByRole("button", { name: /Agents/ })).toHaveAttribute(
      "aria-current",
      "page",
    );
    await expect(
      page.getByText("Review agent conversations and manage their checkpoint history."),
    ).toHaveCount(0);
  });
});
