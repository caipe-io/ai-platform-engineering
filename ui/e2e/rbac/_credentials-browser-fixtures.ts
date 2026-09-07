
import { type Page } from "@playwright/test";

import {
  fulfillJson,
  installMockedRbacApp,
  postJson,
  type MockRouteHandler,
} from "./_mocked-rbac";

export const CREDENTIALS_ADMIN_SESSION = {
  email: "admin@caipe.local",
  name: "Platform Admin",
  role: "admin" as const,
  canViewAdmin: true,
};

export const RAW_SECRET_VALUE = "ghp_raw_token_value";

export type CredentialSecretFixture = {
  id: string;
  name: string;
  description?: string;
  type: string;
  owner: {
    type: string;
    id: string;
    email?: string;
    name?: string;
    displayName?: string;
  };
  createdBy?: {
    type: "user" | "service_account";
    id: string;
    email?: string;
    name?: string;
    displayName?: string;
  };
  maskedPreview: string;
  sharedWithTeams?: string[];
  usage?: Array<{
    type: string;
    id: string;
    name: string;
    location: string;
    detail?: string;
  }>;
  storage?: {
    metadataCollection: string;
    payloadCollection: string;
    encryption: string;
    plaintextReadableByBrowser: false;
    valuePreviewAvailable: true;
  };
  createdAt?: string;
  updatedAt?: string;
  rotatedAt?: string;
};

export type CredentialAuditFixture = {
  action: string;
  result?: string;
  outcome?: string;
  ts?: string;
  resource?: { id?: string; type?: string };
  resource_ref?: string;
  actor?: {
    type: string;
    id: string;
    email?: string;
    name?: string;
    displayName?: string;
  };
};

export const DEFAULT_GITHUB_SECRET: CredentialSecretFixture = {
  id: "secret-github",
  name: "GitHub token",
  description: "GitHub automation token",
  owner: {
    type: "user",
    id: "owner-sub",
    email: "owner@caipe.local",
    name: "Workspace Owner",
  },
  createdBy: {
    type: "user",
    id: "owner-sub",
    email: "owner@caipe.local",
    name: "Workspace Owner",
  },
  type: "bearer_token",
  maskedPreview: "ghp_...abcd",
  sharedWithTeams: ["platform-team", "security-team"],
  usage: [
    {
      type: "mcp_server",
      id: "mcp-github",
      name: "GitHub MCP",
      location: "Agents > Tools",
      detail: "env: GITHUB_TOKEN",
    },
    {
      type: "llm_provider",
      id: "openai",
      name: "OpenAI api key",
      location: "Agents > Model Providers",
      detail: "Resolved by provider credential naming convention",
    },
  ],
  storage: {
    metadataCollection: "credential_secret_refs",
    payloadCollection: "credential_encrypted_payloads",
    encryption: "AES-256-GCM envelope encryption",
    plaintextReadableByBrowser: false,
    valuePreviewAvailable: true,
  },
  createdAt: "2026-06-20T12:00:00.000Z",
  updatedAt: "2026-06-20T02:00:00.000Z",
  rotatedAt: "2026-06-20T02:00:00.000Z",
};

export const DEFAULT_CREDENTIAL_AUDIT_EVENTS: CredentialAuditFixture[] = [
  {
    action: "credential.create",
    result: "success",
    ts: "2026-06-20T01:00:00.000Z",
    actor: {
      type: "user",
      id: "owner-sub",
      email: "owner@caipe.local",
      name: "Workspace Owner",
    },
    resource: { type: "secret_ref", id: "secret-github" },
  },
  {
    action: "credential.rotate",
    result: "success",
    ts: "2026-06-20T02:00:00.000Z",
    actor: { type: "user", id: "other-sub", email: "other@caipe.local", name: "Other User" },
    resource_ref: "secret_ref:secret-other",
  },
];

export const DEFAULT_CREDENTIAL_TEAMS = [
  { _id: "team-1", slug: "platform-team", name: "Platform Team" },
  { _id: "team-2", slug: "security-team", name: "Security Team" },
  { _id: "team-3", slug: "ops-team", name: "Ops Team" },
];

