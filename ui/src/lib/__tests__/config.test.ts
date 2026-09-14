/**
 * Tests for the config system
 *
 * Architecture under test:
 *   Server-side: getServerConfig() reads process.env → returns Config.
 *   Client-side: window.__APP_CONFIG__ injected by root layout <script>.
 *   Universal:   getConfig(key) and `config` export work in both environments.
 *   Security:    getClientConfigScript() XSS-escapes the JSON payload.
 *
 * Test strategy:
 *   - Server tests: manipulate process.env, call getServerConfig().
 *   - Client tests: set window.__APP_CONFIG__, call getConfig() / config.
 *   - Security tests: inject malicious env var values, verify XSS escaping.
 *   - Edge cases: empty strings, undefined, partial config, type coercion.
 */

import {
  getServerConfig,
  getConfig,
  getLogoFilterClass,
  getClientConfigScript,
  config,
} from '../config';
import type { Config } from '../config';

// ==========================================================================
// Helpers
// ==========================================================================

/** Typed accessor for window.__APP_CONFIG__ */
const getWindowConfig = () =>
  (window as unknown as { __APP_CONFIG__?: Config }).__APP_CONFIG__;

const setWindowConfig = (cfg: Config | undefined) => {
  (window as unknown as { __APP_CONFIG__?: Config }).__APP_CONFIG__ = cfg;
};

/** Clean env helper: delete both prefixed and non-prefixed versions */
function clearEnv(...names: string[]) {
  for (const name of names) {
    delete process.env[name];
    delete process.env[`NEXT_PUBLIC_${name}`];
  }
}

// ==========================================================================
// Server-Side Tests (getServerConfig)
// ==========================================================================

