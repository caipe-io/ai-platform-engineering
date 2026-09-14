// assisted-by claude code claude-sonnet-4-6

import { expect, test } from "@playwright/test";

import {
  dismissReleaseUpgradeDialog,
  installChatBootMocks,
  installTestSession,
} from "./_helpers";
import { mockedRbacEnabled } from "./_mocked-rbac";

// ─── Constants ────────────────────────────────────────────────────────────────

const CHAT_MEMBER_SESSION = {
  email: "member@caipe.local",
  subject: "playwright-deprecated-agent-sub",
};

const DELETED_AGENT_ID = "deleted-agent-id";
const DEFAULT_AGENT_ID = "sre-agent-default-id";
const CONV_HEALTHY_AGENT_ID = "00000000-dead-beef-cafe-000000000099";

const CONV_UNLINKED_ID = "conv-unlinked-no-participants";
const CONV_DELETED_AGENT_ID = "conv-deleted-agent-participant";
const CONV_DEPRECATED_AGENT_ID = "conv-deprecated-agent-participant";
const CONV_TITLE = "RBAC E2E Conversation";

const NOW = new Date().toISOString();

// Sample historical messages to simulate old supervisor-agent conversations.
const HISTORICAL_MESSAGES = [
  {
    message_id: "msg-user-1",
    role: "user",
    content: "How do I rotate my LLM keys?",
    timestamp: NOW,
    is_final: true,
    stream_events: [],
  },
  {
    message_id: "msg-assistant-1",
    role: "assistant",
    content: "You can rotate your LLM keys via the Credentials page.",
    timestamp: NOW,
    is_final: true,
    stream_events: [],
  },
];

// ─── Helpers ──────────────────────────────────────────────────────────────────

function minimalSessionEnv() {
  return {
    baseUrl: process.env.CAIPE_UI_BASE_URL ?? "http://localhost:3000",
    keycloakUrl: process.env.KEYCLOAK_URL ?? "http://localhost:7080",
    keycloakRealm: process.env.KEYCLOAK_REALM ?? "caipe",
    user: { email: CHAT_MEMBER_SESSION.email, password: "" },
  };
}

// Fulfill a messages GET with the given items list.
// Must be called AFTER installChatBootMocks — Playwright matches routes in
// LIFO order (last registered = first matched). installChatBootMocks registers
// a broad glob for /api/chat/conversations that returns [] for messages;
// registering our specific route afterward means ours fires first.
async function mockMessages(
  page: import("@playwright/test").Page,
  conversationId: string,
  items: unknown[],
) {
  // Append ** to match query strings like ?page_size=100 appended by apiClient.getMessages.
  await page.route(
    `**/api/chat/conversations/${conversationId}/messages**`,
    async (route) => {
      if (route.request().method() !== "GET") {
        await route.continue();
        return;
      }
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          success: true,
          data: { items, total: items.length, page: 1, page_size: 100, has_more: false },
        }),
      });
    },
  );
}

/**
 * Boot mocks for a conversation whose participants array is EMPTY
 * (legacy supervisor-agent conversations that pre-date the dynamic-agent
 * participants model). The agent route is never mounted because there is no
 * agent participant to look up.
 */
async function bootUnlinkedConversation(
  page: import("@playwright/test").Page,
  conversationId = CONV_UNLINKED_ID,
  messages = HISTORICAL_MESSAGES,
) {
  test.skip(!process.env.NEXTAUTH_SECRET, "NEXTAUTH_SECRET required.");
  const env = minimalSessionEnv();

  // installChatBootMocks without agentId → participants: [] on the fixture.
  await installChatBootMocks(page, env, { conversationId });

  // Register messages AFTER the broad installChatBootMocks glob — Playwright
  // routes are LIFO so this more-specific route wins over the empty-[] fallback.
  await mockMessages(page, conversationId, messages);

  await installTestSession(page, env, {
    email: CHAT_MEMBER_SESSION.email,
    subject: CHAT_MEMBER_SESSION.subject,
    role: "user",
  });

  return env;
}

/**
 * Boot mocks for a conversation that DOES have an agent participant, but that
 * agent returns 404 from the agent-info endpoint (deleted/deprecated).
 */
