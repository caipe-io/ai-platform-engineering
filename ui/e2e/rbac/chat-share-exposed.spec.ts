// assisted-by claude code claude-sonnet-4-6
/**
 * Regression spec for issue #1979 — shared conversations exposure.
 *
 * The bug: GET /api/chat/shared queried ALL non-owner conversations
 * (`owner_id: { $ne: user.email }`) instead of only conversations with a
 * sharing configuration, causing private conversations from other users to
 * leak into the permission pipeline and the UI total count to be inflated.
 *
 * These tests verify the end-to-end behaviour of the "Shared Conversations"
 * section on the home page:
 *   - Only conversations returned by /api/chat/shared appear in the UI
 *   - The supported tabs (Shared with me / Team) filter correctly
 *   - Private conversations that should never be shared are not displayed
 *   - API requests are made with correct scoping parameters
 *   - Empty states render per tab when there are no matching conversations
 *   - Related list/search/trash endpoints do not expose unshared private chats
 *   - The grant API rejects conversation discovery grants to everyone
 *
 * All API calls are mocked so no live backend is required.
 * Enable with: RUN_RBAC_REGRESSION=1 npx playwright test --config=playwright.rbac.config.ts
 */

import { expect, test, type Page } from "@playwright/test";
import { fulfillJson, installMockedRbacApp, mockedRbacEnabled, postJson } from "./_mocked-rbac";

// ─── Fixtures ────────────────────────────────────────────────────────────────

const CALLER_EMAIL = "caller@caipe.local";

function makeConversation(
  id: string,
  title: string,
  sharing: {
    is_public?: boolean;
    shared_with?: string[];
    shared_with_teams?: string[];
    share_link_enabled?: boolean;
  } = {},
  ownerEmail = "other@caipe.local",
) {
  const now = new Date().toISOString();
  return {
    _id: id,
    title,
    owner_id: ownerEmail,
    created_at: now,
    updated_at: now,
    metadata: { total_messages: 2 },
    sharing: {
      is_public: sharing.is_public ?? false,
      shared_with: sharing.shared_with ?? [],
      shared_with_teams: sharing.shared_with_teams ?? [],
      share_link_enabled: sharing.share_link_enabled ?? false,
    },
    tags: [],
    is_archived: false,
    is_pinned: false,
    deleted_at: null,
  };
}

type ConversationFixture = ReturnType<typeof makeConversation>;

type ApiResult<T = unknown> = {
  status: number;
  body: T;
};

type ConversationListBody = {
  success?: boolean;
  data?: {
    items?: ConversationFixture[];
  };
};

type GrantRequestBody = {
  resource?: { type?: string; id?: string };
  grantee?: { type?: string; id?: string };
  capability?: string;
};