describe('getServerConfig', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    jest.resetModules();
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  // ---------- Default values ----------

  describe('defaults (no env vars set)', () => {
    beforeEach(() => {
      // Clear ALL env vars that the config reads
      clearEnv(
        'RAG_URL', 'SSO_ENABLED', 'RAG_ENABLED',
        'MONGODB_ENABLED', 'PREVIEW_MODE', 'ENV_BADGE',
        'ALLOW_DEV_ADMIN_WHEN_SSO_DISABLED', 'SHOW_POWERED_BY',
        'LOGO_STYLE', 'SPINNER_COLOR', 'TAGLINE', 'DESCRIPTION',
        'APP_NAME', 'LOGO_URL', 'GRADIENT_FROM', 'GRADIENT_TO',
        'SUPPORT_EMAIL', 'FEEDBACK_ENABLED', 'AUDIT_LOGS_ENABLED',
        'ACTION_AUDIT_ENABLED',
        'CAIPE_UNSAFE_RBAC_BYPASS',
        'DEFAULT_FONT_SIZE', 'DEFAULT_FONT_FAMILY',
        'DEFAULT_THEME', 'DEFAULT_GRADIENT_THEME',
        'AUTONOMOUS_AGENTS_ENABLED', 'ENABLE_AUTONOMOUS_AGENTS',
        'PROJECTS_ENABLED',
        'PROVIDE_FEEDBACK_ENABLED',
      );
      delete process.env.MONGODB_URI;
      delete process.env.MONGODB_DATABASE;
      delete process.env.RAG_SERVER_URL;
    });

    it('should return all expected default values', () => {
      const cfg = getServerConfig();

      expect(cfg.ragUrl).toBe('http://localhost:9446');
      expect(cfg.isDev).toBe(false);
      expect(cfg.isProd).toBe(false);
      expect(cfg.ssoEnabled).toBe(false);
      expect(cfg.ragEnabled).toBe(true); // default true
      expect(cfg.feedbackEnabled).toBe(true); // default true
      expect(cfg.mongodbEnabled).toBe(false);
      expect(cfg.credentialsEnabled).toBe(false);
      expect(cfg.tagline).toBe('Multi-Agent Workflow Automation');
      expect(cfg.description).toBe(
        'Where Humans and AI agents collaborate to deliver high quality outcomes.',
      );
      expect(cfg.appName).toBe('CAIPE');
      expect(cfg.logoUrl).toBe('/logo.svg');
      expect(cfg.envBadge).toBe('');
      expect(cfg.gradientFrom).toBe('hsl(173,80%,40%)');
      expect(cfg.gradientTo).toBe('hsl(270,75%,60%)');
      expect(cfg.logoStyle).toBe('default');
      expect(cfg.spinnerColor).toBeNull();
      expect(cfg.showPoweredBy).toBe(true);
      expect(cfg.supportEmail).toBe('support@example.com');
      expect(cfg.allowDevAdminWhenSsoDisabled).toBe(false);
      expect(cfg.unsafeRbacBypassEnabled).toBe(false);
      expect(cfg.auditLogsEnabled).toBe(false);
      expect(cfg.autonomousAgentsEnabled).toBe(false);
      expect(cfg.actionAuditEnabled).toBe(true);
      expect(cfg.storageMode).toBe('localStorage');
    });

    it('should return default personalization values', () => {
      const cfg = getServerConfig();
      expect(cfg.defaultFontSize).toBe('medium');
      expect(cfg.defaultFontFamily).toBe('inter');
      expect(cfg.defaultTheme).toBe('dark');
      expect(cfg.defaultGradientTheme).toBe('default');
    });

    it('should return default ticket integration values', () => {
      const cfg = getServerConfig();
      expect(cfg.reportProblemEnabled).toBe(true);
      expect(cfg.provideFeedbackEnabled).toBe(false);
      expect(cfg.jiraTicketEnabled).toBe(false);
      expect(cfg.jiraTicketProject).toBeNull();
      expect(cfg.jiraTicketLabel).toBe('caipe-reported');
      expect(cfg.githubTicketEnabled).toBe(false);
      expect(cfg.githubTicketRepo).toBeNull();
      expect(cfg.githubTicketLabel).toBe('caipe-reported');
      expect(cfg.ticketEnabled).toBe(false);
      expect(cfg.ticketProvider).toBeNull();
    });

    it('should have exactly the expected Config keys (no extras)', () => {
      const cfg = getServerConfig();
      const expectedKeys: (keyof Config)[] = [
        'agentProtocol',
        'ragUrl', 'isDev', 'isProd', 'ssoEnabled',
        'ragEnabled', 'mongodbEnabled', 'credentialsEnabled', 'userConnectionsEnabled',
        'tagline', 'description', 'appName', 'logoUrl', 'envBadge',
        'gradientFrom', 'gradientTo', 'logoStyle', 'spinnerColor',
        'showPoweredBy', 'supportEmail', 'allowDevAdminWhenSsoDisabled', 'unsafeRbacBypassEnabled',
        'storageMode', 'enabledIntegrationIcons', 'faviconUrl',
        'docsUrl', 'sourceUrl', 'workflowRunnerEnabled', 'workflowsEnabled', 'projectsEnabled', 'dynamicAgentsEnabled', 'feedbackEnabled',
        'allowBuiltinSkillMutation',
        'auditLogsEnabled',
        'actionAuditEnabled',
        'auditLogBackend',
        'defaultFontSize', 'defaultFontFamily', 'defaultTheme', 'defaultGradientTheme',
        'dynamicAgentsUrl',
        'autonomousAgentsEnabled',
        'agenticAppsEnabled',
        'reportProblemEnabled',
        'provideFeedbackEnabled',
        'jiraTicketEnabled', 'jiraTicketProject', 'jiraTicketLabel',
        'githubTicketEnabled', 'githubTicketRepo', 'githubTicketLabel',
        'ticketEnabled', 'ticketProvider',
        'userInfoToolEnabled',
        'oidcRequiredGroup',
        'oktaSyncEnabled',
        'scheduleEditorAgentId',
        'schedulerAdminOnly',
        'schedulerEnabled',
      ];
      expect(Object.keys(cfg).sort()).toEqual(expectedKeys.sort());
    });
  });

  describe('projectsEnabled', () => {
    beforeEach(() => clearEnv('PROJECTS_ENABLED'));

    it('should default to false', () => {
      expect(getServerConfig().projectsEnabled).toBe(false);
    });

    it('should be true when PROJECTS_ENABLED=true', () => {
      process.env.PROJECTS_ENABLED = 'true';
      expect(getServerConfig().projectsEnabled).toBe(true);
    });

    it('should remain false for non-true values', () => {
      process.env.PROJECTS_ENABLED = '1';
      expect(getServerConfig().projectsEnabled).toBe(false);
    });
  });

  // ---------- Custom env vars (new names) ----------

  describe('custom env vars (clean names)', () => {
    it('should read SSO_ENABLED=true', () => {
      process.env.SSO_ENABLED = 'true';
      expect(getServerConfig().ssoEnabled).toBe(true);
    });

    it('should read AUTONOMOUS_AGENTS_ENABLED=true', () => {
      process.env.AUTONOMOUS_AGENTS_ENABLED = 'true';
      expect(getServerConfig().autonomousAgentsEnabled).toBe(true);
    });

    it('should read ENABLE_AUTONOMOUS_AGENTS=true as a compose-friendly alias', () => {
      process.env.ENABLE_AUTONOMOUS_AGENTS = 'true';
      expect(getServerConfig().autonomousAgentsEnabled).toBe(true);
    });

    it('should let ENABLE_AUTONOMOUS_AGENTS=false override the legacy UI alias', () => {
      process.env.ENABLE_AUTONOMOUS_AGENTS = 'false';
      process.env.AUTONOMOUS_AGENTS_ENABLED = 'true';
      expect(getServerConfig().autonomousAgentsEnabled).toBe(false);
    });

    it('should read CAIPE_CREDENTIALS_ENABLED=true', () => {
      process.env.CAIPE_CREDENTIALS_ENABLED = 'true';
      expect(getServerConfig().credentialsEnabled).toBe(true);
    });

    it('should treat SSO_ENABLED=false as false', () => {
      process.env.SSO_ENABLED = 'false';
      expect(getServerConfig().ssoEnabled).toBe(false);
    });

    it('should treat SSO_ENABLED=1 as false (strict true check)', () => {
      process.env.SSO_ENABLED = '1';
      expect(getServerConfig().ssoEnabled).toBe(false);
    });

    it('should read RAG_URL', () => {
      process.env.RAG_URL = 'https://rag.internal:9446';
      expect(getServerConfig().ragUrl).toBe('https://rag.internal:9446');
    });

    it('should fall back to RAG_SERVER_URL', () => {
      clearEnv('RAG_URL');
      process.env.RAG_SERVER_URL = 'https://legacy-rag:9446';
      expect(getServerConfig().ragUrl).toBe('https://legacy-rag:9446');
    });

    it('should read APP_NAME', () => {
      process.env.APP_NAME = 'Grid';
      expect(getServerConfig().appName).toBe('Grid');
    });

    it('should read LOGO_URL', () => {
      process.env.LOGO_URL = '/grid-neon-logo.svg';
      expect(getServerConfig().logoUrl).toBe('/grid-neon-logo.svg');
    });

    it('should read TAGLINE', () => {
      process.env.TAGLINE = 'Custom Tagline';
      expect(getServerConfig().tagline).toBe('Custom Tagline');
    });

    it('should read DESCRIPTION', () => {
      process.env.DESCRIPTION = 'A custom description for testing.';
      expect(getServerConfig().description).toBe('A custom description for testing.');
    });

    it('should read ENV_BADGE', () => {
      process.env.ENV_BADGE = 'Staging';
      expect(getServerConfig().envBadge).toBe('Staging');
    });

    it('should fall back PREVIEW_MODE=true to envBadge "Preview"', () => {
      process.env.PREVIEW_MODE = 'true';
      expect(getServerConfig().envBadge).toBe('Preview');
    });

    it('should prefer ENV_BADGE over PREVIEW_MODE when both are set', () => {
      process.env.ENV_BADGE = 'Prod';
      process.env.PREVIEW_MODE = 'true';
      expect(getServerConfig().envBadge).toBe('Prod');
    });

    it('should return empty envBadge when PREVIEW_MODE=false and no ENV_BADGE', () => {
      process.env.PREVIEW_MODE = 'false';
      expect(getServerConfig().envBadge).toBe('');
    });

    it('should return empty envBadge when PREVIEW_MODE is unset and ENV_BADGE is unset', () => {
      expect(getServerConfig().envBadge).toBe('');
    });

    it('should accept NEXT_PUBLIC_ENV_BADGE via env() fallback', () => {
      process.env.NEXT_PUBLIC_ENV_BADGE = 'Dev';
      expect(getServerConfig().envBadge).toBe('Dev');
    });

    it('should accept arbitrary envBadge labels', () => {
      process.env.ENV_BADGE = 'QA';
      expect(getServerConfig().envBadge).toBe('QA');
    });

    it('should accept NEXT_PUBLIC_PREVIEW_MODE=true as backward compat', () => {
      process.env.NEXT_PUBLIC_PREVIEW_MODE = 'true';
      expect(getServerConfig().envBadge).toBe('Preview');
    });

    it('should read ALLOW_DEV_ADMIN_WHEN_SSO_DISABLED=true', () => {
      process.env.ALLOW_DEV_ADMIN_WHEN_SSO_DISABLED = 'true';
      expect(getServerConfig().allowDevAdminWhenSsoDisabled).toBe(true);
    });

    it('should read CAIPE_UNSAFE_RBAC_BYPASS=true', () => {
      process.env.CAIPE_UNSAFE_RBAC_BYPASS = 'true';
      expect(getServerConfig().unsafeRbacBypassEnabled).toBe(true);
    });

    it('should accept numeric CAIPE_UNSAFE_RBAC_BYPASS=1', () => {
      process.env.CAIPE_UNSAFE_RBAC_BYPASS = '1';
      expect(getServerConfig().unsafeRbacBypassEnabled).toBe(true);
    });

    it('should read SUPPORT_EMAIL', () => {
      process.env.SUPPORT_EMAIL = 'admin@cisco.com';
      expect(getServerConfig().supportEmail).toBe('admin@cisco.com');
    });

    it('should read SPINNER_COLOR', () => {
      process.env.SPINNER_COLOR = '#ff6600';
      expect(getServerConfig().spinnerColor).toBe('#ff6600');
    });

    it('should read GRADIENT_FROM and GRADIENT_TO', () => {
      process.env.GRADIENT_FROM = '#ff0000';
      process.env.GRADIENT_TO = '#0000ff';
      const cfg = getServerConfig();
      expect(cfg.gradientFrom).toBe('#ff0000');
      expect(cfg.gradientTo).toBe('#0000ff');
    });
  });

  describe('ticket integration env vars', () => {
    beforeEach(() => {
      clearEnv(
        'REPORT_PROBLEM_ENABLED',
        'PROVIDE_FEEDBACK_ENABLED',
        'JIRA_TICKET_ENABLED', 'JIRA_TICKET_PROJECT', 'JIRA_TICKET_LABEL',
        'GITHUB_TICKET_ENABLED', 'GITHUB_TICKET_REPO', 'GITHUB_TICKET_LABEL',
      );
    });

    it('should enable Jira when JIRA_TICKET_ENABLED=true and JIRA_TICKET_PROJECT set', () => {
      process.env.JIRA_TICKET_ENABLED = 'true';
      process.env.JIRA_TICKET_PROJECT = 'OPENSD';
      const cfg = getServerConfig();
      expect(cfg.jiraTicketEnabled).toBe(true);
      expect(cfg.jiraTicketProject).toBe('OPENSD');
      expect(cfg.ticketEnabled).toBe(true);
      expect(cfg.ticketProvider).toBe('jira');
    });

    it('should enable GitHub when GITHUB_TICKET_ENABLED=true and GITHUB_TICKET_REPO set', () => {
      process.env.GITHUB_TICKET_ENABLED = 'true';
      process.env.GITHUB_TICKET_REPO = 'org/repo';
      const cfg = getServerConfig();
      expect(cfg.githubTicketEnabled).toBe(true);
      expect(cfg.githubTicketRepo).toBe('org/repo');
      expect(cfg.ticketEnabled).toBe(true);
      expect(cfg.ticketProvider).toBe('github');
    });

    it('should prefer Jira when both providers are enabled', () => {
      process.env.JIRA_TICKET_ENABLED = 'true';
      process.env.JIRA_TICKET_PROJECT = 'OPENSD';
      process.env.GITHUB_TICKET_ENABLED = 'true';
      process.env.GITHUB_TICKET_REPO = 'org/repo';
      const cfg = getServerConfig();
      expect(cfg.ticketProvider).toBe('jira');
    });

    it('should read custom Jira label', () => {
      process.env.JIRA_TICKET_ENABLED = 'true';
      process.env.JIRA_TICKET_LABEL = 'my-team-label';
      const cfg = getServerConfig();
      expect(cfg.jiraTicketLabel).toBe('my-team-label');
    });

    it('should read custom GitHub label', () => {
      process.env.GITHUB_TICKET_ENABLED = 'true';
      process.env.GITHUB_TICKET_LABEL = 'prod-issues';
      const cfg = getServerConfig();
      expect(cfg.githubTicketLabel).toBe('prod-issues');
    });

    it('should disable report problem when REPORT_PROBLEM_ENABLED=false', () => {
      process.env.REPORT_PROBLEM_ENABLED = 'false';
      const cfg = getServerConfig();
      expect(cfg.reportProblemEnabled).toBe(false);
    });

    it('should enable report problem by default', () => {
      const cfg = getServerConfig();
      expect(cfg.reportProblemEnabled).toBe(true);
    });

    it('should keep the header feedback shortcut opt-in', () => {
      expect(getServerConfig().provideFeedbackEnabled).toBe(false);
      process.env.PROVIDE_FEEDBACK_ENABLED = 'true';
      expect(getServerConfig().provideFeedbackEnabled).toBe(true);
    });

    it('should derive ticketEnabled=false when no provider is enabled', () => {
      const cfg = getServerConfig();
      expect(cfg.ticketEnabled).toBe(false);
      expect(cfg.ticketProvider).toBeNull();
    });
  });

  // ---------- MongoDB / storageMode ----------

  describe('MongoDB and storageMode', () => {
    beforeEach(() => {
      delete process.env.MONGODB_URI;
      delete process.env.MONGODB_DATABASE;
      clearEnv('MONGODB_ENABLED');
    });

    it('should return localStorage when MongoDB not configured', () => {
      const cfg = getServerConfig();
      expect(cfg.mongodbEnabled).toBe(false);
      expect(cfg.storageMode).toBe('localStorage');
    });

    it('should enable mongodb when MONGODB_URI + MONGODB_DATABASE set', () => {
      process.env.MONGODB_URI = 'mongodb://localhost:27017';
      process.env.MONGODB_DATABASE = 'caipe';
      const cfg = getServerConfig();
      expect(cfg.mongodbEnabled).toBe(true);
      expect(cfg.storageMode).toBe('mongodb');
    });

    it('should NOT enable mongodb when only MONGODB_URI is set', () => {
      process.env.MONGODB_URI = 'mongodb://localhost:27017';
      const cfg = getServerConfig();
      expect(cfg.mongodbEnabled).toBe(false);
      expect(cfg.storageMode).toBe('localStorage');
    });

    it('should NOT enable mongodb when only MONGODB_DATABASE is set', () => {
      process.env.MONGODB_DATABASE = 'caipe';
      const cfg = getServerConfig();
      expect(cfg.mongodbEnabled).toBe(false);
      expect(cfg.storageMode).toBe('localStorage');
    });

    it('should enable mongodb via MONGODB_ENABLED=true even without URI', () => {
      process.env.MONGODB_ENABLED = 'true';
      const cfg = getServerConfig();
      expect(cfg.mongodbEnabled).toBe(true);
      expect(cfg.storageMode).toBe('mongodb');
    });

    it('should enable mongodb via NEXT_PUBLIC_MONGODB_ENABLED=true', () => {
      process.env.NEXT_PUBLIC_MONGODB_ENABLED = 'true';
      const cfg = getServerConfig();
      expect(cfg.mongodbEnabled).toBe(true);
    });
  });

  // ---------- RAG enabled ----------

  describe('ragEnabled', () => {
    beforeEach(() => clearEnv('RAG_ENABLED'));

    it('should default to true (enabled)', () => {
      expect(getServerConfig().ragEnabled).toBe(true);
    });

    it('should be false when RAG_ENABLED=false', () => {
      process.env.RAG_ENABLED = 'false';
      expect(getServerConfig().ragEnabled).toBe(false);
    });

    it('should be true for RAG_ENABLED=true', () => {
      process.env.RAG_ENABLED = 'true';
      expect(getServerConfig().ragEnabled).toBe(true);
    });

    it('should be true for RAG_ENABLED=anything (only "false" disables)', () => {
      process.env.RAG_ENABLED = 'banana';
      expect(getServerConfig().ragEnabled).toBe(true);
    });
  });

  // ---------- feedbackEnabled ----------

  describe('feedbackEnabled', () => {
    beforeEach(() => clearEnv('FEEDBACK_ENABLED'));

    it('should default to true (enabled)', () => {
      expect(getServerConfig().feedbackEnabled).toBe(true);
    });

    it('should be false when FEEDBACK_ENABLED=false', () => {
      process.env.FEEDBACK_ENABLED = 'false';
      expect(getServerConfig().feedbackEnabled).toBe(false);
    });

    it('should be true when FEEDBACK_ENABLED=true', () => {
      process.env.FEEDBACK_ENABLED = 'true';
      expect(getServerConfig().feedbackEnabled).toBe(true);
    });

    it('should be true for any value other than "false"', () => {
      process.env.FEEDBACK_ENABLED = 'banana';
      expect(getServerConfig().feedbackEnabled).toBe(true);
    });
  });

  // ---------- auditLogsEnabled ----------

  describe('auditLogsEnabled', () => {
    beforeEach(() => clearEnv('AUDIT_LOGS_ENABLED'));

    it('should default to false (disabled)', () => {
      expect(getServerConfig().auditLogsEnabled).toBe(false);
    });

    it('should be true when AUDIT_LOGS_ENABLED=true', () => {
      process.env.AUDIT_LOGS_ENABLED = 'true';
      expect(getServerConfig().auditLogsEnabled).toBe(true);
    });

    it('should be false when AUDIT_LOGS_ENABLED=false', () => {
      process.env.AUDIT_LOGS_ENABLED = 'false';
      expect(getServerConfig().auditLogsEnabled).toBe(false);
    });

    it('should be false for non-"true" values (only "true" enables)', () => {
      process.env.AUDIT_LOGS_ENABLED = '1';
      expect(getServerConfig().auditLogsEnabled).toBe(false);

      process.env.AUDIT_LOGS_ENABLED = 'banana';
      expect(getServerConfig().auditLogsEnabled).toBe(false);

      process.env.AUDIT_LOGS_ENABLED = 'TRUE';
      expect(getServerConfig().auditLogsEnabled).toBe(false);
    });
  });

  // ---------- Logo style ----------

  describe('logoStyle', () => {
    beforeEach(() => clearEnv('LOGO_STYLE'));

    it('should default to "default"', () => {
      expect(getServerConfig().logoStyle).toBe('default');
    });

    it('should accept "white"', () => {
      process.env.LOGO_STYLE = 'white';
      expect(getServerConfig().logoStyle).toBe('white');
    });

    it('should fall back to "default" for invalid values', () => {
      process.env.LOGO_STYLE = 'blue';
      expect(getServerConfig().logoStyle).toBe('default');
    });

    it('should fall back to "default" for empty string', () => {
      process.env.LOGO_STYLE = '';
      expect(getServerConfig().logoStyle).toBe('default');
    });
  });

  // ---------- Personalization defaults (env-configurable) ----------

  describe('defaultFontSize', () => {
    beforeEach(() => clearEnv('DEFAULT_FONT_SIZE'));

    it('should default to "medium"', () => {
      expect(getServerConfig().defaultFontSize).toBe('medium');
    });

    it.each(['small', 'medium', 'large', 'x-large'] as const)(
      'should accept valid value "%s"',
      (size) => {
        process.env.DEFAULT_FONT_SIZE = size;
        expect(getServerConfig().defaultFontSize).toBe(size);
      },
    );

    it('should fall back to "medium" for invalid value', () => {
      process.env.DEFAULT_FONT_SIZE = 'huge';
      expect(getServerConfig().defaultFontSize).toBe('medium');
    });

    it('should fall back to "medium" for empty string', () => {
      process.env.DEFAULT_FONT_SIZE = '';
      expect(getServerConfig().defaultFontSize).toBe('medium');
    });

    it('should read NEXT_PUBLIC_ prefix as fallback', () => {
      process.env.NEXT_PUBLIC_DEFAULT_FONT_SIZE = 'large';
      expect(getServerConfig().defaultFontSize).toBe('large');
    });

    it('should prefer non-prefixed over NEXT_PUBLIC_', () => {
      process.env.DEFAULT_FONT_SIZE = 'small';
      process.env.NEXT_PUBLIC_DEFAULT_FONT_SIZE = 'x-large';
      expect(getServerConfig().defaultFontSize).toBe('small');
    });
  });

  describe('defaultFontFamily', () => {
    beforeEach(() => clearEnv('DEFAULT_FONT_FAMILY'));

    it('should default to "inter"', () => {
      expect(getServerConfig().defaultFontFamily).toBe('inter');
    });

    it.each(['inter', 'source-sans', 'ibm-plex', 'system'] as const)(
      'should accept valid value "%s"',
      (family) => {
        process.env.DEFAULT_FONT_FAMILY = family;
        expect(getServerConfig().defaultFontFamily).toBe(family);
      },
    );

    it('should fall back to "inter" for invalid value', () => {
      process.env.DEFAULT_FONT_FAMILY = 'comic-sans';
      expect(getServerConfig().defaultFontFamily).toBe('inter');
    });

    it('should fall back to "inter" for empty string', () => {
      process.env.DEFAULT_FONT_FAMILY = '';
      expect(getServerConfig().defaultFontFamily).toBe('inter');
    });
  });

  describe('defaultTheme', () => {
    beforeEach(() => clearEnv('DEFAULT_THEME'));

    it('should default to "dark"', () => {
      expect(getServerConfig().defaultTheme).toBe('dark');
    });

    it.each(['light', 'legacy-light', 'dark', 'system', 'midnight', 'nord', 'tokyo', 'cyberpunk', 'tron', 'matrix'] as const)(
      'should accept valid value "%s"',
      (theme) => {
        process.env.DEFAULT_THEME = theme;
        expect(getServerConfig().defaultTheme).toBe(theme);
      },
    );

    it('should fall back to "dark" for invalid value', () => {
      process.env.DEFAULT_THEME = 'neon-dreams';
      expect(getServerConfig().defaultTheme).toBe('dark');
    });

    it('should fall back to "dark" for empty string', () => {
      process.env.DEFAULT_THEME = '';
      expect(getServerConfig().defaultTheme).toBe('dark');
    });
  });

  describe('defaultGradientTheme', () => {
    beforeEach(() => clearEnv('DEFAULT_GRADIENT_THEME'));

    it('should default to "default"', () => {
      expect(getServerConfig().defaultGradientTheme).toBe('default');
    });

    it.each(['default', 'minimal', 'professional', 'ocean', 'sunset', 'cyberpunk', 'tron', 'matrix'] as const)(
      'should accept valid value "%s"',
      (gradient) => {
        process.env.DEFAULT_GRADIENT_THEME = gradient;
        expect(getServerConfig().defaultGradientTheme).toBe(gradient);
      },
    );

    it('should fall back to "default" for invalid value', () => {
      process.env.DEFAULT_GRADIENT_THEME = 'rainbow';
      expect(getServerConfig().defaultGradientTheme).toBe('default');
    });

    it('should fall back to "default" for empty string', () => {
      process.env.DEFAULT_GRADIENT_THEME = '';
      expect(getServerConfig().defaultGradientTheme).toBe('default');
    });
  });

  // ---------- showPoweredBy ----------

  describe('showPoweredBy', () => {
    beforeEach(() => clearEnv('SHOW_POWERED_BY'));

    it('should default to true', () => {
      expect(getServerConfig().showPoweredBy).toBe(true);
    });

    it('should be false when SHOW_POWERED_BY=false', () => {
      process.env.SHOW_POWERED_BY = 'false';
      expect(getServerConfig().showPoweredBy).toBe(false);
    });

    it('should be true when SHOW_POWERED_BY=true', () => {
      process.env.SHOW_POWERED_BY = 'true';
      expect(getServerConfig().showPoweredBy).toBe(true);
    });

    it('should be true for SHOW_POWERED_BY=anything (only "false" disables)', () => {
      process.env.SHOW_POWERED_BY = '0';
      expect(getServerConfig().showPoweredBy).toBe(true);
    });
  });

  // ---------- NODE_ENV / isDev / isProd ----------

  describe('NODE_ENV detection', () => {
    it('should set isDev=true in development', () => {
      process.env.NODE_ENV = 'development';
      const cfg = getServerConfig();
      expect(cfg.isDev).toBe(true);
      expect(cfg.isProd).toBe(false);
    });

    it('should set isProd=true in production', () => {
      process.env.NODE_ENV = 'production';
      const cfg = getServerConfig();
      expect(cfg.isDev).toBe(false);
      expect(cfg.isProd).toBe(true);
    });

    it('should set both false in test environment', () => {
      process.env.NODE_ENV = 'test';
      const cfg = getServerConfig();
      expect(cfg.isDev).toBe(false);
      expect(cfg.isProd).toBe(false);
    });
  });

  // ---------- Production defaults ----------

  describe('production defaults (when no RAG URL set)', () => {
    it('should use k8s service URLs for ragUrl in production', () => {
      process.env.NODE_ENV = 'production';
      clearEnv('RAG_URL');
      delete process.env.RAG_SERVER_URL;
      expect(getServerConfig().ragUrl).toBe('http://rag-server:9446');
    });
  });

  // ---------- Backward compatibility (NEXT_PUBLIC_ prefix) ----------

  describe('backward compatibility (NEXT_PUBLIC_ prefix)', () => {
    it('should read NEXT_PUBLIC_SSO_ENABLED as fallback', () => {
      clearEnv('SSO_ENABLED');
      process.env.NEXT_PUBLIC_SSO_ENABLED = 'true';
      expect(getServerConfig().ssoEnabled).toBe(true);
    });

    it('should read NEXT_PUBLIC_APP_NAME as fallback', () => {
      clearEnv('APP_NAME');
      process.env.NEXT_PUBLIC_APP_NAME = 'LegacyApp';
      expect(getServerConfig().appName).toBe('LegacyApp');
    });

    it('should prefer non-prefixed over NEXT_PUBLIC_', () => {
      process.env.APP_NAME = 'NewName';
      process.env.NEXT_PUBLIC_APP_NAME = 'OldName';
      expect(getServerConfig().appName).toBe('NewName');
    });

    it('should read NEXT_PUBLIC_TAGLINE as fallback', () => {
      clearEnv('TAGLINE');
      process.env.NEXT_PUBLIC_TAGLINE = 'Legacy Tagline';
      expect(getServerConfig().tagline).toBe('Legacy Tagline');
    });

    it('should read NEXT_PUBLIC_LOGO_STYLE as fallback', () => {
      clearEnv('LOGO_STYLE');
      process.env.NEXT_PUBLIC_LOGO_STYLE = 'white';
      expect(getServerConfig().logoStyle).toBe('white');
    });

    it('should read NEXT_PUBLIC_GRADIENT_FROM as fallback', () => {
      clearEnv('GRADIENT_FROM');
      process.env.NEXT_PUBLIC_GRADIENT_FROM = '#aabbcc';
      expect(getServerConfig().gradientFrom).toBe('#aabbcc');
    });
  });

  // ---------- oidcRequiredGroup ----------

  describe('oidcRequiredGroup', () => {
    beforeEach(() => {
      delete process.env.OIDC_REQUIRED_GROUP;
    });

    it('defaults to no required group when OIDC_REQUIRED_GROUP is not set', () => {
      expect(getServerConfig().oidcRequiredGroup).toBe('');
    });

    it('reads a custom value from OIDC_REQUIRED_GROUP', () => {
      process.env.OIDC_REQUIRED_GROUP = 'my-org-caipe-users';
      expect(getServerConfig().oidcRequiredGroup).toBe('my-org-caipe-users');
    });

    it('preserves whitespace exactly so invalid deployment config is visible', () => {
      process.env.OIDC_REQUIRED_GROUP = '  caipe-users  ';
      expect(getServerConfig().oidcRequiredGroup).toBe('  caipe-users  ');
    });

    it('keeps OIDC_REQUIRED_GROUP disabled when the env var is an empty string', () => {
      process.env.OIDC_REQUIRED_GROUP = '';
      expect(getServerConfig().oidcRequiredGroup).toBe('');
    });
  });
});

