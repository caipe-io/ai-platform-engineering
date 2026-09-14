// assisted-by Codex Codex-sonnet-4-6
/**
 * Mocked Playwright coverage for browser chat sharing flows.
 *
 * These tests drive the real ShareDialog UI and assert the API contract for:
 * direct user shares, fallback email shares, team shares, permission updates,
 * and recipient-side Shared Conversations visibility.
 */

import { expect, test, type Locator, type Page } from "@playwright/test";

import {
  dismissReleaseUpgradeDialog,
  expectChatComposerReady,
  installChatBootMocks,
  installTestSession,
} from "./_helpers";
import {
  fulfillJson,
  installMockedRbacApp,
  mockedRbacEnabled,
} from "./_mocked-rbac";

const OWNER = {
  email: "owner@caipe.local",
  subject: "playwright-owner-sub",
};
const RECIPIENT = {
  email: "recipient@caipe.local",
  name: "Recipient User",
};
const FALLBACK_EMAIL = "future.user@caipe.local";
const TEAM = {
  _id: "team-platform-object",
  slug: "platform-eng",
  name: "Platform Engineering",
  description: "Runs the platform",
};
const CONVERSATION_ID = "share-user-team-e2e-conv";
const CONVERSATION_TITLE = "User and Team Sharing E2E";
const AGENT_ID = "agent-share-e2e";

type SharePermission = "view" | "comment";

type ShareRequest = {
  method: string;
  body: unknown;
  url: URL;
};

type SharingInput = {
  is_public?: boolean;
  shared_with?: string[];
  shared_with_teams?: string[];
  team_permissions?: Record<string, SharePermission>;
  share_link_enabled?: boolean;
};

type UserSearchResult = {
  email: string;
  name: string;
  avatar_url?: string;
};

type TeamSearchResult = {
  _id: string;
  slug: string;
  name: string;
  description?: string;
};

type ConversationFixture = ReturnType<typeof makeConversation>;

function minimalSessionEnv(email = OWNER.email) {
  return {
    baseUrl: process.env.CAIPE_UI_BASE_URL ?? "http://localhost:3000",
    keycloakUrl: process.env.KEYCLOAK_URL ?? "http://localhost:7080",
    keycloakRealm: process.env.KEYCLOAK_REALM ?? "caipe",
    user: { email, password: "" },
  };
}

function makeConversation(
  id: string,
  title: string,
  sharing: {
    is_public?: boolean;
    shared_with?: string[];
    shared_with_teams?: string[];
    team_permissions?: Record<string, SharePermission>;
    share_link_enabled?: boolean;
  } = {},
  ownerEmail = OWNER.email,
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
      team_permissions: sharing.team_permissions ?? {},
      share_link_enabled: sharing.share_link_enabled ?? false,
    },
    tags: [],
    is_archived: false,
    is_pinned: false,
    deleted_at: null,
  };
}

function paginatedResponse(items: ConversationFixture[]) {
  return {
    success: true,
    data: { items, total: items.length, page: 1, page_size: 20 },
  };
}

async function bootOwnerChat(
  page: Page,
  options: {
    sharing?: SharingInput;
    userPermissions?: Record<string, SharePermission>;
    userSearchResults?: UserSearchResult[];
    teamSearchResults?: TeamSearchResult[];
    onShareRequest?: (request: ShareRequest) => void;
  } = {},
) {
  test.skip(
    !process.env.NEXTAUTH_SECRET,
    "NEXTAUTH_SECRET required for chat sharing SSR.",
  );
  const env = minimalSessionEnv(OWNER.email);
  await installChatBootMocks(page, env, {
    agentId: AGENT_ID,
    conversationId: CONVERSATION_ID,
    title: CONVERSATION_TITLE,
    ownerEmail: OWNER.email,
    accessLevel: "owner",
    sharing: options.sharing,
    userPermissions: options.userPermissions,
    userSearchResults: options.userSearchResults ?? [RECIPIENT],
    teamSearchResults: options.teamSearchResults ?? [TEAM],
    onShareRequest: options.onShareRequest,
  });
  await installTestSession(page, env, {
    email: OWNER.email,
    subject: OWNER.subject,
    role: "user",
  });
  await page.goto(`/chat/${CONVERSATION_ID}`, {
    waitUntil: "domcontentloaded",
  });
  await dismissReleaseUpgradeDialog(page);
  await expectChatComposerReady(page);
  return env;
}

