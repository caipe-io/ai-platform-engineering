// assisted-by Codex Codex-sonnet-4-6

import { expect, test, type Page, type Route } from "@playwright/test";

import {
  dismissReleaseUpgradeDialog,
  expectChatComposerReady,
  installChatBootMocks,
  installTestSession,
} from "./_helpers";
import { mockedRbacEnabled } from "./_mocked-rbac";

const CHAT_AGENT_ID = "agent-sre-schema-e2e";
const CHAT_CONVERSATION_ID = "chat-schema-e2e-conv";
const USER_EMAIL = "schema-e2e@caipe.local";
const OLD_BEDROCK_SCHEMA_ERROR =
  "Model call failed after 6 attempts with ValidationException: " +
  "tools.454.custom.input_schema: input_schema does not support oneOf, allOf, or anyOf at the top level";
const MISSING_TOOL_RESULT_ERROR =
  "An error occurred (ValidationException) when calling the ConverseStream operation: " +
  "Expected toolResult blocks at messages.0.content for the following Ids: tooluse_missing_result";

type StreamStartPayload = {
  message?: string;
  conversation_id?: string;
  agent_id?: string;
  protocol?: string;
  client_context?: { source?: string };
};

type StreamMode = "success" | "bedrock-schema-error" | "tool-result-error";
type StreamScenario = StreamMode | "tool-result-error-then-success";

function minimalSessionEnv() {
  return {
    baseUrl: process.env.CAIPE_UI_BASE_URL ?? "http://localhost:3000",
    keycloakUrl: process.env.KEYCLOAK_URL ?? "http://localhost:7080",
    keycloakRealm: process.env.KEYCLOAK_REALM ?? "caipe",
    user: { email: USER_EMAIL, password: "" },
  };
}

function aguiSse(frames: string[]): string {
  return frames.join("");
}

async function fulfillStream(route: Route, mode: StreamMode): Promise<void> {
  if (mode === "bedrock-schema-error") {
    await route.fulfill({
      status: 500,
      contentType: "text/plain",
      body: OLD_BEDROCK_SCHEMA_ERROR,
    });
    return;
  }

  if (mode === "tool-result-error") {
    await route.fulfill({
      status: 500,
      contentType: "text/plain",
      body: MISSING_TOOL_RESULT_ERROR,
    });
    return;
  }

  await route.fulfill({
    status: 200,
    contentType: "text/event-stream",
    headers: { "Cache-Control": "no-cache" },
    body: aguiSse([
      'event: RUN_STARTED\ndata: {"runId":"quick-chat-e2e-run"}\n\n',
      'event: TEXT_MESSAGE_START\ndata: {"messageId":"assistant-1"}\n\n',
      'event: TEXT_MESSAGE_CONTENT\ndata: {"delta":"Quick chat is healthy "}\n\n',
      'event: TEXT_MESSAGE_CONTENT\ndata: {"delta":"after MCP schemas were sanitized."}\n\n',
      'event: TEXT_MESSAGE_END\ndata: {"messageId":"assistant-1"}\n\n',
      'event: RUN_FINISHED\ndata: {"outcome":"success"}\n\n',
    ]),
  });
}

async function installQuickChatMocks(
  page: Page,
  options: {
    mode: StreamScenario;
    streamStartRequests?: StreamStartPayload[];
  },
): Promise<void> {
  const env = minimalSessionEnv();
  let streamAttempt = 0;

  await installChatBootMocks(page, env, {
    conversationId: CHAT_CONVERSATION_ID,
    ownerEmail: USER_EMAIL,
    agentId: CHAT_AGENT_ID,
    title: "Quick Chat Schema Regression",
  });

  await page.route("**/api/platform/health", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        status: "healthy",
        checked_at: new Date().toISOString(),
        summary: { total: 1, healthy: 1, degraded: 0, down: 0, disabled: 0 },
        capabilities: [
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
        ],
        probe_summary: { total: 0, healthy: 0, warning: 0, down: 0 },
        probes: [],
      }),
    });
  });

  await page.route("**/api/dynamic-agents**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const method = request.method();
    const agent = {
      _id: CHAT_AGENT_ID,
      name: "SRE Agent",
      description: "Mocked SRE agent with many MCP tools",
      enabled: true,
      allowed_tools: {
        argocd: true,
        gitlab: true,
        jira: true,
      },
      ui: {},
    };

    if (path === "/api/dynamic-agents/available" && method === "GET") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ success: true, data: [agent] }),
      });
      return;
    }

    if (path === "/api/dynamic-agents" && method === "GET") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ success: true, data: { items: [agent], total: 1, page: 1, page_size: 20 } }),
      });
      return;
    }

    if (path === `/api/dynamic-agents/agents/${CHAT_AGENT_ID}` && method === "GET") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ success: true, data: agent }),
      });
      return;
    }

    if (
      path === `/api/dynamic-agents/conversations/${CHAT_CONVERSATION_ID}/interrupt-state` &&
      method === "GET"
    ) {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ success: true, data: { interrupted: false } }),
      });
      return;
    }

    await route.continue();
  });

  await page.route(`**/api/chat/conversations/${CHAT_CONVERSATION_ID}/messages`, async (route) => {
    const request = route.request();
    const method = request.method();

    if (method === "GET") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          success: true,
          data: { items: [], total: 0, page: 1, page_size: 100, has_more: false },
        }),
      });
      return;
    }

    if (method === "POST") {
      const body = JSON.parse(request.postData() ?? "{}");
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          success: true,
          data: {
            id: `msg-${Date.now()}`,
            role: body.role ?? "assistant",
            content: body.content ?? "",
          },
        }),
      });
      return;
    }

    await route.continue();
  });

  await page.route("**/api/v1/chat/stream/start", async (route) => {
    if (route.request().method() !== "POST") {
      await route.continue();
      return;
    }
    options.streamStartRequests?.push(JSON.parse(route.request().postData() ?? "{}"));
    streamAttempt += 1;
    const mode =
      options.mode === "tool-result-error-then-success"
        ? streamAttempt === 1
          ? "tool-result-error"
          : "success"
        : options.mode;
    await fulfillStream(route, mode);
  });

  await installTestSession(page, env, {
    email: USER_EMAIL,
    subject: "playwright-chat-schema-sub",
    role: "user",
  });
}

