import { expect,test,type Locator,type Page } from "@playwright/test";

import {
  fulfillJson,
  installMockedRbacApp,
  mockedRbacEnabled,
  postJson,
  type MockRouteHandler,
} from "./_mocked-rbac";

const ADMIN_SESSION = {
  email: "settings-admin@example.com",
  name: "Example Settings Admin",
  role: "admin" as const,
  canViewAdmin: true,
};

const USER_SESSION = {
  email: "settings-user@example.com",
  name: "Example Settings User",
  role: "user" as const,
  canViewAdmin: false,
};

const AGENTS = [
  {
    _id: "incident-response",
    id: "incident-response",
    name: "Incident Response",
    description: "Coordinates incident response workflows.",
    enabled: true,
  },
  {
    _id: "knowledge-agent",
    id: "knowledge-agent",
    name: "Knowledge Agent",
    description: "Answers questions from approved knowledge bases.",
    enabled: true,
  },
];

interface SettingsMockState {
  failNextSettingsPreferenceWrite: boolean;
  platformConfig: {
    default_agent_id: string | null;
    release_notes: { enabled: boolean };
    source: "db" | "fallback";
  };
  platformWrites: Array<Record<string,unknown>>;
  preferences: Record<string,unknown>;
  settingsPreferenceWrites: Array<Record<string,unknown>>;
  userPreferences: Record<string,unknown>;
  userPreferenceWrites: Array<Record<string,unknown>>;
}

function createState(): SettingsMockState {
  return {
    failNextSettingsPreferenceWrite: false,
    platformConfig: {
      default_agent_id: null,
      release_notes: { enabled: true },
      source: "fallback",
    },
    platformWrites: [],
    preferences: {
      auto_scroll_enabled: "true",
      debug_mode_enabled: "false",
      font_family: "inter",
      font_size: "medium",
      gradient_theme: "default",
      memory_enabled: "true",
      releaseNotesNotificationsEnabled: true,
      releaseNotesDismissedVersions: ["0.5.67"],
      show_thinking_enabled: "true",
      show_timestamps_enabled: "false",
      theme: "dark",
    },
    settingsPreferenceWrites: [],
    userPreferences: {
      integrations: { slack: true,webex: true },
      platform_default_agent_id: null,
      slack_default_agent_id: null,
      web_default_agent_id: null,
      webex_bots: [],
    },
    userPreferenceWrites: [],
  };
}