export const DEFAULT_OAUTH_CONNECTOR = {
  id: "atlassian-connector",
  name: "Atlassian Cloud",
  provider: "atlassian",
  enabled: true,
  scopes: [
    "offline_access",
    "read:me",
    "read:jira-work",
    "read:jira-user",
    "write:jira-work",
  ],
};

export type InstallCredentialsBrowserMocksOptions = {
  secrets?: CredentialSecretFixture[];
  auditEvents?: CredentialAuditFixture[];
  oauthConnectors?: Array<Record<string, unknown>>;
  providerConnections?: Array<Record<string, unknown>>;
};

export type InstalledCredentialsBrowserMocks = {
  shareRequests: Array<{ action?: string; teamId?: string }>;
  rotateRequests: Array<{ action?: string; value?: string }>;
  deleteRequests: string[];
  connectionRevokeRequests: string[];
  personalCreateRequests: Array<{ name?: string; type?: string; value?: string }>;
  adminPatchRequests: Array<{ id: string; body: Record<string, unknown> }>;
  adminDeleteRequests: string[];
  get secrets(): CredentialSecretFixture[];
  get providerConnections(): Array<Record<string, unknown>>;
};

export async function forceCredentialsFeatureFlags(page: Page): Promise<void> {
  await page.addInitScript(() => {
    let appConfig: Record<string, unknown> | undefined;
    Object.defineProperty(window, "__APP_CONFIG__", {
      configurable: true,
      get() {
        return appConfig;
      },
      set(next) {
        appConfig = {
          ...(typeof next === "object" && next !== null ? next : {}),
          credentialsEnabled: true,
          userConnectionsEnabled: true,
        };
      },
    });
  });
}