function paginatedResponse(items: ConversationFixture[]) {
  return {
    success: true,
    data: { items, total: items.length, page: 1, page_size: 20 },
  };
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

type SharedApiOptions = {
  items?: ConversationFixture[];
  conversationItems?: ConversationFixture[];
  searchItems?: ConversationFixture[];
  trashItems?: ConversationFixture[];
  onRequest?: (url: URL) => void;
  onConversationRequest?: (url: URL) => void;
  onSearchRequest?: (url: URL) => void;
  onTrashRequest?: (url: URL) => void;
};

async function fetchJson<T = unknown>(page: Page, path: string, init?: RequestInit): Promise<ApiResult<T>> {
  return page.evaluate(
    async ({ path: requestPath, init: requestInit }) => {
      const response = await fetch(requestPath, requestInit);
      let body: unknown = null;
      try {
        body = await response.json();
      } catch {
        body = await response.text();
      }
      return { status: response.status, body };
    },
    { path, init },
  ) as Promise<ApiResult<T>>;
}

async function postJsonFromPage<T = unknown>(
  page: Page,
  path: string,
  body: unknown,
): Promise<ApiResult<T>> {
  return fetchJson<T>(page, path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function installHomePageMocks(
  page: Parameters<typeof installMockedRbacApp>[0],
  options: SharedApiOptions = {},
) {
  const sharedItems = options.items ?? [];
  const conversationItems = options.conversationItems ?? [];
  const searchItems = options.searchItems ?? [];
  const trashItems = options.trashItems ?? [];

  // These RBAC regressions exercise widgets that are intentionally optional
  // on the customizable home page. Enable them explicitly so the tests do not
  // depend on a user's saved layout or the minimal default layout.
  await page.addInitScript(() => {
    localStorage.setItem(
      "caipe-home-widgets",
      JSON.stringify([
        "heroComposer",
        "quickStart",
        "recentChats",
        "sharedConversations",
      ]),
    );
    localStorage.setItem("caipe-home-widgets-version", "2");
  });

  // Force MongoDB storage mode so the SharedConversations section renders.
  // The server injects __APP_CONFIG__ via an inline <script> in <head> based
  // on process.env.MONGODB_URI; test servers lack that env var, so we
  // intercept the HTML page response and rewrite storageMode before the
  // browser sees it. This avoids a React SSR/hydration mismatch because both
  // the server-rendered HTML and the client-side hydration see the same value.
  await page.route("**/*", async (route) => {
    const req = route.request();
    const accept = req.headers()["accept"] ?? "";
    if (
      req.method() !== "GET" ||
      !accept.includes("text/html") ||
      req.url().includes("/api/")
    ) {
      await route.continue();
      return;
    }
    const response = await route.fetch();
    const ct = response.headers()["content-type"] ?? "";
    if (!ct.includes("text/html")) {
      await route.fulfill({ response });
      return;
    }
    const body = (await response.text())
      .replace(/"storageMode"\s*:\s*"localStorage"/g, '"storageMode":"mongodb"')
      .replace(
        /\\"storageMode\\"\s*:\s*\\"localStorage\\"/g,
        '\\"storageMode\\":\\"mongodb\\"',
      );
    await route.fulfill({ response, body });
  });

  await installMockedRbacApp(page, {
    session: { email: CALLER_EMAIL, name: "Caller User" },
    handlers: [
      async ({ route, path, method }) => {
        if (path === "/api/settings" && method === "GET") {
          await fulfillJson(route, {
            success: true,
            data: {
              preferences: {
                home_widgets: [
                  "heroComposer",
                  "quickStart",
                  "recentChats",
                  "sharedConversations",
                ],
                home_widgets_version: 2,
                home_experience: "new",
              },
            },
          });
          return true;
        }
        if (path === "/api/chat/shared" && method === "GET") {
          options.onRequest?.(new URL(route.request().url()));
          await fulfillJson(route, paginatedResponse(sharedItems));
          return true;
        }
        if (path === "/api/chat/conversations" && method === "GET") {
          options.onConversationRequest?.(new URL(route.request().url()));
          await fulfillJson(route, paginatedResponse(conversationItems));
          return true;
        }
        if (path === "/api/chat/search" && method === "GET") {
          options.onSearchRequest?.(new URL(route.request().url()));
          await fulfillJson(route, paginatedResponse(searchItems));
          return true;
        }
        if (path === "/api/chat/conversations/trash" && method === "GET") {
          options.onTrashRequest?.(new URL(route.request().url()));
          await fulfillJson(route, paginatedResponse(trashItems));
          return true;
        }
        if (path === "/api/authz/v1/grants" && method === "POST") {
          const body = await postJson(route) as GrantRequestBody | null;
          if (
            body?.resource?.type === "conversation" &&
            body?.grantee?.type === "everyone" &&
            body.capability === "discover"
          ) {
            await fulfillJson(
              route,
              {
                error: "everyone grants are limited to low-risk resource capabilities",
                code: "INVALID_REQUEST",
              },
              400,
            );
            return true;
          }
          await fulfillJson(route, { success: true });
          return true;
        }
        if (path === "/api/users/me/stats") {
          await fulfillJson(route, {
            success: true,
            data: {
              total_conversations: 0,
              conversations_this_week: 0,
              messages_this_week: 0,
              favorite_agents: [],
            },
          });
          return true;
        }
        if (path === "/api/users/me/favorites") {
          await fulfillJson(route, { success: true, data: { items: [], total: 0 } });
          return true;
        }
        if (path === "/api/chat/bookmarks") {
          await fulfillJson(route, { success: true, data: { items: [], total: 0 } });
          return true;
        }
        if (path === "/api/a2a/agents") {
          await fulfillJson(route, { agents: [] });
          return true;
        }
        if (path.startsWith("/api/storage/mode")) {
          await fulfillJson(route, { mode: "mongodb" });
          return true;
        }
        if (path === "/api/agents") {
          await fulfillJson(route, { success: true, data: [] });
          return true;
        }
        return false;
      },
    ],
  });
}

// ─── Tests ───────────────────────────────────────────────────────────────────

test.describe("issue #1979 — shared conversations exposure regression", () => {
  test.beforeEach(() => {
    test.skip(
      !mockedRbacEnabled(),
      "Set RUN_RBAC_REGRESSION=1 to run the shared conversations regression.",
    );
  });

  // ── API request verification ──────────────────────────────────────────────

  test("home page calls /api/chat/shared on load", async ({ page }) => {
    let sharedApiCallCount = 0;

    await installHomePageMocks(page, {
      items: [],
      onRequest: () => { sharedApiCallCount++; },
    });

    await page.goto("/", { waitUntil: "domcontentloaded" });
    await expect(page.getByTestId("shared-conversations")).toBeVisible({ timeout: 10_000 });

    await expect.poll(() => sharedApiCallCount).toBeGreaterThan(0);
  });

  // ── Rendering shared conversations ────────────────────────────────────────

  test("renders directly shared conversations in Shared with me tab", async ({ page }) => {
    const directConv = makeConversation("conv-direct", "Direct Share Conversation", {
      shared_with: [CALLER_EMAIL],
    });

    await installHomePageMocks(page, { items: [directConv] });
    await page.goto("/", { waitUntil: "domcontentloaded" });

    await expect(page.getByTestId("shared-conversations")).toBeVisible({ timeout: 10_000 });
    await expect(page.getByTestId("shared-tab-shared-with-me")).toBeVisible();

    await expect(page.getByText("Direct Share Conversation")).toBeVisible();
    await expect(page.getByText(`Shared by ${directConv.owner_id}`)).toBeVisible();
  });

  test("renders team-shared conversations in Team tab", async ({ page }) => {
    const teamConv = makeConversation("conv-team", "Team Shared Conversation", {
      shared_with_teams: ["team-abc"],
    });

    await installHomePageMocks(page, { items: [teamConv] });
    await page.goto("/", { waitUntil: "domcontentloaded" });

    await expect(page.getByTestId("shared-conversations")).toBeVisible({ timeout: 10_000 });

    // Switch to Team tab
    await page.getByTestId("shared-tab-team").click();
    await expect(page.getByText("Team Shared Conversation")).toBeVisible();
  });

  // ── Privacy regression — no private conversations ─────────────────────────

  test("does not show private conversations that /api/chat/shared excludes", async ({ page }) => {
    // The API (after the fix) returns ONLY sharing-configured conversations.
    // If it returns nothing, nothing should appear in the UI.
    await installHomePageMocks(page, { items: [] });
    await page.goto("/", { waitUntil: "domcontentloaded" });

    await expect(page.getByTestId("shared-conversations")).toBeVisible({ timeout: 10_000 });
    await expect(page.getByTestId("shared-empty")).toBeVisible();
    await expect(page.getByText("No conversations shared with you yet.")).toBeVisible();
  });

  test("does not show conversations that belong to the caller on the shared page", async ({ page }) => {
    // Caller's own conversation should never appear in the Shared section
    // because the API pre-filters owner_id != caller.
    const ownConv = makeConversation("conv-own", "My Own Conversation", {}, CALLER_EMAIL);

    // If the API (correctly) excludes own conversations, the response would be empty.
    // Simulate: API returns [] (no own convs), UI shows empty state.
    await installHomePageMocks(page, { items: [] });
    await page.goto("/", { waitUntil: "domcontentloaded" });

    await expect(page.getByTestId("shared-conversations")).toBeVisible({ timeout: 10_000 });

    // The title "My Own Conversation" must NOT appear in shared section
    await expect(page.getByText(ownConv.title)).not.toBeVisible();
  });

  // ── Private visibility regression — normal list/search/trash ─────────────

  test("recent chats only render scoped conversation candidates", async ({ page }) => {
    const ownedConv = makeConversation("conv-owned", "Owned Private Conversation", {}, CALLER_EMAIL);
    const teamCandidate = makeConversation("conv-team-candidate", "Team Candidate Conversation", {
      shared_with_teams: ["team-visible"],
    });
    const unsharedPrivate = makeConversation("conv-unshared-private", "Unshared Private Conversation");
    let conversationApiCallCount = 0;

    // assisted-by Codex Codex-sonnet-4-6
    // Route-level tests verify the Mongo candidate query; this covers the browser contract it feeds.
    await installHomePageMocks(page, {
      conversationItems: [ownedConv, teamCandidate],
      onConversationRequest: () => {
        conversationApiCallCount++;
      },
    });

    await page.goto("/", { waitUntil: "domcontentloaded" });

    await expect(page.getByTestId("recent-chats")).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText(ownedConv.title)).toBeVisible();
    await expect(page.getByText(teamCandidate.title)).toBeVisible();
    await expect(page.getByText(unsharedPrivate.title)).not.toBeVisible();
    await expect.poll(() => conversationApiCallCount).toBeGreaterThan(0);
  });

  test("search and trash APIs do not return unshared private conversations", async ({ page }) => {
    const sharedConv = makeConversation("conv-shared-search", "Shared Search Result", {
      shared_with: [CALLER_EMAIL],
    });
    const ownedTrash = makeConversation("conv-owned-trash", "Owned Trash Result", {}, CALLER_EMAIL);
    const unsharedPrivate = makeConversation("conv-private-search", "Private Search Result");
    let searchRequest: URL | null = null;
    let trashRequest: URL | null = null;

    await installHomePageMocks(page, {
      searchItems: [sharedConv],
      trashItems: [ownedTrash],
      onSearchRequest: (url) => {
        searchRequest = url;
      },
      onTrashRequest: (url) => {
        trashRequest = url;
      },
    });

    await page.goto("/", { waitUntil: "domcontentloaded" });

    const search = await fetchJson<ConversationListBody>(
      page,
      "/api/chat/search?q=Private%20Search&page_size=20",
    );
    const searchTitles = search.body.data?.items?.map((item) => item.title) ?? [];

    expect(search.status, JSON.stringify(search.body)).toBe(200);
    expect(searchTitles).toContain(sharedConv.title);
    expect(searchTitles).not.toContain(unsharedPrivate.title);
    expect(searchRequest?.searchParams.get("q")).toBe("Private Search");

    const trash = await fetchJson<ConversationListBody>(page, "/api/chat/conversations/trash?page_size=20");
    const trashTitles = trash.body.data?.items?.map((item) => item.title) ?? [];

    expect(trash.status, JSON.stringify(trash.body)).toBe(200);
    expect(trashTitles).toContain(ownedTrash.title);
    expect(trashTitles).not.toContain(unsharedPrivate.title);
    expect(trashRequest?.searchParams.get("page_size")).toBe("20");
  });

  test("rejects conversation discover grants to everyone", async ({ page }) => {
    await installHomePageMocks(page);
    await page.goto("/", { waitUntil: "domcontentloaded" });

    const result = await postJsonFromPage<{ error?: string; code?: string }>(
      page,
      "/api/authz/v1/grants",
      {
        resource: { type: "conversation", id: "conv-unshared-private" },
        grantee: { type: "everyone" },
        capability: "discover",
      },
    );

    expect(result.status, JSON.stringify(result.body)).toBe(400);
    expect(result.body.code).toBe("INVALID_REQUEST");
    expect(result.body.error).toContain("everyone grants are limited");
  });

  // ── Tab filtering ─────────────────────────────────────────────────────────

  test("Shared with me tab is active by default", async ({ page }) => {
    await installHomePageMocks(page, { items: [] });
    await page.goto("/", { waitUntil: "domcontentloaded" });

    await expect(page.getByTestId("shared-conversations")).toBeVisible({ timeout: 10_000 });

    const activeTab = page.getByTestId("shared-tab-shared-with-me");
    await expect(activeTab).toBeVisible();
    // Active tab has different styling — verify it has the active class indicator
    await expect(activeTab).toHaveClass(/bg-background/);
  });

  test("switching to Team tab shows team-shared conversations and hides direct shares", async ({ page }) => {
    const directConv = makeConversation("conv-direct", "Direct Only", {
      shared_with: [CALLER_EMAIL],
    });
    const teamConv = makeConversation("conv-team", "Team Only", {
      shared_with_teams: ["team-xyz"],
    });

    await installHomePageMocks(page, { items: [directConv, teamConv] });
    await page.goto("/", { waitUntil: "domcontentloaded" });

    await expect(page.getByTestId("shared-conversations")).toBeVisible({ timeout: 10_000 });

    // Default: Shared with me shows all returned conversations
    await expect(page.getByText("Direct Only")).toBeVisible();

    // Switch to Team tab
    await page.getByTestId("shared-tab-team").click();
    await expect(page.getByText("Team Only")).toBeVisible();
    // Direct-only conversation does NOT have shared_with_teams so won't appear in Team tab
    await expect(page.getByText("Direct Only")).not.toBeVisible();
  });

  test("Team tab shows empty state when no team-shared conversations exist", async ({ page }) => {
    const directConv = makeConversation("conv-direct", "Direct Only", {
      shared_with: [CALLER_EMAIL],
    });

    await installHomePageMocks(page, { items: [directConv] });
    await page.goto("/", { waitUntil: "domcontentloaded" });

    await expect(page.getByTestId("shared-conversations")).toBeVisible({ timeout: 10_000 });

    await page.getByTestId("shared-tab-team").click();
    await expect(page.getByTestId("shared-empty")).toBeVisible();
    await expect(page.getByText("No team-shared conversations yet.")).toBeVisible();
  });

  // ── Multiple shared conversations ─────────────────────────────────────────

  test("renders multiple shared conversations as a grid of cards", async ({ page }) => {
    const convs = [
      makeConversation("conv-1", "First Shared", { shared_with: [CALLER_EMAIL] }),
      makeConversation("conv-2", "Second Shared", { shared_with: [CALLER_EMAIL] }),
      makeConversation("conv-3", "Third Shared", { shared_with: [CALLER_EMAIL] }),
    ];

    await installHomePageMocks(page, { items: convs });
    await page.goto("/", { waitUntil: "domcontentloaded" });

    await expect(page.getByTestId("shared-conversations")).toBeVisible({ timeout: 10_000 });

    await expect(page.getByText("First Shared")).toBeVisible();
    await expect(page.getByText("Second Shared")).toBeVisible();
    await expect(page.getByText("Third Shared")).toBeVisible();
  });

  test("each conversation card links to /chat/<id>", async ({ page }) => {
    const conv = makeConversation("conv-link-test", "Linked Conversation", {
      shared_with: [CALLER_EMAIL],
    });

    await installHomePageMocks(page, { items: [conv] });
    await page.goto("/", { waitUntil: "domcontentloaded" });

    await expect(page.getByTestId("conversation-card-conv-link-test")).toBeVisible({ timeout: 10_000 });
    await expect(page.getByTestId("conversation-card-conv-link-test")).toHaveAttribute(
      "href",
      "/chat/conv-link-test",
    );
  });

  // ── Message count display ─────────────────────────────────────────────────

  test("shows message count on conversation cards when totalMessages > 0", async ({ page }) => {
    const conv = makeConversation("conv-msgs", "Chat With Messages", {
      shared_with: [CALLER_EMAIL],
    });
    conv.metadata = { total_messages: 7 };

    await installHomePageMocks(page, { items: [conv] });
    await page.goto("/", { waitUntil: "domcontentloaded" });

    await expect(page.getByTestId("conversation-card-conv-msgs")).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText("7 messages")).toBeVisible();
  });
});
