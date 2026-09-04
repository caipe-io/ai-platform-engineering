/**
 * CAIPE UI Configuration
 *
 * Architecture:
 *
 * Server-side (Node.js):
 *   getServerConfig() reads process.env at runtime and returns a full Config.
 *   Used by API routes, server components, and the root layout.
 *
 * Client-side (browser):
 *   The root layout (server component) calls getClientConfig(), serializes it
 *   as window.__APP_CONFIG__ via an inline <script> tag. Client code reads
 *   this synchronously — no fetch, no React Context, no loading state.
 *
 * Security:
 *   - Only explicitly allowlisted keys are sent to the browser (ClientConfig).
 *   - Server-only secrets (OIDC_CLIENT_SECRET, MONGODB_URI, etc.) never leave
 *     the server. There is no wildcard env var dump.
 *   - The JSON payload is XSS-safe (< is escaped to prevent script injection).
 *
 * Env var naming:
 *   Env vars use clean names (SSO_ENABLED, APP_NAME, etc.). The env() helper
 *   also checks NEXT_PUBLIC_ prefixed names for backward compatibility.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Client-safe configuration — only these fields are sent to the browser.
 * NEVER add secrets, credentials, or internal infrastructure details here.
 */
export interface Config {
  /** RAG Server URL for knowledge base operations */
  ragUrl: string;
  /** Whether we're in development mode */
  isDev: boolean;
  /** Whether we're in production mode */
  isProd: boolean;
  /** Whether SSO authentication is enabled */
  ssoEnabled: boolean;
  /** Whether RAG knowledge bases are enabled */
  ragEnabled: boolean;
  /** Whether MongoDB persistence is enabled */
  mongodbEnabled: boolean;
  /** Whether the credential subsystem (master switch) is enabled */
  credentialsEnabled: boolean;
  /** Whether the user-facing Credentials surface (nav + /credentials page) is enabled */
  userConnectionsEnabled: boolean;
  /** Main tagline displayed throughout the UI */
  tagline: string;
  /** Description text displayed throughout the UI */
  description: string;
  /** Application name displayed throughout the UI */
  appName: string;
  /** Logo URL (relative or absolute) */
  logoUrl: string;
  /** Environment badge label shown next to the app name (e.g. "Dev", "Preview", "Prod"). Empty string = hidden. */
  envBadge: string;
  /** Gradient start color (CSS color value) */
  gradientFrom: string;
  /** Gradient end color (CSS color value) */
  gradientTo: string;
  /** Logo style: "default" (original colors) or "white" (inverted) */
  logoStyle: 'default' | 'white';
  /** Spinner/loading indicator color (CSS color value) */
  spinnerColor: string | null;
  /** Whether to show "Powered by OSS caipe.io" footer */
  showPoweredBy: boolean;
  /** Support email address for contact links */
  supportEmail: string;
  /**
   * When true and SSO is disabled, show Admin tab without login (dev only).
   * Set ALLOW_DEV_ADMIN_WHEN_SSO_DISABLED=true. Do not use in production.
   */
  allowDevAdminWhenSsoDisabled: boolean;
  /**
   * Unsafe dev/emergency bypass for UI RBAC enforcement.
   * Client-visible so the header can show a compact no-auth indicator.
   */
  unsafeRbacBypassEnabled: boolean;
  /** Storage mode: 'mongodb' or 'localStorage' */
  storageMode: 'mongodb' | 'localStorage';
  /** Enabled integration icons on login page (comma-separated list, null = show all) */
  enabledIntegrationIcons: string[] | null;
  /** Favicon URL (relative or absolute) */
  faviconUrl: string;
  /** Documentation URL (hidden in header if not set) */
  docsUrl: string | null;
  /** Source code URL (hidden in header if not set) */
  sourceUrl: string | null;
  /**
   * Whether the dedicated workflow runner is enabled.
    * When false (default), multi-step skills display as "Skill" badges instead of
   * showing step counts. This controls workflow-related hints in the Skills Gallery only.
   * Set WORKFLOW_RUNNER_ENABLED=true to enable.
   */
  workflowRunnerEnabled: boolean;
  /**
   * Whether Workflows is shown in application navigation.
   * Set WORKFLOWS_ENABLED=true to enable.
   */
  workflowsEnabled: boolean;
  /** Whether the Projects surface is shown in application navigation. */
  projectsEnabled: boolean;
  /**
   * Whether Dynamic Agents should be considered enabled by platform health.
   * Set DYNAMIC_AGENTS_ENABLED=true to enable.
   */
  dynamicAgentsEnabled: boolean;
  /**
   * Whether the admin Feedback tab and feedback API are enabled.
   * Enabled by default. Set FEEDBACK_ENABLED=false to disable.
   */
  feedbackEnabled: boolean;
  /**
   * Whether built-in (`is_system: true`) skill rows can be edited /
   * deleted by users via the gallery & API.
   *
   * **Default: `false`** (locked). Built-ins are seeded by the
   * platform and treated as read-only — admins can clone them via
   * the gallery's "Clone" action to produce an editable copy.
   * Set ``ALLOW_BUILTIN_SKILL_MUTATION=true`` to restore the legacy
   * behaviour where any authenticated user could mutate a built-in
   * row.
   *
   * Server-side enforcement lives in
   * ``lib/builtin-skill-policy.ts`` + ``userCanModifyAgentSkill``;
   * this client-visible flag exists so the UI can disable the
   * Edit / Delete buttons without a roundtrip.
   */
  allowBuiltinSkillMutation: boolean;
  /**
   * Whether the admin audit logs feature is enabled.
   * When false (default), the Chat Audit tab is hidden and API routes return 403.
   * Set AUDIT_LOGS_ENABLED=true to enable.
   */
  auditLogsEnabled: boolean;
  /**
   * Whether the unified action audit log (auth + tool + delegation) is enabled.
   * Enabled by default. Set ACTION_AUDIT_ENABLED=false to disable.
   */
  actionAuditEnabled: boolean;
  /** Audit log emission backend. UI supports "service"; storage lives in audit-service. */
  auditLogBackend: string;
  /** Default font size for new users: "small" | "medium" | "large" | "x-large" */
  defaultFontSize: string;
  /** Default font family for new users: "inter" | "source-sans" | "ibm-plex" | "system" */
  defaultFontFamily: string;
  /** Default color theme: "light" | "legacy-light" | "dark" | "midnight" | "nord" | "tokyo" | "cyberpunk" | "tron" | "matrix" */
  defaultTheme: string;
  /** Default gradient theme: "default" | "minimal" | "professional" | "ocean" | "sunset" | "cyberpunk" | "tron" | "matrix" */
  defaultGradientTheme: string;
  /** Dynamic Agents server URL for custom agent chat */
  dynamicAgentsUrl: string;
  /** Whether autonomous task scheduling and webhook automation is enabled */
  autonomousAgentsEnabled: boolean;
  /** Whether the deployment-owned external Apps catalog is exposed */
  agenticAppsEnabled: boolean;
  /** Optional default agent ID used to edit scheduled jobs */
  scheduleEditorAgentId: string | null;
  /** Whether the scheduled-agent workflow is enabled */
  schedulerEnabled: boolean;
  /** Whether the Schedules navigation tab is limited to administrators */
  schedulerAdminOnly: boolean;
  /** Whether Jira ticket creation from feedback/report is enabled */
  jiraTicketEnabled: boolean;
  /** Jira project key for ticket creation (e.g., "OPENSD") */
  jiraTicketProject: string | null;
  /** Custom label applied to Jira tickets for filtering (e.g., "caipe-reported") */
  jiraTicketLabel: string;
  /** Whether GitHub issue creation from feedback/report is enabled */
  githubTicketEnabled: boolean;
  /** GitHub repository for issue creation (e.g., "org/repo") */
  githubTicketRepo: string | null;
  /** Custom label applied to GitHub issues for filtering (e.g., "caipe-reported") */
  githubTicketLabel: string;
  /**
   * Streaming protocol used by agent servers: "custom" (default) or "agui".
   * Controls the ?protocol= query param sent to the backend streaming endpoints.
   * Set AGENT_PROTOCOL=agui to switch to AG-UI wire format.
   */
  agentProtocol: 'custom' | 'agui';
  /**
   * Whether the "Report a Problem" button is shown in the header and feedback dialog.
   * Enabled by default. Set REPORT_PROBLEM_ENABLED=false to disable.
   * When ticketEnabled is also true, reports are routed to the configured ticket provider.
   * When ticketEnabled is false, the dialog still opens but cannot create tickets.
   */
  reportProblemEnabled: boolean;
  /**
   * Whether the compact "Provide Feedback" shortcut is shown in the app header.
   * Disabled by default. Set PROVIDE_FEEDBACK_ENABLED=true to enable it.
   */
  provideFeedbackEnabled: boolean;
  /** Derived: true if either Jira or GitHub ticket creation is enabled */
  ticketEnabled: boolean;
  /** Derived: which provider to use ('jira' takes precedence when both enabled) */
  ticketProvider: 'jira' | 'github' | null;
  /** When true, server extracts user context from JWT — UI should NOT prefix messages with user email */
  userInfoToolEnabled: boolean;
  /** OIDC group required for UI access (injected server-side so the unauthorized page shows the real group) */
  oidcRequiredGroup: string;
  /**
   * Whether Okta background sync is enabled.
   * Derived server-side: true when IDENTITY_SYNC_OKTA_ORG_URL is set AND either
   * an SSWS API token (IDENTITY_SYNC_OKTA_API_TOKEN) or OAuth2 private-key JWT
   * credentials (IDENTITY_SYNC_OKTA_OAUTH_CLIENT_ID + _PRIVATE_KEY) are present.
   * Controls the Identity Sync tab in Admin > Teams & Users.
   */
  oktaSyncEnabled: boolean;
}

