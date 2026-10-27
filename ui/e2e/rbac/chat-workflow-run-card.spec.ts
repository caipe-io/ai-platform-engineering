// assisted-by Codex Codex-sonnet-4-6

import { expect, test } from "@playwright/test";

import {
  dismissReleaseUpgradeDialog,
  expectChatComposerReady,
  installChatBootMocks,
  installTestSession,
} from "./_helpers";
import { mockedRbacEnabled } from "./_mocked-rbac";
import {
  buildDefaultWorkflowCatalog,
  type WorkflowRunFixture,
} from "./_workflow-browser-fixtures";

const CHAT_WORKFLOW_CONV_ID = "chat-workflow-run-card-conv";
const CHAT_WORKFLOW_RUN_ID = "wfrun-chat-card-e2e";
const CHAT_AGENT_ID = "agent-sre-automation";

const COMPLETED_WORKFLOW_RUN: WorkflowRunFixture = {
  _id: CHAT_WORKFLOW_RUN_ID,
  workflow_config_id: "wf-global-mcp",
  workflow_name: "Global SRE workflow",
  status: "completed",
  current_step_index: 1,
  started_at: "2026-06-22T08:00:00.000Z",
  completed_at: "2026-06-22T08:05:00.000Z",
  trigger_info: { triggered_by: "webui", user_email: "member@caipe.local" },
  steps: [
    {
      type: "step",
      index: 0,
      display_text: "Get My Github Profile",
      agent_id: CHAT_AGENT_ID,
      status: "completed",
      response: "GitHub user: sraradhy — 12 public repos.",
      attempts: 1,
    },
    {
      type: "step",
      index: 1,
      display_text: "Summarize",
      agent_id: CHAT_AGENT_ID,
      status: "completed",
      response: "Summary: profile and Jira issues reviewed.",
      attempts: 1,
    },
  ],
  events: {},
};

function minimalSessionEnv() {
  return {
    baseUrl: process.env.CAIPE_UI_BASE_URL ?? "http://localhost:3000",
    keycloakUrl: process.env.KEYCLOAK_URL ?? "http://localhost:7080",
    keycloakRealm: process.env.KEYCLOAK_REALM ?? "caipe",
    user: { email: "member@caipe.local", password: "" },
  };
}

test.describe("mocked RBAC e2e — chat workflow run card", () => {
  test.beforeEach(() => {
    test.skip(
      !mockedRbacEnabled(),
      "Set RUN_RBAC_REGRESSION=1 to run the mocked chat workflow run card regression.",
    );
    test.skip(!process.env.NEXTAUTH_SECRET, "NEXTAUTH_SECRET required for chat workflow SSR.");
  });

  test("shows completed workflow step outputs on the run card in chat", async ({ page }) => {
    const env = minimalSessionEnv();
    const now = new Date().toISOString();
    const workflowConfig = buildDefaultWorkflowCatalog().find((w) => w._id === "wf-global-mcp");
    let conversationListRequests = 0;

    await installChatBootMocks(page, env, {
      conversationId: CHAT_WORKFLOW_CONV_ID,
      ownerEmail: env.user.email,
      agentId: CHAT_AGENT_ID,
      onConversationListRequest: () => { conversationListRequests += 1; },
    });

    await page.route("**/api/chat/conversations**", async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      const method = request.method();
      const path = url.pathname;

      if (path === `/api/chat/conversations/${CHAT_WORKFLOW_CONV_ID}/messages` && method === "GET") {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            success: true,
            data: {
              items: [
                {
                  message_id: "msg-assistant-1",
                  role: "assistant",
                  content: "Started your workflow. I'll post the results here.",
                  timestamp: now,
                  is_final: true,
                  stream_events: [
                    {
                      type: "tool_start",
                      timestamp: now,
                      toolData: {
                        tool_call_id: "wf-tool-1",
                        tool_name: "start_workflow_run",
                        args: { workflow_config_id: "wf-global-mcp" },
                      },
                    },
                    {
                      type: "tool_end",
                      timestamp: now,
                      toolData: {
                        tool_call_id: "wf-tool-1",
                        result: JSON.stringify({
                          run_id: CHAT_WORKFLOW_RUN_ID,
                          workflow_config_id: "wf-global-mcp",
                          workflow_name: "Global SRE workflow",
                          status: "running",
                        }),
                      },
                    },
                  ],
                },
              ],
              total: 1,
              page: 1,
              page_size: 100,
              has_more: false,
            },
          }),
        });
        return;
      }

      if (path === `/api/chat/conversations/${CHAT_WORKFLOW_CONV_ID}` && method === "GET") {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            success: true,
            data: {
              _id: CHAT_WORKFLOW_CONV_ID,
              title: "Workflow chat",
              client_type: "webui",
              owner_id: env.user.email,
              participants: [{ type: "agent", id: CHAT_AGENT_ID }],
              created_at: now,
              updated_at: now,
              metadata: { client_type: "webui", total_messages: 1 },
              sharing: {
                is_public: false,
                shared_with: [],
                shared_with_teams: [],
                share_link_enabled: false,
              },
              tags: [],
              is_archived: false,
              is_pinned: false,
              deleted_at: null,
            },
          }),
        });
        return;
      }

      // Keep unhandled requests inside the shared chat boot mocks.
      await route.fallback();
    });

    await page.route("**/api/dynamic-agents/**", async (route) => {
      const path = new URL(route.request().url()).pathname;
      if (path === "/api/dynamic-agents/available" || path === "/api/dynamic-agents") {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            success: true,
            data: [{ _id: CHAT_AGENT_ID, name: "SRE Agent", enabled: true }],
          }),
        });
        return;
      }
      if (path === `/api/dynamic-agents/agents/${CHAT_AGENT_ID}`) {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            success: true,
            data: {
              _id: CHAT_AGENT_ID,
              name: "SRE Agent",
              enabled: true,
              builtin_tools: { workflows: ["wf-global-mcp"] },
            },
          }),
        });
        return;
      }
      await route.fallback();
    });

    await page.route("**/api/workflow-runs**", async (route) => {
      const url = new URL(route.request().url());
      if (route.request().method() === "GET" && url.searchParams.get("run_id") === CHAT_WORKFLOW_RUN_ID) {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify(COMPLETED_WORKFLOW_RUN),
        });
        return;
      }
      await route.fallback();
    });

    await page.route("**/api/workflow-configs**", async (route) => {
      const url = new URL(route.request().url());
      if (url.searchParams.get("id") === "wf-global-mcp") {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify(workflowConfig ?? { _id: "wf-global-mcp", name: "Global SRE workflow" }),
        });
        return;
      }
      await route.fallback();
    });

    await installTestSession(page, env, {
      email: env.user.email,
      subject: "playwright-chat-workflow-sub",
      role: "user",
    });

    await page.goto(`/chat/${CHAT_WORKFLOW_CONV_ID}`, { waitUntil: "domcontentloaded" });
    await dismissReleaseUpgradeDialog(page);
    await expect.poll(() => conversationListRequests).toBeGreaterThan(0);
    await expectChatComposerReady(page);

    await expect(page.getByText("Global SRE workflow", { exact: true })).toBeVisible();
    await expect(page.getByText("Completed", { exact: true })).toBeVisible();
    await expect(page.getByText(/GitHub user: sraradhy/)).toBeVisible();
    await expect(page.getByText(/Summary: profile and Jira issues reviewed/)).toBeVisible();
    await expect(page.getByText("2/2 steps")).toBeVisible();
  });
});
