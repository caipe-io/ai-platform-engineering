/**
 * @jest-environment node
 */

import {
  getIntegrationAvailability,
  getSlackIntegrationToken,
  getWebexLinkAllowedOrgId,
  getWebexLinkScopes,
  isSlackIntegrationEnabled,
  isWebexIdentityLinkingEnabled,
  isWebexIntegrationEnabled,
} from "../integration-config";

const ENV_KEYS = [
  "COMPOSE_PROFILES",
  "SLACK_BOT_TOKEN",
  "SLACK_INTEGRATION_BOT_TOKEN",
  "SLACK_INTEGRATION_ENABLED",
  "SLACK_ADMIN_API_ENABLED",
  "SLACK_BOT_ADMIN_DEV_AUTH_ENABLED",
  "WEBEX_INTEGRATION_ENABLED",
  "WEBEX_BOT_ADMIN_CLIENT_SECRET",
  "KEYCLOAK_WEBEX_BOT_ADMIN_CLIENT_SECRET",
  "WEBEX_LINK_CLIENT_ID",
  "WEBEX_LINK_CLIENT_SECRET",
  "WEBEX_LINK_REDIRECT_URI",
  "WEBEX_LINK_ALLOWED_ORG_ID",
  "WEBEX_LINK_SCOPES",
] as const;

const originalEnv = new Map(ENV_KEYS.map((key) => [key, process.env[key]]));

beforeEach(() => {
  for (const key of ENV_KEYS) delete process.env[key];
});

afterAll(() => {
  for (const key of ENV_KEYS) {
    const value = originalEnv.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

it("detects Slack from explicit flags or Compose profiles", () => {
  expect(isSlackIntegrationEnabled()).toBe(false);

  process.env.SLACK_INTEGRATION_ENABLED = "yes";
  expect(isSlackIntegrationEnabled()).toBe(true);

  delete process.env.SLACK_INTEGRATION_ENABLED;
  process.env.COMPOSE_PROFILES = "rbac, slack-bot";
  expect(isSlackIntegrationEnabled()).toBe(true);
});

it("detects Webex from its flag, admin secret, or Compose profile", () => {
  expect(isWebexIntegrationEnabled()).toBe(false);

  process.env.WEBEX_INTEGRATION_ENABLED = "true";
  expect(isWebexIntegrationEnabled()).toBe(true);

  delete process.env.WEBEX_INTEGRATION_ENABLED;
  process.env.WEBEX_BOT_ADMIN_CLIENT_SECRET = "admin-secret";
  expect(isWebexIntegrationEnabled()).toBe(true);

  delete process.env.WEBEX_BOT_ADMIN_CLIENT_SECRET;
  process.env.COMPOSE_PROFILES = "webex-bot";
  expect(isWebexIntegrationEnabled()).toBe(true);
});

it("ignores placeholder Slack tokens and returns the configured alias", () => {
  process.env.SLACK_BOT_TOKEN = "<your-token>";
  process.env.SLACK_INTEGRATION_BOT_TOKEN = "slack-token";

  expect(getSlackIntegrationToken()).toBe("slack-token");
});

it("returns both surface flags from the shared availability helper", () => {
  process.env.SLACK_ADMIN_API_ENABLED = "true";
  process.env.WEBEX_INTEGRATION_ENABLED = "on";

  expect(getIntegrationAvailability()).toEqual({ slack: true, webex: true });
});

describe("isWebexIdentityLinkingEnabled", () => {
  it("is disabled when nothing is configured", () => {
    expect(isWebexIdentityLinkingEnabled()).toBe(false);
  });

  it("fails closed when the org allowlist is missing, even with client id/secret set", () => {
    process.env.WEBEX_LINK_CLIENT_ID = "client-id";
    process.env.WEBEX_LINK_CLIENT_SECRET = "client-secret";
    process.env.WEBEX_LINK_REDIRECT_URI = "http://localhost:3000/api/auth/webex-link/callback";

    expect(isWebexIdentityLinkingEnabled()).toBe(false);
  });

  it("is enabled only once every required var is set, and ignores placeholders", () => {
    process.env.WEBEX_LINK_CLIENT_ID = "<your-client-id>";
    process.env.WEBEX_LINK_CLIENT_SECRET = "client-secret";
    process.env.WEBEX_LINK_REDIRECT_URI = "http://localhost:3000/api/auth/webex-link/callback";
    process.env.WEBEX_LINK_ALLOWED_ORG_ID = "org-1";
    expect(isWebexIdentityLinkingEnabled()).toBe(false);

    process.env.WEBEX_LINK_CLIENT_ID = "client-id";
    expect(isWebexIdentityLinkingEnabled()).toBe(true);
  });

  it("defaults the link scopes and reads the org allowlist", () => {
    expect(getWebexLinkScopes()).toBe("spark:people_read");
    expect(getWebexLinkAllowedOrgId()).toBeNull();

    process.env.WEBEX_LINK_SCOPES = "spark:people_read spark:kms";
    process.env.WEBEX_LINK_ALLOWED_ORG_ID = "org-1";
    expect(getWebexLinkScopes()).toBe("spark:people_read spark:kms");
    expect(getWebexLinkAllowedOrgId()).toBe("org-1");
  });
});