async function installSettingsCenterMocks(
  page: Page,
  state: SettingsMockState,
  isAdmin = false,
): Promise<void> {
  const handler: MockRouteHandler = async ({ method,path,route }) => {
    if (path === "/api/version" && method === "GET") {
      await fulfillJson(route,{
        version: "0.5.67",
        gitCommit: "abc1234",
        buildDate: "2026-08-20T12:00:00.000Z",
        packageVersion: "0.5.67",
      });
      return true;
    }

    if (path === "/api/platform/health" && method === "GET") {
      await fulfillJson(route,{
        status: "healthy",
        checked_at: "2026-08-20T12:00:00.000Z",
        summary: { total: 2,healthy: 2,degraded: 0,down: 0,disabled: 0 },
        capabilities: [
          {
            id: "chat-runtime",
            label: "Chat Runtime",
            group: "runtime",
            status: "healthy",
            required: true,
            description: "Chat runtime availability.",
            detail: "Runtime reachable",
            latency_ms: 12,
          },
          {
            id: "authentication",
            label: "Authentication",
            group: "identity",
            status: "healthy",
            required: true,
            description: "Authentication availability.",
            detail: "SSO enabled",
            latency_ms: null,
          },
        ],
      });
      return true;
    }

    if (path === "/api/settings/preferences" && method === "PATCH") {
      const body = (await postJson(route)) as Record<string,unknown>;
      state.settingsPreferenceWrites.push(body);
      if (state.failNextSettingsPreferenceWrite) {
        state.failNextSettingsPreferenceWrite = false;
        await fulfillJson(route,{ success: false,error: "Preference service unavailable" },503);
        return true;
      }
      Object.assign(state.preferences,body);
      await fulfillJson(route,{
        success: true,
        data: { preferences: state.preferences },
      });
      return true;
    }

    if (path === "/api/settings" && method === "GET") {
      await fulfillJson(route,{
        success: true,
        data: {
          defaults: {},
          notifications: {},
          preferences: state.preferences,
        },
      });
      return true;
    }

    if (path === "/api/user/accessible-agents" && method === "GET") {
      await fulfillJson(route,{
        success: true,
        data: {
          agents: AGENTS.map(({ description,id,name }) => ({ description,id,name })),
          page: 1,
          page_size: 100,
          total: AGENTS.length,
        },
      });
      return true;
    }

    if (path === "/api/user/preferences" && method === "GET") {
      await fulfillJson(route,{ success: true,data: state.userPreferences });
      return true;
    }

    if (path === "/api/user/preferences" && method === "PUT") {
      const body = (await postJson(route)) as Record<string,unknown>;
      state.userPreferenceWrites.push(body);
      Object.assign(state.userPreferences,body);
      await fulfillJson(route,{ success: true,data: body });
      return true;
    }

    if (path === "/api/dynamic-agents/available" && method === "GET") {
      await fulfillJson(route,{ success: true,data: AGENTS });
      return true;
    }

    if (path === "/api/admin/platform-config" && method === "GET") {
      await fulfillJson(route,{ success: true,data: state.platformConfig });
      return true;
    }

    if (path === "/api/admin/platform-config" && method === "PATCH") {
      const body = (await postJson(route)) as Record<string,unknown>;
      state.platformWrites.push(body);
      if (Object.prototype.hasOwnProperty.call(body,"default_agent_id")) {
        state.platformConfig.default_agent_id = body.default_agent_id as string | null;
        state.platformConfig.source = "db";
      }
      const releaseNotes = body.release_notes as { enabled?: unknown } | undefined;
      if (typeof releaseNotes?.enabled === "boolean") {
        state.platformConfig.release_notes.enabled = releaseNotes.enabled;
      }
      await fulfillJson(route,{ success: true,data: state.platformConfig });
      return true;
    }

    if (path === "/api/auth/my-roles" && method === "GET") {
      await fulfillJson(route,{
        email: isAdmin ? ADMIN_SESSION.email : USER_SESSION.email,
        idp_source: "playwright",
        name: isAdmin ? ADMIN_SESSION.name : USER_SESSION.name,
        per_agent_roles: [],
        per_kb_roles: [],
        realm_roles: isAdmin ? ["admin"] : ["user"],
        role: isAdmin ? "admin" : "user",
        slack_linked: true,
        teams: [],
      });
      return true;
    }

    return false;
  };

  await installMockedRbacApp(page,{
    handlers: [handler],
    isAdmin,
    session: isAdmin ? ADMIN_SESSION : USER_SESSION,
  });
}

async function switchThumbIsInsideTrack(toggle: Locator): Promise<boolean> {
  const track = await toggle.locator("span").first().boundingBox();
  const thumb = await toggle.locator("span").nth(1).boundingBox();
  if (!track || !thumb) return false;

  const tolerance = 0.5;
  return thumb.x >= track.x - tolerance
    && thumb.x + thumb.width <= track.x + track.width + tolerance
    && thumb.y >= track.y - tolerance
    && thumb.y + thumb.height <= track.y + track.height + tolerance;
}

async function openSettings(
  page: Page,
  section: "Appearance" | "Chat & agents" | "Notifications" = "Chat & agents",
): Promise<Locator> {
  const route = {
    Appearance: "/settings/appearance",
    "Chat & agents": "/settings/chat-and-agents",
    Notifications: "/settings/notifications",
  }[section];
  await page.goto(route,{ waitUntil: "domcontentloaded" });
  await expect(page).toHaveURL(route);
  const main = page.getByRole("main");
  await expect(main.getByRole("heading",{ level: 1,name: section })).toBeVisible();
  return main;
}