// ---------------------------------------------------------------------------
// Defaults (single source of truth)
// ---------------------------------------------------------------------------

const DEFAULT_TAGLINE = 'Multi-Agent Workflow Automation';
const DEFAULT_DESCRIPTION = 'Where Humans and AI agents collaborate to deliver high quality outcomes.';
const DEFAULT_APP_NAME = 'CAIPE';
const DEFAULT_LOGO_URL = '/logo.svg';
const DEFAULT_GRADIENT_FROM = 'hsl(173,80%,40%)';
const DEFAULT_GRADIENT_TO = 'hsl(270,75%,60%)';
const DEFAULT_SUPPORT_EMAIL = 'support@example.com';
const DEFAULT_FONT_SIZE = 'medium';
const DEFAULT_FONT_FAMILY = 'inter';
const DEFAULT_THEME = 'dark';
const DEFAULT_GRADIENT_THEME = 'default';
const VALID_FONT_SIZES = ['small', 'medium', 'large', 'x-large'];
const VALID_FONT_FAMILIES = ['inter', 'source-sans', 'ibm-plex', 'system'];
const VALID_THEMES = ['light', 'legacy-light', 'dark', 'system', 'midnight', 'nord', 'tokyo', 'cyberpunk', 'tron', 'matrix'];
const VALID_GRADIENT_THEMES = ['default', 'minimal', 'professional', 'ocean', 'sunset', 'cyberpunk', 'tron', 'matrix'];

