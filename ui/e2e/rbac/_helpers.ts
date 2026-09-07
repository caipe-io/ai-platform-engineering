// assisted-by Codex Codex-sonnet-4-6
/**
 * Shared helpers for the RBAC e2e suite.
 */

import { encode } from "next-auth/jwt";
import { expect, type Locator, type Page } from "@playwright/test";
import type { RbacEnv } from "./_env";

export async function chooseSearchablePickerOption(
  page: Page,
  trigger: Locator,
  optionName: string | RegExp,
): Promise<void> {
  await trigger.click();
  await page.getByRole("option", { name: optionName }).click();
}

type TestSessionInput = {
  email: string;
  subject: string;
  role?: "admin" | "user";
  /** Override the embedded token expiry (unix seconds). Defaults to now + 1h. */
  expiresAt?: number;
  /** Set the `hasRefreshToken` claim on the minted token when provided. */
  hasRefreshToken?: boolean;
};

type TestCredentials = {
  email: string;
  password: string;
  sub?: string;
};

type SharePermission = "view" | "comment";

type ChatShareUserSearchResult = {
  email: string;
  name: string;
  avatar_url?: string;
};

type ChatShareTeamSearchResult = {
  _id: string;
  slug: string;
  name: string;
  description?: string;
};

type ChatBootMocksOptions = {
  conversationId?: string;
  ownerEmail?: string;
  title?: string;
  /** When true (default), GET /api/chat/conversations returns the fixture conversation. */
  seedExistingConversation?: boolean;
  /** Artificial delay for the conversation list GET (simulates Sidebar + /chat racing). */
  conversationListDelayMs?: number;
  /** When set, seeds an agent participant on the conversation fixture. */
  agentId?: string;
  sharing?: {
    is_public?: boolean;
    public_permission?: SharePermission;
    shared_with?: string[];
    shared_with_teams?: string[];
    team_permissions?: Record<string, SharePermission>;
    share_link_enabled?: boolean;
  };
  userPermissions?: Record<string, SharePermission>;
  userSearchResults?: ChatShareUserSearchResult[];
  teamSearchResults?: ChatShareTeamSearchResult[];
  viewerHasSharedAccess?: boolean;
  accessLevel?: "owner" | "shared" | "shared_readonly" | "admin_audit";
  onConversationListRequest?: (url: URL) => void;
  onConversationCreate?: () => void;
  onShareRequest?: (request: { method: string; body: unknown; url: URL }) => void;
};

function chatConversationFixture(
  id: string,
  ownerEmail: string,
  agentId?: string,
  options: Pick<
    ChatBootMocksOptions,
    "accessLevel" | "sharing" | "title" | "viewerHasSharedAccess"
  > = {},
) {
  const now = new Date().toISOString();
  return {
    _id: id,
    title: options.title ?? "RBAC E2E Conversation",
    client_type: "webui",
    owner_id: ownerEmail,
    participants: agentId ? [{ type: "agent", id: agentId }] : [],
    created_at: now,
    updated_at: now,
    metadata: { client_type: "webui", total_messages: 0 },
    sharing: {
      is_public: false,
      shared_with: [],
      shared_with_teams: [],
      share_link_enabled: false,
      ...options.sharing,
    },
    viewer_has_shared_access: options.viewerHasSharedAccess,
    access_level: options.accessLevel,
    tags: [],
    is_archived: false,
    is_pinned: false,
    deleted_at: null,
  };
}

