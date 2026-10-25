import { expect, test, type Page } from "@playwright/test";

import {
  fulfillJson,
  installMockedRbacApp,
  mockedRbacEnabled,
  type MockRouteHandler,
} from "./_mocked-rbac";

const ROW_PERMISSIONS = {
  can_manage: true,
  can_write: true,
  can_discover: true,
};

function agent(id: string, name: string, visibility: "global" | "team", creator: string) {
  return {
    _id: id,
    name,
    description: `${name} description`,
    system_prompt: "Help with examples.",
    visibility,
    owner_team_slug: "example-team",
    owner_team_id: "example-team-id",
    shared_with_teams: [],
    allowed_tools: {},
    subagents: [],
    skills: [],
    model: { id: "example-model", provider: "example-provider" },
    enabled: true,
    owner_id: "owner@example.test",
    creator: {
      label: creator,
      name: creator,
      email: `${creator.toLowerCase().replaceAll(" ", "-")}@example.test`,
    },
    is_system: false,
    config_driven: false,
    permissions: ROW_PERMISSIONS,
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
  };
}

function mcpServer(id: string, name: string, transport: "http" | "stdio") {
  return {
    _id: id,
    name,
    description: `${name} description`,
    transport,
    endpoint: transport === "http" ? `https://${id}.example.test/mcp` : undefined,
    command: transport === "stdio" ? "example-command" : undefined,
    enabled: true,
    config_driven: false,
    permissions: {
      can_manage: true,
      can_invoke: true,
      can_discover: true,
    },
  };
}

async function appearsBefore(page: Page, first: string, second: string): Promise<boolean> {
  const firstElement = page.getByText(first, { exact: true }).first();
  const secondElement = page.getByText(second, { exact: true }).first();
  return firstElement.evaluate((element, other) => (
    Boolean(element.compareDocumentPosition(other as Node) & Node.DOCUMENT_POSITION_FOLLOWING)
  ), await secondElement.elementHandle());
}

test.describe("dynamic-agent lists — global sorting and creator display", () => {
  test.beforeEach(() => {
    test.skip(
      !mockedRbacEnabled(),
      "Set RUN_RBAC_REGRESSION=1 to run the mocked list sorting regression.",
    );
  });

  test("shows creator identity and requests global agent sorting", async ({ page }) => {
    const pinned = agent("agent-pinned", "Zulu Pinned", "global", "Primary Creator");
    const alpha = agent("agent-alpha", "Alpha Agent", "team", "Example Creator");
    const beta = agent("agent-beta", "Beta Agent", "global", "Second Creator");
    const requests: URL[] = [];

    const handler: MockRouteHandler = async ({ route, url, path, method }) => {
      if (path !== "/api/dynamic-agents" || method !== "GET") return false;
      requests.push(url);
      const sortBy = url.searchParams.get("sort_by") ?? "name";
      const sortOrder = url.searchParams.get("sort_order") ?? "asc";
      const sorted = sortBy === "visibility"
        ? [pinned, beta, alpha]
        : sortOrder === "desc" ? [pinned, beta, alpha] : [pinned, alpha, beta];
      await fulfillJson(route, {
        success: true,
        data: {
          items: sorted,
          total: sorted.length,
          page: 1,
          page_size: 20,
          has_more: false,
        },
      });
      return true;
    };

    await installMockedRbacApp(page, { isAdmin: true, handlers: [handler] });
    await page.goto("/dynamic-agents?tab=agents", { waitUntil: "domcontentloaded" });

    await expect(page.getByText("Created by", { exact: true })).toBeVisible();
    await expect(page.getByText("Example Creator", { exact: true })).toBeVisible();
    await expect(page.getByText("example-creator@example.test", { exact: true })).toBeVisible();
    await expect(page.getByRole("columnheader", { name: /Name/ })).toHaveAttribute(
      "aria-sort",
      "ascending",
    );
    await expect.poll(() => appearsBefore(page, "Zulu Pinned", "Alpha Agent")).toBe(true);
    await expect.poll(() => appearsBefore(page, "Alpha Agent", "Beta Agent")).toBe(true);

    await page.getByRole("button", { name: "Sort by Visibility ascending" }).click();
    await expect.poll(() => requests.at(-1)?.searchParams.get("sort_by")).toBe("visibility");
    await expect.poll(() => requests.at(-1)?.searchParams.get("sort_order")).toBe("asc");

    await page.getByRole("button", { name: "Sort by Name ascending" }).click();
    // Name ascending is the canonical default, so the client omits both
    // parameters and lets the API apply its global default sort.
    await expect.poll(() => requests.at(-1)?.searchParams.get("sort_by")).toBeNull();
    await expect.poll(() => requests.at(-1)?.searchParams.get("sort_order")).toBeNull();
  });

  test("requests global MCP server sorting", async ({ page }) => {
    const alpha = mcpServer("mcp-alpha", "Alpha MCP", "stdio");
    const beta = mcpServer("mcp-beta", "Beta MCP", "http");
    const requests: URL[] = [];

    const handler: MockRouteHandler = async ({ route, url, path, method }) => {
      if (path === "/api/mcp-servers/agentgateway/discover" && method === "GET") {
        await fulfillJson(route, { success: true, data: { targets: [] } });
        return true;
      }
      if (path !== "/api/mcp-servers" || method !== "GET") return false;
      requests.push(url);
      const sortBy = url.searchParams.get("sort_by") ?? "name";
      const sorted = sortBy === "transport" ? [beta, alpha] : [alpha, beta];
      await fulfillJson(route, {
        success: true,
        data: {
          items: sorted,
          capabilities: { repair_agentgateway: false },
          total: sorted.length,
          page: 1,
          page_size: 20,
          has_more: false,
        },
      });
      return true;
    };

    await installMockedRbacApp(page, { isAdmin: true, handlers: [handler] });
    await page.goto("/dynamic-agents?tab=mcp-servers", { waitUntil: "domcontentloaded" });

    await expect(page.getByRole("columnheader", { name: /Name/ })).toHaveAttribute(
      "aria-sort",
      "ascending",
    );
    await expect.poll(() => appearsBefore(page, "Alpha MCP", "Beta MCP")).toBe(true);

    await page.getByRole("button", { name: "Sort by Transport ascending" }).click();
    await expect.poll(() => requests.at(-1)?.searchParams.get("sort_by")).toBe("transport");
    await expect.poll(() => requests.at(-1)?.searchParams.get("sort_order")).toBe("asc");
    await expect.poll(() => appearsBefore(page, "Beta MCP", "Alpha MCP")).toBe(true);
  });
});
