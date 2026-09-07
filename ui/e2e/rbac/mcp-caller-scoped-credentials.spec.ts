// assisted-by Codex Codex-sonnet-4-6

import { expect, test } from "@playwright/test";

import {
  CREDENTIALS_ADMIN_SESSION,
  gotoPersonalCredentialsConnections,
  installCredentialsBrowserMocks,
} from "./_credentials-browser-fixtures";
import {
  dismissReleaseUpgradeDialog,
  expectChatComposerReady,
  installChatBootMocks,
  installTestSession,
} from "./_helpers";
import { mockedRbacEnabled } from "./_mocked-rbac";
import { NEW_ATLASSIAN_CONNECTION } from "./_provider-connection-fixtures";

const CHAT_AGENT_ID = "jira-gu-agent";
const CHAT_CONVERSATION_ID = "rbac-caller-cred-conv";

const CALLER_CREDENTIAL_WARNING =
  "Jira needs your Atlassian account connected. " +
  "[Connect Atlassian](/credentials/connections) — then start a new chat.";

function minimalSessionEnv() {
  return {
    baseUrl: process.env.CAIPE_UI_BASE_URL ?? "http://localhost:3000",
    keycloakUrl: process.env.KEYCLOAK_URL ?? "http://localhost:7080",
    keycloakRealm: process.env.KEYCLOAK_REALM ?? "caipe",
    user: { email: CREDENTIALS_ADMIN_SESSION.email, password: "" },
  };
}

function sseBody(frames: string[]): string {
  return frames.join("");
}

async function installCallerCredentialChatMocks(
  page: import("@playwright/test").Page,
  options: { streamStartRequests?: string[] } = {},
): Promise<void> {
  const env = minimalSessionEnv();

  await installChatBootMocks(page, env, {
    conversationId: CHAT_CONVERSATION_ID,
    ownerEmail: CREDENTIALS_ADMIN_SESSION.email,
    agentId: CHAT_AGENT_ID,
  });

  await page.route("**/api/dynamic-agents**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    const method = route.request().method();

    if (path === "/api/dynamic-agents" && method === "GET") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          success: true,
          data: {
            items: [{ _id: CHAT_AGENT_ID, name: "Jira", enabled: true }],
          },
        }),
      });
      return;
    }

    if (path === `/api/dynamic-agents/agents/${CHAT_AGENT_ID}` && method === "GET") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          success: true,
          data: {
            _id: CHAT_AGENT_ID,
            name: "Jira",
            enabled: true,
            allowed_tools: { "mcp-jira-gu": true },
          },
        }),
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
    const method = route.request().method();
    if (method === "POST") {
      const body = JSON.parse(route.request().postData() ?? "{}");
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          success: true,
          data: {
            id: `msg-${Date.now()}`,
            role: body.role ?? "user",
            content: body.content ?? "",
          },
        }),
      });
      return;
    }
    await route.continue();
  });

  await page.route("**/api/changelog", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ releases: [] }),
    });
  });

  await page.route("**/api/v1/chat/stream/start", async (route) => {
    if (route.request().method() !== "POST") {
      await route.continue();
      return;
    }

    const body = JSON.parse(route.request().postData() ?? "{}");
    options.streamStartRequests?.push(body.message ?? "");

    await route.fulfill({
      status: 200,
      contentType: "text/event-stream",
      headers: {
        "Cache-Control": "no-cache",
      },
      body: sseBody([
        'event: RUN_STARTED\ndata: {"runId":"e2e-caller-cred-run"}\n\n',
        `event: CUSTOM\ndata: ${JSON.stringify({
          name: "WARNING",
          value: { message: CALLER_CREDENTIAL_WARNING, namespace: [] },
        })}\n\n`,
        'event: TEXT_MESSAGE_CONTENT\ndata: {"delta":"I cannot access Jira without your Atlassian connection."}\n\n',
        'event: RUN_FINISHED\ndata: {"outcome":"success"}\n\n',
      ]),
    });
  });

  await installTestSession(page, env, {
    email: CREDENTIALS_ADMIN_SESSION.email,
    subject: "playwright-caller-cred-sub",
    role: "admin",
  });
}

test.describe("RBAC e2e — caller-scoped MCP credentials", () => {
  test.beforeEach(() => {
    test.skip(
      !mockedRbacEnabled(),
      "Set RUN_RBAC_REGRESSION=1 to run the mocked caller-scoped MCP credential regression.",
    );
  });

  test.describe("Connected Apps — clear connection", () => {
    test("clears a connected provider from the workspace and issues DELETE", async ({ page }) => {
      test.skip(!process.env.NEXTAUTH_SECRET, "NEXTAUTH_SECRET required for /credentials SSR.");

      await installTestSession(page, minimalSessionEnv(), {
        email: CREDENTIALS_ADMIN_SESSION.email,
        subject: process.env.RBAC_USER_SUB?.trim() || "playwright-admin-sub",
        role: "admin",
      });

      const mocks = await installCredentialsBrowserMocks(page, {
        providerConnections: [NEW_ATLASSIAN_CONNECTION],
      });

      await gotoPersonalCredentialsConnections(page);
      await dismissReleaseUpgradeDialog(page);
      await expect(page.getByRole("heading", { name: "Connected Apps" })).toBeVisible();
      await expect(page.getByText("Atlassian Cloud")).toBeVisible();

      await page.getByRole("button", { name: /clear atlassian connection/i }).click();

      await expect.poll(() => mocks.connectionRevokeRequests).toEqual([
        NEW_ATLASSIAN_CONNECTION.id,
      ]);
      expect(
        mocks.providerConnections.find((connection) => connection.id === NEW_ATLASSIAN_CONNECTION.id),
      ).toBeUndefined();
      await expect(page.getByRole("link", { name: /connect atlassian/i })).toBeVisible();
      await expect(page.getByRole("button", { name: /clear atlassian connection/i })).toHaveCount(0);
    });
  });

  test.describe("Chat — caller credential warning", () => {
    test("renders a clickable Connect link and navigates to Connected Apps", async ({ page }) => {
      test.skip(!process.env.NEXTAUTH_SECRET, "NEXTAUTH_SECRET required for chat SSR.");

      const streamStartRequests: string[] = [];
      await installCallerCredentialChatMocks(page, { streamStartRequests });

      await page.goto(`/chat/${CHAT_CONVERSATION_ID}`, { waitUntil: "domcontentloaded" });
      await dismissReleaseUpgradeDialog(page);
      await expectChatComposerReady(page);

      const composer = page.locator("textarea").first();
      await composer.fill("List my Jira issues");
      await composer.press("Enter");

      await expect.poll(() => streamStartRequests.length).toBe(1);
      expect(streamStartRequests[0]).toBe("List my Jira issues");

      await expect(page.getByText(/needs your Atlassian account connected/i)).toBeVisible({
        timeout: 15_000,
      });

      const connectLink = page.getByRole("link", { name: "Connect Atlassian" });
      await expect(connectLink).toBeVisible();
      await expect(connectLink).toHaveAttribute("href", "/credentials/connections");

      await expect(page.getByText(/cannot access Jira without your Atlassian connection/i)).toBeVisible();

      await installCredentialsBrowserMocks(page);
      await connectLink.click({ force: true });

      await expect(page).toHaveURL(/\/credentials\/connections$/);
      await expect(page.getByRole("heading", { name: "Connected Apps" })).toBeVisible();
    });
  });
});
