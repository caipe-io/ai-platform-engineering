const ENABLED_VALUES = new Set(["1", "true", "yes", "on"]);

function envValue(name: string): string | null {
  const value = process.env[name]?.trim();
  if (!value || value.startsWith("#")) return null;
  if (value.startsWith("<") && value.endsWith(">")) return null;
  if (value.toLowerCase().includes("your-")) return null;
  return value;
}

function envEnabled(name: string): boolean {
  const value = envValue(name)?.toLowerCase();
  return value ? ENABLED_VALUES.has(value) : false;
}

function hasComposeProfile(...profileNames: string[]): boolean {
  const profiles = new Set(
    (process.env.COMPOSE_PROFILES ?? "")
      .split(",")
      .map((profile) => profile.trim())
      .filter(Boolean),
  );
  return profileNames.some((profile) => profiles.has(profile));
}

export function getSlackIntegrationToken(): string | null {
  return envValue("SLACK_BOT_TOKEN") ?? envValue("SLACK_INTEGRATION_BOT_TOKEN");
}

export function isSlackIntegrationEnabled(): boolean {
  return (
    envEnabled("SLACK_INTEGRATION_ENABLED") ||
    envEnabled("SLACK_ADMIN_API_ENABLED") ||
    envEnabled("SLACK_BOT_ADMIN_DEV_AUTH_ENABLED") ||
    hasComposeProfile("slack-bot", "all-integrations")
  );
}

export function isWebexIntegrationEnabled(): boolean {
  return (
    envEnabled("WEBEX_INTEGRATION_ENABLED") ||
    Boolean(envValue("WEBEX_BOT_ADMIN_CLIENT_SECRET")) ||
    Boolean(envValue("KEYCLOAK_WEBEX_BOT_ADMIN_CLIENT_SECRET")) ||
    hasComposeProfile("webex-bot", "all-integrations")
  );
}

export interface IntegrationAvailability {
  slack: boolean;
  webex: boolean;
}

export function getIntegrationAvailability(): IntegrationAvailability {
  return {
    slack: isSlackIntegrationEnabled(),
    webex: isWebexIntegrationEnabled(),
  };
}

const WEBEX_LINK_DEFAULT_SCOPES = "spark:people_read";

// Requires the org allowlist too: without it the callback can't enforce
// that a linked Webex account actually belongs to this org, so the
// feature must stay off rather than accept any Webex account.
export function isWebexIdentityLinkingEnabled(): boolean {
  return (
    Boolean(envValue("WEBEX_LINK_CLIENT_ID")) &&
    Boolean(envValue("WEBEX_LINK_CLIENT_SECRET")) &&
    Boolean(envValue("WEBEX_LINK_REDIRECT_URI")) &&
    Boolean(envValue("WEBEX_LINK_ALLOWED_ORG_ID"))
  );
}

export function getWebexLinkScopes(): string {
  return envValue("WEBEX_LINK_SCOPES") ?? WEBEX_LINK_DEFAULT_SCOPES;
}

export function getWebexLinkAllowedOrgId(): string | null {
  return envValue("WEBEX_LINK_ALLOWED_ORG_ID");
}