export async function installChatBootMocks(
  page: Page,
  env: RbacEnv,
  options: ChatBootMocksOptions = {},
): Promise<void> {
  const conversationId = options.conversationId ?? "rbac-e2e-conversation";
  const ownerEmail = options.ownerEmail ?? env.user.email;
  const conversation = chatConversationFixture(conversationId, ownerEmail, options.agentId, {
    accessLevel: options.accessLevel,
    sharing: options.sharing,
    title: options.title,
    viewerHasSharedAccess: options.viewerHasSharedAccess,
  });
  const seedExistingConversation = options.seedExistingConversation !== false;
  const conversationListDelayMs = options.conversationListDelayMs ?? 0;
  let created = seedExistingConversation;
  const directSharePermission = options.accessLevel === "shared_readonly" ? "view" : "comment";
  const userPermissions: Record<string, SharePermission> = {
    ...(conversation.sharing.shared_with ?? []).reduce<Record<string, SharePermission>>((acc, email) => {
      acc[email] = directSharePermission;
      return acc;
    }, {}),
    ...(options.userPermissions ?? {}),
  };
  conversation.sharing.team_permissions = { ...(conversation.sharing.team_permissions ?? {}) };
  const shareableTeams = options.teamSearchResults ?? [];

  const updateConversationSharing = (sharingUpdate: typeof conversation.sharing) => {
    conversation.sharing = {
      is_public: Boolean(sharingUpdate.is_public),
      public_permission: sharingUpdate.public_permission,
      shared_with: [...(sharingUpdate.shared_with ?? [])],
      shared_with_teams: [...(sharingUpdate.shared_with_teams ?? [])],
      team_permissions: { ...(sharingUpdate.team_permissions ?? {}) },
      share_link_enabled: Boolean(sharingUpdate.share_link_enabled),
    };
  };

  const accessList = () =>
    (conversation.sharing.shared_with ?? []).map((email: string) => ({
      conversation_id: conversationId,
      granted_by: ownerEmail,
      granted_to: email,
      permission: userPermissions[email] ?? directSharePermission,
      granted_at: new Date().toISOString(),
    }));

  await page.route("**/api/admin/platform-config", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        success: true,
        data: {
          default_agent_id: options.agentId ?? null,
          release_notes: { enabled: false },
        },
      }),
    });
  });

  await page.route("**/api/users/search**", async (route) => {
    const requestUrl = new URL(route.request().url());
    const query = (requestUrl.searchParams.get("q") ?? "").trim().toLowerCase();
    const matches = (options.userSearchResults ?? []).filter((user) =>
      `${user.name} ${user.email}`.toLowerCase().includes(query),
    );
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ success: true, data: matches }),
    });
  });

  if (options.agentId) {
    const agent = {
      _id: options.agentId,
      name: "RBAC E2E Agent",
      description: "Mocked dynamic agent for chat browser regressions",
      enabled: true,
      skills: [],
      ui: {},
    };

    await page.route("**/api/dynamic-agents**", async (route) => {
      const request = route.request();
      const requestUrl = new URL(request.url());
      const method = request.method();
      const path = requestUrl.pathname;

      if (path === "/api/dynamic-agents/teams" && method === "GET") {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ success: true, data: shareableTeams }),
        });
        return;
      }

      if (path === "/api/dynamic-agents/available" && method === "GET") {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ success: true, data: [agent] }),
        });
        return;
      }

      if (path === `/api/dynamic-agents/agents/${options.agentId}` && method === "GET") {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ success: true, data: agent }),
        });
        return;
      }

      if (path === "/api/dynamic-agents" && method === "GET") {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            success: true,
            data: { items: [agent], total: 1, page: 1, page_size: 20 },
          }),
        });
        return;
      }

      await route.continue();
    });
  }

  if (shareableTeams.length > 0) {
    await page.route("**/api/dynamic-agents/teams**", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ success: true, data: shareableTeams }),
      });
    });
  }

  await page.route("**/api/chat/conversations**", async (route) => {
    const request = route.request();
    const requestUrl = new URL(request.url());
    const method = request.method();
    const path = requestUrl.pathname;

    if (path === "/api/chat/conversations" && method === "GET") {
      options.onConversationListRequest?.(requestUrl);
      if (conversationListDelayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, conversationListDelayMs));
      }
      const items = created || seedExistingConversation ? [conversation] : [];
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          success: true,
          data: {
            items,
            total: items.length,
            page: 1,
            page_size: 100,
            has_more: false,
          },
        }),
      });
      return;
    }

    if (path === "/api/chat/conversations" && method === "POST") {
      options.onConversationCreate?.();
      created = true;
      await route.fulfill({
        status: 201,
        contentType: "application/json",
        body: JSON.stringify({
          success: true,
          data: { conversation, created: true },
        }),
      });
      return;
    }

    if (path === `/api/chat/conversations/${conversationId}` && method === "GET") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ success: true, data: conversation }),
      });
      return;
    }

    if (path === `/api/chat/conversations/${conversationId}/share` && method === "GET") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          success: true,
          data: {
            sharing: conversation.sharing,
            access_list: accessList(),
          },
        }),
      });
      return;
    }

    if (path === `/api/chat/conversations/${conversationId}/share` && method === "POST") {
      const body = route.request().postDataJSON() as {
        user_emails?: string[];
        team_ids?: string[];
        permission?: SharePermission;
        is_public?: boolean;
        public_permission?: SharePermission;
        enable_link?: boolean;
      };
      options.onShareRequest?.({ method, body, url: requestUrl });
      const permission = body.permission ?? "comment";

      if (Array.isArray(body.user_emails)) {
        const next = new Set(conversation.sharing.shared_with ?? []);
        for (const email of body.user_emails) {
          next.add(email);
          userPermissions[email] = permission;
        }
        conversation.sharing.shared_with = [...next];
      }

      if (Array.isArray(body.team_ids)) {
        const next = new Set(conversation.sharing.shared_with_teams ?? []);
        const nextTeamPermissions = { ...(conversation.sharing.team_permissions ?? {}) };
        for (const teamId of body.team_ids) {
          next.add(teamId);
          nextTeamPermissions[teamId] = permission;
        }
        conversation.sharing.shared_with_teams = [...next];
        conversation.sharing.team_permissions = nextTeamPermissions;
      }

      if (typeof body.is_public === "boolean") {
        conversation.sharing.is_public = body.is_public;
      }
      if (body.public_permission) {
        conversation.sharing.public_permission = body.public_permission;
      }
      if (typeof body.enable_link === "boolean") {
        conversation.sharing.share_link_enabled = body.enable_link;
      }
      updateConversationSharing(conversation.sharing);

      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ success: true, data: conversation }),
      });
      return;
    }

    if (path === `/api/chat/conversations/${conversationId}/share` && method === "PATCH") {
      const body = route.request().postDataJSON() as {
        email?: string;
        team_id?: string;
        permission?: SharePermission;
      };
      options.onShareRequest?.({ method, body, url: requestUrl });

      if (body.permission && body.email) {
        userPermissions[body.email] = body.permission;
      }
      if (body.permission && body.team_id) {
        conversation.sharing.team_permissions = {
          ...(conversation.sharing.team_permissions ?? {}),
          [body.team_id]: body.permission,
        };
      }

      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ success: true, data: conversation }),
      });
      return;
    }

    if (
      (path === `/api/chat/conversations/${conversationId}/turns` ||
        path === `/api/chat/conversations/${conversationId}/messages`) &&
      method === "GET"
    ) {
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

    await route.continue();
  });
}

