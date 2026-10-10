import { expect, test, type Page } from "@playwright/test";

import {
  dismissReleaseUpgradeDialog,
  expectChatComposerReady,
  installChatBootMocks,
  installTestSession,
} from "./_helpers";
import { mockedRbacEnabled } from "./_mocked-rbac";

const CHAT_AGENT_ID = "auth-interrupt-agent";
const CHAT_CONVERSATION_ID = "auth-interrupt-conv";
const TEST_EMAIL = "auth-interrupt@example.com";

function minimalSessionEnv() {
  return {
    baseUrl: process.env.CAIPE_UI_BASE_URL ?? "http://localhost:3000",
    keycloakUrl: process.env.KEYCLOAK_URL ?? "http://localhost:7080",
    keycloakRealm: process.env.KEYCLOAK_REALM ?? "example",
    user: { email: TEST_EMAIL, password: "" },
  };
}

async function installDynamicAgentAuthInterruptMocks(
  page: Page,
  options: { streamStartRequests?: string[] } = {},
): Promise<void> {
  const env = minimalSessionEnv();

  await page.addInitScript(() => {
    window.sessionStorage.setItem("release-notes:localtag:revision-1:skip", "true");
    window.sessionStorage.setItem("release-notes:playwright:revision-1:skip", "true");
  });

  await installChatBootMocks(page, env, {
    conversationId: CHAT_CONVERSATION_ID,
    ownerEmail: TEST_EMAIL,
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
            items: [{ _id: CHAT_AGENT_ID, name: "Auth Interrupt Agent", enabled: true }],
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
            name: "Auth Interrupt Agent",
            enabled: true,
            allowed_tools: {},
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
    if (route.request().method() !== "POST") {
      await route.continue();
      return;
    }

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
  });

  await page.route("**/api/changelog", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ releases: [] }),
    });
  });

  await page.route("**/api/admin/platform-config", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        success: true,
        data: {
          default_agent_id: null,
          release_notes: { enabled: false },
        },
      }),
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
      status: 401,
      contentType: "application/json",
      body: JSON.stringify({
        success: false,
        error: "Your session has expired. Please sign in again.",
        code: "BEARER_EXPIRED",
        reason: "session_expired",
        action: "sign_in",
      }),
    });
  });

  await installTestSession(page, env, {
    email: TEST_EMAIL,
    subject: "playwright-auth-interrupt-sub",
    role: "admin",
  });
}

test.describe("mocked Dynamic Agent auth interruption UX", () => {
  test.beforeEach(() => {
    test.skip(
      !mockedRbacEnabled(),
      "Set RUN_RBAC_REGRESSION=1 to run the mocked Dynamic Agent auth interruption regression.",
    );
  });

  test("shows session-expired turn copy instead of generic interrupted copy", async ({ page }) => {
    test.skip(!process.env.NEXTAUTH_SECRET, "NEXTAUTH_SECRET required for chat SSR.");

    const streamStartRequests: string[] = [];
    await installDynamicAgentAuthInterruptMocks(page, { streamStartRequests });

    await page.goto(`/chat/${CHAT_CONVERSATION_ID}`, { waitUntil: "domcontentloaded" });
    await dismissReleaseUpgradeDialog(page);
    await expectChatComposerReady(page);

    const composer = page.locator("textarea").first();
    await composer.fill("Run an authenticated dynamic agent task");
    await composer.press("Enter");

    await expect.poll(() => streamStartRequests).toEqual([
      "Run an authenticated dynamic agent task",
    ]);

    await dismissReleaseUpgradeDialog(page);

    await expect(page.getByText("Session expired - signing you in again...")).toBeVisible();
    await expect(
      page.getByText("This response failed to complete. No content was generated."),
    ).toHaveCount(0);
    await expect(page.getByText("Session expired")).toBeVisible();
  });
});