// ==========================================================================
// XSS / Security Tests (getClientConfigScript)
// ==========================================================================

describe('getClientConfigScript (XSS safety)', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    jest.resetModules();
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('should return valid JSON', () => {
    const script = getClientConfigScript();
    // The script has \u003c which JSON.parse handles natively
    const parsed = JSON.parse(script);
    expect(parsed).toBeDefined();
    expect(typeof parsed.appName).toBe('string');
  });

  it('should escape < to \\u003c to prevent script injection', () => {
    process.env.APP_NAME = '<script>alert("xss")</script>';
    const script = getClientConfigScript();
    // Must NOT contain raw < character
    expect(script).not.toContain('<');
    // Must contain the escaped version
    expect(script).toContain('\\u003c');
  });

  it('should handle </script> injection attempt', () => {
    process.env.TAGLINE = '</script><script>document.location="evil.com"</script>';
    const script = getClientConfigScript();
    expect(script).not.toContain('</script>');
    expect(script).not.toContain('<script>');
    // Should still parse to the original value
    const parsed = JSON.parse(script);
    expect(parsed.tagline).toBe('</script><script>document.location="evil.com"</script>');
  });

  it('should handle event handler injection via <img onerror>', () => {
    process.env.DESCRIPTION = '<img src=x onerror=alert(1)>';
    const script = getClientConfigScript();
    expect(script).not.toContain('<img');
    const parsed = JSON.parse(script);
    expect(parsed.description).toBe('<img src=x onerror=alert(1)>');
  });

  it('should safely handle values with quotes and special chars', () => {
    process.env.APP_NAME = 'He said "hello" & she \'waved\'';
    const script = getClientConfigScript();
    const parsed = JSON.parse(script);
    expect(parsed.appName).toBe('He said "hello" & she \'waved\'');
  });

  it('should handle unicode and emoji in values', () => {
    process.env.TAGLINE = '🚀 AI Platform — línea de trabajo 日本語';
    const script = getClientConfigScript();
    const parsed = JSON.parse(script);
    expect(parsed.tagline).toBe('🚀 AI Platform — línea de trabajo 日本語');
  });

  it('should handle empty string values', () => {
    process.env.APP_NAME = '';
    const script = getClientConfigScript();
    const parsed = JSON.parse(script);
    // Empty string is falsy, so default should be used
    expect(parsed.appName).toBe('CAIPE');
  });

  it('should NOT include server-only secrets', () => {
    // These vars should never appear in the client config
    process.env.OIDC_CLIENT_SECRET = 'super-secret-123';
    process.env.MONGODB_URI = 'mongodb://user:password@host:27017/db';
    process.env.NEXTAUTH_SECRET = 'jwt-secret-456';
    process.env.MONGODB_DATABASE = 'caipe';

    const script = getClientConfigScript();
    expect(script).not.toContain('super-secret-123');
    expect(script).not.toContain('user:password');
    expect(script).not.toContain('jwt-secret-456');
    // The full URI should not be present (only boolean mongodbEnabled)
    expect(script).not.toContain('mongodb://');
  });

  it('should only contain Config interface keys', () => {
    const script = getClientConfigScript();
    const parsed = JSON.parse(script);
    const expectedKeys: (keyof Config)[] = [
      'agentProtocol',
      'ragUrl', 'isDev', 'isProd', 'ssoEnabled',
      'ragEnabled', 'mongodbEnabled', 'credentialsEnabled', 'userConnectionsEnabled',
      'tagline', 'description', 'appName', 'logoUrl', 'envBadge',
      'gradientFrom', 'gradientTo', 'logoStyle', 'spinnerColor',
      'showPoweredBy', 'supportEmail', 'allowDevAdminWhenSsoDisabled', 'unsafeRbacBypassEnabled',
      'storageMode', 'enabledIntegrationIcons', 'faviconUrl',
      'docsUrl', 'sourceUrl', 'workflowRunnerEnabled', 'workflowsEnabled', 'projectsEnabled', 'dynamicAgentsEnabled', 'feedbackEnabled',
      'allowBuiltinSkillMutation',
      'auditLogsEnabled',
      'actionAuditEnabled',
      'auditLogBackend',
      'defaultFontSize', 'defaultFontFamily', 'defaultTheme', 'defaultGradientTheme',
      'dynamicAgentsUrl',
      'autonomousAgentsEnabled',
      'agenticAppsEnabled',
      'reportProblemEnabled',
      'provideFeedbackEnabled',
      'jiraTicketEnabled', 'jiraTicketProject', 'jiraTicketLabel',
      'githubTicketEnabled', 'githubTicketRepo', 'githubTicketLabel',
      'ticketEnabled', 'ticketProvider',
      'userInfoToolEnabled',
      'oidcRequiredGroup',
      'oktaSyncEnabled',
      'scheduleEditorAgentId',
      'schedulerAdminOnly',
      'schedulerEnabled',
    ];
    expect(Object.keys(parsed).sort()).toEqual(expectedKeys.sort());
  });
});