/** Default config used as client fallback before the layout script executes. */
const DEFAULT_CONFIG: Config = {
  ragUrl: 'http://localhost:9446',
  isDev: false,
  isProd: false,
  ssoEnabled: false,
  ragEnabled: true,
  mongodbEnabled: false,
  credentialsEnabled: false,
  userConnectionsEnabled: false,
  tagline: DEFAULT_TAGLINE,
  description: DEFAULT_DESCRIPTION,
  appName: DEFAULT_APP_NAME,
  logoUrl: DEFAULT_LOGO_URL,
  envBadge: '',
  gradientFrom: DEFAULT_GRADIENT_FROM,
  gradientTo: DEFAULT_GRADIENT_TO,
  logoStyle: 'default',
  spinnerColor: null,
  showPoweredBy: true,
  supportEmail: DEFAULT_SUPPORT_EMAIL,
  allowDevAdminWhenSsoDisabled: false,
  unsafeRbacBypassEnabled: false,
  storageMode: 'localStorage',
  enabledIntegrationIcons: null,
  faviconUrl: '/favicon.ico',
  docsUrl: null,
  sourceUrl: null,
  workflowRunnerEnabled: false,
  workflowsEnabled: false,
  projectsEnabled: false,
  dynamicAgentsEnabled: false,
  feedbackEnabled: true,
  allowBuiltinSkillMutation: false,
  auditLogsEnabled: false,
  actionAuditEnabled: true,
  auditLogBackend: 'service',
  defaultFontSize: DEFAULT_FONT_SIZE,
  defaultFontFamily: DEFAULT_FONT_FAMILY,
  defaultTheme: DEFAULT_THEME,
  defaultGradientTheme: DEFAULT_GRADIENT_THEME,
  dynamicAgentsUrl: 'http://localhost:8100',
  autonomousAgentsEnabled: false,
  agenticAppsEnabled: false,
  scheduleEditorAgentId: null,
  schedulerEnabled: false,
  schedulerAdminOnly: false,
  agentProtocol: 'agui',
  reportProblemEnabled: true,
  provideFeedbackEnabled: false,
  jiraTicketEnabled: false,
  jiraTicketProject: null,
  jiraTicketLabel: 'caipe-reported',
  githubTicketEnabled: false,
  githubTicketRepo: null,
  githubTicketLabel: 'caipe-reported',
  ticketEnabled: false,
  ticketProvider: null,
  userInfoToolEnabled: false,
  oidcRequiredGroup: '',
  oktaSyncEnabled: false,
};