async function bootDeletedAgentConversation(
  page: import("@playwright/test").Page,
  conversationId = CONV_DELETED_AGENT_ID,
  agentId = DELETED_AGENT_ID,
  messages = HISTORICAL_MESSAGES,
) {
  test.skip(!process.env.NEXTAUTH_SECRET, "NEXTAUTH_SECRET required.");
  const env = minimalSessionEnv();

  // installChatBootMocks WITH agentId → participants has the agent entry.
  // Its **/api/dynamic-agents** handler returns 200 for the agent — we override
  // the specific per-agent path below to return 404 instead.
  await installChatBootMocks(page, env, { conversationId, agentId });

  // Register messages and 404-agent route AFTER installChatBootMocks — LIFO wins.
  await mockMessages(page, conversationId, messages);

  // Override the per-agent lookup to 404 — simulates a deleted/deprecated agent.
  await page.route(`**/api/dynamic-agents/agents/${agentId}`, async (route) => {
    await route.fulfill({
      status: 404,
      contentType: "application/json",
      body: JSON.stringify({ success: false, error: "Agent not found" }),
    });
  });

  await installTestSession(page, env, {
    email: CHAT_MEMBER_SESSION.email,
    subject: CHAT_MEMBER_SESSION.subject,
    role: "user",
  });

  return env;
}

// ─── Tests ────────────────────────────────────────────────────────────────────