// ==========================================================================
// Client-Side Tests (window.__APP_CONFIG__, getConfig, config proxy)
// ==========================================================================

describe('client-side config (window.__APP_CONFIG__)', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    jest.resetModules();
    process.env = { ...originalEnv };
    // Clear any previous window config
    setWindowConfig(undefined);
  });

  afterEach(() => {
    process.env = originalEnv;
    setWindowConfig(undefined);
  });

  describe('getConfig() on the client', () => {
    it('should return default values when window.__APP_CONFIG__ is not set', () => {
      expect(getWindowConfig()).toBeUndefined();
      // In jsdom, window is defined, so getConfig reads from window
      expect(getConfig('appName')).toBe('CAIPE');
      expect(getConfig('ssoEnabled')).toBe(false);
      expect(getConfig('storageMode')).toBe('localStorage');
    });

    it('should return injected values when window.__APP_CONFIG__ is set', () => {
      setWindowConfig({
        ragUrl: 'https://rag.example.com',
        isDev: false,
        isProd: true,
        ssoEnabled: true,
        ragEnabled: true,
        mongodbEnabled: true,
        tagline: 'Prod Tagline',
        description: 'Prod Description',
        appName: 'ProdApp',
        logoUrl: '/prod-logo.svg',
        envBadge: '',
        gradientFrom: '#111',
        gradientTo: '#222',
        logoStyle: 'white',
        spinnerColor: '#00ff00',
        showPoweredBy: false,
        supportEmail: 'prod@example.com',
        allowDevAdminWhenSsoDisabled: false,
        unsafeRbacBypassEnabled: false,
        storageMode: 'mongodb',
        defaultFontSize: 'large',
        defaultFontFamily: 'ibm-plex',
        defaultTheme: 'nord',
        defaultGradientTheme: 'ocean',
      });

      expect(getConfig('appName')).toBe('ProdApp');
      expect(getConfig('ssoEnabled')).toBe(true);
      expect(getConfig('storageMode')).toBe('mongodb');
      expect(getConfig('logoStyle')).toBe('white');
      expect(getConfig('showPoweredBy')).toBe(false);
      expect(getConfig('spinnerColor')).toBe('#00ff00');
      expect(getConfig('isProd')).toBe(true);
      expect(getConfig('defaultFontSize')).toBe('large');
      expect(getConfig('defaultFontFamily')).toBe('ibm-plex');
      expect(getConfig('defaultTheme')).toBe('nord');
      expect(getConfig('defaultGradientTheme')).toBe('ocean');
    });

    it('should reflect changes when window.__APP_CONFIG__ is updated', () => {
      // Simulate initial load
      setWindowConfig({
        ragUrl: 'http://localhost:9446',
        isDev: true, isProd: false,
        ssoEnabled: false, ragEnabled: true,
        mongodbEnabled: false,
        tagline: 'Dev', description: 'Dev', appName: 'DevApp',
        logoUrl: '/logo.svg', envBadge: '',
        gradientFrom: '#000', gradientTo: '#fff',
        logoStyle: 'default', spinnerColor: null,
        showPoweredBy: true, supportEmail: 'dev@test.com',
        allowDevAdminWhenSsoDisabled: true, unsafeRbacBypassEnabled: false, storageMode: 'localStorage',
        defaultFontSize: 'medium', defaultFontFamily: 'inter',
        defaultTheme: 'dark', defaultGradientTheme: 'default',
      });

      expect(getConfig('appName')).toBe('DevApp');

      // Update (e.g., hot reload scenario)
      setWindowConfig({
        ...getWindowConfig()!,
        appName: 'UpdatedApp',
        ssoEnabled: true,
      });

      expect(getConfig('appName')).toBe('UpdatedApp');
      expect(getConfig('ssoEnabled')).toBe(true);
    });
  });

  describe('config proxy on the client', () => {
    it('should read from window.__APP_CONFIG__ via proxy', () => {
      setWindowConfig({
        ragUrl: 'https://rag.test.com',
        isDev: false, isProd: true,
        ssoEnabled: true, ragEnabled: false,
        mongodbEnabled: true,
        tagline: 'Proxy Test', description: 'Test',
        appName: 'ProxyApp', logoUrl: '/proxy.svg',
        envBadge: 'Preview', gradientFrom: '#aaa', gradientTo: '#bbb',
        logoStyle: 'white', spinnerColor: '#ccc',
        showPoweredBy: false, supportEmail: 'proxy@test.com',
        allowDevAdminWhenSsoDisabled: false, unsafeRbacBypassEnabled: false, storageMode: 'mongodb',
        defaultFontSize: 'small', defaultFontFamily: 'system',
        defaultTheme: 'midnight', defaultGradientTheme: 'sunset',
      });

      // config is a Proxy in jsdom (window is defined)
      expect(config.appName).toBe('ProxyApp');
      expect(config.ssoEnabled).toBe(true);
      expect(config.logoStyle).toBe('white');
      expect(config.storageMode).toBe('mongodb');
    });

    it('should return defaults when window.__APP_CONFIG__ is missing', () => {
      setWindowConfig(undefined);
      expect(config.appName).toBe('CAIPE');
      expect(config.ssoEnabled).toBe(false);
      expect(config.ragEnabled).toBe(true);
    });
  });
});

