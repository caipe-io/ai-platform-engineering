import { expect, test, type Page } from "@playwright/test";

import { installChatBootMocks, installTestSession } from "./_helpers";
import { mockedRbacEnabled } from "./_mocked-rbac";

const primaryId = "example-live-primary";
const secondaryId = "example-live-secondary";

async function bootLiveChats(page: Page, primaryTitle = "Primary investigation", primaryConversationId = primaryId): Promise<void> {
  const env = {
    baseUrl: process.env.CAIPE_UI_BASE_URL ?? "http://localhost:3000",
    keycloakUrl: process.env.KEYCLOAK_URL ?? "http://localhost:7080",
    keycloakRealm: process.env.KEYCLOAK_REALM ?? "example",
    user: { email: "member@example.com", password: "" },
  };
  await installChatBootMocks(page, env, { conversationId: primaryConversationId, agentId: "example-agent", title: primaryTitle });
  await installTestSession(page, env, { email: env.user.email, subject: "example-member", role: "user" });
  const conversations = [primaryConversationId, secondaryId].map((id, index) => ({
    _id: id,
    title: index === 0 ? primaryTitle : "Secondary investigation",
    client_type: "webui",
    owner_id: env.user.email,
    participants: [{ type: "agent", id: "example-agent" }],
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    metadata: { client_type: "webui", total_messages: 0 },
    sharing: { shared_with: [], shared_with_teams: [], share_link_enabled: false },
  }));
  await page.route("**/api/chat/conversations**", async route => {
    const path = new URL(route.request().url()).pathname;
    if (route.request().method() !== "GET") return route.fallback();
    if (path === "/api/chat/conversations") {
      return route.fulfill({ json: { success: true, data: { items: conversations, total: 2, page: 1, page_size: 100, has_more: false } } });
    }
    const conversation = conversations.find(chat => path === `/api/chat/conversations/${chat._id}`);
    if (conversation) return route.fulfill({ json: { success: true, data: conversation } });
    if (/\/(messages|turns)$/.test(path)) {
      return route.fulfill({ json: { success: true, data: { items: [], total: 0, has_more: false } } });
    }
    return route.fallback();
  });
  // Exercise the shared app-status observer without starting a provider run.
  await page.route("**/api/v1/chat/stream/status", route => route.fulfill({ json: { running: true, turnId: "example-turn" } }));
}