test.describe("mocked RBAC e2e — deprecated / unlinked agent conversations", () => {
  test.beforeEach(() => {
    test.skip(
      !mockedRbacEnabled(),
      "Set RUN_RBAC_REGRESSION=1 to run the mocked deprecated-agent regressions.",
    );
  });

  // ── Scenario A: participants: [] (no agent participant at all) ──────────────
  // These conversations go through the same agent_deleted banner path as scenario B.

  test("shows 'Agent No Longer Available' banner for unlinked (participants:[]) conversations", async ({
    page,
  }) => {
    await bootUnlinkedConversation(page, CONV_UNLINKED_ID);
    await page.goto(`/chat/${CONV_UNLINKED_ID}`, { waitUntil: "domcontentloaded" });
    await dismissReleaseUpgradeDialog(page);

    await expect(page.getByText("Agent No Longer Available")).toBeVisible({ timeout: 10_000 });
    await expect(
      page.getByText(/deprecated or deleted/i),
    ).toBeVisible();
  });

  test("renders historical messages in read-only mode for unlinked conversations", async ({
    page,
  }) => {
    await bootUnlinkedConversation(page, CONV_UNLINKED_ID);
    await page.goto(`/chat/${CONV_UNLINKED_ID}`, { waitUntil: "domcontentloaded" });
    await dismissReleaseUpgradeDialog(page);

    await expect(page.getByText("How do I rotate my LLM keys?")).toBeVisible({ timeout: 8_000 });
    await expect(
      page.getByText("You can rotate your LLM keys via the Credentials page."),
    ).toBeVisible();
  });

  test("CTA button is visible in unlinked conversation banner", async ({ page }) => {
    await bootUnlinkedConversation(page, CONV_UNLINKED_ID);
    await page.goto(`/chat/${CONV_UNLINKED_ID}`, { waitUntil: "domcontentloaded" });
    await dismissReleaseUpgradeDialog(page);

    await expect(page.getByText("Agent No Longer Available")).toBeVisible({ timeout: 10_000 });
    const ctaButton = page.getByRole("button", { name: /Resume with default agent/i });
    await expect(ctaButton).toBeVisible();
  });

  test("does not render a chat composer input for unlinked conversations", async ({ page }) => {
    await bootUnlinkedConversation(page, CONV_UNLINKED_ID);
    await page.goto(`/chat/${CONV_UNLINKED_ID}`, { waitUntil: "domcontentloaded" });
    await dismissReleaseUpgradeDialog(page);

    await expect(page.getByText("Agent No Longer Available")).toBeVisible({ timeout: 10_000 });
    await expect(page.locator("textarea").first()).not.toBeVisible({ timeout: 3_000 });
  });

  test("conversation still appears in the sidebar history", async ({ page }) => {
    await bootUnlinkedConversation(page, CONV_UNLINKED_ID);
    await page.goto(`/chat/${CONV_UNLINKED_ID}`, { waitUntil: "domcontentloaded" });
    await dismissReleaseUpgradeDialog(page);

    // Sidebar renders titles via title= attribute on the <p> element.
    await expect(page.getByTitle(CONV_TITLE)).toBeVisible();
  });

  test("shows banner even when the unlinked conversation has no messages", async ({
    page,
  }) => {
    await bootUnlinkedConversation(page, CONV_UNLINKED_ID, [] /* empty messages */);
    await page.goto(`/chat/${CONV_UNLINKED_ID}`, { waitUntil: "domcontentloaded" });
    await dismissReleaseUpgradeDialog(page);

    await expect(page.getByText("Agent No Longer Available")).toBeVisible({ timeout: 10_000 });
  });

  // ── Scenario B: agent participant exists but agent returns 404 ─────────────

  test("shows 'Agent No Longer Available' banner when agent participant returns 404", async ({
    page,
  }) => {
    await bootDeletedAgentConversation(page);
    await page.goto(`/chat/${CONV_DELETED_AGENT_ID}`, { waitUntil: "domcontentloaded" });
    await dismissReleaseUpgradeDialog(page);

    await expect(page.getByText("Agent No Longer Available")).toBeVisible({ timeout: 10_000 });
    await expect(
      page.getByText(/deprecated or deleted/i),
    ).toBeVisible();
  });

  test("renders historical messages in read-only mode when agent is 404", async ({ page }) => {
    await bootDeletedAgentConversation(page);
    await page.goto(`/chat/${CONV_DELETED_AGENT_ID}`, { waitUntil: "domcontentloaded" });
    await dismissReleaseUpgradeDialog(page);

    // Both sides of the historical conversation should be visible.
    await expect(page.getByText("How do I rotate my LLM keys?")).toBeVisible({ timeout: 8_000 });
    await expect(
      page.getByText("You can rotate your LLM keys via the Credentials page."),
    ).toBeVisible();
  });

  test("chat input composer is absent when agent returns 404", async ({ page }) => {
    await bootDeletedAgentConversation(page);
    await page.goto(`/chat/${CONV_DELETED_AGENT_ID}`, { waitUntil: "domcontentloaded" });
    await dismissReleaseUpgradeDialog(page);

    await expect(page.getByText("Agent No Longer Available")).toBeVisible({ timeout: 10_000 });
    await expect(page.locator("textarea").first()).not.toBeVisible({ timeout: 3_000 });
  });

  test("'Resume with default agent' CTA link is shown in the banner for deleted agent", async ({
    page,
  }) => {
    await bootDeletedAgentConversation(page);
    await page.goto(`/chat/${CONV_DELETED_AGENT_ID}`, { waitUntil: "domcontentloaded" });
    await dismissReleaseUpgradeDialog(page);

    await expect(page.getByText("Agent No Longer Available")).toBeVisible({ timeout: 10_000 });

    const ctaButton = page.getByRole("button", { name: /Resume with default agent/i });
    await expect(ctaButton).toBeVisible();
  });

  test("deleted-agent conversation stays in the sidebar and is navigable", async ({ page }) => {
    await bootDeletedAgentConversation(page);
    await page.goto(`/chat/${CONV_DELETED_AGENT_ID}`, { waitUntil: "domcontentloaded" });
    await dismissReleaseUpgradeDialog(page);

    await expect(page.getByTitle(CONV_TITLE)).toBeVisible();
  });

  test("deleted-agent banner is not shown for a healthy active agent", async ({ page }) => {
    test.skip(!process.env.NEXTAUTH_SECRET, "NEXTAUTH_SECRET required.");
    const env = minimalSessionEnv();
    await installChatBootMocks(page, env, {
      conversationId: CONV_HEALTHY_AGENT_ID,
      agentId: DEFAULT_AGENT_ID,
    });
    await installTestSession(page, env, {
      email: CHAT_MEMBER_SESSION.email,
      subject: CHAT_MEMBER_SESSION.subject,
      role: "user",
    });

    await page.goto(`/chat/${CONV_HEALTHY_AGENT_ID}`, { waitUntil: "domcontentloaded" });
    await dismissReleaseUpgradeDialog(page);

    await expect(page.getByText("Agent No Longer Available")).not.toBeVisible({ timeout: 4_000 });
    await expect(page.getByText("Agent no longer available")).not.toBeVisible({ timeout: 1_000 });
  });

  // ── Scenario C: clicking "Resume with default agent" re-links the conversation ──

  // Helper: override platform-config + available after bootDeletedAgentConversation so that
  // resolveUsableChatAgentId() resolves to DEFAULT_AGENT_ID (not the 404 deleted agent).
  // Must be called AFTER boot* because Playwright routes are LIFO.
  async function mockDefaultAgentResolution(
    page: import("@playwright/test").Page,
    defaultAgentId = DEFAULT_AGENT_ID,
  ) {
    const agentFixture = {
      _id: defaultAgentId,
      name: "Default Agent SRE",
      enabled: true,
      skills: [],
      ui: {},
    };
    await page.route("**/api/admin/platform-config", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          success: true,
          data: { default_agent_id: defaultAgentId, release_notes: { enabled: false } },
        }),
      });
    });
    await page.route("**/api/dynamic-agents/available", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ success: true, data: [agentFixture] }),
      });
    });
    // Per-agent lookup for DEFAULT_AGENT_ID must return 200 so ChatContainer doesn't set agentNotFound.
    await page.route(`**/api/dynamic-agents/agents/${defaultAgentId}`, async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ success: true, data: agentFixture }),
      });
    });
  }

  test("clicking 'Resume with default agent' dismisses the banner and shows the composer (deleted-agent)", async ({
    page,
  }) => {
    await bootDeletedAgentConversation(page);
    // LIFO: these override the boot mocks so resolution uses DEFAULT_AGENT_ID, not the 404 agent.
    await mockDefaultAgentResolution(page);
    await page.route(`**/api/chat/conversations/${CONV_DELETED_AGENT_ID}`, async (route) => {
      if (route.request().method() === "PUT") {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ success: true, data: {} }),
        });
        return;
      }
      await route.continue();
    });

    await page.goto(`/chat/${CONV_DELETED_AGENT_ID}`, { waitUntil: "domcontentloaded" });
    await dismissReleaseUpgradeDialog(page);
    await expect(page.getByText("Agent No Longer Available")).toBeVisible({ timeout: 10_000 });

    await page.getByRole("button", { name: /Resume with default agent/i }).click();

    await expect(page.getByText("Agent No Longer Available")).not.toBeVisible({ timeout: 8_000 });
    await expect(page.locator("textarea").first()).toBeVisible({ timeout: 8_000 });
  });

  test("clicking 'Resume with default agent' dismisses the banner and shows the composer (unlinked)", async ({
    page,
  }) => {
    await bootUnlinkedConversation(page);
    await mockDefaultAgentResolution(page);
    await page.route(`**/api/chat/conversations/${CONV_UNLINKED_ID}`, async (route) => {
      if (route.request().method() === "PUT") {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ success: true, data: {} }),
        });
        return;
      }
      await route.continue();
    });

    await page.goto(`/chat/${CONV_UNLINKED_ID}`, { waitUntil: "domcontentloaded" });
    await dismissReleaseUpgradeDialog(page);
    await expect(page.getByText("Agent No Longer Available")).toBeVisible({ timeout: 10_000 });

    await page.getByRole("button", { name: /Resume with default agent/i }).click();

    await expect(page.getByText("Agent No Longer Available")).not.toBeVisible({ timeout: 8_000 });
    await expect(page.locator("textarea").first()).toBeVisible({ timeout: 8_000 });
  });

  test("PUT /api/chat/conversations/[id] is called with participants when resuming", async ({
    page,
  }) => {
    await bootDeletedAgentConversation(page);
    await mockDefaultAgentResolution(page);

    let capturedBody: unknown = null;
    await page.route(`**/api/chat/conversations/${CONV_DELETED_AGENT_ID}`, async (route) => {
      if (route.request().method() === "PUT") {
        capturedBody = JSON.parse(route.request().postData() ?? "{}");
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ success: true, data: {} }),
        });
        return;
      }
      await route.continue();
    });

    await page.goto(`/chat/${CONV_DELETED_AGENT_ID}`, { waitUntil: "domcontentloaded" });
    await dismissReleaseUpgradeDialog(page);
    await expect(page.getByText("Agent No Longer Available")).toBeVisible({ timeout: 10_000 });

    await page.getByRole("button", { name: /Resume with default agent/i }).click();

    await expect(page.getByText("Agent No Longer Available")).not.toBeVisible({ timeout: 8_000 });
    await expect.poll(() => capturedBody, { timeout: 20_000 }).not.toBeNull();
    expect(capturedBody).toMatchObject({
      participants: expect.arrayContaining([
        expect.objectContaining({ type: "agent", id: DEFAULT_AGENT_ID }),
      ]),
    });
  });

  test("'Choose agent' button opens agent picker in the deprecated-agent banner", async ({
    page,
  }) => {
    await bootDeletedAgentConversation(page);
    await mockDefaultAgentResolution(page);

    await page.goto(`/chat/${CONV_DELETED_AGENT_ID}`, { waitUntil: "domcontentloaded" });
    await dismissReleaseUpgradeDialog(page);
    await expect(page.getByText("Agent No Longer Available")).toBeVisible({ timeout: 10_000 });

    await page.getByRole("button", { name: /Choose agent/i }).click();

    // AgentPicker trigger should appear; Resume button is disabled until an agent is selected.
    await expect(page.getByText(/Select an agent/i)).toBeVisible({ timeout: 4_000 });
    await expect(page.getByRole("button", { name: /^Resume$/i })).toBeDisabled();
  });

  // ── Scenario D: deprecated agent (participant exists, agent 404) with empty history ─

  test("deprecated agent conversation with empty history shows banner only (no message area)", async ({
    page,
  }) => {
    await bootDeletedAgentConversation(
      page,
      CONV_DEPRECATED_AGENT_ID,
      DELETED_AGENT_ID,
      [] /* empty messages */,
    );
    await page.goto(`/chat/${CONV_DEPRECATED_AGENT_ID}`, { waitUntil: "domcontentloaded" });
    await dismissReleaseUpgradeDialog(page);

    await expect(page.getByText("Agent No Longer Available")).toBeVisible({ timeout: 10_000 });
    await expect(page.locator("textarea").first()).not.toBeVisible({ timeout: 3_000 });
  });
});
