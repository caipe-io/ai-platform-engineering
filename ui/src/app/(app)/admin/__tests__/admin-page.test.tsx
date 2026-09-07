/**
 * Tests for Admin Dashboard page
 *
 * Covers:
 * - Loading state
 * - Fatal auth errors and card-local stats errors
 * - Read-only badge and descriptions for non-admin users
 * - Admin actions visibility (role change, team CRUD) for admin users
 * - Admin actions hidden for read-only users
 * - Data rendering (stats cards, user list, team list)
 */

// assisted-by Codex Codex-sonnet-4-6

import React from 'react';
import { act, render, screen, waitFor, within, fireEvent } from '@testing-library/react';

// assisted-by Codex Codex-sonnet-4-6

// ============================================================================
// Mocks
// ============================================================================

let mockIsAdmin = false;
const pushMock = jest.fn();
const replaceMock = jest.fn();
let currentSearchParams = new URLSearchParams();
let currentPathname = '/admin';
jest.mock('@/hooks/use-admin-role', () => ({
  useAdminRole: () => ({ isAdmin: mockIsAdmin, loading: false }),
}));

const mockSessionStatus = { status: 'authenticated' as const };
jest.mock('next-auth/react', () => ({
  useSession: () => ({ data: { user: { email: 'test@example.com' } }, ...mockSessionStatus }),
}));

jest.mock('next/navigation', () => ({
  useSearchParams: () => currentSearchParams,
  useRouter: () => ({ push: pushMock, replace: replaceMock, back: jest.fn(), refresh: jest.fn() }),
  usePathname: () => currentPathname,
}));

jest.mock('@/lib/config', () => ({
  getConfig: (key: string) =>
    ({
      auditLogsEnabled: true,
      feedbackEnabled: true,
      ssoEnabled: false,
    })[key] ?? true,
}));

jest.mock('@/lib/auth/dev-auth-provider', () => ({
  ...jest.requireActual('@/lib/auth/dev-auth-provider'),
  isDevAnonymousAuthEnabled: jest.fn(() => false),
}));

jest.mock('@/components/auth-guard', () => ({
  AuthGuard: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

jest.mock('@/components/ui/caipe-spinner', () => ({
  CAIPESpinner: ({ message }: { message: string }) => <div data-testid="spinner">{message}</div>,
}));

jest.mock('@/components/ui/scroll-area', () => ({
  ScrollArea: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

jest.mock('@/components/admin/shared/SimpleLineChart', () => ({
  SimpleLineChart: () => <div data-testid="line-chart" />,
}));

jest.mock('@/components/admin/shared/FeedbackTrendChart', () => ({
  FeedbackTrendChart: ({
    data,
    onPointClick,
  }: {
    data: Array<{ date: string; label: string; positive: number; negative: number }>;
    onPointClick?: (point: {
      date: string;
      label: string;
      positive: number;
      negative: number;
    }) => void;
  }) => (
    <div data-testid="feedback-trend-chart">
      {JSON.stringify(data)}
      {data.map((point) => (
        <button
          aria-label={`View feedback for ${point.label}`}
          key={point.date}
          onClick={() => onPointClick?.(point)}
          type="button"
        />
      ))}
    </div>
  ),
}));

jest.mock('@/components/admin/platform/MetricsTab', () => ({
  MetricsTab: () => <div data-testid="metrics-tab">MetricsTab</div>,
}));

jest.mock('@/components/admin/platform/HealthTab', () => ({
  HealthTab: () => <div data-testid="health-tab">HealthTab</div>,
}));

jest.mock('@/components/admin/settings/ReviewConfigsTab', () => ({
  ReviewConfigsTab: (props: { readOnly?: boolean }) => (
    <div data-testid="review-configs-tab" data-read-only={String(Boolean(props.readOnly))}>
      ReviewConfigsTab
    </div>
  ),
}));

jest.mock('@/components/admin/settings/RagSettingsTab', () => ({
  RagSettingsTab: (props: { readOnly?: boolean }) => (
    <div data-testid="rag-settings-tab" data-read-only={String(Boolean(props.readOnly))}>
      RagSettingsTab
    </div>
  ),
}));

jest.mock('@/components/admin/settings/ImportAgentsFromConfigCard', () => ({
  ImportAgentsFromConfigCard: (props: { readOnly?: boolean }) => (
    <div data-testid="import-agents-card" data-read-only={String(Boolean(props.readOnly))}>
      ImportAgentsFromConfigCard
    </div>
  ),
}));

jest.mock('@/components/admin/autonomous/AutonomousTeamAccessPanel', () => ({
  AutonomousTeamAccessPanel: () => (
    <div data-testid="autonomous-enablement-panel">Autonomous team access</div>
  ),
}));

jest.mock('@/components/admin/ServiceAccountsTab', () => ({
  ServiceAccountsTab: (props: { readOnly?: boolean }) => (
    <div data-testid="service-accounts-tab" data-read-only={String(Boolean(props.readOnly))}>
      ServiceAccountsTab
    </div>
  ),
}));

jest.mock('@/components/admin/insights/SkillMetricsCards', () => ({
  VisibilityBreakdown: () => <div />,
  CategoryBreakdown: () => <div />,
  RunStatsTable: () => <div />,
  TopCreatorsCard: () => <div />,
}));

jest.mock('@/components/admin/security/AccessExplorerTab', () => ({
  AccessExplorerTab: () => <div data-testid="access-explorer-tab">AccessExplorerTab</div>,
}));

jest.mock('@/components/admin/security/RbacSelfCheckTab', () => ({
  RbacSelfCheckTab: () => <div data-testid="rbac-self-check-tab">RbacSelfCheckTab</div>,
}));

jest.mock('@/components/admin/rebac/SlackChannelRebacPanel', () => ({
  SlackChannelRebacPanel: (props: { disabled?: boolean; selfService?: boolean }) => (
    <div
      data-testid="slack-integration-panel"
      data-disabled={String(Boolean(props.disabled))}
      data-self-service={String(Boolean(props.selfService))}
    >
      SlackIntegrationPanel
    </div>
  ),
}));

jest.mock('@/components/admin/rebac/WebexSpaceRebacPanel', () => ({
  WebexSpaceRebacPanel: (props: { disabled?: boolean; selfService?: boolean }) => (
    <div
      data-testid="webex-integration-panel"
      data-disabled={String(Boolean(props.disabled))}
      data-self-service={String(Boolean(props.selfService))}
    >
      WebexIntegrationPanel
    </div>
  ),
}));

jest.mock('@/components/admin/security/MigrationTab', () => ({
  MigrationTab: () => <div data-testid="migration-tab">MigrationTab</div>,
}));

jest.mock('@/components/admin/security/KeycloakMigrationHealthPanel', () => ({
  KeycloakMigrationHealthPanel: () => <div data-testid="keycloak-health-tab">KeycloakHealthTab</div>,
}));

jest.mock('@/components/admin/security/AuditLogsTab', () => ({
  AuditLogsTab: () => <div data-testid="audit-logs-tab">AuditLogsTab</div>,
}));

jest.mock('@/components/admin/security/UnifiedAuditTab', () => ({
  UnifiedAuditTab: () => <div data-testid="unified-audit-tab">UnifiedAuditTab</div>,
}));


jest.mock('@/components/admin/teams/CreateTeamDialog', () => ({
  CreateTeamDialog: () => null,
}));

jest.mock('@/components/admin/teams/TeamDetailsDialog', () => ({
  TeamDetailsDialog: () => null,
}));

jest.mock('@/lib/api-client', () => ({
  apiClient: { get: jest.fn(), post: jest.fn() },
}));

jest.mock('framer-motion', () => ({
  motion: {
    div: ({ children, ...props }: React.HTMLAttributes<HTMLDivElement>) => <div {...props}>{children}</div>,
    span: ({
      animate,
      children,
      initial,
      layoutId,
      transition,
      ...props
    }: React.HTMLAttributes<HTMLSpanElement> & {
      animate?: unknown;
      initial?: unknown;
      layoutId?: string;
      transition?: unknown;
    }) => {
      void animate;
      void initial;
      void layoutId;
      void transition;
      return <span {...props}>{children}</span>;
    },
  },
  useReducedMotion: () => false,
}));

const mockStatsResponse = {
  success: true,
  data: {
    overview: {
      total_users: 42,
      total_conversations: 150,
      total_messages: 1200,
      shared_conversations: 10,
      dau: 15,
      mau: 35,
      conversations_today: 8,
      messages_today: 65,
      avg_messages_per_conversation: 8,
    },
    daily_activity: [],
    top_users: { by_conversations: [], by_messages: [] },
    top_agents: [],
    feedback_summary: { positive: 0, negative: 0, total: 0 },
    response_time: { avg_ms: 0, min_ms: 0, max_ms: 0, sample_count: 0 },
    hourly_heatmap: [],
    completed_workflows: {
      total: 0,
      today: 0,
      interrupted: 0,
      completion_rate: 0,
      avg_messages_per_workflow: 0,
    },
    available_channels: ['primary-channel'],
    available_agents: [{ id: 'agent-primary', name: 'Primary Agent' }],
  },
};

/** Shape from GET /api/admin/users (Keycloak list — UserManagementTab) */
const mockUsersListResponse = {
  users: [
    {
      id: 'kc-admin',
      username: 'admin',
      email: 'admin@example.com',
      firstName: 'Admin',
      lastName: 'User',
      enabled: true,
      attributes: {} as Record<string, string[]>,
      roles: ['admin'],
    },
    {
      id: 'kc-user',
      username: 'user',
      email: 'user@example.com',
      firstName: 'Regular',
      lastName: 'User',
      enabled: true,
      attributes: {} as Record<string, string[]>,
      roles: ['user'],
    },
  ],
  total: 2,
  page: 1,
  pageSize: 20,
};

const mockTeamsResponse = {
  success: true,
  data: {
    teams: [
      {
        _id: 'team-1',
        name: 'Platform Team',
        slug: 'platform-team',
        description: 'The platform engineering team',
        owner_id: 'admin@example.com',
        created_at: new Date().toISOString(),
        // Production list responses expose the canonical count and intentionally
        // omit the retired embedded members[]. Team filters must use the slug.
        member_count: 2,
      },
    ],
  },
};

const mockFeedbackResponse = {
  success: true,
  data: {
    entries: [],
    pagination: { page: 1, limit: 50, total: 0, total_pages: 0 },
  },
};

const mockConfigResponse = {
  success: true,
  data: { auditLogsEnabled: true },
};

const allGatesOpen = {
  users: true,
  teams: true,
  roles: true,
  slack: true,
  webex: true,
  skills: true,
  feedback: true,
  stats: true,
  metrics: true,
  health: true,
  audit_logs: true,
  action_audit: true,
  openfga: true,
  migrations: true,
};

const baselineUserGates = {
  ...allGatesOpen,
  roles: false,
  metrics: false,
  audit_logs: false,
  action_audit: false,
  openfga: false,
  migrations: false,
};

function setupFetchMock(overrides: {
  tabGates?: Record<string, boolean>;
  integrationPanelModes?: { slack: string; webex: string };
  simulation?: unknown;
  userPreferences?: unknown;
} = {}): jest.Mock {
  const mock = jest.fn((url: string) => {
    if (url.includes('/api/user/preferences')) {
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve(overrides.userPreferences ?? { success: true, data: {} }),
      });
    }
    if (url.includes('/api/rbac/admin-tab-gates')) {
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve({
          gates: overrides.tabGates ?? allGatesOpen,
          integration_panel_modes: overrides.integrationPanelModes ?? {
            slack: 'full',
            webex: 'full',
          },
          simulation: overrides.simulation ?? null,
        }),
      });
    }
    if (url.includes('/api/admin/stats') && !url.includes('skills')) {
      const statsResponse = typeof overrides.stats === 'function'
        ? overrides.stats(url)
        : overrides.stats;
      if (overrides.statsStatus) {
        return Promise.resolve({
          ok: overrides.statsStatus >= 200 && overrides.statsStatus < 300,
          status: overrides.statsStatus,
          json: () => Promise.resolve(statsResponse || { success: false, error: 'Forbidden' }),
        });
      }
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve(statsResponse || mockStatsResponse),
      });
    }
    if (url.includes('/api/admin/users')) {
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve(overrides.usersList ?? mockUsersListResponse),
      });
    }
    if (url.includes('/api/admin/roles')) {
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () =>
          Promise.resolve(
            overrides.roles ?? {
              success: true,
              data: {
                roles: [
                  { id: 'r1', name: 'admin', clientRole: false },
                  { id: 'r2', name: 'user', clientRole: false },
                ],
              },
            }
          ),
      });
    }
    if (url.includes('/api/admin/teams')) {
      const teamsResponse =
        typeof overrides.teams === 'function' ? overrides.teams(url) : overrides.teams;
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve(teamsResponse || mockTeamsResponse),
      });
    }
    if (url.includes('/api/admin/stats/skills')) {
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ success: false }),
      });
    }
    if (url.includes('/api/admin/feedback')) {
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve(overrides.feedback || mockFeedbackResponse),
      });
    }
    if (url.includes('/api/config')) {
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve(overrides.config || mockConfigResponse),
      });
    }
    return Promise.resolve({
      ok: true,
      json: () => Promise.resolve({ success: true, data: {} }),
    });
  });
  global.fetch = mock as unknown;
  return mock;
}