async function submitPrompt(page: Page, prompt: string): Promise<void> {
  await page.goto(`/chat/${CHAT_CONVERSATION_ID}`, { waitUntil: "domcontentloaded" });
  await dismissReleaseUpgradeDialog(page);
  await expectChatComposerReady(page);

  const composer = page.getByRole("textbox", { name: "Message" });
  await composer.fill(prompt);
  await composer.press("Enter");
}

test.describe("mocked RBAC e2e — chat stream regression", () => {
  test.beforeEach(() => {
    test.skip(
      !mockedRbacEnabled(),
      "Set RUN_RBAC_REGRESSION=1 to run the mocked chat stream regression.",
    );
    test.skip(!process.env.NEXTAUTH_SECRET, "NEXTAUTH_SECRET required for chat stream SSR.");
  });

  test("streams a quick chat response through AG-UI after MCP tool schema sanitization", async ({ page }) => {
    const streamStartRequests: StreamStartPayload[] = [];
    await installQuickChatMocks(page, { mode: "success", streamStartRequests });

    await submitPrompt(page, "hi");

    await expect.poll(() => streamStartRequests.length).toBe(1);
    expect(streamStartRequests[0]).toMatchObject({
      message: "hi",
      conversation_id: CHAT_CONVERSATION_ID,
      agent_id: CHAT_AGENT_ID,
      protocol: "agui",
      client_context: { source: "webui" },
    });

    await expect(page.getByText(/Quick chat is healthy after MCP schemas were sanitized/i)).toBeVisible({
      timeout: 15_000,
    });
    await expect(page.getByText(/input_schema does not support/i)).toHaveCount(0);
    await expect(page.getByText(/Response was interrupted/i)).toHaveCount(0);
  });

  test("surfaces the old Bedrock schema failure when the backend still returns it", async ({ page }) => {
    const streamStartRequests: StreamStartPayload[] = [];
    await installQuickChatMocks(page, { mode: "bedrock-schema-error", streamStartRequests });

    await submitPrompt(page, "hi");

    await expect.poll(() => streamStartRequests.length).toBe(1);
    await expect(page.getByText(/ValidationException/i)).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText(/input_schema does not support oneOf, allOf, or anyOf/i)).toBeVisible();
    await expect(page.getByText(/Quick chat is healthy after MCP schemas were sanitized/i)).toHaveCount(0);
  });

  test("can submit a follow-up after a missing toolResult stream failure", async ({ page }) => {
    const streamStartRequests: StreamStartPayload[] = [];
    await installQuickChatMocks(page, {
      mode: "tool-result-error-then-success",
      streamStartRequests,
    });

    await submitPrompt(page, "inspect the conversation history");

    await expect.poll(() => streamStartRequests.length).toBe(1);
    await expect(page.getByText(/Expected toolResult blocks/i)).toBeVisible({ timeout: 15_000 });

    await expectChatComposerReady(page);
    const composer = page.getByRole("textbox", { name: "Message" });
    await composer.fill("try again");
    await composer.press("Enter");

    await expect.poll(() => streamStartRequests.length).toBe(2);
    expect(streamStartRequests.map((request) => request.conversation_id)).toEqual([
      CHAT_CONVERSATION_ID,
      CHAT_CONVERSATION_ID,
    ]);
    await expect(page.getByText(/Quick chat is healthy after MCP schemas were sanitized/i)).toBeVisible({
      timeout: 15_000,
    });
  });
});