// ==========================================================================
// getLogoFilterClass Tests
// ==========================================================================

describe('getLogoFilterClass', () => {
  beforeEach(() => {
    setWindowConfig(undefined);
  });

  afterEach(() => {
    setWindowConfig(undefined);
  });

  it('should return empty string for "default" style', () => {
    expect(getLogoFilterClass('default')).toBe('');
  });

  it('should return "brightness-0 invert" for "white" style', () => {
    expect(getLogoFilterClass('white')).toBe('brightness-0 invert');
  });

  it('should read logoStyle from config when no argument provided', () => {
    // Default config has logoStyle='default'
    expect(getLogoFilterClass()).toBe('');
  });

  it('should use window.__APP_CONFIG__ logoStyle when available', () => {
    setWindowConfig({
      ragUrl: '', isDev: false, isProd: false,
      ssoEnabled: false, ragEnabled: true, mongodbEnabled: false,
      tagline: '', description: '',
      appName: '', logoUrl: '', envBadge: '',
      gradientFrom: '', gradientTo: '', logoStyle: 'white',
      spinnerColor: null, showPoweredBy: true, supportEmail: '',
      allowDevAdminWhenSsoDisabled: false, unsafeRbacBypassEnabled: false, storageMode: 'localStorage',
      defaultFontSize: 'medium', defaultFontFamily: 'inter',
      defaultTheme: 'dark', defaultGradientTheme: 'default',
    });
    expect(getLogoFilterClass()).toBe('brightness-0 invert');
  });
});