// ---------------------------------------------------------------------------
// Server-side config (reads process.env)
// ---------------------------------------------------------------------------

/**
 * Read an env var by clean name, falling back to NEXT_PUBLIC_ prefix
 * for backward compatibility.
 */
function env(name: string): string | undefined {
  return process.env[name] || process.env[`NEXT_PUBLIC_${name}`] || undefined;
}

const ENABLED_VALUES = new Set(['1', 'true', 'yes', 'on']);

function enabledEnv(name: string): boolean {
  const raw = env(name)?.trim().toLowerCase();
  return raw ? ENABLED_VALUES.has(raw) : false;
}

/**
 * Server-only config values that must NEVER be sent to the browser.
 * Access via getServerOnlyConfig().
 */
export interface ServerOnlyConfig {
  prometheusUrl: string | null;
}

let _serverOnlyConfig: ServerOnlyConfig | null = null;

export function getServerOnlyConfig(): ServerOnlyConfig {
  if (_serverOnlyConfig) return _serverOnlyConfig;
  _serverOnlyConfig = {
    prometheusUrl: env('PROMETHEUS_URL') || null,
  };
  return _serverOnlyConfig;
}

/** Return value if it's in the allowed list, otherwise return fallback. */
function validated(value: string | undefined, allowed: string[], fallback: string): string {
  return value && allowed.includes(value) ? value : fallback;
}

/**
 * assisted-by Codex Codex-sonnet-4-6
 * Returns the internal server-side URL for the chat runtime.
 *
 * Use this in API routes that proxy or probe the runtime. It resolves to the
 * Docker-internal dynamic-agents service when configured, falling back to the
 * legacy supervisor URL for older deployments.
 *
 * MUST only be called on the server (Node.js runtime).
 */