export async function dismissReleaseUpgradeDialog(page: Page): Promise<void> {
  const dialog = page.getByRole("dialog", { name: /what'?s new/i });

  for (let attempt = 0; attempt < 4; attempt += 1) {
    if (!(await dialog.isVisible({ timeout: 1_000 }).catch(() => false))) {
      return;
    }

    const skipButton = dialog.getByRole("button", { name: /skip until next login/i });
    if (await skipButton.isVisible().catch(() => false)) {
      await skipButton.click({ force: true });
      if (await dialog.isHidden({ timeout: 3_000 }).catch(() => false)) {
        return;
      }
    }

    const dismissButton = dialog.getByRole("button", { name: /do not show again/i });
    if (await dismissButton.isVisible().catch(() => false)) {
      await dismissButton.click({ force: true });
      if (await dialog.isHidden({ timeout: 5_000 }).catch(() => false)) {
        return;
      }
    }

    const closeButton = dialog.getByRole("button", { name: /^close$/i });
    if (await closeButton.isVisible().catch(() => false)) {
      await closeButton.click({ force: true });
      if (await dialog.isHidden({ timeout: 3_000 }).catch(() => false)) {
        return;
      }
    }

    await page.keyboard.press("Escape").catch(() => undefined);
    if (await dialog.isHidden({ timeout: 1_000 }).catch(() => false)) {
      return;
    }

    await page.waitForTimeout(250);
  }
}

export async function expectChatComposerReady(
  page: Page,
  timeoutMs = 30_000,
): Promise<void> {
  const composer = page.locator("textarea").first();
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    await dismissReleaseUpgradeDialog(page);

    const pathname = new URL(page.url()).pathname;
    if (pathname === "/chat") {
      await page.waitForURL(/\/chat\/[^/]+/, { timeout: 2_000 }).catch(() => undefined);
    }

    if (await composer.isVisible({ timeout: 500 }).catch(() => false)) {
      await expect(composer).toBeVisible();
      return;
    }

    await page.waitForTimeout(250);
  }

  await dismissReleaseUpgradeDialog(page);
  await expect(composer).toBeVisible({ timeout: 1_000 });
}

export function isDuoSecurityHost(hostname: string): boolean {
  const normalized = hostname.toLowerCase();
  return normalized === "duosecurity.com" || normalized.endsWith(".duosecurity.com");
}

/** Sign in by visiting the home page and walking the NextAuth -> Keycloak flow. */
export async function signIn(
  page: Page,
  env: RbacEnv,
  creds: TestCredentials = env.user,
): Promise<void> {
  if (
    typeof creds.sub === "string" &&
    creds.sub.length > 0 &&
    process.env.NEXTAUTH_SECRET
  ) {
    await installTestSession(page, env, {
      email: creds.email,
      subject: creds.sub,
      role: creds.email === env.user.email ? "admin" : "user",
    });
    await page.goto("/", { waitUntil: "domcontentloaded" });
    await dismissReleaseUpgradeDialog(page);
    await expect(page).toHaveURL(new RegExp(`^${env.baseUrl}`));
    return;
  }

  await page.goto("/");
  // Some stacks redirect unauthenticated users straight to Keycloak, while
  // others first land on the local /login page and wait for the user to
  // click the SSO button.
  await page.waitForURL(
    (u) =>
      u.toString().includes(env.keycloakUrl) ||
      u.toString().startsWith(env.baseUrl + "/login"),
    { timeout: 30_000 },
  );

  if (page.url().startsWith(env.baseUrl + "/login")) {
    await Promise.all([
      page.waitForURL((u) => u.toString().includes(env.keycloakUrl), {
        timeout: 30_000,
      }),
      page.getByRole("button", { name: /sign in with sso/i }).click(),
    ]);
  } else {
    await page.waitForURL((u) => u.toString().includes(env.keycloakUrl), {
      timeout: 30_000,
    });
  }

  await page.fill('input[name="username"], input[name="email"]', creds.email);
  await page.fill('input[name="password"]', creds.password);
  await Promise.all([
    page.waitForURL((u) => u.toString().startsWith(env.baseUrl), {
      timeout: 45_000,
    }),
    page.click('button[type="submit"], input[type="submit"]'),
  ]);

  await expect(page).toHaveURL(new RegExp(`^${env.baseUrl}`));
}

/**
 * Install a real NextAuth JWT session cookie without walking the interactive
 * OIDC browser flow. Local dev realms often force Duo via `OIDC_IDP_HINT`,
 * which is unsuitable for deterministic headless regressions; the BFF still
 * decodes this cookie through the same NextAuth JWT path as normal sessions.
 */
export async function installTestSession(
  page: Page,
  env: RbacEnv,
  input: TestSessionInput,
): Promise<void> {
  const secret = process.env.NEXTAUTH_SECRET;
  if (!secret) {
    throw new Error("NEXTAUTH_SECRET is required to mint the RBAC e2e session cookie");
  }

  const nowSeconds = Math.floor(Date.now() / 1000);
  const tokenExpiresAt = input.expiresAt ?? nowSeconds + 60 * 60;
  const token = await encode({
    secret,
    maxAge: 60 * 60,
    token: {
      sub: input.subject,
      name: input.email,
      email: input.email,
      accessToken: "rbac-e2e-local-access-token",
      expiresAt: tokenExpiresAt,
      isAuthorized: true,
      role: input.role ?? "admin",
      canViewAdmin: true,
      canAccessDynamicAgents: true,
      org: process.env.CAIPE_ORG_KEY?.trim() || "caipe",
      ...(input.hasRefreshToken !== undefined
        ? { hasRefreshToken: input.hasRefreshToken }
        : {}),
    },
  });

  await page.context().addCookies([
    {
      name: "next-auth.session-token",
      value: token,
      url: env.baseUrl,
      httpOnly: true,
      sameSite: "Lax",
      // Keep the browser-level cookie alive past the embedded token expiry so
      // tests that start with an already-expired token still load authenticated.
      expires: Math.max(tokenExpiresAt, nowSeconds) + 60 * 60,
    },
  ]);
}

/** Click the user menu and select "Sign out". */
export async function signOut(page: Page, env: RbacEnv): Promise<void> {
  await dismissReleaseUpgradeDialog(page);
  await page.getByRole("button", { name: /account|menu|profile/i }).click();
  await Promise.all([
    page.waitForURL(
      (u) =>
        u.toString().startsWith(`${env.baseUrl}/login`) ||
        u.toString().includes(env.keycloakUrl) ||
        isDuoSecurityHost(u.hostname),
      { timeout: 30_000 },
    ),
    page.getByRole("button", { name: /sign out|log out/i }).click({ force: true }),
  ]);
}

/** Forge a session cookie expiry by setting the NextAuth cookie's maxAge to 0. */
export async function expireSession(page: Page): Promise<void> {
  const cookies = await page.context().cookies();
  const sessionCookies = cookies.filter((c) =>
    /next-auth\.session-token|__Secure-next-auth\.session-token/.test(c.name),
  );
  for (const c of sessionCookies) {
    await page.context().addCookies([
      { ...c, expires: Math.floor(Date.now() / 1000) - 60 },
    ]);
  }
}