// ==========================================================================
// Edge Cases & Robustness Tests
// ==========================================================================

describe('edge cases', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    jest.resetModules();
    process.env = { ...originalEnv };
    setWindowConfig(undefined);
  });

  afterEach(() => {
    process.env = originalEnv;
    setWindowConfig(undefined);
  });

  describe('env var edge cases', () => {
    it('should handle env var set to empty string (falls back to default)', () => {
      process.env.TAGLINE = '';
      // Empty string is falsy, falls through to default
      expect(getServerConfig().tagline).toBe('Multi-Agent Workflow Automation');
    });

    it('should handle env var with whitespace-only value', () => {
      process.env.APP_NAME = '   ';
      // Whitespace is truthy, so it gets used
      expect(getServerConfig().appName).toBe('   ');
    });

    it('should handle boolean env with whitespace around true', () => {
      process.env.SSO_ENABLED = ' true ';
      // Strict equality check, so whitespace-padded "true" is NOT true
      expect(getServerConfig().ssoEnabled).toBe(false);
    });

    it('should handle boolean env with uppercase TRUE', () => {
      process.env.SSO_ENABLED = 'TRUE';
      // Strict equality check against 'true' (lowercase)
      expect(getServerConfig().ssoEnabled).toBe(false);
    });

    it('should handle very long env var values', () => {
      const longValue = 'A'.repeat(10000);
      process.env.TAGLINE = longValue;
      expect(getServerConfig().tagline).toBe(longValue);
      expect(getServerConfig().tagline.length).toBe(10000);
    });

    it('should handle env vars with newlines', () => {
      process.env.DESCRIPTION = 'Line 1\nLine 2\nLine 3';
      const cfg = getServerConfig();
      expect(cfg.description).toBe('Line 1\nLine 2\nLine 3');
    });

    it('should handle env vars with backslashes', () => {
      process.env.APP_NAME = 'Path\\To\\App';
      expect(getServerConfig().appName).toBe('Path\\To\\App');
    });

    it('should handle env vars with JSON-like content', () => {
      process.env.TAGLINE = '{"key":"value"}';
      const script = getClientConfigScript();
      const parsed = JSON.parse(script);
      expect(parsed.tagline).toBe('{"key":"value"}');
    });
  });

  describe('Config type safety', () => {
    it('getConfig should return correct types for boolean keys', () => {
      const sso: boolean = getConfig('ssoEnabled');
      expect(typeof sso).toBe('boolean');

      const rag: boolean = getConfig('ragEnabled');
      expect(typeof rag).toBe('boolean');

      const mongo: boolean = getConfig('mongodbEnabled');
      expect(typeof mongo).toBe('boolean');
    });

    it('getConfig should return correct types for string keys', () => {
      const name: string = getConfig('appName');
      expect(typeof name).toBe('string');

      const url: string = getConfig('ragUrl');
      expect(typeof url).toBe('string');
    });

    it('getConfig should return correct type for nullable keys', () => {
      const spinner: string | null = getConfig('spinnerColor');
      expect(spinner === null || typeof spinner === 'string').toBe(true);
    });

    it('getConfig should return correct type for union keys', () => {
      const mode: 'mongodb' | 'localStorage' = getConfig('storageMode');
      expect(['mongodb', 'localStorage']).toContain(mode);

      const style: 'default' | 'white' = getConfig('logoStyle');
      expect(['default', 'white']).toContain(style);
    });
  });

  describe('getClientConfigScript serialization roundtrip', () => {
    it('should roundtrip all default config values', () => {
      clearEnv(
        'RAG_URL', 'SSO_ENABLED', 'RAG_ENABLED',
        'MONGODB_ENABLED', 'PREVIEW_MODE', 'ENV_BADGE',
        'ALLOW_DEV_ADMIN_WHEN_SSO_DISABLED', 'SHOW_POWERED_BY',
        'LOGO_STYLE', 'SPINNER_COLOR', 'TAGLINE', 'DESCRIPTION',
        'APP_NAME', 'LOGO_URL', 'GRADIENT_FROM', 'GRADIENT_TO',
        'SUPPORT_EMAIL', 'CAIPE_UNSAFE_RBAC_BYPASS',
      );
      delete process.env.MONGODB_URI;
      delete process.env.MONGODB_DATABASE;
      delete process.env.RAG_SERVER_URL;

      const script = getClientConfigScript();
      const parsed: Config = JSON.parse(script);
      const direct = getServerConfig();

      // Every key should match
      for (const key of Object.keys(direct) as (keyof Config)[]) {
        expect(parsed[key]).toEqual(direct[key]);
      }
    });

    it('should roundtrip custom config values', () => {
      process.env.APP_NAME = 'TestRoundtrip';
      process.env.SSO_ENABLED = 'true';
      process.env.LOGO_STYLE = 'white';
      process.env.SPINNER_COLOR = '#abc123';

      const script = getClientConfigScript();
      const parsed: Config = JSON.parse(script);

      expect(parsed.appName).toBe('TestRoundtrip');
      expect(parsed.ssoEnabled).toBe(true);
      expect(parsed.logoStyle).toBe('white');
      expect(parsed.spinnerColor).toBe('#abc123');
    });

    it('should preserve null values through serialization', () => {
      clearEnv('SPINNER_COLOR');
      const script = getClientConfigScript();
      const parsed: Config = JSON.parse(script);
      expect(parsed.spinnerColor).toBeNull();
    });
  });
});

