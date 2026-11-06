import { expect, test, type Page } from "@playwright/test";

import { installChatBootMocks, installTestSession } from "./_helpers";
import { mockedRbacEnabled } from "./_mocked-rbac";

const primaryId = "example-live-primary";
const secondaryId = "example-live-secondary";

async function bootLiveChats(page: Page, primaryTitle = "Primary investigation"): Promise<void> {
  const env = {
    baseUrl: process.env.CAIPE_UI_BASE_URL ?? "http://localhost:3000",
    keycloakUrl: process.env.KEYCLOAK_URL ?? "http://localhost:7080",
    keycloakRealm: process.env.KEYCLOAK_REALM ?? "example",
    user: { email: "member@example.com", password: "" },
  };
  await installChatBootMocks(page, env, { conversationId: primaryId, agentId: "example-agent", title: primaryTitle });
  await installTestSession(page, env, { email: env.user.email, subject: "example-member", role: "user" });
  const conversations = [primaryId, secondaryId].map((id, index) => ({
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
    const single = header.getByRole("link", { name: "1 live chat: Primary investigation. Open chat" });
    await expect(single).toBeVisible({ timeout: 30_000 });
    await expect(single).toHaveAttribute("aria-current", "page");
    await page.getByTestId("conversation-history-scroll").getByTitle("Secondary investigation").click();
    await expect(page).toHaveURL(new RegExp(`/chat/${secondaryId}$`));
    const trigger = header.getByRole("button", { name: "2 live chats. Choose a chat" });
    await expect(trigger).toBeVisible();
    await trigger.focus();
    await page.keyboard.press("Enter");
    const menu = page.getByRole("region", { name: "Live chats" });
    await expect(menu.getByRole("link", { name: "Open Secondary investigation" })).toHaveAttribute("aria-current", "page");
    const width = page.viewportSize()!.width;
    await testInfo.attach("Live chats menu", { body: await page.screenshot({ animations: "disabled", clip: { x: width - 450, y: 0, width: 450, height: 300 } }), contentType: "image/png" });
    await menu.getByRole("link", { name: "Open Primary investigation" }).click();
    await expect(page).toHaveURL(new RegExp(`/chat/${primaryId}$`));
    await expect(menu).not.toBeVisible();
    await trigger.click();
    await page.keyboard.press("Escape");
    await expect(trigger).toBeFocused();
  });

  test("keeps the compact link usable on mobile and respects reduced motion", async ({ page }) => {
    await bootLiveChats(page);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.goto(`/chat/${primaryId}`);
    const link = page.locator("header").getByRole("link", { name: "1 live chat: Primary investigation. Open chat" });
    await expect(link).toBeVisible({ timeout: 30_000 });
    await expect(link).toHaveAttribute("href", `/chat/${primaryId}`);
    await expect(link.locator(".truncate")).not.toBeVisible();
    const dot = link.locator("[aria-hidden=true]");
    await expect(dot).toHaveCSS("animation-name", "none");
    const bounds = await link.boundingBox();
    expect(bounds).not.toBeNull();
    expect(bounds!.x).toBeGreaterThanOrEqual(0);
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(390);
  });

  test("constrains a long title while keeping its complete accessible name", async ({ page }) => {
    const title = "Example investigation with a long conversation title ".repeat(8).trim();
    await bootLiveChats(page, title);
    await page.goto(`/chat/${primaryId}`);
    const link = page.locator("header").getByRole("link", { name: `1 live chat: ${title}. Open chat` });
    await expect(link).toBeVisible({ timeout: 30_000 });
    const titleElement = link.locator(".truncate");
    await expect(titleElement).toHaveText(title);
    const bounds = await titleElement.boundingBox();
    expect(bounds!.width).toBeLessThanOrEqual(144);
    expect(await titleElement.evaluate(element => element.scrollWidth > element.clientWidth)).toBe(true);
    await expect(link).toHaveAttribute("title", `${title} — Streaming`);
  });
});
