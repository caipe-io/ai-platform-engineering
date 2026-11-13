export interface BuiltInOAuthConnectorDescriptor {
  provider: "amplitude" | "atlassian" | "figma" | "github" | "gitlab" | "linear" | "notion" | "pagerduty" | "webex";
  name: string;
  authorizationUrl: string;
  tokenUrl: string;
  scopes: string[];
  pkce?: boolean;
}

export const BUILT_IN_OAUTH_CONNECTORS: BuiltInOAuthConnectorDescriptor[] = [
  {
    provider: "amplitude",
    name: "Amplitude",
    authorizationUrl: "https://app.amplitude.com/oauth2/authorize",
    tokenUrl: "https://app.amplitude.com/oauth2/token",
    scopes: ["read:user", "read:chart", "read:dashboard"],
    pkce: true,
  },
  {
    provider: "github",
    name: "GitHub",
    authorizationUrl: "https://github.com/login/oauth/authorize",
    tokenUrl: "https://github.com/login/oauth/access_token",
    scopes: ["repo", "read:user"],
  },
  {
    provider: "atlassian",
    name: "Atlassian Cloud",
    authorizationUrl: "https://auth.atlassian.com/authorize",
    tokenUrl: "https://auth.atlassian.com/oauth/token",
    // Jira `/rest/api/3/myself` (get_current_user_account_id) needs read:jira-user
    // (read:me is the Atlassian account endpoint, not the Jira user endpoint).
    // write:* scopes back the MCP create/update issue, comment, and attachment tools.
    scopes: [
      "offline_access",
      "read:me",
      "read:jira-work",
      "read:jira-user",
      "write:jira-work",
      "read:confluence-content.all",
      "read:confluence-content.summary",
      "read:confluence-space.summary",
      "read:confluence-user",
      "readonly:content.attachment:confluence",
      "search:confluence",
      "write:confluence-content",
    ],
  },
  {
    provider: "webex",
    name: "Webex",
    authorizationUrl: "https://webexapis.com/v1/authorize",
    tokenUrl: "https://webexapis.com/v1/access_token",
    scopes: [
      "spark:kms",
      "spark:people_read",
      "meeting:recordings_read",
      "identity:people_read",
      "spark:messages_read",
      "spark:mcp",
      "spark-admin:people_read",
    ],
  },
  {
    provider: "pagerduty",
    name: "PagerDuty",
    authorizationUrl: "https://identity.pagerduty.com/oauth/authorize",
    tokenUrl: "https://identity.pagerduty.com/oauth/token",
    scopes: [
      "users.read",
      "incidents.read",
      "services.read",
      "oncalls.read",
      "schedules.read",
      "teams.read",
      "escalation_policies.read",
    ],
  },
  {
    provider: "gitlab",
    name: "GitLab",
    authorizationUrl: "https://gitlab.com/oauth/authorize",
    tokenUrl: "https://gitlab.com/oauth/token",
    scopes: ["api", "read_user"],
  },
  {
    provider: "figma",
    name: "Figma",
    authorizationUrl: "https://www.figma.com/oauth",
    tokenUrl: "https://www.figma.com/api/oauth/token",
    scopes: ["file_content"],
  },
  {
    provider: "linear",
    name: "Linear",
    authorizationUrl: "https://linear.app/oauth/authorize",
    tokenUrl: "https://api.linear.app/oauth/token",
    scopes: ["read"],
  },
  {
    provider: "notion",
    name: "Notion",
    authorizationUrl: "https://api.notion.com/v1/oauth/authorize",
    tokenUrl: "https://api.notion.com/v1/oauth/token",
    scopes: [],
  },
];