test.describe("live-chat header navigation", () => {
  test.beforeEach(() => {
    test.skip(!mockedRbacEnabled() || !process.env.NEXTAUTH_SECRET, "Enable mocked RBAC and configure the local session database.");
  });

  test("keeps the current chat visible and opens the chosen live conversation", async ({ page }, testInfo) => {
    await bootLiveChats(page);
    await page.goto(`/chat/${primaryId}`);
    const header = page.locator("header");
    const single = header.getByRole("button", { name: "Live Agent Chat (1). Choose a chat" });
    await expect(single).toBeVisible({ timeout: 30_000 });
    await expect(single).toHaveText(/^Live Agent Chat \(1\)$/);
    await single.click();
    await expect(page.getByRole("region", { name: "Live Agent Chat" }).getByRole("link", { name: "Open Primary investigation" })).toHaveAttribute("aria-current", "page");
    await page.keyboard.press("Escape");
    await page.getByTestId("conversation-history-scroll").getByTitle("Secondary investigation").click();
    await expect(page).toHaveURL(new RegExp(`/chat/${secondaryId}$`));
    const trigger = header.getByRole("button", { name: "Live Agent Chat (2). Choose a chat" });
    await expect(trigger).toBeVisible();
    await trigger.focus();
    await page.keyboard.press("Enter");
    const menu = page.getByRole("region", { name: "Live Agent Chat" });
    await expect(menu.getByRole("link", { name: "Open Secondary investigation" })).toHaveAttribute("aria-current", "page");
    const width = page.viewportSize()!.width;
    await testInfo.attach("Live chats menu", { body: await page.screenshot({ animations: "disabled", clip: { x: width - 450, y: 0, width: 450, height: 300 } }), contentType: "image/png" });
    const firstDestination = menu.getByRole("link", { name: "Open Primary investigation" });
    await expect(firstDestination).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(menu.getByRole("link", { name: "Open Secondary investigation" })).toBeFocused();
    await page.keyboard.press("Shift+Tab");
    await expect(firstDestination).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(new RegExp(`/chat/${primaryId}$`));
    await expect(menu).not.toBeVisible();
    await trigger.click();
    await page.keyboard.press("Escape");
    await expect(trigger).toBeFocused();
  });

  test("opens a legacy conversation using its original decoded ID", async ({ page }) => {
    const legacyId = "example:legacy-chat";
    await bootLiveChats(page, "Legacy investigation", legacyId);
    const observedIds: string[] = [];
    page.on("request", request => {
      if (new URL(request.url()).pathname === "/api/v1/chat/stream/status") {
        observedIds.push(request.postDataJSON().conversation_id);
      }
    });
    await page.goto(`/chat/${encodeURIComponent(legacyId)}`);
    const single = page.locator("header").getByRole("button", { name: "Live Agent Chat (1). Choose a chat" });
    await expect(single).toBeVisible({ timeout: 30_000 });
    await single.click();
    const link = page.getByRole("region", { name: "Live Agent Chat" }).getByRole("link", { name: "Open Legacy investigation" });
    await expect(link).toHaveAttribute("aria-current", "page");
    await page.keyboard.press("Escape");
    await page.getByTestId("conversation-history-scroll").getByTitle("Secondary investigation").click();
    const trigger = page.locator("header").getByRole("button", { name: "Live Agent Chat (2). Choose a chat" });
    await trigger.click();
    await page.getByRole("region", { name: "Live Agent Chat" }).getByRole("link", { name: "Open Legacy investigation" }).click();
    await expect(page).toHaveURL(new RegExp(`/chat/${encodeURIComponent(legacyId)}$`));
    await trigger.click();
    await expect(page.getByRole("region", { name: "Live Agent Chat" }).getByRole("link", { name: "Open Legacy investigation" })).toHaveAttribute("aria-current", "page");
    expect(observedIds).toContain(legacyId);
    expect(observedIds).not.toContain(encodeURIComponent(legacyId));
  });

  for (const interaction of ["keyboard", "pointer"] as const) {
    test(`preserves ${interaction} focus when a live chat finishes`, async ({ page }) => {
      await bootLiveChats(page);
      let primaryFinished = false;
      await page.route("**/api/v1/chat/stream/status", route => route.fulfill({ json: {
        running: !(primaryFinished && route.request().postDataJSON().conversation_id === primaryId),
        turnId: "example-turn",
      } }));
      await page.goto(`/chat/${primaryId}`);
      const header = page.locator("header");
      await expect(header.getByRole("button", { name: "Live Agent Chat (1). Choose a chat" })).toBeVisible({ timeout: 30_000 });
      await page.getByTestId("conversation-history-scroll").getByTitle("Secondary investigation").click();
      const trigger = header.getByRole("button", { name: "Live Agent Chat (2). Choose a chat" });
      await expect(trigger).toBeVisible();
      await trigger.focus();
      await page.keyboard.press("Enter");
      const menu = page.getByRole("region", { name: "Live Agent Chat" });
      await expect(menu.getByRole("link", { name: "Open Primary investigation" })).toBeFocused();
      if (interaction === "pointer") {
        await menu.getByRole("heading", { name: "Live Agent Chat" }).click();
        await expect(page.locator("body")).toBeFocused();
      }

      primaryFinished = true;
      await expect(header.getByRole("button", { name: "Live Agent Chat (1). Choose a chat" })).toHaveAttribute("aria-expanded", "true", { timeout: 20_000 });
      await expect(menu.getByRole("link", { name: "Open Primary investigation" })).toHaveCount(0);
      await expect(interaction === "keyboard"
        ? menu.getByRole("link", { name: "Open Secondary investigation" })
        : page.locator("body")).toBeFocused();
    });
  }

  test("keeps the compact picker usable on mobile and respects reduced motion", async ({ page }) => {
    await bootLiveChats(page);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.goto(`/chat/${primaryId}`);
    const trigger = page.locator("header").getByRole("button", { name: "Live Agent Chat (1). Choose a chat" });
    await expect(trigger).toBeVisible({ timeout: 30_000 });
    await expect(trigger).toHaveText(/^Live Agent Chat \(1\)$/);
    const dot = trigger.locator("[aria-hidden=true]");
    await expect(dot).toHaveCSS("animation-name", "none");
    const bounds = await trigger.boundingBox();
    expect(bounds).not.toBeNull();
    expect(bounds!.x).toBeGreaterThanOrEqual(0);
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(390);
    await trigger.click();
    await expect(page.getByRole("region", { name: "Live Agent Chat" }).getByRole("link", { name: "Open Primary investigation" })).toHaveAttribute("href", `/chat/${primaryId}`);
  });

  test("keeps long titles out of the header and wraps the full title in the picker", async ({ page }) => {
    const title = "Example investigation with a long conversation title ".repeat(8).trim();
    await bootLiveChats(page, title);
    await page.goto(`/chat/${primaryId}`);
    const trigger = page.locator("header").getByRole("button", { name: "Live Agent Chat (1). Choose a chat" });
    await expect(trigger).toBeVisible({ timeout: 30_000 });
    await expect(trigger).toHaveText(/^Live Agent Chat \(1\)$/);
    await trigger.click();
    const link = page.getByRole("region", { name: "Live Agent Chat" }).getByRole("link", { name: `Open ${title}` });
    const titleElement = link.locator("span").first();
    await expect(titleElement).toHaveText(title);
    const bounds = await titleElement.boundingBox();
    expect(bounds!.width).toBeLessThanOrEqual(288);
    expect(bounds!.height).toBeGreaterThan(40);
    expect(await titleElement.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
    await expect(titleElement).toHaveCSS("white-space", "normal");
    await expect(link).toHaveAttribute("title", title);
  });
});
