// assisted-by Codex Codex-sonnet-4-6

import { encode } from "next-auth/jwt";
import { type Page, type Route } from "@playwright/test";

export const MOCK_RBAC_EMAIL = "non-manager@caipe.local";

export type MockRouteContext = {
  route: Route;
  url: URL;
  path: string;
  method: string;
};

export type MockRouteHandler = (context: MockRouteContext) => boolean | Promise<boolean>;

type SessionOverrides = {
  email?: string;
  name?: string;
  role?: "admin" | "user";
  canViewAdmin?: boolean;
};

type MockedRbacOptions = {
  isAdmin?: boolean;
  session?: SessionOverrides;
  gates?: Record<string, boolean>;
  handlers?: MockRouteHandler[];
};

export const DEFAULT_ADMIN_GATES: Record<string, boolean> = {
  action_audit: true,
  audit_logs: true,
  credentials: false,
  feedback: false,
  health: true,
  identity_group_sync: false,
  dynamic_agent_conversations: true,
  metrics: true,
  migrations: false,
  openfga: true,
  roles: true,
  settings: true,
  skills: true,
  service_accounts: true,
  slack: false,
  stats: false,
  teams: true,
  users: true,
  webex: false,
};

export function mockedRbacEnabled() {
  return (
    process.env.RUN_RBAC_REGRESSION === "1" ||
    process.env.RUN_WORKFLOW_E2E === "1" ||
    process.env.RUN_RBAC_E2E === "1"
  );
}

export function mockSessionBody(options: MockedRbacOptions = {}) {
  const isAdmin = options.isAdmin ?? false;
  const role = options.session?.role ?? (isAdmin ? "admin" : "user");
  const email = options.session?.email ?? MOCK_RBAC_EMAIL;

  return {
    user: {
      name: options.session?.name ?? (isAdmin ? "RBAC Admin" : "Non Manager"),
      email,
    },
    role,
    isAuthorized: true,
    canViewAdmin: options.session?.canViewAdmin ?? isAdmin,
    canAccessDynamicAgents: true,
    accessToken: "playwright-access-token",
    expiresAt: Math.floor(Date.now() / 1000) + 3600,
    expires: new Date(Date.now() + 3600_000).toISOString(),
  };
}

export async function postJson(route: Route) {
  try {
    return route.request().postDataJSON();
  } catch {
    return null;
  }
}

export async function fulfillJson(route: Route, body: unknown, status = 200) {
  await route.fulfill({
    status,
    contentType: "application/json",
    body: JSON.stringify(body),
  });
}

export async function installMockedRbacApp(page: Page, options: MockedRbacOptions = {}) {
  const isAdmin = options.isAdmin ?? false;
  const session = mockSessionBody({ ...options, isAdmin });
  const gates = { ...DEFAULT_ADMIN_GATES, ...(options.gates ?? {}) };
  const handlers = options.handlers ?? [];

  // The application layout now verifies the session during SSR. Keep the
  // browser API mock for client-side assertions, but also install a matching
  // signed cookie so protected pages can render before those routes exist.
  const secret = process.env.NEXTAUTH_SECRET;
  if (secret) {
    const nowSeconds = Math.floor(Date.now() / 1000);
    const token = await encode({
      secret,
      maxAge: 60 * 60,
      token: {
        sub: `playwright-mocked-${session.role}`,
        name: session.user.name,
        email: session.user.email,
        accessToken: "playwright-access-token",
        expiresAt: nowSeconds + 60 * 60,
        isAuthorized: true,
        role: session.role,
        canViewAdmin: session.canViewAdmin,
        canAccessDynamicAgents: true,
        org: process.env.CAIPE_ORG_KEY?.trim() || "caipe",
      },
    });
    await page.context().addCookies([
      {
        name: "next-auth.session-token",
        value: token,
        url: process.env.CAIPE_UI_BASE_URL ?? "http://localhost:3000",
        httpOnly: true,
        sameSite: "Lax",
        expires: nowSeconds + 2 * 60 * 60,
      },
    ]);
  }

  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const method = request.method();
    const path = url.pathname;
    const context = { route, url, path, method };

    for (const handler of handlers) {
      if (await handler(context)) {
        return;
      }
    }

    if (path === "/api/auth/session") {
      await fulfillJson(route, session);
      return;
    }

    if (path === "/api/auth/role") {
      await fulfillJson(route, { role: session.role });
      return;
    }

    if (path === "/api/users/me") {
      await fulfillJson(route, {
        id: session.user.email,
        email: session.user.email,
        name: session.user.name,
        role: session.role,
      });
      return;
    }

    if (path === "/api/rbac/admin-tab-gates") {
      const integrationPanelModes: Record<string, "full" | "self_service"> = {};
      if (gates.slack) {
        integrationPanelModes.slack = options.isAdmin ? "full" : "self_service";
      }
      if (gates.webex) {
        integrationPanelModes.webex = options.isAdmin ? "full" : "self_service";
      }
      await fulfillJson(route, { gates, integration_panel_modes: integrationPanelModes });
      return;
    }

    if (path === "/api/admin/platform-config") {
      await fulfillJson(route, { data: { release_notes: { enabled: false } } });
      return;
    }

    if (path === "/api/admin/stats") {
      await fulfillJson(route, {
        success: true,
        data: {
          overview: {
            active_users: 0,
            avg_messages_per_conversation: 0,
            conversations_today: 0,
            dau: 0,
            mau: 0,
            messages_today: 0,
            shared_conversations: 0,
            total_conversations: 0,
            total_messages: 0,
            total_sessions: 0,
            total_users: 0,
          },
          available_channels: [],
          completed_workflows: {
            avg_messages_per_workflow: 0,
            completion_rate: 0,
            interrupted: 0,
            today: 0,
            total: 0,
          },
          daily_activity: [],
          daily_usage: [],
          feedback_summary: {
            negative: 0,
            positive: 0,
            total: 0,
          },
          hourly_heatmap: [],
          platform_summary: {
            satisfaction_rate: 0,
          },
          response_time: {
            avg_ms: 0,
            max_ms: 0,
            min_ms: 0,
            sample_count: 0,
          },
          source_breakdown: [],
          top_agents: [],
          top_users: {
            by_conversations: [],
            by_messages: [],
          },
        },
      });
      return;
    }

    if (path === "/api/admin/teams") {
      await fulfillJson(route, { success: true, data: { teams: [] } });
      return;
    }

    if (path === "/api/admin/stats/skills") {
      await fulfillJson(route, { success: false });
      return;
    }

    if (path === "/api/admin/feedback") {
      await fulfillJson(route, { success: true, data: [] });
      return;
    }

    if (path === "/api/settings") {
      await fulfillJson(route, { data: { preferences: {} } });
      return;
    }

    if (path === "/api/changelog") {
      await fulfillJson(route, { releases: [] });
      return;
    }

    if (path === "/api/version") {
      await fulfillJson(route, {
        version: "playwright",
        gitCommit: "e2e",
        buildDate: "2026-06-12T16:00:00.000Z",
      });
      return;
    }

    if (path === "/api/dynamic-agents/available" || path === "/api/dynamic-agents") {
      await fulfillJson(route, { data: [] });
      return;
    }

    if (path === "/api/dynamic-agents/teams") {
      await fulfillJson(route, { success: true, data: [] });
      return;
    }

    if (path === "/api/dynamic-agents/health") {
      await fulfillJson(route, { status: "healthy" });
      return;
    }

    if (path.startsWith("/api/a2a/")) {
      await fulfillJson(route, { name: "playwright-supervisor", skills: [] });
      return;
    }

    await fulfillJson(route, { success: true });
  });
}