jest.spyOn(console, 'error').mockImplementation(() => {});
jest.spyOn(console, 'log').mockImplementation(() => {});

import AdminPage from '../page';
import { isDevAnonymousAuthEnabled } from '@/lib/auth/dev-auth-provider';

const mockIsDevAnonymousAuthEnabled = isDevAnonymousAuthEnabled as jest.MockedFunction<
  typeof isDevAnonymousAuthEnabled
>;

// ============================================================================
// Tests
// ============================================================================

describe('Admin Dashboard Page', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockIsAdmin = false;
    mockIsDevAnonymousAuthEnabled.mockReturnValue(true);
    currentSearchParams = new URLSearchParams();
    currentPathname = '/admin';
  });

  describe('Loading state', () => {
    it('renders the admin shell before lazy tab data loads', async () => {
      setupFetchMock();
      render(<AdminPage />);

      expect(await screen.findByRole('heading', { level: 1, name: 'Users' })).toBeInTheDocument();
      expect(screen.queryByTestId('spinner')).not.toBeInTheDocument();
    });

    it('does not eagerly fetch /api/admin/users during loadAdminData', async () => {
      // Regression: loadAdminData() used to fetch /api/admin/users in its
      // Promise.all and then discard the result. With 1000+ realm users this
      // added several seconds of Keycloak round-trips to the first paint of
      // every admin tab — even tabs that have nothing to do with users.
      // UserManagementTab now owns the only first-paint /api/admin/users
      // call, and only when the Users tab is the active tab.
      mockIsAdmin = true;
      currentPathname = '/admin/platform/agents';
      currentSearchParams = new URLSearchParams();
      const fetchMock = setupFetchMock();
      render(<AdminPage />);

      await waitFor(() => {
        expect(screen.getByRole('heading', { level: 1, name: 'Agent configuration' })).toBeInTheDocument();
      });
      expect(screen.getByTestId('import-agents-card')).toHaveAttribute('data-read-only', 'false');

      const userListCalls = fetchMock.mock.calls.filter(([url]) => {
        if (typeof url !== 'string') return false;
        // Match /api/admin/users and /api/admin/users?... but not
        // /api/admin/users/{id}/... or /api/admin/users/stats.
        return /\/api\/admin\/users(\?|$)/.test(url);
      });
      expect(userListCalls).toEqual([]);
    });
  });

  describe('Error state', () => {
    it('keeps the page usable and shows card-local errors on stats fetch failure', async () => {
      // Must be on a tab with a loader (stats) so a fetch is actually triggered.
      currentPathname = '/admin/insights/statistics';
      currentSearchParams = new URLSearchParams();
      (global.fetch as jest.Mock) = jest.fn().mockRejectedValue(new Error('Network error'));
      render(<AdminPage />);

      expect((await screen.findAllByText(/network error/i)).length).toBeGreaterThan(1);
      expect(screen.getByRole('heading', { level: 1, name: 'Statistics' })).toBeInTheDocument();
      expect(screen.queryByText('Retry')).not.toBeInTheDocument();
    });

    it('shows auth error on 401 response', async () => {
      // Must be on a tab with a loader (stats) so a fetch is actually triggered.
      currentPathname = '/admin/insights/statistics';
      currentSearchParams = new URLSearchParams();
      (global.fetch as jest.Mock) = jest.fn().mockResolvedValue({
        ok: false,
        status: 401,
        json: () => Promise.resolve({ success: false, error: 'Unauthorized' }),
      });
      render(<AdminPage />);

      await waitFor(() => {
        expect(screen.getByText(/not authenticated/i)).toBeInTheDocument();
      });
    });
  });

  describe('Read-only mode (non-admin user)', () => {
    beforeEach(() => {
      mockIsAdmin = false;
      mockIsDevAnonymousAuthEnabled.mockReturnValue(false);
      setupFetchMock({
        tabGates: baselineUserGates,
        integrationPanelModes: { slack: 'self_service', webex: 'self_service' },
      });
    });

    it('does not label the self-service admin view as read-only', async () => {
      render(<AdminPage />);

      await waitFor(() => {
        expect(screen.getByRole('heading', { name: 'Users' })).toBeInTheDocument();
      });

      expect(screen.queryByText('Read-Only')).not.toBeInTheDocument();
    });

    it('shows read-only description text', async () => {
      render(<AdminPage />);

      await waitFor(() => {
        expect(
          screen.getByText('Review people, roles, memberships, and resource access.')
        ).toBeInTheDocument();
      });
    });

    it('does not show Actions column header in users tab', async () => {
      render(<AdminPage />);

      await waitFor(() => {
        expect(screen.getByText('admin@example.com')).toBeInTheDocument();
      });

      expect(screen.queryByText('Actions')).not.toBeInTheDocument();
    });

    it('does not show Make Admin / Remove Admin buttons', async () => {
      render(<AdminPage />);

      await waitFor(() => {
        expect(screen.getByText('user@example.com')).toBeInTheDocument();
      });

      expect(screen.queryByText('Make Admin')).not.toBeInTheDocument();
      expect(screen.queryByText('Remove Admin')).not.toBeInTheDocument();
    });

    it('shows user table without Keycloak role filters or columns', async () => {
      render(<AdminPage />);

      await waitFor(() => {
        expect(screen.getByText('Email')).toBeInTheDocument();
        expect(screen.getByText('Name')).toBeInTheDocument();
      });

      const table = screen.getByRole('table');
      expect(within(table).queryByText('Roles')).not.toBeInTheDocument();
      expect(screen.queryByText('All roles')).not.toBeInTheDocument();
    });

    it('opens resource-scoped Slack and Webex panels for non-admin messaging managers', async () => {
      setupFetchMock({
        tabGates: {
          ...allGatesOpen,
          roles: false,
          feedback: false,
          stats: false,
          audit_logs: false,
          action_audit: false,
          openfga: false,
          migrations: false,
          slack: true,
          webex: true,
        },
        integrationPanelModes: {
          slack: 'self_service',
          webex: 'self_service',
        },
      });
      currentPathname = '/admin/integrations/slack';
      currentSearchParams = new URLSearchParams();

      render(<AdminPage />);

      await waitFor(() => {
        expect(screen.getByRole('button', { name: 'Integrations' })).toHaveAttribute(
          'data-active',
          'true',
        );
      });

      const navigation = screen.getByRole('navigation', { name: 'Admin sections' });
      expect(within(navigation).getByRole('link', { name: /^Slack$/i })).toHaveAttribute(
        'aria-current',
        'page',
      );
      expect(within(navigation).getByRole('link', { name: /^Webex$/i })).toBeInTheDocument();
      await waitFor(() => {
        expect(screen.getByTestId('slack-integration-panel')).toHaveAttribute('data-self-service', 'true');
      });
      expect(screen.getByTestId('slack-integration-panel')).toHaveAttribute('data-disabled', 'false');
    });

    it('shows permitted categories and only Health inside Operations', async () => {
      currentPathname = '/admin/operations/health';
      render(<AdminPage />);

      const navigation = await screen.findByRole('navigation', { name: 'Admin sections' });
      expect(within(navigation).getByRole('button', { name: 'Integrations' })).toBeInTheDocument();
      expect(within(navigation).getByRole('button', { name: 'Insights' })).toBeInTheDocument();
      expect(within(navigation).getByRole('button', { name: 'Metrics & Health' })).toHaveAttribute(
        'data-active',
        'true',
      );
      expect(within(navigation).getByRole('link', { name: 'Health' })).toHaveAttribute(
        'aria-current',
        'page',
      );
      expect(within(navigation).queryByRole('link', { name: 'Metrics' })).not.toBeInTheDocument();
    });
  });

  describe('Admin mode', () => {
    beforeEach(() => {
      mockIsAdmin = true;
      mockIsDevAnonymousAuthEnabled.mockReturnValue(true);
      setupFetchMock();
    });

    it('opens a subtle searchable view-as modal from the category bar', async () => {
      render(<AdminPage />);

      await waitFor(() => {
        expect(screen.getByRole('button', { name: /view as/i })).toBeInTheDocument();
      });
      expect(screen.queryByText(/Read-only simulator\. The UI stays authenticated as you/i)).not.toBeInTheDocument();

      fireEvent.click(screen.getByRole('button', { name: /view as/i }));

      expect(screen.getByRole('dialog')).toBeInTheDocument();
      expect(screen.getByText('View As — Read-Only Access Preview')).toBeInTheDocument();
      expect(screen.getByText(/does not sign in as them or change your current session/i)).toBeInTheDocument();
      const search = screen.getByPlaceholderText(/search by email, name, or user id/i);
      fireEvent.change(search, { target: { value: 'user' } });

      await waitFor(() => {
        expect(global.fetch).toHaveBeenCalledWith('/api/admin/users?search=user&pageSize=20');
      });

      fireEvent.click(await screen.findByRole('button', { name: /Regular User user@example.com kc-user/i }));
      fireEvent.click(screen.getByRole('button', { name: 'Preview' }));

      expect(replaceMock).toHaveBeenCalledWith(
        expect.stringContaining('simulate_type=user&simulate_id=kc-user'),
        { scroll: false }
      );
    });

    it('shows the simulated user name and baseline navigation instead of a blank shell', async () => {
      currentSearchParams = new URLSearchParams('simulate_type=user&simulate_id=kc-user');
      setupFetchMock({
        tabGates: {
          ...allGatesOpen,
          roles: false,
          identity_group_sync: false,
          slack: true,
          webex: true,
          feedback: true,
          stats: true,
          metrics: false,
          audit_logs: false,
          action_audit: false,
          openfga: false,
          migrations: false,
        },
        simulation: {
          active: true,
          readonly: true,
          subject: {
            type: 'user',
            id: 'kc-user',
            openfga_user: 'user:kc-user',
            display_name: 'Regular User',
            email: 'user@example.com',
          },
        },
        integrationPanelModes: {
          slack: 'self_service',
          webex: 'self_service',
        },
      });

      render(<AdminPage />);

      expect(await screen.findByRole('button', { name: /viewing as regular user/i })).toBeInTheDocument();
      expect(screen.queryByText(/previewing regular user's effective access/i)).not.toBeInTheDocument();
      expect(screen.getByText('Review people, roles, memberships, and resource access.')).toBeInTheDocument();
      expect(screen.queryByText('Access Preview · Read-Only')).not.toBeInTheDocument();
      expect(screen.queryByText(/no user session is impersonated/i)).not.toBeInTheDocument();
      const navigation = await screen.findByRole('navigation', { name: 'Admin sections' });
      expect(within(navigation).getByRole('button', { name: 'Teams & Users' })).toHaveAttribute(
        'data-active',
        'true',
      );
      expect(within(navigation).getByRole('link', { name: 'Users' })).toHaveAttribute(
        'aria-current',
        'page',
      );
      expect(within(navigation).getByRole('link', { name: 'Teams' })).toBeInTheDocument();
      expect(within(navigation).getByRole('button', { name: 'Integrations' })).toBeInTheDocument();
      expect(within(navigation).getByRole('button', { name: 'Insights' })).toBeInTheDocument();
      expect(within(navigation).getByRole('button', { name: 'Metrics & Health' })).toBeInTheDocument();
      expect(within(navigation).getByRole('link', { name: 'Users' })).toHaveAttribute(
        'href',
        expect.stringContaining('simulate_type=user'),
      );
      expect(screen.queryByText(/No Admin access is available/i)).not.toBeInTheDocument();
    });

    it('scopes Teams & Users data requests to the selected preview account', async () => {
      currentPathname = '/admin/people/users';
      currentSearchParams = new URLSearchParams('simulate_type=user&simulate_id=kc-user');
      const fetchMock = setupFetchMock({
        tabGates: baselineUserGates,
        simulation: {
          active: true,
          readonly: true,
          subject: {
            type: 'user',
            id: 'kc-user',
            openfga_user: 'user:kc-user',
            display_name: 'Regular User',
          },
        },
      });

      render(<AdminPage />);

      await waitFor(() => {
        expect(fetchMock).toHaveBeenCalledWith(
          '/api/admin/users?page=1&pageSize=20&simulate_type=user&simulate_id=kc-user'
        );
        expect(fetchMock).toHaveBeenCalledWith(
          '/api/admin/teams?simulate_type=user&simulate_id=kc-user'
        );
      });

    });

    it('scopes the Teams grid request to the selected preview account', async () => {
      currentPathname = '/admin/people/teams';
      currentSearchParams = new URLSearchParams('simulate_type=user&simulate_id=kc-user');
      const fetchMock = setupFetchMock({
        tabGates: baselineUserGates,
        simulation: {
          active: true,
          readonly: true,
          subject: {
            type: 'user',
            id: 'kc-user',
            openfga_user: 'user:kc-user',
            display_name: 'Regular User',
          },
        },
      });

      render(<AdminPage />);

      await waitFor(() => {
        const gridRequest = fetchMock.mock.calls.find(([url]) =>
          typeof url === 'string'
          && url.includes('/api/admin/teams?page=1')
          && url.includes('simulate_type=user')
          && url.includes('simulate_id=kc-user')
        );
        expect(gridRequest).toBeDefined();
      });
    });

    it('uses a simulated admin\'s effective access while keeping the preview read-only', async () => {
      currentPathname = '/admin/platform/agents';
      currentSearchParams = new URLSearchParams('simulate_type=user&simulate_id=admin-target');
      setupFetchMock({
        tabGates: {
          ...allGatesOpen,
          credentials: true,
          service_accounts: true,
        },
        simulation: {
          active: true,
          readonly: true,
          subject: {
            type: 'user',
            id: 'admin-target',
            openfga_user: 'user:admin-target',
            display_name: 'Target Admin',
            organization_admin: true,
          },
        },
        integrationPanelModes: {
          slack: 'full',
          webex: 'full',
        },
      });

      render(<AdminPage />);

      expect(await screen.findByRole('button', { name: /viewing as target admin/i })).toBeInTheDocument();
      const navigation = await screen.findByRole('navigation', { name: 'Admin sections' });
      expect(within(navigation).getByRole('button', { name: 'Resources' })).toHaveAttribute(
        'data-active',
        'true',
      );
      for (const label of [
        'Agent configuration',
        'MCP Catalog',
        'RAG',
        'Skill Hubs',
        'Service Accounts',
        'Credentials',
      ]) {
        expect(within(navigation).getByRole('link', { name: label })).toBeInTheDocument();
      }
      expect(within(navigation).getByRole('link', { name: 'Agent configuration' })).toHaveAttribute(
        'aria-current',
        'page',
      );
      expect(screen.getByTestId('import-agents-card')).toHaveAttribute('data-read-only', 'true');
    });

    it('scopes Feedback requests to the selected preview account', async () => {
      currentPathname = '/admin/insights/feedback';
      currentSearchParams = new URLSearchParams('simulate_type=user&simulate_id=kc-user');
      setupFetchMock({
        tabGates: baselineUserGates,
        integrationPanelModes: {
          slack: 'self_service',
          webex: 'self_service',
        },
        simulation: {
          active: true,
          readonly: true,
          subject: {
            type: 'user',
            id: 'kc-user',
            openfga_user: 'user:kc-user',
            display_name: 'Regular User',
            email: 'user@example.com',
          },
        },
      });

      render(<AdminPage />);

      await waitFor(() => {
        expect(global.fetch).toHaveBeenCalledWith(
          expect.stringMatching(/\/api\/admin\/feedback\?.*simulate_type=user.*simulate_id=kc-user/)
        );
      });
    });

    it('does not show Read-Only badge', async () => {
      render(<AdminPage />);

      await waitFor(() => {
        expect(screen.getByRole('heading', { level: 1, name: 'Users' })).toBeInTheDocument();
      });

      expect(screen.queryByText('Read-Only')).not.toBeInTheDocument();
    });

    it('shows admin description text', async () => {
      render(<AdminPage />);

      await waitFor(() => {
        expect(
          screen.getByText('Review people, roles, memberships, and resource access.')
        ).toBeInTheDocument();
      });
    });

    it('shows UserManagementTab column headers', async () => {
      currentPathname = '/admin/people/users';
      currentSearchParams = new URLSearchParams();

      render(<AdminPage />);

      await waitFor(() => {
        expect(screen.getByText('admin@example.com')).toBeInTheDocument();
      });

      const table = screen.getByRole('table');
      expect(within(table).getByText('Name')).toBeInTheDocument();
      expect(within(table).getByText('Email')).toBeInTheDocument();
      expect(within(table).queryByText('Roles')).not.toBeInTheDocument();
    });

    it('exposes Slack linked as a user table filter', async () => {
      currentPathname = '/admin/people/users';
      currentSearchParams = new URLSearchParams('umSlack=linked');
      const fetchMock = setupFetchMock();

      render(<AdminPage />);

      await waitFor(() => {
        expect(screen.getByText('admin@example.com')).toBeInTheDocument();
      });

      const slackLabel = screen.getByText('Slack', { selector: 'span.text-xs' });
      const slackFilter = slackLabel.parentElement?.querySelector('select');
      expect(slackFilter).toBeDefined();
      expect(slackFilter).toHaveValue('linked');

      await waitFor(() => {
        expect(fetchMock).toHaveBeenCalledWith(
          expect.stringContaining('/api/admin/users?page=1&pageSize=20&slackStatus=linked')
        );
      });

      fireEvent.change(slackFilter!, { target: { value: 'unlinked' } });
      expect(replaceMock).toHaveBeenCalledWith(
        expect.stringContaining('umSlack=unlinked'),
        { scroll: false }
      );
    });

    it('exposes Webex linked as a user table filter', async () => {
      currentPathname = '/admin/people/users';
      currentSearchParams = new URLSearchParams('umWebex=linked');
      const fetchMock = setupFetchMock();

      render(<AdminPage />);

      await waitFor(() => {
        expect(screen.getByText('admin@example.com')).toBeInTheDocument();
      });

      const webexLabel = screen.getByText('Webex', { selector: 'span.text-xs' });
      const webexFilter = webexLabel.parentElement?.querySelector('select');
      expect(webexFilter).toBeDefined();
      expect(webexFilter).toHaveValue('linked');

      await waitFor(() => {
        expect(fetchMock).toHaveBeenCalledWith(
          expect.stringContaining('/api/admin/users?page=1&pageSize=20&webexStatus=linked')
        );
      });

      fireEvent.change(webexFilter!, { target: { value: 'unlinked' } });
      expect(replaceMock).toHaveBeenCalledWith(
        expect.stringContaining('umWebex=unlinked'),
        { scroll: false }
      );
    });

    it('renders Autonomous Enablement as its own Security & Policy page', async () => {
      mockIsAdmin = true;
      currentPathname = '/admin/security/autonomous-enablement';
      setupFetchMock();

      render(<AdminPage />);

      expect(await screen.findByTestId('autonomous-enablement-panel')).toBeInTheDocument();
      const navigation = screen.getByRole('navigation', { name: 'Admin sections' });
      expect(
        within(navigation).getByRole('link', { name: /^Autonomous Enablement$/i }),
      ).toHaveAttribute('aria-current', 'page');
    });

    it('orders Security & Policy destinations and omits Permissions Tool', async () => {
      currentPathname = '/admin/security/rbac-audit';

      render(<AdminPage />);

      const navigation = await screen.findByRole('navigation', { name: 'Admin sections' });
      const destinationLabels = [
        'Access before sign-in',
        'AI Review',
        'Autonomous Enablement',
        'RBAC Audit',
        'Approvals',
        'Access Explorer',
        'Self Check',
        'Chat Audit',
        'Keycloak',
        'Migrations',
      ];
      const renderedLinks = within(navigation)
        .getAllByRole('link')
        .map((link) => link.textContent?.trim())
        .filter((label): label is string => destinationLabels.includes(label ?? ''));
      expect(renderedLinks).toEqual(destinationLabels);
      expect(within(navigation).getByRole('link', { name: /^RBAC Audit$/i })).toHaveAttribute(
        'aria-current',
        'page',
      );
      expect(
        within(navigation).queryByRole('link', { name: /^Permissions Tool$/i }),
      ).not.toBeInTheDocument();
      for (const subgroup of ['Policy', 'Authorization', 'Audit', 'Identity & maintenance']) {
        expect(within(navigation).queryByText(subgroup)).not.toBeInTheDocument();
      }
    });

    it('does not show Keycloak role badges for listed users', async () => {
      currentPathname = '/admin/people/users';
      currentSearchParams = new URLSearchParams();

      render(<AdminPage />);

      await waitFor(() => {
        expect(screen.getByText('user@example.com')).toBeInTheDocument();
      });

      const table = screen.getByRole('table');
      expect(within(table).queryByText('admin')).not.toBeInTheDocument();
      expect(within(table).queryByText('user')).not.toBeInTheDocument();
    });

    it("discloses categories manually and collapses the previous category after navigation", async () => {
      currentPathname = "/admin/people/users";
      setupFetchMock();
      const { rerender } = render(<AdminPage />);

      const navigation = await screen.findByRole("navigation", { name: "Admin sections" });
      const peopleCategory = within(navigation).getByRole("button", { name: "Teams & Users" });
      expect(peopleCategory).toHaveAttribute("data-active", "true");
      expect(peopleCategory).toHaveAttribute("aria-expanded", "true");
      expect(within(navigation).getByRole("link", { name: "Users" })).toHaveAttribute("aria-current", "page");
      expect(within(navigation).getByRole("link", { name: "Teams" })).toBeInTheDocument();
      expect(within(navigation).queryByRole("link", { name: "Roles" })).not.toBeInTheDocument();
      expect(within(navigation).queryByRole("link", { name: "Slack" })).not.toBeInTheDocument();

      fireEvent.click(within(navigation).getByRole("button", { name: "Integrations" }));

      expect(within(navigation).getByRole("link", { name: "Slack" })).toBeInTheDocument();
      expect(within(navigation).getByRole("link", { name: "Webex" })).toBeInTheDocument();
      expect(peopleCategory).toHaveAttribute("aria-expanded", "true");
      expect(within(navigation).getByRole("link", { name: "Users" })).toBeInTheDocument();
      expect(replaceMock).not.toHaveBeenCalled();

      currentPathname = "/admin/integrations/slack";
      rerender(<AdminPage />);

      expect(
        await screen.findByRole("heading", { level: 1, name: "Slack" }),
      ).toBeInTheDocument();
      const updatedNavigation = screen.getByRole("navigation", { name: "Admin sections" });
      expect(updatedNavigation).toBe(navigation);
      await waitFor(() => {
        expect(
          within(updatedNavigation).getByRole("button", { name: "Teams & Users" }),
        ).toHaveAttribute("aria-expanded", "false");
      });
      expect(
        within(updatedNavigation).getByRole("button", { name: "Integrations" }),
      ).toHaveAttribute("aria-expanded", "true");
    });

    it("defaults bare Admin to the canonical Users route", async () => {
      render(<AdminPage />);

      expect(await screen.findByRole("heading", { level: 1, name: "Users" })).toBeInTheDocument();
      const breadcrumb = screen.getByRole("navigation", { name: "Breadcrumb" });
      expect(within(breadcrumb).getByRole("link", { name: "Home" })).toHaveAttribute("href", "/");
      expect(within(breadcrumb).getByRole("link", { name: "Admin" })).toHaveAttribute(
        "href",
        "/admin/people/users",
      );
      expect(within(breadcrumb).getByRole("link", { name: "Teams & Users" })).toHaveAttribute(
        "href",
        "/admin/people/users",
      );
      expect(within(breadcrumb).getByRole("link", { name: "Users" })).toHaveAttribute(
        "aria-current",
        "page",
      );
      expect(
        within(screen.getByRole("navigation", { name: "Admin sections" }))
          .getByRole("link", { name: "Users" }),
      ).toHaveAttribute("aria-current", "page");
      expect(await screen.findByText("admin@example.com")).toBeInTheDocument();
      expect(replaceMock).toHaveBeenCalledWith("/admin/people/users", { scroll: false });
      expect(screen.queryByText("Settings")).not.toBeInTheDocument();
    });

    it.each([
      ["/admin/platform/rag", "RAG"],
      ["/admin/integrations/slack", "Slack"],
      ["/admin/integrations/webex", "Webex"],
      ["/admin/security/access-explorer", "Access Explorer"],
      ["/admin/security/self-check", "Self Check"],
      ["/admin/operations/metrics", "Metrics"],
      ["/admin/operations/health", "Health"],
    ])("selects canonical destination %s", async (path, label) => {
      currentPathname = path;
      render(<AdminPage />);

      expect(await screen.findByRole("heading", { level: 1, name: label })).toBeInTheDocument();
      expect(
        within(screen.getByRole("navigation", { name: "Admin sections" }))
          .getByRole("link", { name: label }),
      ).toHaveAttribute("aria-current", "page");
      expect(replaceMock).not.toHaveBeenCalled();
    });

    it('opens an in-app modal before deleting a team', async () => {
      currentPathname = '/admin/people/teams';
      currentSearchParams = new URLSearchParams();
      const confirmSpy = jest.spyOn(window, 'confirm').mockReturnValue(false);
      const fetchMock = setupFetchMock();

      render(<AdminPage />);

      expect(await screen.findByText('Platform Team')).toBeInTheDocument();

      fireEvent.click(screen.getByRole('button', { name: /delete platform team/i }));

      expect(confirmSpy).not.toHaveBeenCalled();
      expect(
        screen.getByText(/delete the team "Platform Team"/i)
      ).toBeInTheDocument();

      fireEvent.click(screen.getByRole('button', { name: /^delete team$/i }));

      await waitFor(() => {
        expect(fetchMock).toHaveBeenCalledWith('/api/admin/teams/team-1', {
          method: 'DELETE',
        });
      });

      confirmSpy.mockRestore();
    });

    it('marks the Everyone and Super Admins teams as built in', async () => {
      currentPathname = '/admin/people/teams';
      currentSearchParams = new URLSearchParams();
      setupFetchMock({
        teams: {
          success: true,
          data: {
            teams: [
              {
                _id: 'team-everyone',
                name: 'Everyone',
                slug: 'everyone',
                owner_id: 'admin@example.com',
                member_count: 2,
              },
              {
                _id: 'team-super-admins',
                name: 'Super Admins',
                slug: 'super-admins',
                owner_id: 'admin@example.com',
                member_count: 1,
              },
            ],
          },
        },
      });

      render(<AdminPage />);

      expect(
        await screen.findByLabelText(
          'Built-in team for organization-wide access.',
        ),
      ).toBeInTheDocument();
      expect(
        screen.getByLabelText('Built-in team for platform administrators.'),
      ).toBeInTheDocument();
    });

    // The team card was decluttered to four high-signal chips (Members,
    // Agents, MCPs, KBs); the Slack/Webex "Chat" chip was dropped — those
    // surfaces remain reachable via the team-management dialog tabs.

    it('shows the KB chip count from the server-decorated kb_count', async () => {
      // KB grants are sourced from OpenFGA and decorated onto each team as
      // `kb_count` by GET /api/admin/teams; the card no longer derives the
      // count from a `resources.knowledge_bases` array.
      currentPathname = '/admin/people/teams';
      currentSearchParams = new URLSearchParams();
      setupFetchMock({
        teams: {
          success: true,
          data: {
            teams: [
              {
                _id: 'team-kbs',
                name: 'KB Team',
                owner_id: 'admin@example.com',
                created_at: new Date().toISOString(),
                member_count: 1,
                members: [],
                kb_count: 2,
              },
            ],
          },
        },
      });

      render(<AdminPage />);

      expect(await screen.findByText('KB Team')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /2 KBs/i })).toBeInTheDocument();
    });

    it('filters teams by search text and shows an empty result state', async () => {
      currentPathname = '/admin/people/teams';
      currentSearchParams = new URLSearchParams();
      // The Teams grid is server-paginated: search is sent to the API as a
      // `search` query param and the server returns the matching page. The
      // mock mirrors that — it filters by the `search` param so the debounced
      // re-query drives the UI exactly as the real endpoint would.
      const allTeams = [
        {
          _id: 'team-platform',
          name: 'Platform Team',
          description: 'Core platform engineering',
          owner_id: 'platform-owner@example.com',
          created_at: new Date().toISOString(),
          members: [
            { user_id: 'platform-owner@example.com', role: 'owner', added_at: new Date().toISOString() },
          ],
        },
        {
          _id: 'team-security',
          name: 'Security Team',
          description: 'Guardrails and audits',
          owner_id: 'security-owner@example.com',
          created_at: new Date().toISOString(),
          members: [
            { user_id: 'security-owner@example.com', role: 'owner', added_at: new Date().toISOString() },
          ],
        },
      ];
      setupFetchMock({
        teams: (url: string) => {
          const search = new URL(url, 'http://localhost').searchParams.get('search')?.toLowerCase() ?? '';
          const matched = search
            ? allTeams.filter((t) => t.name.toLowerCase().includes(search))
            : allTeams;
          return {
            success: true,
            data: { teams: matched, total: matched.length, page: 1, page_size: 12, has_more: false },
          };
        },
      });

      render(<AdminPage />);

      expect(await screen.findByText('Platform Team')).toBeInTheDocument();
      expect(screen.getByText('Security Team')).toBeInTheDocument();

      fireEvent.change(
        screen.getByRole('searchbox', { name: /search teams/i }),
        { target: { value: 'security' } }
      );

      // Debounced server re-query drops the non-matching team.
      await waitFor(() => {
        expect(screen.queryByText('Platform Team')).not.toBeInTheDocument();
      });
      expect(screen.getByText('Security Team')).toBeInTheDocument();

      fireEvent.change(
        screen.getByRole('searchbox', { name: /search teams/i }),
        { target: { value: 'does-not-exist' } }
      );

      expect(await screen.findByText(/No teams match "does-not-exist"/i)).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /clear team search/i })).toBeInTheDocument();
    });

    it('refreshes teams from the database without reloading the whole admin dashboard', async () => {
      currentPathname = '/admin/people/teams';
      currentSearchParams = new URLSearchParams();
      let teamFetchCount = 0;
      const fetchMock = setupFetchMock({
        teams: () => {
          teamFetchCount += 1;
          return {
            success: true,
            data: {
              teams: [
                {
                  _id: `team-${teamFetchCount}`,
                  name: teamFetchCount === 1 ? 'Platform Team' : 'Security Team',
                  description: teamFetchCount === 1 ? 'Initial team' : 'Fresh team from MongoDB',
                  owner_id: 'admin@example.com',
                  created_at: new Date().toISOString(),
                  members: [
                    { user_id: 'admin@example.com', role: 'owner', added_at: new Date().toISOString() },
                  ],
                },
              ],
            },
          };
        },
      });

      render(<AdminPage />);

      expect(await screen.findByText('Platform Team')).toBeInTheDocument();

      fireEvent.click(screen.getByRole('button', { name: /refresh teams/i }));

      expect(await screen.findByText('Security Team')).toBeInTheDocument();
      expect(screen.queryByText('Platform Team')).not.toBeInTheDocument();

      const teamRequests = fetchMock.mock.calls.filter(([url]) =>
        String(url).includes('/api/admin/teams')
      );
      expect(teamRequests).toHaveLength(2);
      // The grid is server-paginated, so every request carries page/page_size
      // plus the cache-busting `fresh` stamp and hits with cache: 'no-store'.
      expect(teamRequests[0][0]).toEqual(expect.stringContaining('/api/admin/teams?'));
      expect(teamRequests[0][0]).toEqual(expect.stringContaining('fresh='));
      expect(teamRequests[0][1]).toMatchObject({ cache: 'no-store' });
      expect(teamRequests[1][0]).toEqual(expect.stringContaining('/api/admin/teams?'));
      expect(teamRequests[1][0]).toEqual(expect.stringContaining('fresh='));
      expect(teamRequests[1][1]).toMatchObject({ cache: 'no-store' });
    });

    it('does not request archived teams or show the Archived badge by default', async () => {
      currentPathname = '/admin/people/teams';
      currentSearchParams = new URLSearchParams();
      const fetchMock = setupFetchMock();

      render(<AdminPage />);

      expect(await screen.findByText('Platform Team')).toBeInTheDocument();
      expect(screen.queryByText('Archived')).not.toBeInTheDocument();

      const teamRequests = fetchMock.mock.calls.filter(([url]) =>
        String(url).includes('/api/admin/teams')
      );
      expect(teamRequests.length).toBeGreaterThan(0);
      teamRequests.forEach(([url]) => {
        expect(String(url)).not.toContain('include_archived=true');
      });
    });

    it('requests archived teams when "Show archived" is checked', async () => {
      currentPathname = '/admin/people/teams';
      currentSearchParams = new URLSearchParams();
      const fetchMock = setupFetchMock();

      render(<AdminPage />);

      expect(await screen.findByText('Platform Team')).toBeInTheDocument();

      fireEvent.click(screen.getByLabelText(/show archived/i));

      await waitFor(() => {
        const teamRequests = fetchMock.mock.calls.filter(([url]) =>
          String(url).includes('/api/admin/teams')
        );
        expect(
          teamRequests.some(([url]) => String(url).includes('include_archived=true'))
        ).toBe(true);
      });
    });

    it('renders the Archived badge for teams with status "archived"', async () => {
      currentPathname = '/admin/people/teams';
      currentSearchParams = new URLSearchParams();
      setupFetchMock({
        teams: (url: string) => {
          const includeArchived = new URL(url, 'http://localhost').searchParams.get('include_archived') === 'true';
          const teams = includeArchived
            ? [
                {
                  _id: 'team-archived',
                  name: 'Retired Team',
                  owner_id: 'admin@example.com',
                  created_at: new Date().toISOString(),
                  member_count: 1,
                  members: [],
                  status: 'archived',
                },
              ]
            : [];
          return { success: true, data: { teams, total: teams.length, page: 1, page_size: 12 } };
        },
      });

      render(<AdminPage />);

      fireEvent.click(screen.getByLabelText(/show archived/i));

      expect(await screen.findByText('Retired Team')).toBeInTheDocument();
      expect(screen.getByText('Archived')).toBeInTheDocument();
    });
  });

  describe('Insights filter deep links', () => {
    it('makes the default Statistics range explicit in the canonical URL', async () => {
      currentPathname = '/admin/insights/statistics';
      currentSearchParams = new URLSearchParams();
      setupFetchMock();

      render(<AdminPage />);

      await waitFor(() => {
        expect(replaceMock).toHaveBeenCalledWith(
          '/admin/insights/statistics?dateRange=30d',
          { scroll: false },
        );
      });
    });

    it('applies Statistics URL filters to the first card requests', async () => {
      currentPathname = '/admin/insights/statistics';
      currentSearchParams = new URLSearchParams({
        source: 'slack',
        statsChannels: 'primary-channel',
        statsAgents: 'agent-primary',
        statsIncludeBots: 'true',
        users: 'test-user@example.com',
        dateRange: '7d',
      });
      const fetchMock = setupFetchMock();

      render(<AdminPage />);
      await screen.findByText('42');

      const statsUrls = fetchMock.mock.calls
        .map(([url]) => new URL(url, 'http://localhost'))
        .filter((url) => url.pathname === '/api/admin/stats');
      expect(statsUrls.length).toBeGreaterThan(0);
      expect(statsUrls.every((url) => (
        url.searchParams.get('source') === 'slack'
        && url.searchParams.get('channel') === 'primary-channel'
        && url.searchParams.get('agent') === 'agent-primary'
        && url.searchParams.get('include_bots') === 'true'
        && url.searchParams.get('user') === 'test-user@example.com'
        && url.searchParams.get('range') === '7d'
      ))).toBe(true);
      expect(screen.getByLabelText(/show bot users/i)).toBeChecked();
      expect(await screen.findByRole('button', { name: /Primary Agent/ })).toBeInTheDocument();

      fireEvent.click(screen.getByLabelText(/show bot users/i));
      const updatedStatsUrl = new URL(replaceMock.mock.calls.at(-1)?.[0], 'http://localhost');
      expect(updatedStatsUrl.searchParams.has('statsIncludeBots')).toBe(false);
      expect(updatedStatsUrl.searchParams.get('statsChannels')).toBe('primary-channel');
      expect(updatedStatsUrl.searchParams.get('statsAgents')).toBe('agent-primary');
    });

    it('applies Feedback URL filters to the initial request', async () => {
      currentPathname = '/admin/insights/feedback';
      currentSearchParams = new URLSearchParams({
        source: 'slack',
        channels: 'primary-channel',
        rating: 'negative',
        search: 'incorrect',
        users: 'team:Platform Team,test-user@example.com',
        dateRange: '7d',
      });
      const fetchMock = setupFetchMock({
        feedback: {
          ...mockFeedbackResponse,
          data: {
            ...mockFeedbackResponse.data,
            channels: ['primary-channel'],
            users: ['test-user@example.com'],
          },
        },
      });

      render(<AdminPage />);

      await waitFor(() => {
        expect(fetchMock.mock.calls.some(([url]) => String(url).startsWith('/api/admin/feedback?'))).toBe(true);
      });
      const feedbackUrls = fetchMock.mock.calls
        .map(([url]) => new URL(url, 'http://localhost'))
        .filter((url) => url.pathname === '/api/admin/feedback');
      expect(feedbackUrls).toHaveLength(1);
      const feedbackUrl = feedbackUrls[0];
      expect(feedbackUrl.searchParams.get('source')).toBe('slack');
      expect(feedbackUrl.searchParams.get('channel')).toBe('primary-channel');
      expect(feedbackUrl.searchParams.get('rating')).toBe('negative');
      expect(feedbackUrl.searchParams.get('search')).toBe('incorrect');
      expect(feedbackUrl.searchParams.get('team')).toBe('platform-team');
      expect(feedbackUrl.searchParams.get('user')).toBe('test-user@example.com');
      const from = Date.parse(feedbackUrl.searchParams.get('from') ?? '');
      const to = Date.parse(feedbackUrl.searchParams.get('to') ?? '');
      expect(to - from).toBeGreaterThanOrEqual(6.9 * 24 * 60 * 60 * 1000);
      expect(to - from).toBeLessThanOrEqual(7.1 * 24 * 60 * 60 * 1000);
      expect(screen.getByRole('button', { name: 'negative' })).toHaveClass('bg-primary');

      fireEvent.click(screen.getByRole('button', { name: 'all' }));
      const updatedFeedbackUrl = new URL(replaceMock.mock.calls.at(-1)?.[0], 'http://localhost');
      expect(updatedFeedbackUrl.searchParams.has('rating')).toBe(false);
      expect(updatedFeedbackUrl.searchParams.get('source')).toBe('slack');
      expect(updatedFeedbackUrl.searchParams.get('channels')).toBe('primary-channel');
    });
  });

  describe('Webex source option', () => {
    it('shows a Webex option in the Statistics source picker when Webex is enabled', async () => {
      currentPathname = '/admin/insights/statistics';
      const fetchMock = setupFetchMock({
        userPreferences: { success: true, data: { integrations: { webex: true } } },
      });

      render(<AdminPage />);
      await screen.findByText('42');

      const sourceSelect = await screen.findByDisplayValue('All Sources');
      expect(within(sourceSelect as HTMLElement).getByRole('option', { name: 'Webex' })).toBeInTheDocument();

      fireEvent.change(sourceSelect, { target: { value: 'webex' } });

      await waitFor(() => {
        const sourceRefreshes = fetchMock.mock.calls.filter(([url]) => {
          const parsed = new URL(url, 'http://localhost');
          return parsed.pathname === '/api/admin/stats' && parsed.searchParams.get('source') === 'webex';
        });
        expect(sourceRefreshes.length).toBeGreaterThan(0);
      });
      expect(sourceSelect).toHaveValue('webex');
    });

    it('omits the Webex option from the Statistics source picker when Webex is disabled', async () => {
      currentPathname = '/admin/insights/statistics';
      setupFetchMock({
        userPreferences: { success: true, data: { integrations: { webex: false } } },
      });

      render(<AdminPage />);
      await screen.findByText('42');

      const sourceSelect = await screen.findByDisplayValue('All Sources');
      expect(within(sourceSelect as HTMLElement).queryByRole('option', { name: 'Webex' })).not.toBeInTheDocument();
    });

    it('never shows a Webex option in the Feedback source picker, regardless of the Webex flag', async () => {
      currentPathname = '/admin/insights/feedback';
      setupFetchMock({
        userPreferences: { success: true, data: { integrations: { webex: true } } },
      });

      render(<AdminPage />);

      const sourceSelect = await screen.findByDisplayValue('All Sources');
      expect(within(sourceSelect as HTMLElement).queryByRole('option', { name: 'Webex' })).not.toBeInTheDocument();
    });
  });

  describe('API source option', () => {
    it('always shows an API option in the Statistics source picker, unlike Webex there is no enablement flag', async () => {
      currentPathname = '/admin/insights/statistics';
      const fetchMock = setupFetchMock({
        userPreferences: { success: true, data: { integrations: { webex: false } } },
      });

      render(<AdminPage />);
      await screen.findByText('42');

      const sourceSelect = await screen.findByDisplayValue('All Sources');
      expect(within(sourceSelect as HTMLElement).getByRole('option', { name: 'API' })).toBeInTheDocument();

      fireEvent.change(sourceSelect, { target: { value: 'api' } });

      await waitFor(() => {
        const sourceRefreshes = fetchMock.mock.calls.filter(([url]) => {
          const parsed = new URL(url, 'http://localhost');
          return parsed.pathname === '/api/admin/stats' && parsed.searchParams.get('source') === 'api';
        });
        expect(sourceRefreshes.length).toBeGreaterThan(0);
      });
      expect(sourceSelect).toHaveValue('api');
    });

    it('never shows an API option in the Feedback source picker', async () => {
      currentPathname = '/admin/insights/feedback';
      setupFetchMock({
        userPreferences: { success: true, data: { integrations: { webex: true } } },
      });

      render(<AdminPage />);

      const sourceSelect = await screen.findByDisplayValue('All Sources');
      expect(within(sourceSelect as HTMLElement).queryByRole('option', { name: 'API' })).not.toBeInTheDocument();
    });
  });

  describe('Stats rendering', () => {
    beforeEach(() => {
      currentPathname = '/admin/insights/statistics';
      setupFetchMock();
    });

    it('renders overview stat cards and detailed charts on Statistics', async () => {
      currentPathname = '/admin/insights/statistics';
      render(<AdminPage />);

      await waitFor(() => {
        expect(screen.getByText('42')).toBeInTheDocument();
      });

      expect(
        within(screen.getByRole('navigation', { name: 'Admin sections' }))
          .getByRole('link', { name: /^Statistics$/i }),
      ).toHaveAttribute(
        'aria-current',
        'page',
      );
      expect(screen.getByText('Total Users')).toBeInTheDocument();
      expect(screen.getByText('Conversations')).toBeInTheDocument();
      expect(screen.getByText('Messages')).toBeInTheDocument();
      expect(screen.getByText('Daily Active Users (DAU)')).toBeInTheDocument();
      expect(screen.queryByText('NaN')).not.toBeInTheDocument();
    });

    it('does not refresh the default 30-day stats after entering Statistics', async () => {
      const fetchMock = setupFetchMock();
      render(<AdminPage />);

      await screen.findByText('42');
      await act(async () => {
        await new Promise((resolve) => window.setTimeout(resolve, 200));
      });

      const statsUrls = fetchMock.mock.calls
        .map(([url]) => new URL(url, 'http://localhost'))
        .filter((url) => url.pathname === '/api/admin/stats');
      expect(statsUrls).toHaveLength(12);
      expect(new Set(statsUrls.map((url) => url.searchParams.get('section'))).size).toBe(12);
      expect(statsUrls.every((url) => url.searchParams.get('range') === '30d')).toBe(true);
    });

    it('passes positive and negative daily feedback as separate chart series', async () => {
      setupFetchMock({
        stats: {
          ...mockStatsResponse,
          data: {
            ...mockStatsResponse.data,
            feedback_summary: {
              positive: 8,
              negative: 3,
              total: 11,
              daily: [{ date: '2026-07-20', positive: 8, negative: 3 }],
            },
          },
        },
      });
      render(<AdminPage />);

      fireEvent.click(await screen.findByRole('button', { name: 'Insights' }));

      const chart = await screen.findByTestId('feedback-trend-chart');
      expect(chart).toHaveTextContent('"positive":8');
      expect(chart).toHaveTextContent('"negative":3');
      expect(chart).not.toHaveTextContent('"value":11');
    });

    it('loads a requested Top Users page without changing the other leaderboard page', async () => {
      currentPathname = '/admin/insights/statistics';
      const fetchMock = setupFetchMock({
        stats: (url: string) => {
          const requestUrl = new URL(url, 'http://localhost');
          if (requestUrl.searchParams.get('section') !== 'top_users') {
            // Section requests return only their own payload in production.
            // Keeping unrelated responses empty prevents a later request from
            // replacing the Top Users page under test with fixture defaults.
            return { success: true, data: {} };
          }
          const conversationsPage = Number(
            requestUrl.searchParams.get('top_conversations_page') ?? '1',
          );
          const messagesPage = Number(
            requestUrl.searchParams.get('top_messages_page') ?? '1',
          );
          return {
            success: true,
            data: {
              top_users: {
                by_conversations: [{
                  _id: conversationsPage === 2
                    ? 'test-user-11@example.com'
                    : 'test-user-01@example.com',
                  name: conversationsPage === 2 ? 'Test User 11' : 'Test User 01',
                  count: 20,
                  owner_type: 'linked',
                }],
                by_messages: [{
                  _id: messagesPage === 2
                    ? 'test-message-user-11@example.com'
                    : 'test-message-user-01@example.com',
                  name: messagesPage === 2 ? 'Test Message User 11' : 'Test Message User 01',
                  count: 40,
                  owner_type: 'linked',
                }],
                pagination: {
                  by_conversations: {
                    page: conversationsPage,
                    limit: 10,
                    total: 21,
                    total_pages: 3,
                  },
                  by_messages: {
                    page: messagesPage,
                    limit: 10,
                    total: 21,
                    total_pages: 3,
                  },
                },
              },
            },
          };
        },
      });
      render(<AdminPage />);

      await screen.findByText('Test User 01');

      const pageInput = screen.getByRole('spinbutton', {
        name: 'Go to top users by conversations page',
      });
      fireEvent.change(pageInput, { target: { value: '2' } });
      fireEvent.submit(pageInput.closest('form') as HTMLFormElement);

      expect(await screen.findByText('Test User 11')).toBeInTheDocument();
      expect(screen.getByText('#11')).toBeInTheDocument();
      expect(screen.getByText('Test Message User 01')).toBeInTheDocument();

      const lastTopUsersRequest = fetchMock.mock.calls
        .map(([url]) => new URL(url, 'http://localhost'))
        .filter((url) => (
          url.pathname === '/api/admin/stats'
          && url.searchParams.get('section') === 'top_users'
        ))
        .at(-1);
      expect(lastTopUsersRequest?.searchParams.get('top_conversations_page')).toBe('2');
      expect(lastTopUsersRequest?.searchParams.get('top_messages_page')).toBe('1');
    });

    it('shows pagination loading only on the requested Top Users card', async () => {
      currentPathname = '/admin/insights/statistics';
      const topUsersResponse = (url: string) => {
        const requestUrl = new URL(url, 'http://localhost');
        if (requestUrl.searchParams.get('section') !== 'top_users') {
          return { success: true, data: {} };
        }
        const conversationsPage = Number(
          requestUrl.searchParams.get('top_conversations_page') ?? '1',
        );
        return {
          success: true,
          data: {
            top_users: {
              by_conversations: [{
                _id: conversationsPage === 2
                  ? 'test-user-11@example.com'
                  : 'test-user-01@example.com',
                name: conversationsPage === 2 ? 'Test User 11' : 'Test User 01',
                count: 20,
                owner_type: 'linked',
              }],
              by_messages: [{
                _id: 'test-message-user-01@example.com',
                name: 'Test Message User 01',
                count: 40,
                owner_type: 'linked',
              }],
              pagination: {
                by_conversations: {
                  page: conversationsPage,
                  limit: 10,
                  total: 21,
                  total_pages: 3,
                },
                by_messages: {
                  page: 1,
                  limit: 10,
                  total: 21,
                  total_pages: 3,
                },
              },
            },
          },
        };
      };
      const baseFetch = setupFetchMock({ stats: topUsersResponse });
      let deferNextTopUsersRequest = false;
      let resolveTopUsersRequest: (() => void) | undefined;
      const fetchMock = jest.fn((url: string) => {
        const requestUrl = new URL(url, 'http://localhost');
        if (
          deferNextTopUsersRequest
          && requestUrl.pathname === '/api/admin/stats'
          && requestUrl.searchParams.get('section') === 'top_users'
        ) {
          deferNextTopUsersRequest = false;
          return new Promise((resolve) => {
            resolveTopUsersRequest = () => resolve({
              ok: true,
              status: 200,
              json: () => Promise.resolve(topUsersResponse(url)),
            });
          });
        }
        return baseFetch(url);
      });
      global.fetch = fetchMock as unknown as typeof fetch;

      render(<AdminPage />);
      await screen.findByText('Test User 01');

      deferNextTopUsersRequest = true;
      fireEvent.click(screen.getByRole('button', {
        name: 'Next top users by conversations page',
      }));

      await waitFor(() => {
        expect(
          screen.getByTestId('stats-card-top-users-conversations'),
        ).toHaveAttribute('aria-busy', 'true');
        expect(
          screen.getByTestId('stats-card-top-users-messages'),
        ).toHaveAttribute('aria-busy', 'false');
      });
      expect(screen.getByText('Test Message User 01')).toBeInTheDocument();

      await act(async () => {
        resolveTopUsersRequest?.();
      });
      expect(await screen.findByText('Test User 11')).toBeInTheDocument();
    });

    it('pushes canonical Feedback history with the clicked trend date', async () => {
      currentSearchParams = new URLSearchParams({
        source: 'slack',
        users: 'test-user@example.com',
        statsAgents: 'agent-primary',
        dateRange: '30d',
      });
      setupFetchMock({
        stats: {
          ...mockStatsResponse,
          data: {
            ...mockStatsResponse.data,
            feedback_summary: {
              positive: 8,
              negative: 3,
              total: 11,
              daily: [{ date: '2026-07-20', positive: 8, negative: 3 }],
            },
          },
        },
      });

      render(<AdminPage />);

      fireEvent.click(await screen.findByRole('button', { name: 'View feedback for Jul 20' }));

      const targetUrl = new URL(pushMock.mock.calls.at(-1)?.[0], 'http://localhost');
      expect(targetUrl.pathname).toBe('/admin/insights/feedback');
      expect(targetUrl.searchParams.get('dateRange')).toBe('custom');
      expect(targetUrl.searchParams.get('from')).toBe(
        new Date(2026, 6, 20, 0, 0, 0, 0).toISOString(),
      );
      expect(targetUrl.searchParams.get('to')).toBe(
        new Date(2026, 6, 20, 23, 59, 59, 999).toISOString(),
      );
      expect(targetUrl.searchParams.get('source')).toBe('slack');
      expect(targetUrl.searchParams.get('users')).toBe('test-user@example.com');
      expect(targetUrl.searchParams.get('statsAgents')).toBe('agent-primary');
    });

    it('resets a custom Feedback date in the canonical Statistics link', async () => {
      currentPathname = '/admin/insights/feedback';
      currentSearchParams = new URLSearchParams({
        source: 'slack',
        dateRange: 'custom',
        from: new Date(2026, 6, 20, 0, 0, 0, 0).toISOString(),
        to: new Date(2026, 6, 20, 23, 59, 59, 999).toISOString(),
      });

      render(<AdminPage />);

      const navigation = await screen.findByRole('navigation', { name: 'Admin sections' });
      const statisticsLink = within(navigation).getByRole('link', { name: 'Statistics' });
      const targetUrl = new URL(statisticsLink.getAttribute('href') ?? '', 'http://localhost');
      expect(targetUrl.pathname).toBe('/admin/insights/statistics');
      expect(targetUrl.searchParams.get('dateRange')).toBe('30d');
      expect(targetUrl.searchParams.has('from')).toBe(false);
      expect(targetUrl.searchParams.has('to')).toBe(false);
      expect(targetUrl.searchParams.get('source')).toBe('slack');
    });

    it('updates cards independently and issues one request per section when a filter changes', async () => {
      const baseFetch = setupFetchMock();
      let resolveFeedback: ((response: unknown) => void) | undefined;
      let deferFeedback = false;
      const fetchMock = jest.fn((url: string) => {
        const section = url.includes('/api/admin/stats?')
          ? new URL(url, 'http://localhost').searchParams.get('section')
          : null;
        if (deferFeedback && section === 'feedback') {
          return new Promise((resolve) => {
            resolveFeedback = resolve;
          });
        }
        return baseFetch(url);
      });
      global.fetch = fetchMock as unknown as typeof fetch;

      render(<AdminPage />);
      fireEvent.click(await screen.findByRole('button', { name: 'Insights' }));

      await waitFor(() => {
        expect(screen.getByTestId('stats-card-top-agents')).toHaveAttribute('aria-busy', 'false');
      });

      const callsBeforeFilter = fetchMock.mock.calls.length;
      deferFeedback = true;
      fireEvent.change(screen.getByDisplayValue('All Sources'), { target: { value: 'web' } });

      await waitFor(() => {
        expect(screen.getByTestId('stats-card-feedback-summary')).toHaveAttribute('aria-busy', 'true');
        expect(screen.getByTestId('stats-card-top-agents')).toHaveAttribute('aria-busy', 'false');
      });
      expect(screen.getByText('Top Agents by Usage')).toBeInTheDocument();

      const refreshCalls = fetchMock.mock.calls
        .slice(callsBeforeFilter)
        .map(([url]) => new URL(url, 'http://localhost').searchParams.get('section'))
        .filter(Boolean);
      expect(refreshCalls).toHaveLength(11);
      expect(new Set(refreshCalls).size).toBe(11);
      expect(refreshCalls).not.toContain('filters');
      const refreshUrls = fetchMock.mock.calls
        .slice(callsBeforeFilter)
        .map(([url]) => new URL(url, 'http://localhost'))
        .filter((url) => url.pathname === '/api/admin/stats');
      expect(refreshUrls).toHaveLength(11);
      expect(refreshUrls.every((url) => url.searchParams.get('source') === 'web')).toBe(true);
      await waitFor(() => {
        expect(fetchMock.mock.calls.slice(callsBeforeFilter).some(([url]) => {
          const parsed = new URL(url, 'http://localhost');
          return parsed.pathname === '/api/admin/stats/skills'
            && parsed.searchParams.get('source') === 'web';
        })).toBe(true);
      });

      resolveFeedback?.({
        ok: true,
        status: 200,
        json: () => Promise.resolve({
          success: true,
          data: { feedback_summary: mockStatsResponse.data.feedback_summary },
        }),
      });
      await waitFor(() => {
        expect(screen.getByTestId('stats-card-feedback-summary')).toHaveAttribute('aria-busy', 'false');
      });

      const callsBeforeBotFilter = fetchMock.mock.calls.length;
      fireEvent.click(screen.getByLabelText(/show bot users/i));
      await waitFor(() => {
        expect(fetchMock.mock.calls.length).toBe(callsBeforeBotFilter + 4);
      });
      const botFilterSections = fetchMock.mock.calls
        .slice(callsBeforeBotFilter)
        .map(([url]) => new URL(url, 'http://localhost').searchParams.get('section'));
      expect(new Set(botFilterSections)).toEqual(new Set([
        'top_users',
        'top_agents',
        'response_time',
        'hourly_heatmap',
      ]));
    });

    it('applies an agent selection to every card, including overview', async () => {
      const filteredStats = {
        ...mockStatsResponse,
        data: {
          ...mockStatsResponse.data,
          overview: {
            ...mockStatsResponse.data.overview,
            total_users: 7,
            total_conversations: 8,
            total_messages: 9,
          },
        },
      };
      const fetchMock = setupFetchMock({
        stats: (url: string) => new URL(url, 'http://localhost').searchParams.has('agent')
          ? filteredStats
          : mockStatsResponse,
      });

      render(<AdminPage />);
      fireEvent.click(await screen.findByRole('button', { name: 'Insights' }));
      await screen.findByText('42');

      const callsBeforeFilter = fetchMock.mock.calls.length;
      fireEvent.click(await screen.findByRole('button', { name: 'All Agents' }));
      fireEvent.click(await screen.findByRole('button', { name: 'Primary Agent' }));

      await waitFor(() => {
        const usersCard = screen.getByText('Total Users').closest('.rounded-lg');
        expect(within(usersCard as HTMLElement).getByText('7')).toBeInTheDocument();
      });

      const refreshUrls = fetchMock.mock.calls
        .slice(callsBeforeFilter)
        .map(([url]) => new URL(url, 'http://localhost'))
        .filter((url) => url.pathname === '/api/admin/stats');
      expect(refreshUrls).toHaveLength(11);
      expect(refreshUrls.every((url) => url.searchParams.get('agent') === 'agent-primary')).toBe(true);
      expect(refreshUrls.find((url) => url.searchParams.get('section') === 'overview'))
        .toBeDefined();
    });

    it('applies a Slack channel selection to every card request', async () => {
      const fetchMock = setupFetchMock();
      render(<AdminPage />);
      fireEvent.click(await screen.findByRole('button', { name: 'Insights' }));
      await screen.findByText('42');

      fireEvent.change(screen.getByDisplayValue('All Sources'), { target: { value: 'slack' } });
      await waitFor(() => {
        expect(screen.getByRole('button', { name: 'All Channels' })).toBeInTheDocument();
      });
      await waitFor(() => {
        const sourceRefreshes = fetchMock.mock.calls.filter(([url]) => {
          const parsed = new URL(url, 'http://localhost');
          return parsed.pathname === '/api/admin/stats' && parsed.searchParams.get('source') === 'slack';
        });
        expect(sourceRefreshes.length).toBeGreaterThanOrEqual(9);
      });

      const callsBeforeChannel = fetchMock.mock.calls.length;
      fireEvent.click(screen.getByRole('button', { name: 'All Channels' }));
      fireEvent.click(await screen.findByRole('button', { name: 'primary-channel' }));

      await waitFor(() => {
        const channelRefreshes = fetchMock.mock.calls
          .slice(callsBeforeChannel)
          .map(([url]) => new URL(url, 'http://localhost'))
          .filter((url) => url.pathname === '/api/admin/stats');
        expect(channelRefreshes).toHaveLength(11);
        expect(channelRefreshes.every((url) => (
          url.searchParams.get('source') === 'slack'
          && url.searchParams.get('channel') === 'primary-channel'
        ))).toBe(true);
      });
    });

    it('refreshes every card with the canonical team slug when members are not embedded', async () => {
      const fetchMock = setupFetchMock();
      render(<AdminPage />);
      fireEvent.click(await screen.findByRole('button', { name: 'Insights' }));
      await screen.findByText('42');

      fireEvent.click(screen.getByRole('button', { name: 'All Users & Teams' }));
      const callsBeforeTeam = fetchMock.mock.calls.length;
      fireEvent.click(await screen.findByRole('button', { name: 'team:Platform Team' }));

      await waitFor(() => {
        const teamRefreshes = fetchMock.mock.calls
          .slice(callsBeforeTeam)
          .map(([url]) => new URL(url, 'http://localhost'))
          .filter((url) => url.pathname === '/api/admin/stats');
        expect(teamRefreshes).toHaveLength(11);
        expect(teamRefreshes.every((url) => (
          url.searchParams.get('team') === 'platform-team'
          && url.searchParams.has('user') === false
        ))).toBe(true);
      });
      await waitFor(() => {
        expect(fetchMock.mock.calls.slice(callsBeforeTeam).some(([url]) => {
          const parsed = new URL(url, 'http://localhost');
          return parsed.pathname === '/api/admin/stats/skills'
            && parsed.searchParams.get('team') === 'platform-team'
            && parsed.searchParams.has('user') === false;
        })).toBe(true);
      });
    });

    it('renders user list with correct data', async () => {
      currentPathname = '/admin/people/users';
      render(<AdminPage />);

      await waitFor(() => {
        expect(screen.getByText('admin@example.com')).toBeInTheDocument();
        expect(screen.getByText('user@example.com')).toBeInTheDocument();
      });

      expect(screen.getByText('Admin User')).toBeInTheDocument();
      expect(screen.getByText('Regular User')).toBeInTheDocument();
    });

    it('fetches stats with a relative date preset', async () => {
      currentPathname = '/admin/insights/statistics';
      const fetchMock = setupFetchMock();

      render(<AdminPage />);

      await waitFor(() => {
        expect(fetchMock).toHaveBeenCalledWith(
          expect.stringMatching(/\/api\/admin\/stats\?.*range=30d/),
          expect.objectContaining({ signal: expect.any(AbortSignal) })
        );
      });

      // Presets stay relative, so a manual refresh advances the range endpoint.
      expect(fetchMock).toHaveBeenCalledWith(
        expect.stringMatching(/\/api\/admin\/stats\?.*range=30d/),
        expect.objectContaining({ signal: expect.any(AbortSignal) })
      );
    });

    it('updates all overview cards when the date range changes', async () => {
      const shortRangeStats = {
        ...mockStatsResponse,
        data: {
          ...mockStatsResponse.data,
          overview: {
            ...mockStatsResponse.data.overview,
            total_users: 2,
            total_conversations: 3,
            total_messages: 4,
          },
        },
      };
      setupFetchMock({
        stats: (url: string) => {
          const requestUrl = new URL(url, 'http://localhost:3000');
          if (requestUrl.searchParams.get('range') === '1h') return shortRangeStats;
          const fromParam = requestUrl.searchParams.get('from');
          const toParam = requestUrl.searchParams.get('to');
          if (fromParam && toParam) {
            const from = new Date(fromParam);
            const to = new Date(toParam);
            if (to.getTime() - from.getTime() <= 2 * 60 * 60 * 1000) {
              return shortRangeStats;
            }
          }
          return mockStatsResponse;
        },
      });

      render(<AdminPage />);
      fireEvent.click(await screen.findByRole('button', { name: 'Insights' }));
      await screen.findByText('42');

      fireEvent.click(screen.getByRole('button', { name: '1h' }));

      await waitFor(() => {
        const usersCard = screen.getByText('Total Users').closest('.rounded-lg');
        const conversationsCard = screen.getByText('Conversations').closest('.rounded-lg');
        const messagesCard = screen.getByText('Messages').closest('.rounded-lg');
        expect(within(usersCard as HTMLElement).getByText('2')).toBeInTheDocument();
        expect(within(conversationsCard as HTMLElement).getByText('3')).toBeInTheDocument();
        expect(within(messagesCard as HTMLElement).getByText('4')).toBeInTheDocument();
      });
      await waitFor(() => {
        expect((global.fetch as jest.Mock).mock.calls.some(([url]) => {
          const parsed = new URL(url, 'http://localhost');
          return parsed.pathname === '/api/admin/stats/skills'
            && parsed.searchParams.get('range') === '1h';
        })).toBe(true);
      });
    });
  });
});