export function getInternalA2AUrl(): string {
  return (env('A2A_BASE_URL') || env('DYNAMIC_AGENTS_URL') || 'http://caipe-supervisor:8000').replace(/\/$/, '');
}

/**
 * Build the full Config from server-side process.env.
 *
 * MUST only be called on the server (Node.js runtime).
 */
export function getServerConfig(): Config {
  const isProduction = process.env.NODE_ENV === 'production';
  const isDev = process.env.NODE_ENV === 'development';

  const ragUrl = env('RAG_URL')
    || process.env.RAG_SERVER_URL
    || (isProduction ? 'http://rag-server:9446' : 'http://localhost:9446');

  const ssoEnabled = env('SSO_ENABLED') === 'true';
  const ragEnabled = env('RAG_ENABLED') !== 'false';
  const mongodbEnabled = !!(process.env.MONGODB_URI && process.env.MONGODB_DATABASE)
    || env('MONGODB_ENABLED') === 'true';
  const envBadge = env('ENV_BADGE')
    || (env('PREVIEW_MODE') === 'true' ? 'Preview' : '');
  const allowDevAdminWhenSsoDisabled = env('ALLOW_DEV_ADMIN_WHEN_SSO_DISABLED') === 'true';
  const unsafeRbacBypassEnabled = enabledEnv('CAIPE_UNSAFE_RBAC_BYPASS');
  const workflowRunnerEnabled = env('WORKFLOW_RUNNER_ENABLED') === 'true';
  const workflowsEnabled = env('WORKFLOWS_ENABLED') === 'true';
  const projectsEnabled = env('PROJECTS_ENABLED') === 'true';
  const dynamicAgentsEnabled = env('DYNAMIC_AGENTS_ENABLED') === 'true';
  const feedbackEnabled = env('FEEDBACK_ENABLED') !== 'false';
  // Default `false` (locked). Must mirror the server-side check in
  // `lib/builtin-skill-policy.ts` so the UI never offers an action
  // the API will reject.
  const allowBuiltinSkillMutation = env('ALLOW_BUILTIN_SKILL_MUTATION') === 'true';
  const auditLogsEnabled = env('AUDIT_LOGS_ENABLED') === 'true';
  const actionAuditEnabled = env('ACTION_AUDIT_ENABLED') !== 'false';
  const auditLogBackend = env('AUDIT_LOG_BACKEND') || 'service';
  const credentialsEnabled = env('CAIPE_CREDENTIALS_ENABLED') === 'true';
  // The user-facing Credentials surface is gated independently of the SA token
  // surface. It defaults to the master flag (backward-compatible) and can be
  // explicitly turned off with CAIPE_USER_CONNECTIONS_ENABLED=false. Mirrors
  // subFeatureEnabled() in feature-flags/credentials.ts (kept inline here so
  // config.ts stays free of server-only imports for the client bundle).
  // Match subFeatureEnabled's parsing exactly — trim + lowercase, so a value
  // like " true" doesn't diverge between the two sources of truth.
  const userConnectionsRaw = env('CAIPE_USER_CONNECTIONS_ENABLED')?.trim().toLowerCase();
  const userConnectionsEnabled =
    credentialsEnabled &&
    (userConnectionsRaw === undefined ? true : userConnectionsRaw === 'true');
  const userInfoToolEnabled = env('ENABLE_USER_INFO_TOOL') === 'true';

  // Enabled when an org URL is set AND we have credentials in EITHER mode:
  // SSWS API token, or OAuth2 private-key JWT (client id + private key). Kept
  // in sync with isOktaConnectorConfigured() in okta-directory-connector.ts.
  const oktaSyncEnabled = !!(
    process.env.IDENTITY_SYNC_OKTA_ORG_URL?.trim() &&
    (process.env.IDENTITY_SYNC_OKTA_API_TOKEN?.trim() ||
      (process.env.IDENTITY_SYNC_OKTA_OAUTH_CLIENT_ID?.trim() &&
        process.env.IDENTITY_SYNC_OKTA_OAUTH_PRIVATE_KEY?.trim()))
  );
  const autonomousAgentsFlag =
    env('ENABLE_AUTONOMOUS_AGENTS') ?? env('AUTONOMOUS_AGENTS_ENABLED');
  const autonomousAgentsEnabled = autonomousAgentsFlag === 'true';
  const agenticAppsEnabled = env('AGENTIC_APPS_INSTALL_ENABLED') === 'true';

  const dynamicAgentsUrl = env('DYNAMIC_AGENTS_URL')
    || (isProduction ? 'http://dynamic-agents:8100' : 'http://localhost:8100');

  const agentProtocolEnv = env('AGENT_PROTOCOL');
  const agentProtocol: 'custom' | 'agui' = agentProtocolEnv === 'custom' ? 'custom' : 'agui';

  const reportProblemEnabled = env('REPORT_PROBLEM_ENABLED') !== 'false';
  const provideFeedbackEnabled = env('PROVIDE_FEEDBACK_ENABLED') === 'true';
  const jiraTicketEnabled = env('JIRA_TICKET_ENABLED') === 'true';
  const jiraTicketProject = env('JIRA_TICKET_PROJECT') || null;
  const jiraTicketLabel = env('JIRA_TICKET_LABEL') || 'caipe-reported';
  const githubTicketEnabled = env('GITHUB_TICKET_ENABLED') === 'true';
  const githubTicketRepo = env('GITHUB_TICKET_REPO') || null;
  const githubTicketLabel = env('GITHUB_TICKET_LABEL') || 'caipe-reported';
  const ticketEnabled = jiraTicketEnabled || githubTicketEnabled;
  const ticketProvider: 'jira' | 'github' | null = jiraTicketEnabled ? 'jira' : githubTicketEnabled ? 'github' : null;

  const showPoweredByEnv = env('SHOW_POWERED_BY');
  const showPoweredBy = showPoweredByEnv !== undefined ? showPoweredByEnv !== 'false' : true;

  const logoStyleEnv = env('LOGO_STYLE');
  const logoStyle: 'default' | 'white' = logoStyleEnv === 'white' ? 'white' : 'default';

  return {
    ragUrl,
    isDev,
    isProd: isProduction,
    ssoEnabled,
    ragEnabled,
    mongodbEnabled,
    credentialsEnabled,
    userConnectionsEnabled,
    tagline: env('TAGLINE') || DEFAULT_TAGLINE,
    description: env('DESCRIPTION') || DEFAULT_DESCRIPTION,
    appName: env('APP_NAME') || DEFAULT_APP_NAME,
    logoUrl: env('LOGO_URL') || DEFAULT_LOGO_URL,
    envBadge,
    gradientFrom: env('GRADIENT_FROM') || DEFAULT_GRADIENT_FROM,
    gradientTo: env('GRADIENT_TO') || DEFAULT_GRADIENT_TO,
    logoStyle,
    spinnerColor: env('SPINNER_COLOR') || null,
    showPoweredBy,
    supportEmail: env('SUPPORT_EMAIL') || DEFAULT_SUPPORT_EMAIL,
    allowDevAdminWhenSsoDisabled,
    unsafeRbacBypassEnabled,
    storageMode: mongodbEnabled ? 'mongodb' : 'localStorage',
    enabledIntegrationIcons: env('ENABLED_INTEGRATION_ICONS')?.split(',').map((icon) => icon.trim().toLowerCase()) ?? null,
    faviconUrl: env('FAVICON_URL') || '/favicon.ico',
    docsUrl: env('DOCS_URL') || null,
    sourceUrl: env('SOURCE_URL') || null,
    workflowRunnerEnabled,
    workflowsEnabled,
    projectsEnabled,
    dynamicAgentsEnabled,
    feedbackEnabled,
    allowBuiltinSkillMutation,
    auditLogsEnabled,
    actionAuditEnabled,
    auditLogBackend,
    defaultFontSize: validated(env('DEFAULT_FONT_SIZE'), VALID_FONT_SIZES, DEFAULT_FONT_SIZE),
    defaultFontFamily: validated(env('DEFAULT_FONT_FAMILY'), VALID_FONT_FAMILIES, DEFAULT_FONT_FAMILY),
    defaultTheme: validated(env('DEFAULT_THEME'), VALID_THEMES, DEFAULT_THEME),
    defaultGradientTheme: validated(env('DEFAULT_GRADIENT_THEME'), VALID_GRADIENT_THEMES, DEFAULT_GRADIENT_THEME),
    dynamicAgentsUrl,
    autonomousAgentsEnabled,
    agenticAppsEnabled,
    scheduleEditorAgentId: env('SCHEDULE_EDITOR_AGENT_ID') || null,
    schedulerEnabled: env('SCHEDULER_ENABLED') === 'true',
    schedulerAdminOnly: env('SCHEDULER_ADMIN_ONLY') === 'true',
    agentProtocol,
    reportProblemEnabled,
    provideFeedbackEnabled,
    jiraTicketEnabled,
    jiraTicketProject,
    jiraTicketLabel,
    githubTicketEnabled,
    githubTicketRepo,
    githubTicketLabel,
    ticketEnabled,
    ticketProvider,
    userInfoToolEnabled,
    oidcRequiredGroup: process.env.OIDC_REQUIRED_GROUP ?? DEFAULT_CONFIG.oidcRequiredGroup,
    oktaSyncEnabled,
  };
}

