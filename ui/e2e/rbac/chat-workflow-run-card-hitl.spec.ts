// assisted-by claude code claude-sonnet-4-6
// E2E tests for the inline HITL form in WorkflowRunCard (chat window).
// Verifies that when a workflow run is waiting_for_input, the chat card
// expands to show the MetadataInputForm directly, matching the agent HITL UX.

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

const CONV_ID = "chat-workflow-hitl-conv";
const RUN_ID = "wfrun-hitl-e2e";
const AGENT_ID = "agent-sre-automation";
const WORKFLOW_CONFIG_ID = "wf-global-mcp";

function minimalSessionEnv() {
  return {
    baseUrl: process.env.CAIPE_UI_BASE_URL ?? "http://localhost:3000",
    keycloakUrl: process.env.KEYCLOAK_URL ?? "http://localhost:7080",
    keycloakRealm: process.env.KEYCLOAK_REALM ?? "caipe",
    user: { email: "member@caipe.local", password: "" },
  };
}

/** Shared route mocks for the chat conversation that contains a workflow run. */
async function installChatWorkflowMocks(
  page: Parameters<typeof installChatBootMocks>[0],
  env: ReturnType<typeof minimalSessionEnv>,
  runFixture: WorkflowRunFixture,
) {
  const now = new Date().toISOString();
  const workflowConfig = buildDefaultWorkflowCatalog().find((w) => w._id === WORKFLOW_CONFIG_ID);

  await installChatBootMocks(page, env, {
    conversationId: CONV_ID,
    ownerEmail: env.user.email,
    agentId: AGENT_ID,
  });

  // Conversation messages — assistant message with start_workflow_run tool call
  await page.route("**/api/chat/conversations**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    const method = request.method();

    if (path === `/api/chat/conversations/${CONV_ID}/messages` && method === "GET") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          success: true,
          data: {
            items: [
              {
                message_id: "msg-assistant-hitl",
                role: "assistant",
                content: "Starting workflow, will post results here.",
                timestamp: now,
                is_final: true,
                stream_events: [
                  {
                    type: "tool_start",
                    timestamp: now,
                    toolData: {
                      tool_call_id: "wf-hitl-tool-1",
                      tool_name: "start_workflow_run",
                      args: { workflow_config_id: WORKFLOW_CONFIG_ID },
                    },
                  },
                  {
                    type: "tool_end",
                    timestamp: now,
                    toolData: {
                      tool_call_id: "wf-hitl-tool-1",
                      result: JSON.stringify({
                        run_id: RUN_ID,
                        workflow_config_id: WORKFLOW_CONFIG_ID,
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

    if (path === `/api/chat/conversations/${CONV_ID}` && method === "GET") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          success: true,
          data: {
            _id: CONV_ID,
            title: "Workflow HITL chat",
            client_type: "webui",
            owner_id: env.user.email,
            participants: [{ type: "agent", id: AGENT_ID }],
            created_at: now,
            updated_at: now,
            metadata: { client_type: "webui", total_messages: 1 },
            sharing: { is_public: false, shared_with: [], shared_with_teams: [], share_link_enabled: false },
            tags: [],
            is_archived: false,
            is_pinned: false,
            deleted_at: null,
          },
        }),
      });
      return;
    }

    await route.continue();
  });

  await page.route("**/api/dynamic-agents/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/dynamic-agents/available" || path === "/api/dynamic-agents") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          success: true,
          data: [{ _id: AGENT_ID, name: "SRE Agent", enabled: true }],
        }),
      });
      return;
    }
    if (path === `/api/dynamic-agents/agents/${AGENT_ID}`) {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          success: true,
          data: {
            _id: AGENT_ID,
            name: "SRE Agent",
            enabled: true,
            builtin_tools: { workflows: [WORKFLOW_CONFIG_ID] },
          },
        }),
      });
      return;
    }
    await route.continue();
  });

  await page.route("**/api/workflow-runs**", async (route) => {
    const url = new URL(route.request().url());
    if (route.request().method() === "GET" && url.searchParams.get("run_id") === RUN_ID) {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(runFixture),
      });
      return;
    }
    await route.continue();
  });

  await page.route("**/api/workflow-configs**", async (route) => {
    const url = new URL(route.request().url());
    if (url.searchParams.get("id") === WORKFLOW_CONFIG_ID) {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(workflowConfig ?? { _id: WORKFLOW_CONFIG_ID, name: "Global SRE workflow" }),
      });
      return;
    }
    await route.continue();
  });
}