// ==========================================================================
// Integration-style: simulating the full layout → client flow
// ==========================================================================

describe('end-to-end: layout injection → client read', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    jest.resetModules();
    process.env = { ...originalEnv };
    setWindowConfig(undefined);
  });

  afterEach(() => {
    process.env = originalEnv;
    setWindowConfig(undefined);
  });

  it('should allow client to read config injected by layout', () => {
    // Step 1: Server (layout.tsx) calls getClientConfigScript()
    process.env.SSO_ENABLED = 'true';
    process.env.APP_NAME = 'IntegrationTestApp';
    process.env.MONGODB_URI = 'mongodb://secret-host:27017';
    process.env.MONGODB_DATABASE = 'test-db';

    const script = getClientConfigScript();

    // Step 2: Browser executes the <script> tag
    // This simulates: window.__APP_CONFIG__ = <script output>
    const injected: Config = JSON.parse(script);
    setWindowConfig(injected);

    // Step 3: Client components call getConfig()
    expect(getConfig('ssoEnabled')).toBe(true);
    expect(getConfig('appName')).toBe('IntegrationTestApp');
    expect(getConfig('mongodbEnabled')).toBe(true);
    expect(getConfig('storageMode')).toBe('mongodb');

    // Step 4: Verify secrets are NOT exposed
    const raw = script;
    expect(raw).not.toContain('secret-host');
    expect(raw).not.toContain('mongodb://');
    expect(raw).not.toContain('test-db');
  });

  it('should handle the "clean deploy" scenario (no env vars)', () => {
    // Simulate a fresh deployment with no env vars at all
    clearEnv(
      'RAG_URL', 'SSO_ENABLED', 'RAG_ENABLED',
      'MONGODB_ENABLED', 'PREVIEW_MODE', 'ENV_BADGE',
      'ALLOW_DEV_ADMIN_WHEN_SSO_DISABLED', 'SHOW_POWERED_BY',
      'LOGO_STYLE', 'SPINNER_COLOR', 'TAGLINE', 'DESCRIPTION',
      'APP_NAME', 'LOGO_URL', 'GRADIENT_FROM', 'GRADIENT_TO',
      'SUPPORT_EMAIL', 'CAIPE_UNSAFE_RBAC_BYPASS',
    );
    delete process.env.MONGODB_URI;
    delete process.env.MONGODB_DATABASE;
    delete process.env.RAG_SERVER_URL;

    const script = getClientConfigScript();
    setWindowConfig(JSON.parse(script));

    // Should get sensible defaults
    expect(getConfig('appName')).toBe('CAIPE');
    expect(getConfig('ssoEnabled')).toBe(false);
    expect(getConfig('ragEnabled')).toBe(true);
    expect(getConfig('storageMode')).toBe('localStorage');
    expect(getConfig('showPoweredBy')).toBe(true);
    expect(getConfig('logoStyle')).toBe('default');
    expect(getConfig('defaultFontSize')).toBe('medium');
    expect(getConfig('defaultFontFamily')).toBe('inter');
    expect(getConfig('defaultTheme')).toBe('dark');
    expect(getConfig('defaultGradientTheme')).toBe('default');
  });

  it('should handle the "full production" scenario', () => {
    process.env.NODE_ENV = 'production';
    process.env.SSO_ENABLED = 'true';
    process.env.APP_NAME = 'Grid';
    process.env.TAGLINE = 'Enterprise AI Platform';
    process.env.LOGO_URL = '/grid-logo.svg';
    process.env.LOGO_STYLE = 'white';
    process.env.GRADIENT_FROM = '#1a1a2e';
    process.env.GRADIENT_TO = '#16213e';
    process.env.SHOW_POWERED_BY = 'false';
    process.env.MONGODB_URI = 'mongodb+srv://admin:secret@cluster.mongodb.net';
    process.env.MONGODB_DATABASE = 'grid-prod';
    process.env.SPINNER_COLOR = '#4ecdc4';
    process.env.SUPPORT_EMAIL = 'support@grid.cisco.com';

    const script = getClientConfigScript();
    setWindowConfig(JSON.parse(script));

    expect(getConfig('appName')).toBe('Grid');
    expect(getConfig('isProd')).toBe(true);
    expect(getConfig('ssoEnabled')).toBe(true);
    expect(getConfig('logoStyle')).toBe('white');
    expect(getConfig('showPoweredBy')).toBe(false);
    expect(getConfig('mongodbEnabled')).toBe(true);
    expect(getConfig('storageMode')).toBe('mongodb');
    expect(getConfig('spinnerColor')).toBe('#4ecdc4');
    expect(getConfig('supportEmail')).toBe('support@grid.cisco.com');

    // Secrets must NOT be in the script
    expect(script).not.toContain('admin:secret');
    expect(script).not.toContain('cluster.mongodb.net');
    expect(script).not.toContain('grid-prod');
  });

  it('should handle customized personalization defaults', () => {
    process.env.DEFAULT_FONT_SIZE = 'large';
    process.env.DEFAULT_FONT_FAMILY = 'ibm-plex';
    process.env.DEFAULT_THEME = 'nord';
    process.env.DEFAULT_GRADIENT_THEME = 'professional';

    const script = getClientConfigScript();
    setWindowConfig(JSON.parse(script));

    expect(getConfig('defaultFontSize')).toBe('large');
    expect(getConfig('defaultFontFamily')).toBe('ibm-plex');
    expect(getConfig('defaultTheme')).toBe('nord');
    expect(getConfig('defaultGradientTheme')).toBe('professional');
  });

  it('should silently reject invalid personalization defaults', () => {
    process.env.DEFAULT_FONT_SIZE = 'tiny';
    process.env.DEFAULT_FONT_FAMILY = 'papyrus';
    process.env.DEFAULT_THEME = 'solarized';
    process.env.DEFAULT_GRADIENT_THEME = 'neon';

    const script = getClientConfigScript();
    setWindowConfig(JSON.parse(script));

    expect(getConfig('defaultFontSize')).toBe('medium');
    expect(getConfig('defaultFontFamily')).toBe('inter');
    expect(getConfig('defaultTheme')).toBe('dark');
    expect(getConfig('defaultGradientTheme')).toBe('default');
  });
});