/**
 * Get the client-safe config as an XSS-safe JSON string.
 *
 * Called by the root layout to inject into <script>. Escapes < to \u003c
 * so a malicious env var value cannot break out of the script tag.
 */
export function getClientConfigScript(): string {
  const cfg = getServerConfig();
  return JSON.stringify(cfg).replace(/</g, '\\u003c');
}

// ---------------------------------------------------------------------------
// Universal config accessors (work on both server and client)
// ---------------------------------------------------------------------------

/**
 * Read the client config object from window.__APP_CONFIG__.
 * Returns DEFAULT_CONFIG as fallback if not yet injected.
 */
function getClientAppConfig(): Config {
  if (typeof window !== 'undefined') {
    const w = window as unknown as { __APP_CONFIG__?: Config };
    if (w.__APP_CONFIG__) return w.__APP_CONFIG__;
  }
  return DEFAULT_CONFIG;
}

/**
 * Get a single config value by key.
 *
 * - Server: reads process.env via getServerConfig().
 * - Client: reads window.__APP_CONFIG__ (injected by root layout).
 *
 * This is the primary API for all config access throughout the app.
 */
export function getConfig<K extends keyof Config>(key: K): Config[K] {
  if (typeof window !== 'undefined') {
    return getClientAppConfig()[key];
  }
  return getServerConfig()[key];
}

/**
 * Full config object.
 *
 * - Server: populated at module load time from process.env.
 * - Client: Proxy that reads from window.__APP_CONFIG__ on each access.
 */
export const config: Config = typeof window === 'undefined'
  ? getServerConfig()
  : new Proxy(DEFAULT_CONFIG, {
      get(_target, prop: string) {
        return getClientAppConfig()[prop as keyof Config];
      },
    });

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

/**
 * Get the CSS class for the logo based on logoStyle.
 * Pass the style explicitly, or omit to read from current config.
 */
export function getLogoFilterClass(style?: 'default' | 'white'): string {
  const s = style ?? getConfig('logoStyle');
  return s === 'white' ? 'brightness-0 invert' : '';
}

export default config;