async function openShareDialog(page: Page): Promise<Locator> {
  await page
    .getByRole("button", { name: "Share conversation" })
    .first()
    .click({ force: true });
  const dialog = page.getByRole("dialog", { name: "Share Conversation" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText(CONVERSATION_TITLE)).toBeVisible();
  return dialog;
}

function sidebarShareButton(page: Page): Locator {
  return page.getByRole("button", { name: "Share conversation" }).first();
}

async function expectSidebarShareIcon(
  page: Page,
  {
    tooltip,
    expectedIconClass,
    forbiddenIconClass,
  }: {
    tooltip: string;
    expectedIconClass: RegExp;
    forbiddenIconClass: RegExp;
  },
) {
  const button = sidebarShareButton(page);
  await expect(button).toBeVisible();
  const icon = button.locator("svg").first();
  await expect(icon).toHaveClass(expectedIconClass);
  await expect(icon).not.toHaveClass(forbiddenIconClass);

  await button.hover();
  await expect(page.getByRole("tooltip", { name: tooltip })).toBeVisible();
}

async function selectDefaultSharePermission(
  dialog: Locator,
  permission: SharePermission,
) {
  await dialog
    .locator('select[title="Permission for new shares"]')
    .selectOption(permission);
}

function accessRow(dialog: Locator, label: string): Locator {
  return dialog
    .locator(".flex.items-center.justify-between", { hasText: label })
    .last();
}

async function selectAccessRowPermission(
  dialog: Locator,
  label: string,
  permission: SharePermission,
) {
  await accessRow(dialog, label).locator("select").selectOption(permission);
}

async function installSharedHomeMocks(
  page: Page,
  sessionEmail: string,
  conversations: ConversationFixture[],
) {
  // Shared Conversations is optional in the minimal default home layout.
  // Turn it on for these focused sharing regressions.
  await page.addInitScript(() => {
    localStorage.setItem(
      "caipe-home-widgets",
      JSON.stringify(["heroComposer", "quickStart", "sharedConversations"]),
    );
    localStorage.setItem("caipe-home-widgets-version", "2");
  });

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
    session: { email: sessionEmail, name: "Recipient User" },
    handlers: [
      async ({ route, path, method }) => {
        if (path === "/api/settings" && method === "GET") {
          await fulfillJson(route, {
            success: true,
            data: {
              preferences: {
                home_widgets: ["heroComposer", "quickStart", "sharedConversations"],
                home_widgets_version: 2,
                home_experience: "new",
              },
            },
          });
          return true;
        }
        if (path === "/api/chat/shared" && method === "GET") {
          await fulfillJson(route, paginatedResponse(conversations));
          return true;
        }
        if (path === "/api/chat/conversations" && method === "GET") {
          await fulfillJson(route, paginatedResponse([]));
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
          await fulfillJson(route, {
            success: true,
            data: { items: [], total: 0 },
          });
          return true;
        }
        if (path === "/api/chat/bookmarks") {
          await fulfillJson(route, {
            success: true,
            data: { items: [], total: 0 },
          });
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
        return false;
      },
    ],
  });
}