function credentialSecretsHandler(
  state: {
    secrets: CredentialSecretFixture[];
    shareRequests: Array<{ action?: string; teamId?: string }>;
    rotateRequests: Array<{ action?: string; value?: string }>;
    deleteRequests: string[];
    personalCreateRequests: Array<{ name?: string; type?: string; value?: string }>;
    adminPatchRequests: Array<{ id: string; body: Record<string, unknown> }>;
    adminDeleteRequests: string[];
    auditEvents: CredentialAuditFixture[];
    oauthConnectors: Array<Record<string, unknown>>;
    providerConnections: Array<Record<string, unknown>>;
    connectionRevokeRequests: string[];
  },
): MockRouteHandler {
  return async ({ route, path, method }) => {
    if (path === "/api/auth/my-roles" && method === "GET") {
      await fulfillJson(route, {
        teams: DEFAULT_CREDENTIAL_TEAMS.map((team) => ({
          _id: team._id,
          slug: team.slug,
          name: team.name,
        })),
      });
      return true;
    }

    if (path === "/api/admin/teams" && method === "GET") {
      await fulfillJson(route, { success: true, data: { teams: DEFAULT_CREDENTIAL_TEAMS } });
      return true;
    }

    if (path === "/api/admin/credentials/secrets" && method === "GET") {
      await fulfillJson(route, { success: true, data: state.secrets });
      return true;
    }

    if (path === "/api/admin/credentials/audit" && method === "GET") {
      await fulfillJson(route, { success: true, data: state.auditEvents });
      return true;
    }

    if (path === "/api/admin/credentials/oauth-connectors" && method === "GET") {
      await fulfillJson(route, { success: true, data: state.oauthConnectors });
      return true;
    }

    if (path === "/api/admin/credentials/oauth-connectors" && method === "POST") {
      const body = ((await postJson(route)) ?? {}) as Record<string, unknown>;
      const connector = {
        id: "connector-new",
        name: String(body.name ?? "New connector"),
        provider: String(body.provider ?? "custom"),
        enabled: true,
        scopes: Array.isArray(body.scopes) ? body.scopes : [],
      };
      state.oauthConnectors = [...state.oauthConnectors, connector];
      await fulfillJson(route, { success: true, data: connector }, 201);
      return true;
    }

    const adminSecretMatch = path.match(/^\/api\/admin\/credentials\/secrets\/([^/]+)$/);
    if (adminSecretMatch) {
      const secretId = decodeURIComponent(adminSecretMatch[1] ?? "");
      if (method === "PATCH") {
        const body = ((await postJson(route)) ?? {}) as Record<string, unknown>;
        state.adminPatchRequests.push({ id: secretId, body });
        const current = state.secrets.find((secret) => secret.id === secretId);
        const updated = {
          ...(current ?? DEFAULT_GITHUB_SECRET),
          ...body,
          id: secretId,
        } as CredentialSecretFixture;
        state.secrets = state.secrets.map((secret) => (secret.id === secretId ? updated : secret));
        await fulfillJson(route, { success: true, data: updated });
        return true;
      }
      if (method === "DELETE") {
        state.adminDeleteRequests.push(secretId);
        state.secrets = state.secrets.filter((secret) => secret.id !== secretId);
        await fulfillJson(route, { success: true, data: { deleted: true } });
        return true;
      }
    }

    if (path === "/api/credentials/secrets" && method === "GET") {
      await fulfillJson(route, { success: true, data: state.secrets });
      return true;
    }

    if (path === "/api/credentials/secrets" && method === "POST") {
      const body = ((await postJson(route)) ?? {}) as {
        name?: string;
        type?: string;
        value?: string;
      };
      state.personalCreateRequests.push(body);
      const created: CredentialSecretFixture = {
        id: "secret-new",
        name: body.name ?? "New secret",
        type: body.type ?? "bearer_token",
        owner: DEFAULT_GITHUB_SECRET.owner,
        maskedPreview: "e2e_...alue",
        sharedWithTeams: [],
        storage: DEFAULT_GITHUB_SECRET.storage,
      };
      state.secrets = [...state.secrets, created];
      await fulfillJson(route, { success: true, data: created }, 201);
      return true;
    }

    const personalSecretMatch = path.match(/^\/api\/credentials\/secrets\/([^/]+)$/);
    if (personalSecretMatch) {
      const secretId = decodeURIComponent(personalSecretMatch[1] ?? "");
      if (method === "PATCH") {
        const body = ((await postJson(route)) ?? {}) as {
          action?: string;
          teamId?: string;
          value?: string;
        };
        if (body.action === "rotate") {
          state.rotateRequests.push(body);
          const updated = {
            ...DEFAULT_GITHUB_SECRET,
            id: secretId,
            maskedPreview: "rot_...ated",
            rotatedAt: "2026-06-21T18:30:00.000Z",
          };
          state.secrets = state.secrets.map((secret) =>
            secret.id === secretId ? updated : secret,
          );
          await fulfillJson(route, { success: true, data: updated });
          return true;
        }
        if (body.action === "share") {
          state.shareRequests.push(body);
          const updated = {
            ...DEFAULT_GITHUB_SECRET,
            id: secretId,
            sharedWithTeams: [...(DEFAULT_GITHUB_SECRET.sharedWithTeams ?? []), body.teamId ?? ""],
          };
          state.secrets = state.secrets.map((secret) =>
            secret.id === secretId ? updated : secret,
          );
          await fulfillJson(route, { success: true, data: updated });
          return true;
        }
      }
      if (method === "DELETE") {
        state.deleteRequests.push(secretId);
        state.secrets = state.secrets.filter((secret) => secret.id !== secretId);
        await fulfillJson(route, { success: true, data: { deleted: true } });
        return true;
      }
    }

    if (path === "/api/credentials/oauth-connectors" && method === "GET") {
      await fulfillJson(route, { success: true, data: state.oauthConnectors });
      return true;
    }

    if (path === "/api/credentials/connections" && method === "GET") {
      await fulfillJson(route, { success: true, data: state.providerConnections });
      return true;
    }

    const connectionMatch = path.match(/^\/api\/credentials\/connections\/([^/]+)$/);
    if (connectionMatch && method === "DELETE") {
      const connectionId = decodeURIComponent(connectionMatch[1] ?? "");
      state.connectionRevokeRequests.push(connectionId);
      const revoked = state.providerConnections.find((connection) => connection.id === connectionId);
      state.providerConnections = state.providerConnections.filter(
        (connection) => connection.id !== connectionId,
      );
      await fulfillJson(route, {
        success: true,
        data: revoked
          ? { ...revoked, status: "disabled" }
          : { id: connectionId, status: "disabled" },
      });
      return true;
    }

    if (path.match(/^\/api\/credentials\/connections\/[^/]+\/refresh$/) && method === "POST") {
      await fulfillJson(route, { success: false, data: { ok: false } }, 404);
      return true;
    }

    if (path.match(/^\/api\/credentials\/connections\/[^/]+\/profile$/) && method === "POST") {
      const connectionId = path.split("/").at(-2) ?? "";
      await fulfillJson(route, {
        success: true,
        data: {
          ok: true,
          provider: "atlassian",
          accessible_resources: [{ name: "CAIPE Jira", scopes: ["read:jira-user"] }],
          diagnostics: [
            {
              id: "atlassian_accessible_resources",
              label: "Accessible Atlassian sites",
              status: "passed",
              detail: "CAIPE Jira is accessible.",
              action: "No action needed.",
            },
          ],
          _connectionId: connectionId,
        },
      });
      return true;
    }

    return false;
  };
}

