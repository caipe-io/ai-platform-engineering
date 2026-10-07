import { expect, test } from "@playwright/test";

import {
  fulfillJson,
  installMockedRbacApp,
  mockedRbacEnabled,
  postJson,
  type MockRouteHandler,
} from "./_mocked-rbac";
import {
  buildDefaultWorkflowCatalog,
  buildSreAgentWithWorkflowsFixture,
  installWorkflowBrowserMocks,
  WORKFLOW_ORG_ADMIN_SESSION,
} from "./_workflow-browser-fixtures";

test.describe("mocked workflow agent service auth", () => {
  test.beforeEach(() => {
    test.skip(
      !mockedRbacEnabled(),
      "Set RUN_RBAC_REGRESSION=1 to run workflow agent service-auth regression.",
    );
  });

  test("returns 401 for agent-style workflow run POST without Bearer (WorkflowApiClient unconfigured path)", async ({
    page,
  }) => {
    await installWorkflowBrowserMocks(page, {
      session: WORKFLOW_ORG_ADMIN_SESSION,
      isAdmin: true,
      requireBearerForWorkflowRuns: true,
    });

    await page.goto("/workflows", { waitUntil: "domcontentloaded" });

    const unauthenticated = await page.evaluate(async () => {
      const res = await fetch("/api/workflow-runs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          workflow_config_id: "wf-global-mcp",
          trigger_info: { triggered_by: "agent", context: { agent_id: "agent-sre-agent" } },
        }),
      });
      return { status: res.status, body: await res.json() };
    });

    expect(unauthenticated.status).toBe(401);
    expect(unauthenticated.body).toMatchObject({
      code: "NOT_SIGNED_IN",
      reason: "not_signed_in",
      action: "sign_in",
    });
  });

  test("accepts agent-triggered workflow run POST with Bearer and records trigger_info", async ({
    page,
  }) => {
    const mocks = await installWorkflowBrowserMocks(page, {
      session: WORKFLOW_ORG_ADMIN_SESSION,
      isAdmin: true,
      requireBearerForWorkflowRuns: true,
    });

    await page.goto("/workflows", { waitUntil: "domcontentloaded" });

    const authenticated = await page.evaluate(async () => {
      const res = await fetch("/api/workflow-runs", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer service-account-token",
        },
        body: JSON.stringify({
          workflow_config_id: "wf-global-mcp",
          user_context: "neo-coder run SRI Custom workflow",
          trigger_info: {
            triggered_by: "agent",
            context: { agent_id: "agent-sre-agent", agent_name: "SRE Agent" },
          },
        }),
      });
      return { status: res.status, body: await res.json() };
    });

    expect(authenticated.status).toBe(201);
    expect(authenticated.body).toMatchObject({ run_id: "wfrun-playwright-rbac", status: "running" });
    expect(mocks.runAuthHeaders[0]).toMatch(/^Bearer /);
    expect(mocks.runRequests[0]).toMatchObject({
      workflow_config_id: "wf-global-mcp",
      trigger_info: { triggered_by: "agent" },
    });
  });

  test("persists selected workflow IDs on agent save (Webex prerequisite wiring)", async ({
    page,
  }) => {
    const workflows = buildDefaultWorkflowCatalog();
    const sreAgent = buildSreAgentWithWorkflowsFixture(["wf-movie-guessing"]);
    let updateBody: unknown = null;

    const handler: MockRouteHandler = async ({ route, path, method }) => {
      if (path === "/api/dynamic-agents" && method === "GET") {
        await fulfillJson(route, {
          success: true,
          data: {
            items: [sreAgent],
            total: 1,
            page: 1,
            page_size: 100,
            has_more: false,
          },
        });
        return true;
      }

      if (path === "/api/dynamic-agents" && method === "PUT") {
        updateBody = await postJson(route);
        await fulfillJson(route, {
          success: true,
          data: {
            ...sreAgent,
            ...(typeof updateBody === "object" && updateBody !== null ? updateBody : {}),
          },
        });
        return true;
      }

      if (path === "/api/dynamic-agents/models" && method === "GET") {
        await fulfillJson(route, {
          success: true,
          data: [{ model_id: "gpt-4o", name: "GPT-4o", provider: "openai" }],
        });
        return true;
      }

      if (path === "/api/dynamic-agents/teams" && method === "GET") {
        await fulfillJson(route, {
          success: true,
          data: [
            {
              _id: "team-platform",
              slug: "platform",
              name: "Platform",
              user_role: "admin",
              can_own_agents: true,
            },
          ],
        });
        return true;
      }

      if (path === "/api/workflow-configs" && method === "GET") {
        await fulfillJson(route, workflows);
        return true;
      }

      if (path === "/api/review-configs/agent-system-prompt" && method === "GET") {
        await fulfillJson(route, {
          target: "agent-system-prompt",
          enabled: false,
          enforcement: "advisory",
          criteria: [],
        });
        return true;
      }

      return false;
    };

    await installMockedRbacApp(page, { isAdmin: true, handlers: [handler] });

    await page.goto("/dynamic-agents?tab=agents", { waitUntil: "domcontentloaded" });
    await page.getByText("SRE Agent", { exact: true }).click();
    await expect(page.getByText(/Edit Agent - SRE Agent/i)).toBeVisible();

    await page.getByRole("button", { name: /^\d+ Advanced$/ }).click();
    await page.getByRole("button", { name: /^Workflows/i }).click();
    await expect(page.getByText("Platform team workflow")).toBeVisible();
    await page.getByRole("button", { name: /Platform team workflow/i }).click();

    await page.getByRole("button", { name: /Save Changes/i }).click();
    await expect.poll(() => updateBody).not.toBeNull();

    expect(updateBody).toMatchObject({
      builtin_tools: {
        workflows: expect.arrayContaining(["wf-movie-guessing", "wf-team-platform"]),
      },
    });
  });
});