test.describe("mocked RBAC e2e — WorkflowRunCard HITL inline form", () => {
  test.beforeEach(() => {
    test.skip(
      !mockedRbacEnabled(),
      "Set RUN_RBAC_REGRESSION=1 to run the mocked WorkflowRunCard HITL regression.",
    );
    test.skip(!process.env.NEXTAUTH_SECRET, "NEXTAUTH_SECRET required for chat workflow SSR.");
  });

  test("shows inline MetadataInputForm when run is waiting_for_input with input_required interrupt", async ({ page }) => {
    const env = minimalSessionEnv();

    const waitingRun: WorkflowRunFixture = {
      _id: RUN_ID,
      workflow_config_id: WORKFLOW_CONFIG_ID,
      workflow_name: "Global SRE workflow",
      status: "waiting_for_input",
      current_step_index: 0,
      started_at: new Date().toISOString(),
      steps: [
        {
          type: "step",
          index: 0,
          display_text: "Create LLM Key",
          agent_id: AGENT_ID,
          status: "waiting_for_input",
          attempts: 1,
          interrupt: {
            type: "input_required",
            interruptId: "interrupt-1",
            prompt: "Please provide the details for your LLM API key",
            agent: "SRE Agent",
            fields: [
              {
                field_name: "key_type",
                field_label: "Key Type",
                field_type: "select",
                field_values: ["individual", "team"],
                required: true,
              },
              {
                field_name: "model",
                field_label: "Model",
                field_type: "text",
                required: true,
              },
            ],
          },
        },
      ],
      events: {},
    };

    await installChatWorkflowMocks(page, env, waitingRun);

    await installTestSession(page, env, {
      email: env.user.email,
      subject: "playwright-hitl-sub",
      role: "user",
    });

    await page.goto(`/chat/${CONV_ID}`, { waitUntil: "domcontentloaded" });
    await dismissReleaseUpgradeDialog(page);
    await expectChatComposerReady(page);

    // The form title should be visible (not just a tiny badge)
    await expect(page.getByText("Please provide the details for your LLM API key")).toBeVisible();

    // Field labels should be visible
    await expect(page.getByText("Key Type")).toBeVisible();
    await expect(
      page.locator("label").filter({ hasText: /^Model\*?$/ }),
    ).toBeVisible();

    // Submit button should be present
    await expect(page.getByRole("button", { name: /submit/i })).toBeVisible();

    // The small card-style "Workflow Run" row should NOT be showing (form replaced it)
    // The "Input required" label inside STATUS_CONFIG badge should not exist as a standalone card
    await expect(page.getByText("Waiting for input")).not.toBeVisible();
  });

  test("shows inline tool_approval buttons when run is waiting_for_input with tool_approval interrupt", async ({ page }) => {
    const env = minimalSessionEnv();

    const toolApprovalRun: WorkflowRunFixture = {
      _id: RUN_ID,
      workflow_config_id: WORKFLOW_CONFIG_ID,
      workflow_name: "Global SRE workflow",
      status: "waiting_for_input",
      current_step_index: 1,
      started_at: new Date().toISOString(),
      steps: [
        {
          type: "step",
          index: 0,
          display_text: "Analyze cluster",
          agent_id: AGENT_ID,
          status: "completed",
          response: "Analysis done.",
          attempts: 1,
        },
        {
          type: "step",
          index: 1,
          display_text: "Apply patch",
          agent_id: AGENT_ID,
          status: "waiting_for_input",
          attempts: 1,
          interrupt: {
            type: "tool_approval",
            interruptId: "interrupt-2",
            prompt: "Approve applying the patch?",
            toolName: "kubectl_apply",
            toolArgs: { namespace: "production", manifest: "deployment.yaml" },
          },
        },
      ],
      events: {},
    };

    await installChatWorkflowMocks(page, env, toolApprovalRun);

    await installTestSession(page, env, {
      email: env.user.email,
      subject: "playwright-tool-approval-sub",
      role: "user",
    });

    await page.goto(`/chat/${CONV_ID}`, { waitUntil: "domcontentloaded" });
    await dismissReleaseUpgradeDialog(page);
    await expectChatComposerReady(page);

    // Tool approval header and tool name
    await expect(page.getByText("Tool Approval Required")).toBeVisible();
    await expect(page.getByText("kubectl_apply")).toBeVisible();

    // Approve and Reject buttons
    await expect(page.getByRole("button", { name: /approve/i })).toBeVisible();
    await expect(page.getByRole("button", { name: /reject/i })).toBeVisible();
  });

  test("submitting the inline form calls the resume API and updates the card", async ({ page }) => {
    const env = minimalSessionEnv();

    const waitingRun: WorkflowRunFixture = {
      _id: RUN_ID,
      workflow_config_id: WORKFLOW_CONFIG_ID,
      workflow_name: "Global SRE workflow",
      status: "waiting_for_input",
      current_step_index: 0,
      started_at: new Date().toISOString(),
      steps: [
        {
          type: "step",
          index: 0,
          display_text: "Confirm action",
          agent_id: AGENT_ID,
          status: "waiting_for_input",
          attempts: 1,
          interrupt: {
            type: "input_required",
            interruptId: "interrupt-3",
            prompt: "Confirm to proceed",
            fields: [
              {
                field_name: "confirmation",
                field_label: "Confirmation",
                field_type: "text",
                required: true,
              },
            ],
          },
        },
      ],
      events: {},
    };

    const resumedRun: WorkflowRunFixture = {
      ...waitingRun,
      status: "running",
      steps: [
        {
          ...waitingRun.steps[0],
          status: "running",
          interrupt: null,
        },
      ],
    };

    let resumeCallBody: unknown = null;

    await installChatWorkflowMocks(page, env, waitingRun);

    // Override workflow-runs GET to return resumed run after resume POST
    await page.route(`**/api/workflow-runs/${RUN_ID}/resume`, async (route) => {
      resumeCallBody = await route.request().postDataJSON();
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ status: "resumed" }) });
    });

    await page.route("**/api/workflow-runs**", async (route) => {
      const url = new URL(route.request().url());
      if (route.request().method() === "GET" && url.searchParams.get("run_id") === RUN_ID) {
        const fixture = resumeCallBody ? resumedRun : waitingRun;
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify(fixture),
        });
        return;
      }
      await route.fallback();
    });

    await installTestSession(page, env, {
      email: env.user.email,
      subject: "playwright-resume-sub",
      role: "user",
    });

    await page.goto(`/chat/${CONV_ID}`, { waitUntil: "domcontentloaded" });
    await dismissReleaseUpgradeDialog(page);
    await expectChatComposerReady(page);

    // Form is visible
    await expect(page.getByText("Confirm to proceed")).toBeVisible();

    // Fill in the confirmation field
    await page.getByPlaceholder("Enter confirmation...").fill("yes");

    // Submit
    await page.getByRole("button", { name: /submit/i }).click();

    // Resume endpoint was called with correct step_index and form values
    await expect.poll(() => resumeCallBody).toMatchObject({
      step_index: 0,
      resume_data: expect.stringContaining("form_input"),
    });

    // After resume, card transitions to running state (form disappears)
    await expect(page.getByText("Confirm to proceed")).not.toBeVisible({ timeout: 5000 });
    await expect(page.getByText("Running", { exact: true })).toBeVisible({ timeout: 5000 });
  });

  test("shows normal compact card for running workflow (no form)", async ({ page }) => {
    const env = minimalSessionEnv();

    const runningRun: WorkflowRunFixture = {
      _id: RUN_ID,
      workflow_config_id: WORKFLOW_CONFIG_ID,
      workflow_name: "Global SRE workflow",
      status: "running",
      current_step_index: 0,
      started_at: new Date().toISOString(),
      steps: [
        {
          type: "step",
          index: 0,
          display_text: "Step 1",
          agent_id: AGENT_ID,
          status: "running",
          attempts: 1,
        },
      ],
      events: {},
    };

    await installChatWorkflowMocks(page, env, runningRun);

    await installTestSession(page, env, {
      email: env.user.email,
      subject: "playwright-running-sub",
      role: "user",
    });

    await page.goto(`/chat/${CONV_ID}`, { waitUntil: "domcontentloaded" });
    await dismissReleaseUpgradeDialog(page);
    await expectChatComposerReady(page);

    // Compact card shown
    await expect(page.getByText("Global SRE workflow", { exact: true })).toBeVisible();
    await expect(page.getByText("Running", { exact: true })).toBeVisible();

    // No input form visible
    await expect(page.getByRole("button", { name: /submit/i })).not.toBeVisible();
    await expect(page.getByRole("button", { name: /approve/i })).not.toBeVisible();
  });
});