export async function installCredentialsBrowserMocks(
  page: Page,
  options: InstallCredentialsBrowserMocksOptions = {},
): Promise<InstalledCredentialsBrowserMocks> {
  const shareRequests: Array<{ action?: string; teamId?: string }> = [];
  const rotateRequests: Array<{ action?: string; value?: string }> = [];
  const deleteRequests: string[] = [];
  const connectionRevokeRequests: string[] = [];
  const personalCreateRequests: Array<{ name?: string; type?: string; value?: string }> = [];
  const adminPatchRequests: Array<{ id: string; body: Record<string, unknown> }> = [];
  const adminDeleteRequests: string[] = [];

  let secrets = [...(options.secrets ?? [DEFAULT_GITHUB_SECRET])];
  let auditEvents = [...(options.auditEvents ?? DEFAULT_CREDENTIAL_AUDIT_EVENTS)];
  let oauthConnectors = [...(options.oauthConnectors ?? [DEFAULT_OAUTH_CONNECTOR])];
  let providerConnections = [...(options.providerConnections ?? [])];

  const state = {
    get secrets() {
      return secrets;
    },
    set secrets(next: CredentialSecretFixture[]) {
      secrets = next;
    },
    shareRequests,
    rotateRequests,
    deleteRequests,
    connectionRevokeRequests,
    personalCreateRequests,
    adminPatchRequests,
    adminDeleteRequests,
    get auditEvents() {
      return auditEvents;
    },
    set auditEvents(next: CredentialAuditFixture[]) {
      auditEvents = next;
    },
    get oauthConnectors() {
      return oauthConnectors;
    },
    set oauthConnectors(next: Array<Record<string, unknown>>) {
      oauthConnectors = next;
    },
    get providerConnections() {
      return providerConnections;
    },
    set providerConnections(next: Array<Record<string, unknown>>) {
      providerConnections = next;
    },
  };

  await forceCredentialsFeatureFlags(page);
  await installMockedRbacApp(page, {
    isAdmin: true,
    session: CREDENTIALS_ADMIN_SESSION,
    gates: {
      credentials: true,
      teams: true,
      users: true,
      migrations: true,
      health: true,
      metrics: true,
      openfga: true,
      service_accounts: true,
    },
    handlers: [credentialSecretsHandler(state)],
  });

  return {
    shareRequests,
    rotateRequests,
    deleteRequests,
    connectionRevokeRequests,
    personalCreateRequests,
    adminPatchRequests,
    adminDeleteRequests,
    get secrets() {
      return secrets;
    },
    get providerConnections() {
      return providerConnections;
    },
  };
}

export async function gotoAdminCredentialsTab(page: Page): Promise<void> {
  await page.goto("/admin/platform/credentials", { waitUntil: "domcontentloaded" });
}

export async function gotoPersonalCredentialsSecrets(page: Page): Promise<void> {
  await page.goto("/credentials/secrets", { waitUntil: "domcontentloaded" });
}

export async function gotoPersonalCredentialsConnections(page: Page): Promise<void> {
  await page.goto("/credentials/connections", { waitUntil: "domcontentloaded" });
}