test.describe("mocked RBAC e2e - chat sharing users and teams", () => {
  test.beforeEach(() => {
    test.skip(
      !mockedRbacEnabled(),
      "Set RUN_RBAC_REGRESSION=1 to run mocked chat sharing coverage.",
    );
  });

  test("owner shares a conversation with a directory user from the dialog", async ({
    page,
  }) => {
    const shareRequests: ShareRequest[] = [];
    await bootOwnerChat(page, {
      onShareRequest: (request) => shareRequests.push(request),
    });

    const dialog = await openShareDialog(page);
    await dialog
      .getByPlaceholder("Search by email or team name...")
      .fill("recipient");
    await expect(dialog.getByText("People", { exact: true })).toBeVisible();
    await dialog.getByText(RECIPIENT.name, { exact: true }).click();

    await expect(dialog.getByText(RECIPIENT.email)).toBeVisible();
    expect(shareRequests).toContainEqual(
      expect.objectContaining({
        method: "POST",
        body: {
          user_emails: [RECIPIENT.email],
          permission: "comment",
        },
      }),
    );
  });

  test("sidebar uses the share icon before a conversation is shared", async ({
    page,
  }) => {
    await bootOwnerChat(page);

    await expectSidebarShareIcon(page, {
      tooltip: "Share",
      expectedIconClass: /\btext-foreground\b/,
      forbiddenIconClass: /\b(text-muted-foreground|text-blue-500)\b/,
    });
  });

  test("sidebar uses the blue team icon and Edit Share tooltip for shared conversations", async ({
    page,
  }) => {
    await bootOwnerChat(page, {
      sharing: {
        shared_with: [RECIPIENT.email],
      },
      userPermissions: { [RECIPIENT.email]: "comment" },
    });

    await expectSidebarShareIcon(page, {
      tooltip: "Edit Share",
      expectedIconClass: /\btext-blue-500\b/,
      forbiddenIconClass: /\btext-muted-foreground\b/,
    });
  });

  test("owner can share with an unprovisioned email using view-only permission", async ({
    page,
  }) => {
    const shareRequests: ShareRequest[] = [];
    await bootOwnerChat(page, {
      userSearchResults: [],
      teamSearchResults: [],
      onShareRequest: (request) => shareRequests.push(request),
    });

    const dialog = await openShareDialog(page);
    await selectDefaultSharePermission(dialog, "view");
    await dialog
      .getByPlaceholder("Search by email or team name...")
      .fill(FALLBACK_EMAIL);
    await expect(dialog.getByText("No people or teams found")).toBeVisible();
    await dialog
      .getByRole("button", { name: `Share with ${FALLBACK_EMAIL}` })
      .click();

    await expect(dialog.getByText(FALLBACK_EMAIL)).toBeVisible();
    expect(shareRequests).toContainEqual(
      expect.objectContaining({
        method: "POST",
        body: {
          user_emails: [FALLBACK_EMAIL],
          permission: "view",
        },
      }),
    );
  });

  test("owner shares a conversation with a team and displays the team access row", async ({
    page,
  }) => {
    const shareRequests: ShareRequest[] = [];
    await bootOwnerChat(page, {
      onShareRequest: (request) => shareRequests.push(request),
    });

    const dialog = await openShareDialog(page);
    await selectDefaultSharePermission(dialog, "view");
    await dialog
      .getByPlaceholder("Search by email or team name...")
      .fill("platform");
    await expect(dialog.getByText("Teams", { exact: true })).toBeVisible();
    await dialog.getByText(TEAM.name, { exact: true }).click();

    await expect(accessRow(dialog, TEAM.name)).toBeVisible();
    await expect(accessRow(dialog, TEAM.name).locator("select")).toHaveValue(
      "view",
    );
    expect(shareRequests).toContainEqual(
      expect.objectContaining({
        method: "POST",
        body: {
          team_ids: [TEAM.slug],
          permission: "view",
        },
      }),
    );
  });

  test("owner updates direct-user and team permissions from the access list", async ({
    page,
  }) => {
    const shareRequests: ShareRequest[] = [];
    await bootOwnerChat(page, {
      sharing: {
        shared_with: [RECIPIENT.email],
        shared_with_teams: [TEAM.slug],
        team_permissions: { [TEAM.slug]: "view" },
      },
      userPermissions: { [RECIPIENT.email]: "comment" },
      onShareRequest: (request) => shareRequests.push(request),
    });

    const dialog = await openShareDialog(page);
    await expect(
      accessRow(dialog, RECIPIENT.email).locator("select"),
    ).toHaveValue("comment");
    await expect(accessRow(dialog, TEAM.name).locator("select")).toHaveValue(
      "view",
    );

    await selectAccessRowPermission(dialog, RECIPIENT.email, "view");
    await selectAccessRowPermission(dialog, TEAM.name, "comment");

    expect(shareRequests).toContainEqual(
      expect.objectContaining({
        method: "PATCH",
        body: {
          email: RECIPIENT.email,
          permission: "view",
        },
      }),
    );
    expect(shareRequests).toContainEqual(
      expect.objectContaining({
        method: "PATCH",
        body: {
          team_id: TEAM.slug,
          permission: "comment",
        },
      }),
    );
  });

  test("recipient sees direct user shares on the Shared with me home tab", async ({
    page,
  }) => {
    const directConversation = makeConversation(
      "direct-share-home",
      "Direct User Share",
      {
        shared_with: [RECIPIENT.email],
      },
    );
    await installSharedHomeMocks(page, RECIPIENT.email, [directConversation]);

    await page.goto("/", { waitUntil: "domcontentloaded" });

    await expect(page.getByTestId("shared-conversations")).toBeVisible();
    await expect(page.getByTestId("shared-tab-shared-with-me")).toHaveClass(
      /bg-background/,
    );
    await expect(page.getByText("Direct User Share")).toBeVisible();
    await expect(page.getByText(`Shared by ${OWNER.email}`)).toBeVisible();
  });

  test("recipient sees team shares only in the Team home tab", async ({
    page,
  }) => {
    const directConversation = makeConversation(
      "direct-share-home-team-view",
      "Direct Recipient Share",
      {
        shared_with: [RECIPIENT.email],
      },
    );
    const teamConversation = makeConversation(
      "team-share-home",
      "Team Recipient Share",
      {
        shared_with_teams: [TEAM.slug],
        team_permissions: { [TEAM.slug]: "comment" },
      },
    );
    await installSharedHomeMocks(page, RECIPIENT.email, [
      directConversation,
      teamConversation,
    ]);

    await page.goto("/", { waitUntil: "domcontentloaded" });

    await expect(page.getByTestId("shared-conversations")).toBeVisible();
    await page.getByTestId("shared-tab-team").click();
    await expect(page.getByText("Team Recipient Share")).toBeVisible();
    await expect(page.getByText("Direct Recipient Share")).not.toBeVisible();
  });
});