test.describe("mocked routed Settings browser regression",() => {
  test.beforeEach(() => {
    test.skip(
      !mockedRbacEnabled(),
      "Set RUN_RBAC_REGRESSION=1 to run the mocked routed Settings regression.",
    );
  });

  test("shows the version in About instead of the navigation footer",async ({ page }) => {
    const state = createState();
    await installSettingsCenterMocks(page,state);
    await openSettings(page,"Notifications");

    await expect(page.getByTestId("application-version")).toHaveCount(0);
    await page.getByRole("button",{ name: /user menu for/i }).click();
    await page.getByRole("button",{ name: "About" }).click();
    await expect(page.getByTestId("application-version")).toContainText("Version: v0.5.67");
    await expect(page.getByTestId("application-version")).not.toHaveAttribute("href");
    await expect(page.getByRole("link",{ name: "System health" })).toHaveCount(0);
  });

  test("opens Appearance from the header without hydration errors or a duplicate dialog",async ({ page }) => {
    const state = createState();
    await installSettingsCenterMocks(page,state);
    const renderingErrors: string[] = [];
    page.on("console",(message) => {
      if (message.type() === "error") renderingErrors.push(message.text());
    });
    page.on("pageerror",(error) => renderingErrors.push(error.message));
    await page.goto("/",{ waitUntil: "domcontentloaded" });

    const shortcut = page.getByRole("link",{ exact: true,name: "Appearance settings" });
    await expect(shortcut).toHaveAttribute("href","/settings/appearance");
    await shortcut.click();

    await expect(page).toHaveURL("/settings/appearance");
    await expect(page.getByRole("heading",{ level: 1,name: "Appearance" })).toBeVisible();
    const navigation = page.getByRole("navigation",{ name: "Settings sections" });
    await expect(navigation.getByRole("link",{ name: "Appearance" })).toHaveAttribute(
      "aria-current",
      "page",
    );
    await expect(navigation.getByRole("link",{ name: "Chat & agents" })).toHaveAttribute(
      "href",
      "/settings/chat-and-agents",
    );
    await expect(page.getByRole("dialog",{ name: "Settings" })).toHaveCount(0);
    expect(
      renderingErrors.filter((message) => /hydration|script tag while rendering/i.test(message)),
    ).toEqual([]);
  });

  test("keeps Legacy Light native surfaces light after switching from Dark and reloading",async ({ page }) => {
    const state = createState();
    await installSettingsCenterMocks(page,state);
    const renderingErrors: string[] = [];
    page.on("console",(message) => {
      if (message.type() === "error") renderingErrors.push(message.text());
    });
    page.on("pageerror",(error) => renderingErrors.push(error.message));
    const settings = await openSettings(page,"Appearance");

    await settings.getByRole("button",{
      name: "Legacy Light Original bright neutral palette",
    }).click();

    await expect(page.locator("html")).toHaveAttribute("data-theme","legacy-light");
    await expect.poll(() => page.evaluate(() => (
      getComputedStyle(document.documentElement).colorScheme
    ))).toBe("light");
    await expect.poll(() => state.settingsPreferenceWrites).toContainEqual({
      theme: "legacy-light",
    });

    await page.reload({ waitUntil: "domcontentloaded" });

    await expect(page.locator("html")).toHaveAttribute("data-theme","legacy-light");
    await expect.poll(() => page.evaluate(() => (
      getComputedStyle(document.documentElement).colorScheme
    ))).toBe("light");
    await expect(page.getByRole("link",{ name: "Appearance settings" })).toContainText(
      "Legacy Light",
    );
    expect(
      renderingErrors.filter((message) => /hydration|script tag while rendering/i.test(message)),
    ).toEqual([]);
  });

  test("shows preference explanations on hover without a dead documentation link",async ({ page }) => {
    const state = createState();
    await installSettingsCenterMocks(page,state);
    const settings = await openSettings(page);

    await settings.getByRole("button",{ name: "More about Cross-Thread Memory" }).hover();

    await expect(page.getByRole("tooltip")).toContainText(
      "the assistant extracts and recalls facts about you",
    );
    await expect(page.locator('a[href="/docs/features/cross-thread-memory"]')).toHaveCount(0);
  });

  test("rolls back a failed personal autosave, retries it, and reloads the saved value",async ({ page }) => {
    const state = createState();
    state.failNextSettingsPreferenceWrite = true;
    await installSettingsCenterMocks(page,state);
    let settings = await openSettings(page,"Notifications");

    let toggle = settings.getByRole("switch",{ name: "Notify me about new releases" });
    await expect.poll(() => switchThumbIsInsideTrack(toggle)).toBe(true);
    await toggle.click();

    await expect(settings.getByRole("alert")).toContainText("Preference service unavailable");
    await expect(toggle).toHaveAttribute("aria-checked","true");
    await expect.poll(() => switchThumbIsInsideTrack(toggle)).toBe(true);
    await expect.poll(() => state.settingsPreferenceWrites).toEqual([
      { releaseNotesNotificationsEnabled: false },
    ]);

    await settings.getByRole("button",{ name: "Retry" }).click();
    await expect(toggle).toHaveAttribute("aria-checked","false");
    await expect.poll(() => switchThumbIsInsideTrack(toggle)).toBe(true);
    await expect(settings.getByText("Saved",{ exact: true })).toBeVisible();

    await page.reload({ waitUntil: "domcontentloaded" });
    settings = page.getByRole("main");
    await expect(settings.getByRole("heading",{ level: 1,name: "Notifications" })).toBeVisible();
    toggle = settings.getByRole("switch",{ name: "Notify me about new releases" });
    await expect(toggle).toHaveAttribute("aria-checked","false");
  });

  test("auto-saves each personal default-agent surface independently",async ({ page }) => {
    const state = createState();
    await installSettingsCenterMocks(page,state);
    const settings = await openSettings(page);

    await settings.getByRole("combobox",{ name: "Web default agent" }).click();
    await page.getByRole("option",{ name: "Incident Response" }).click();

    await expect.poll(() => state.userPreferenceWrites).toEqual([
      { web_default_agent_id: "incident-response" },
    ]);
    await expect(settings.getByRole("combobox",{ name: "Web default agent" })).toContainText("Incident Response");
    await expect(settings.getByRole("combobox",{ name: "Slack default agent" })).toContainText("Use platform default");
    await expect(settings.getByRole("button",{ name: /^save$/i })).toHaveCount(0);
  });

  test("requires consequence confirmation before changing a platform default",async ({ page }) => {
    const state = createState();
    await installSettingsCenterMocks(page,state,true);
    await page.goto("/admin/configuration/defaults",{ waitUntil: "domcontentloaded" });
    const defaults = page.getByRole("main");

    await expect(defaults.getByRole("heading",{ level: 1,name: "Defaults" })).toBeVisible();
    await expect(
      page.getByRole("navigation",{ name: "Admin sections" }).getByRole("link",{ name: "Defaults" }),
    ).toHaveAttribute(
      "href",
      "/admin/configuration/defaults",
    );
    await defaults.getByRole("combobox",{ name: "Platform default agent for new chats" }).click();
    await page.getByRole("option",{ name: "Incident Response" }).click();

    const confirmation = page.getByRole("dialog",{
      name: "Make “Incident Response” the platform default?",
    });
    await expect(confirmation).toBeVisible();
    expect(state.platformWrites).toEqual([]);

    await confirmation.getByRole("button",{ name: "Make it the default" }).click();
    await expect(confirmation).toBeHidden();
    await expect.poll(() => state.platformWrites).toEqual([{
      acknowledge_public_access: true,
      default_agent_id: "incident-response",
    }]);
    await expect(defaults.getByText("Saved",{ exact: true })).toBeVisible();
  });

});
