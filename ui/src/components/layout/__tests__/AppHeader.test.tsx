/**
 * Unit tests for the application chrome.
 *
 * Application rail visibility:
 * - Personal Insights is NOT a global destination (moved to user menu)
 * - Skills and Chat tabs are always visible
 * - Knowledge Bases tab is visible when RAG is enabled
 * - Admin tab is visible for admin users, disabled without MongoDB
 * - Active tab styling based on pathname
 */

import React from 'react'
import Link from 'next/link'
import {
  render as testingRender,
  screen,
  fireEvent,
  within,
  type RenderOptions,
  type RenderResult,
} from '@testing-library/react'

// ============================================================================
// Mocks — must be before imports
// ============================================================================

const mockSession = {
  data: { user: { name: 'Test User', email: 'test@test.com' } } as unknown,
  status: 'authenticated' as const,
  update: jest.fn(),
}
jest.mock('next-auth/react', () => ({
  useSession: jest.fn(() => mockSession),
}))

let mockPathname = '/chat'
// Shared spy so admin-alert popover tests can assert programmatic
// navigation. Reset in beforeEach.
const mockRouterPush = jest.fn()
jest.mock('next/navigation', () => ({
  usePathname: () => mockPathname,
  useSearchParams: () => new URLSearchParams(),
  useRouter: () => ({
    push: mockRouterPush,
    replace: jest.fn(),
    back: jest.fn(),
    forward: jest.fn(),
    refresh: jest.fn(),
    prefetch: jest.fn(),
  }),
}))

// Mock admin role hook
let mockIsAdmin = false
let mockCanAccessDynamicAgents = false
jest.mock('@/hooks/use-admin-role', () => ({
  useAdminRole: () => ({
    isAdmin: mockIsAdmin,
    canAccessDynamicAgents: mockCanAccessDynamicAgents,
  }),
}))

let mockCanUseAutonomous = false
let mockAutonomousAgentsEnabled = true
jest.mock('@/hooks/use-autonomous-capability', () => ({
  useAutonomousCapability: () => ({
    canUseAutonomous: mockCanUseAutonomous,
    loading: false,
  }),
}))

let mockAdminTabGates = {
  dynamic_agent_conversations: false,
  users: true,
  teams: true,
  skills: true,
}
jest.mock('@/hooks/useAdminTabGates', () => ({
  useAdminTabGates: () => ({
    gates: mockAdminTabGates,
    loading: false,
  }),
}))

let mockKbGates = {
  search: true,
  data_sources: true,
  graph: true,
  mcp_tools: true,
  has_any_kb: true,
  can_ingest: true,
  can_search: true,
}
let mockKbGatesLoading = false
let mockKbOrgAdminBypass = true
jest.mock('@/hooks/use-kb-tab-gates', () => ({
  useKbTabGates: () => ({
    gates: mockKbGates,
    loading: mockKbGatesLoading,
    orgAdminBypass: mockKbOrgAdminBypass,
  }),
}))

// Mock chat store
let mockStreamingConversations = new Map<string, unknown>()
let mockUnviewedConversations = new Set<string>()
let mockInputRequiredConversations = new Set<string>()
jest.mock('@/store/chat-store', () => ({
  resolveChatNavigationPath: jest.fn(
    ({ activeConversationId }: { activeConversationId?: string | null }) =>
      activeConversationId ? `/chat/${activeConversationId}` : '/chat',
  ),
  useChatStore: jest.fn(() => ({
    isStreaming: mockStreamingConversations.size > 0,
    streamingConversations: mockStreamingConversations,
    unviewedConversations: mockUnviewedConversations,
    inputRequiredConversations: mockInputRequiredConversations,
    conversations: [],
    activeConversationId: null,
  })),
}))

let mockStorageMode = 'mongodb'
let mockRagEnabled = false
let mockEnvBadge = ''
const mockReportProblemEnabled = true
let mockProvideFeedbackEnabled = false

const mockReleasePrompt = {
  open: false,
  isAdmin: false,
  releaseVersion: null as string | null,
  release: null as unknown,
  releaseMarkdown: null as unknown,
  skipUntilNextLogin: jest.fn(),
  dismissPermanently: jest.fn(),
  isLoading: false,
  isDismissing: false,
}
jest.mock('@/hooks/use-release-upgrade-prompt', () => ({
  useReleaseUpgradePrompt: () => mockReleasePrompt,
}))

let mockMigrationStatus = {
  status: null as unknown,
  isLoading: false,
}
jest.mock('@/hooks/use-migration-status', () => ({
  useMigrationStatus: () => mockMigrationStatus,
}))

let mockKeycloakHealth = {
  summary: null as unknown,
  isLoading: false,
}
jest.mock('@/hooks/use-keycloak-health-summary', () => ({
  useKeycloakHealthSummary: () => mockKeycloakHealth,
}))

jest.mock('@/components/release/ReleaseUpgradeDialog', () => ({
  ReleaseUpgradeDialog: ({ open, isAdmin, releaseVersion }: unknown) =>
    open ? (
      <div data-testid="release-upgrade-dialog">
        ReleaseUpgradeDialog {releaseVersion} {isAdmin ? 'admin' : 'user'}
      </div>
    ) : null,
}))

jest.mock('@/components/notifications/NotificationBell', () => ({
  NotificationBell: () => <button aria-label="Notifications" />,
}))

const mockToast = jest.fn()
jest.mock('@/components/ui/toast', () => ({
  useToast: () => ({ toast: mockToast }),
}))

// Mock config
jest.mock('@/lib/config', () => ({
  config: {
    appName: 'Test App',
    tagline: 'Test tagline',
    logoUrl: '/logo.svg',
    logoStyle: 'auto',
    supportEmail: 'support@example.com',
    docsUrl: 'https://docs.example.com',
    githubUrl: 'https://github.com/example',
    ssoEnabled: true,
    get envBadge() { return mockEnvBadge },
    workflowsEnabled: false,
    dynamicAgentsEnabled: true,
    schedulerEnabled: false,
    schedulerAdminOnly: false,
    userConnectionsEnabled: true,
    feedbackEnabled: true,
    auditLogsEnabled: true,
    credentialsEnabled: true,
    oktaSyncEnabled: true,
    get storageMode() { return mockStorageMode },
    get ragEnabled() { return mockRagEnabled },
    get reportProblemEnabled() { return mockReportProblemEnabled },
    get provideFeedbackEnabled() { return mockProvideFeedbackEnabled },
    get autonomousAgentsEnabled() { return mockAutonomousAgentsEnabled },
  },
  getConfig: jest.fn((key: string) => {
    const configs: Record<string, unknown> = {
      appName: 'Test App',
      ssoEnabled: true,
      get envBadge() { return mockEnvBadge },
      get storageMode() { return mockStorageMode },
      get ragEnabled() { return mockRagEnabled },
    }
    return configs[key]
  }),
  getLogoFilterClass: jest.fn(() => ''),
}))

// Mock Link component
jest.mock('next/link', () => {
  const MockLink = React.forwardRef(({ children, href, className, ...props }: unknown, ref: unknown) => (
    <a ref={ref} href={href} className={className} data-testid={`link-${href}`} {...props}>{children}</a>
  ))
  MockLink.displayName = 'MockLink'
  return MockLink
})

// Mock UI components
jest.mock('@/components/ui/tooltip', () => {
  const TooltipTrigger = React.forwardRef(function MockTooltipTrigger(
    { children, asChild, ...props }: unknown,
    ref: unknown,
  ) {
    if (asChild && React.isValidElement(children)) {
      return children
    }
    return <div ref={ref} {...props}>{children}</div>
  })
  return {
    Tooltip: ({ children }: unknown) => <>{children}</>,
    TooltipContent: ({ children }: unknown) => <div>{children}</div>,
    TooltipProvider: ({ children }: unknown) => <>{children}</>,
    TooltipTrigger,
  }
})

// Popover mock that:
//   - Always renders PopoverContent so existing tests can scan for rows
//     without first clicking the trigger.
//   - Wires PopoverTrigger's onClick to call the most recently-seen
//     `onOpenChange` from <Popover>, so a focused regression test can
//     open the popover via a trigger click and then verify it closes
//     after a row click — the user-visible half of the "clicking the
//     alert doesn't do anything" bug.
//   - Records every value of the controlled `open` prop.
const popoverOpenProps: boolean[] = []
let lastPopoverState: {
  open: boolean
  onOpenChange?: (next: boolean) => void
} = { open: false }
jest.mock('@/components/ui/popover', () => {
  const Popover = ({ children, open, onOpenChange }: unknown) => {
    popoverOpenProps.push(Boolean(open))
    // eslint-disable-next-line react-hooks/globals
    lastPopoverState = { open: Boolean(open), onOpenChange }
    return <>{children}</>
  }
  const PopoverTrigger = React.forwardRef(function MockPopoverTrigger(
    { children, asChild, ...props }: unknown,
    ref: unknown,
  ) {
    const toggleOpen = () => {
      lastPopoverState.onOpenChange?.(!lastPopoverState.open)
    }
    if (asChild && React.isValidElement(children)) {
      const child = children as React.ReactElement<unknown>
      const originalClick = child.props.onClick
      const handleClick = (e: React.MouseEvent) => {
        originalClick?.(e)
        toggleOpen()
      }
      return React.cloneElement(child, { onClick: handleClick })
    }
    return (
      <div ref={ref} {...props} onClick={toggleOpen}>
        {children}
      </div>
    )
  })
  const PopoverContent = ({ children }: unknown) => <div>{children}</div>
  return {
    Popover,
    PopoverContent,
    PopoverTrigger,
  }
})

jest.mock('@/components/user-menu', () => ({
  UserMenu: () => (
    <div data-testid="user-menu" />
  ),
}))

jest.mock('@/components/ticket/ReportProblemDialog', () => ({
  ReportProblemDialog: ({ open }: { open: boolean }) =>
    open ? <div data-testid="provide-feedback-dialog">Provide Feedback Dialog</div> : null,
}))

jest.mock('@/components/settings-panel', () => ({
  SettingsPanel: () => (
    <div data-testid="settings-panel" />
  ),
}))

jest.mock('@/components/ui/button', () => ({
  Button: React.forwardRef(function MockButton({ children, ...props }: unknown, ref: unknown) {
    return (
    <button ref={ref} {...props}>{children}</button>
    )
  }),
}))

jest.mock('@/lib/utils', () => ({
  cn: (...args: unknown[]) => args.filter(Boolean).join(' '),
}))

// ============================================================================
// Imports — after mocks
// ============================================================================

import { AppHeader } from '../AppHeader'
import { ApplicationNavigationRail } from '../ApplicationNavigation'
import { HeaderBreadcrumbSlotProvider } from '../HeaderBreadcrumbSlot'
import { WorkspaceHierarchicalNavigationList } from '../WorkspaceNavigation'
import {
  ApplicationNavigationProvider,
  useRegisterApplicationNavigation,
} from '../ApplicationNavigationContext'
import { Database,Users } from 'lucide-react'

function AdminNavigationFixture({ version = 'users' }: { version?: string }) {
  useRegisterApplicationNavigation({
    areaKey: 'admin',
    content: (
      <nav aria-label="Admin sections">
        <Link data-navigation-leaf="true" href="/admin/people/users">Users</Link>
      </nav>
    ),
    version,
  })
  return null
}

function render(
  ui: React.ReactElement,
  options?: RenderOptions,
): RenderResult {
  const renderChrome = (content: React.ReactElement) => (
    <ApplicationNavigationProvider>
      <ApplicationNavigationRail />
      {content}
    </ApplicationNavigationProvider>
  )
  const result = testingRender(renderChrome(ui),options)
  const rerender = result.rerender
  return {
    ...result,
    rerender: (nextUi: React.ReactNode) => {
      rerender(renderChrome(nextUi as React.ReactElement))
    },
  }
}

function applicationNavigation(): HTMLElement {
  return screen.getByRole('navigation', { name: 'Application navigation' })
}

function applicationLink(name: string): HTMLElement {
  const navigation = within(applicationNavigation())
  const link = navigation.queryByRole('link', { name, exact: true })
    ?? navigation.getAllByRole('link')
    .find((candidate) => candidate.textContent?.includes(name))
  if (!link) throw new Error(`Application link not found: ${name}`)
  return link
}

function applicationButton(name: string): HTMLElement {
  return within(applicationNavigation()).getByRole('button', { name, exact: true })
}

// ============================================================================
// Tests
// ============================================================================

beforeEach(() => {
  mockMigrationStatus = {
    status: null,
    isLoading: false,
  }
  mockKeycloakHealth = {
    summary: null,
    isLoading: false,
  }
  mockRouterPush.mockReset()
  popoverOpenProps.length = 0
  lastPopoverState = { open: false }
})

describe('AppHeader — application chrome', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockStorageMode = 'mongodb'
    mockPathname = '/chat'
    mockIsAdmin = false
    mockCanAccessDynamicAgents = false
    mockAdminTabGates = {
      dynamic_agent_conversations: false,
      users: true,
      teams: true,
      skills: true,
    }
    mockCanUseAutonomous = false
    mockAutonomousAgentsEnabled = true
    mockRagEnabled = false
    mockKbGates = {
      search: true,
      data_sources: true,
      graph: true,
      mcp_tools: true,
      has_any_kb: true,
      can_ingest: true,
      can_search: true,
    }
    mockKbGatesLoading = false
    mockKbOrgAdminBypass = true
    mockEnvBadge = ''
    mockProvideFeedbackEnabled = false
    mockStreamingConversations = new Map()
    mockUnviewedConversations = new Set()
    mockInputRequiredConversations = new Set()
    mockSession.status = 'authenticated' as const
    mockSession.data = { user: { name: 'Test User', email: 'test@test.com' } } as unknown
    mockReleasePrompt.open = false
    mockReleasePrompt.isAdmin = false
    mockReleasePrompt.releaseVersion = null
    mockReleasePrompt.release = null
    mockReleasePrompt.releaseMarkdown = null
  })

  describe('Autonomous navigation', () => {
    it('hides Autonomous for a user without the capability', () => {
      render(<AppHeader />)
      expect(within(applicationNavigation()).queryByRole('link', { name: 'Autonomous' })).not.toBeInTheDocument()
    })

    it('shows Autonomous for an eligible user when the feature is enabled', () => {
      mockCanUseAutonomous = true
      render(<AppHeader />)
      expect(applicationLink('Autonomous')).toHaveAttribute('href', '/autonomous')
    })
  })

  describe('Insights tab removed from nav', () => {
    it('does NOT show Personal Insights in the application rail even with MongoDB', () => {
      render(<AppHeader />)
      // Insights was moved to user menu — it should NOT be a tab
      expect(
        within(applicationNavigation()).queryByRole('link', { name: 'Personal Insights' }),
      ).not.toBeInTheDocument()
    })

    it('does NOT show Personal Insights text in nav with authenticated user + mongodb', () => {
      render(<AppHeader />)
      // The text "Personal Insights" should NOT appear as a navigation tab
      // (UserMenu is mocked out, so it won't appear from there either)
      expect(
        within(applicationNavigation()).queryByText('Personal Insights'),
      ).not.toBeInTheDocument()
    })
  })

  describe('Home tab', () => {
    function getHomeNavPill() {
      return applicationLink('Home')
    }

    it('shows Home tab', () => {
      render(<AppHeader />)
      expect(screen.getByText('Home')).toBeInTheDocument()
    })

    it('places global search at the header right', () => {
      render(<AppHeader />)
      expect(
        within(applicationNavigation())
          .queryByTestId('application-navigation-search-trigger-sidebar'),
      ).not.toBeInTheDocument()
      expect(screen.getByTestId('application-navigation-search-trigger-compact'))
        .toBeInTheDocument()
    })

    it('Home nav pill links to /', () => {
      render(<AppHeader />)
      const pill = getHomeNavPill()
      expect(pill).toBeDefined()
      expect(pill.getAttribute('href')).toBe('/')
    })

    it('marks Home as the current page when pathname is /', () => {
      mockPathname = '/'
      render(<AppHeader />)
      const pill = getHomeNavPill()
      expect(pill).toHaveAttribute('aria-current', 'page')
    })

    it('does not mark Home as current on other paths', () => {
      mockPathname = '/chat'
      render(<AppHeader />)
      const pill = getHomeNavPill()
      expect(pill).not.toHaveAttribute('aria-current')
    })

    it('keeps the brand static without a hover sparkle', () => {
      render(<AppHeader />)
      for (const brand of screen.getAllByRole('link', { name: 'Test App home' })) {
        expect(brand.querySelector('.brand-sparkle')).toBeNull()
      }
    })

    it('left-aligns the rail toggle without a divider', () => {
      render(<AppHeader />)
      const footer = screen.getByRole('button', { name: 'Collapse sidebar' }).parentElement
      expect(footer).toHaveClass('justify-start')
      expect(footer).not.toHaveClass('justify-center', 'border-t', 'pt-2')
    })

  })

  describe('header breadcrumbs', () => {
    it('provides a section breadcrumb for routes without a page-specific trail', () => {
      mockPathname = '/skills/workspace/new'

      render(
        <HeaderBreadcrumbSlotProvider>
          <AppHeader />
        </HeaderBreadcrumbSlotProvider>,
      )

      const slot = screen.getByTestId('app-header-breadcrumb-slot')
      const breadcrumb = within(slot).getByRole('navigation', { name: 'Breadcrumb' })
      expect(within(breadcrumb).getByText('Home')).toHaveAttribute('href', '/')
      expect(within(breadcrumb).getByText('Skills')).toHaveAttribute('href', '/skills')
    })

    it('does not repeat Home as a breadcrumb on the Home route', () => {
      mockPathname = '/'

      render(
        <HeaderBreadcrumbSlotProvider>
          <AppHeader />
        </HeaderBreadcrumbSlotProvider>,
      )

      expect(
        within(screen.getByTestId('app-header-breadcrumb-slot')).queryByRole('navigation'),
      ).not.toBeInTheDocument()
    })
  })

  describe('core tabs', () => {
    it('always shows Skills and Chat tabs', () => {
      render(<AppHeader />)
      expect(screen.getByText('Skills')).toBeInTheDocument()
      expect(applicationLink('Chat')).toHaveTextContent('Chat')
    })

    it('keeps global destinations in the rail and discloses active section navigation', () => {
      mockStorageMode = 'mongodb'
      mockIsAdmin = true
      mockPathname = '/admin/people/users'

      render(
        <>
          <AdminNavigationFixture />
          <AppHeader />
        </>,
      )

      expect(
        screen.getByRole('navigation', { name: 'Application navigation' }),
      ).toBeInTheDocument()
      expect(screen.getByText('Home')).toBeInTheDocument()
      expect(applicationLink('Chat')).toHaveTextContent('Chat')
      expect(screen.getByText('Skills')).toBeInTheDocument()
      expect(applicationButton('Agents')).toBeInTheDocument()
      const admin = applicationButton('Admin')
      expect(admin).toHaveAttribute('aria-expanded', 'true')
      const adminPanel = document.getElementById(admin.getAttribute('aria-controls')!)
      expect(adminPanel).not.toHaveClass('transition-[grid-template-rows,opacity]')
      expect(screen.getByRole('navigation', { name: 'Admin sections' })).toBeInTheDocument()
      fireEvent.click(admin)
      expect(adminPanel).toHaveClass('transition-[grid-template-rows,opacity]')
      expect(screen.queryByRole('navigation', { name: 'Admin sections' })).not.toBeInTheDocument()
      fireEvent.click(admin)
      expect(screen.getByRole('navigation', { name: 'Admin sections' })).toBeInTheDocument()
      expect(screen.getByTestId('settings-panel')).toBeInTheDocument()
      expect(screen.getByTestId('user-menu')).toBeInTheDocument()
    })

    it('collapses the previous section when navigation moves to another area', () => {
      mockStorageMode = 'mongodb'
      mockIsAdmin = true
      mockRagEnabled = true
      mockPathname = '/admin/people/users'

      const { rerender } = render(
        <>
          <AdminNavigationFixture />
          <AppHeader />
        </>,
      )

      expect(applicationButton('Admin')).toHaveAttribute('aria-expanded', 'true')

      mockPathname = '/knowledge-bases/collections'
      rerender(
        <>
          <AdminNavigationFixture />
          <AppHeader />
        </>,
      )

      expect(applicationButton('Admin')).toHaveAttribute('aria-expanded', 'false')
      const knowledge = applicationButton('Knowledge Bases')
      expect(knowledge).toHaveAttribute('aria-expanded', 'true')
      const knowledgePanel = document.getElementById(knowledge.getAttribute('aria-controls')!)
      expect(knowledgePanel).not.toHaveClass('transition-[grid-template-rows,opacity]')
    })

    it('collapses section navigation when navigation moves to a page without sections', () => {
      mockStorageMode = 'mongodb'
      mockIsAdmin = true
      mockPathname = '/admin/people/users'

      const { rerender } = render(<AdminNavigationFixture />)

      expect(applicationButton('Admin')).toHaveAttribute('aria-expanded', 'true')

      mockPathname = '/chat'
      rerender(<></>)

      expect(applicationButton('Admin')).toHaveAttribute('aria-expanded', 'false')

      mockPathname = '/'
      rerender(<></>)

      expect(applicationButton('Admin')).toHaveAttribute('aria-expanded', 'false')
    })

    it('keeps Admin expanded while its registered destination changes', () => {
      mockStorageMode = 'mongodb'
      mockIsAdmin = true
      mockPathname = '/admin/people/users'

      const { rerender } = render(
        <AdminNavigationFixture key="users" version="users" />,
      )

      const navigation = screen.getByRole('navigation', { name: 'Admin sections' })
      expect(applicationButton('Admin')).toHaveAttribute('aria-expanded', 'true')

      rerender(
        <AdminNavigationFixture key="skill-hubs" version="skill-hubs" />,
      )

      expect(applicationButton('Admin')).toHaveAttribute('aria-expanded', 'true')
      expect(screen.getByRole('navigation', { name: 'Admin sections' })).toBe(navigation)
    })

    it('keeps the Admin navigation mounted through a page registration gap', () => {
      mockStorageMode = 'mongodb'
      mockIsAdmin = true
      mockPathname = '/admin/people/users'

      const { rerender } = render(<AdminNavigationFixture />)
      const navigation = screen.getByRole('navigation', { name: 'Admin sections' })

      rerender(<></>)

      expect(applicationButton('Admin')).toHaveAttribute('aria-expanded', 'true')
      expect(screen.getByRole('navigation', { name: 'Admin sections' }))
        .toBe(navigation)
    })

    it('keeps the routed Admin category expanded while page navigation is unavailable', () => {
      mockStorageMode = 'mongodb'
      mockIsAdmin = true
      mockPathname = '/admin/people/users'

      const { rerender } = render(<AppHeader />)

      const admin = applicationButton('Admin')
      expect(admin).toHaveAttribute('aria-expanded', 'true')
      expect(screen.getByRole('button', { name: 'Teams & Users' }))
        .toHaveAttribute('aria-expanded', 'true')

      mockPathname = '/admin/platform/skill-hubs'
      rerender(<AppHeader />)

      expect(admin).toHaveAttribute('aria-expanded', 'true')
      expect(screen.getByRole('button', { name: 'Resources' }))
        .toHaveAttribute('aria-expanded', 'true')
      expect(screen.getByRole('link', { name: 'RAG' }))
        .toHaveAttribute('href', '/admin/platform/rag')
      expect(screen.getByRole('link', { name: 'Skill Hubs' }))
        .toHaveAttribute('aria-current', 'page')
    })

    it('animates manual category toggles but not route-driven category changes', () => {
      const categories = [
        {
          id: 'people',
          label: 'People group',
          icon: Users,
          groups: [{
            id: 'people-items',
            items: [{ id: 'users',label: 'Users',href: '/admin/people/users',icon: Users }],
          }],
        },
        {
          id: 'resources',
          label: 'Resource group',
          icon: Database,
          groups: [{
            id: 'resource-items',
            items: [{
              id: 'skill-hubs',
              label: 'Skill Hubs',
              href: '/admin/platform/skill-hubs',
              icon: Database,
            }],
          }],
        },
      ]
      const navigation = (activeCategoryId: string,activeItemId: string) => (
        <WorkspaceHierarchicalNavigationList
          activeCategoryId={activeCategoryId}
          activeItemId={activeItemId}
          categories={categories}
          navigationLabel="Test admin sections"
        />
      )
      const { rerender } = render(navigation('people','users'))
      const resources = screen.getByRole('button', { name: 'Resource group' })
      const resourcesPanel = document.getElementById(
        resources.getAttribute('aria-controls')!,
      )
      const people = screen.getByRole('button', { name: 'People group' })

      expect(resourcesPanel).not.toHaveClass('transition-[grid-template-rows,opacity]')
      expect(people).toHaveClass('workspace-navigation-active')
      fireEvent.click(resources)
      expect(resourcesPanel).toHaveClass('transition-[grid-template-rows,opacity]')

      rerender(navigation('resources','skill-hubs'))

      expect(screen.getByRole('button', { name: 'People group' }))
        .toHaveAttribute('aria-expanded', 'false')
      expect(resources).toHaveAttribute('aria-expanded', 'true')
      expect(resourcesPanel).not.toHaveClass('transition-[grid-template-rows,opacity]')
    })

    it('opens inactive section navigation on hover and highlights only the current item', () => {
      mockPathname = '/chat'
      mockRagEnabled = true

      render(<AppHeader />)
      fireEvent.click(screen.getByRole('button', { name: 'Collapse sidebar' }))

      const chat = applicationLink('Chat')
      const knowledge = screen.getByRole('button', { name: 'Knowledge Bases' })
      const agents = screen.getByRole('button', { name: 'Agents' })
      const credentials = screen.getByRole('button', { name: 'Credentials' })

      expect(chat.querySelector('.gradient-primary-br')).not.toBeNull()
      expect(knowledge.querySelector('.gradient-primary-br')).toBeNull()
      expect(agents.querySelector('.gradient-primary-br')).toBeNull()
      expect(credentials.querySelector('.gradient-primary-br')).toBeNull()

      fireEvent.mouseEnter(knowledge)
      expect(
        screen.getByRole('navigation', { name: 'Knowledge Base sections' }),
      ).toBeInTheDocument()
    })

    it('shows Skills as active on /skills', () => {
      mockPathname = '/skills'
      render(<AppHeader />)
      const link = applicationLink('Skills')
      expect(link).toHaveAttribute('aria-current', 'page')
    })

    it('shows Chat as active on /chat', () => {
      mockPathname = '/chat'
      render(<AppHeader />)
      const link = applicationLink('Chat')
      expect(link).toHaveAttribute('aria-current', 'page')
    })

    it('shows Knowledge Bases tab only when RAG is enabled', () => {
      mockRagEnabled = true
      const { rerender } = render(<AppHeader />)
      expect(screen.getByText('Knowledge Bases')).toBeInTheDocument()

      mockRagEnabled = false
      rerender(<AppHeader />)
      expect(screen.queryByText('Knowledge Bases')).not.toBeInTheDocument()
    })

    it('disables Knowledge Bases and shows only the access disclaimer when unavailable', () => {
      mockRagEnabled = true
      mockKbOrgAdminBypass = false
      mockKbGates = {
        search: false,
        data_sources: false,
        graph: false,
        mcp_tools: false,
        has_any_kb: false,
        can_ingest: false,
        can_search: false,
      }

      render(<AppHeader />)

      const unavailable = within(applicationNavigation()).getByRole('button', {
        name: 'Knowledge Bases: unavailable',
      })
      expect(unavailable).toHaveAttribute('aria-disabled', 'true')
      expect(
        screen.queryByRole('navigation', { name: 'Knowledge Base sections' }),
      ).not.toBeInTheDocument()

      fireEvent.click(unavailable)
      expect(screen.getByText('Knowledge Bases unavailable')).toBeInTheDocument()
      expect(screen.getByText(/don't have Knowledge Base access yet/)).toBeInTheDocument()
      expect(screen.getByRole('link', { name: 'Contact admin' })).toHaveAttribute(
        'href',
        'mailto:support@example.com?subject=Test%20App%20access%20request',
      )
    })

    it('shows Agents in MongoDB mode even without AD group access', () => {
      mockCanAccessDynamicAgents = false
      mockStorageMode = 'mongodb'

      render(<AppHeader />)

      expect(applicationButton('Agents')).toHaveTextContent('Agents')
    })
  })

  describe('admin tab', () => {
    it('shows Admin tab for admin users', () => {
      mockIsAdmin = true
      render(<AppHeader />)
      expect(screen.getByText('Admin')).toBeInTheDocument()
    })

    it('shows Admin tab for non-admin authenticated users (readonly)', () => {
      mockIsAdmin = false
      render(<AppHeader />)
      expect(screen.getByText('Admin')).toBeInTheDocument()
    })

    it('does NOT show Admin tab for unauthenticated users', () => {
      mockIsAdmin = false
      mockSession.status = 'unauthenticated'
      mockSession.data = null
      render(<AppHeader />)
      expect(
        within(applicationNavigation()).queryByText('Admin'),
      ).not.toBeInTheDocument()
    })

    it('Admin tab is clickable when MongoDB is configured (admin user)', () => {
      mockIsAdmin = true
      mockStorageMode = 'mongodb'
      render(<AppHeader />)
      expect(applicationButton('Admin')).toBeInTheDocument()
    })

    it('Admin tab is clickable when MongoDB is configured (non-admin user)', () => {
      mockIsAdmin = false
      mockStorageMode = 'mongodb'
      render(<AppHeader />)
      expect(applicationButton('Admin')).toBeInTheDocument()
    })

    it('Admin tab is disabled when MongoDB is not configured', () => {
      mockIsAdmin = true
      mockStorageMode = 'localStorage'
      render(<AppHeader />)
      expect(screen.getByText('Admin')).toBeInTheDocument()
      const disabledAdmin = within(applicationNavigation()).getByRole('button', {
        name: 'Admin: unavailable',
      })
      expect(disabledAdmin).toHaveAttribute('aria-disabled', 'true')

      fireEvent.click(disabledAdmin)
      expect(screen.getByText('Admin unavailable')).toBeInTheDocument()
      expect(
        screen.getByText(/Admin tools require persistent platform storage/),
      ).toBeInTheDocument()
      expect(screen.getByRole('link', { name: 'Contact admin' })).toHaveAttribute(
        'href',
        'mailto:support@example.com?subject=Test%20App%20access%20request',
      )
    })

    it('marks Admin as current on a nested Admin route for an admin user', () => {
      mockIsAdmin = true
      mockPathname = '/admin/security/ai-review'
      mockStorageMode = 'mongodb'
      render(<AppHeader />)
      expect(applicationButton('Admin')).toHaveAttribute('aria-current', 'page')
    })

    it('marks Admin as current on a nested Admin route for a read-only user', () => {
      mockIsAdmin = false
      mockPathname = '/admin/people/users'
      mockStorageMode = 'mongodb'
      render(<AppHeader />)
      expect(applicationButton('Admin')).toHaveAttribute('aria-current', 'page')
    })
  })

  describe('environment badge', () => {
    it('does NOT show an environment badge when envBadge is empty', () => {
      render(<AppHeader />)
      expect(screen.queryByText('Preview')).not.toBeInTheDocument()
      expect(screen.queryByText('Dev')).not.toBeInTheDocument()
      expect(screen.queryByText('Prod')).not.toBeInTheDocument()
    })

    it('shows the environment badge immediately before Search', () => {
      mockEnvBadge = 'Preview'
      render(<AppHeader />)

      const badge = screen.getByText('Preview')
      const search = screen.getByTestId('application-navigation-search-trigger-compact')
      expect(within(applicationNavigation()).queryByText('Preview')).not.toBeInTheDocument()
      expect(badge.nextElementSibling).toBe(search)
    })
  })

  describe('right-side elements', () => {
    it('hides the feedback shortcut when the feature flag is disabled', () => {
      render(<AppHeader />)
      expect(screen.queryByRole('button', { name: 'Provide Feedback' })).not.toBeInTheDocument()
    })

    it('opens the feedback dialog when the feature flag is enabled', () => {
      mockProvideFeedbackEnabled = true
      render(<AppHeader />)

      fireEvent.click(screen.getByRole('button', { name: 'Provide Feedback' }))

      expect(screen.getByTestId('provide-feedback-dialog')).toBeInTheDocument()
      expect(screen.getByTestId('header-provide-feedback')).toHaveAttribute(
        'title',
        'Provide Feedback',
      )
    })

    it('renders UserMenu', () => {
      render(<AppHeader />)
      expect(screen.getByTestId('user-menu')).toBeInTheDocument()
    })

    it('renders SettingsPanel', () => {
      render(<AppHeader />)
      expect(screen.getByTestId('settings-panel')).toBeInTheDocument()
    })

    it('renders notifications for signed-in users', () => {
      render(<AppHeader />)
      expect(screen.getByRole('button', { name: 'Notifications' })).toBeInTheDocument()
    })
  })
})

// ============================================================================
// Chat tab notification dot tests
// ============================================================================

describe('AppHeader — Chat tab notification dots', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockStorageMode = 'mongodb'
    mockPathname = '/skills'
    mockIsAdmin = false
    mockRagEnabled = false
    mockStreamingConversations = new Map()
    mockUnviewedConversations = new Set()
    mockInputRequiredConversations = new Set()
    mockSession.status = 'authenticated' as const
    mockSession.data = { user: { name: 'Test User', email: 'test@test.com' } } as unknown
  })

  it('shows green badge with count on Chat tab when conversations are streaming', () => {
    mockStreamingConversations = new Map([
      ['conv-1', { conversationId: 'conv-1', messageId: 'msg-1', client: {} }],
    ])

    render(<AppHeader />)

    const chatLink = applicationLink('Chat')
    const pingDot = chatLink.querySelector('.animate-ping')
    expect(pingDot).toBeInTheDocument()
    expect(pingDot?.className).toContain('bg-emerald-400')

    const badge = chatLink.querySelector('.bg-emerald-500')
    expect(badge).toBeInTheDocument()
    expect(badge?.textContent).toBe('1')
    expect(badge).toHaveClass('relative', 'ml-auto')
    expect(badge).not.toHaveClass('absolute')
  })

  it('offsets the chat activity badge outside the icon in the collapsed rail', () => {
    mockStreamingConversations = new Map([
      ['conv-1', { conversationId: 'conv-1', messageId: 'msg-1', client: {} }],
    ])

    render(<AppHeader />)
    fireEvent.click(screen.getByRole('button', { name: 'Collapse sidebar' }))

    const badge = applicationLink('Chat').querySelector('.bg-emerald-500')
    expect(badge).toHaveClass('absolute', '-right-1.5', '-top-1.5', 'ring-2')
    expect(badge).not.toHaveClass('ml-auto')
  })

  it('shows green badge with correct count for multiple streaming conversations', () => {
    mockStreamingConversations = new Map([
      ['conv-1', { conversationId: 'conv-1', messageId: 'msg-1', client: {} }],
      ['conv-2', { conversationId: 'conv-2', messageId: 'msg-2', client: {} }],
    ])

    render(<AppHeader />)

    const chatLink = applicationLink('Chat')
    const badge = chatLink.querySelector('.bg-emerald-500')
    expect(badge?.textContent).toBe('2')
  })

  it('shows blue badge with count on Chat tab when there are unviewed conversations', () => {
    mockUnviewedConversations = new Set(['conv-1'])

    render(<AppHeader />)

    const chatLink = applicationLink('Chat')
    const blueBadge = chatLink.querySelector('.bg-blue-500')
    expect(blueBadge).toBeInTheDocument()
    expect(blueBadge?.textContent).toBe('1')
  })

  it('shows blue badge with correct count for multiple unviewed conversations', () => {
    mockUnviewedConversations = new Set(['conv-1', 'conv-2', 'conv-3'])

    render(<AppHeader />)

    const chatLink = applicationLink('Chat')
    const blueBadge = chatLink.querySelector('.bg-blue-500')
    expect(blueBadge?.textContent).toBe('3')
  })

  it('green badge takes priority over blue badge when both streaming and unviewed exist', () => {
    mockStreamingConversations = new Map([
      ['conv-1', { conversationId: 'conv-1', messageId: 'msg-1', client: {} }],
    ])
    mockUnviewedConversations = new Set(['conv-2'])

    render(<AppHeader />)

    const chatLink = applicationLink('Chat')
    const greenBadge = chatLink.querySelector('.bg-emerald-500')
    const blueBadge = chatLink.querySelector('.bg-blue-500')
    expect(greenBadge).toBeInTheDocument()
    expect(blueBadge).not.toBeInTheDocument()
  })

  it('shows amber badge with count on Chat tab when conversations need input', () => {
    mockInputRequiredConversations = new Set(['conv-1'])

    render(<AppHeader />)

    const chatLink = applicationLink('Chat')
    const amberBadge = chatLink.querySelector('.bg-amber-500')
    expect(amberBadge).toBeInTheDocument()
    expect(amberBadge?.textContent).toBe('1')
  })

  it('shows amber badge with correct count for multiple input-required conversations', () => {
    mockInputRequiredConversations = new Set(['conv-1', 'conv-2'])

    render(<AppHeader />)

    const chatLink = applicationLink('Chat')
    const amberBadge = chatLink.querySelector('.bg-amber-500')
    expect(amberBadge?.textContent).toBe('2')
  })

  it('green badge takes priority over amber badge', () => {
    mockStreamingConversations = new Map([
      ['conv-1', { conversationId: 'conv-1', messageId: 'msg-1', client: {} }],
    ])
    mockInputRequiredConversations = new Set(['conv-2'])

    render(<AppHeader />)

    const chatLink = applicationLink('Chat')
    expect(chatLink.querySelector('.bg-emerald-500')).toBeInTheDocument()
    expect(chatLink.querySelector('.bg-amber-500')).not.toBeInTheDocument()
  })

  it('amber badge takes priority over blue badge', () => {
    mockInputRequiredConversations = new Set(['conv-1'])
    mockUnviewedConversations = new Set(['conv-2'])

    render(<AppHeader />)

    const chatLink = applicationLink('Chat')
    expect(chatLink.querySelector('.bg-amber-500')).toBeInTheDocument()
    expect(chatLink.querySelector('.bg-blue-500')).not.toBeInTheDocument()
  })

  it('shows no notification badge when nothing is streaming, input-required, or unviewed', () => {
    render(<AppHeader />)

    const chatLink = applicationLink('Chat')
    const greenBadge = chatLink.querySelector('.bg-emerald-500')
    const amberBadge = chatLink.querySelector('.bg-amber-500')
    const blueBadge = chatLink.querySelector('.bg-blue-500')
    expect(greenBadge).not.toBeInTheDocument()
    expect(amberBadge).not.toBeInTheDocument()
    expect(blueBadge).not.toBeInTheDocument()
  })

  it('mounts the release upgrade dialog for authenticated sessions', () => {
    mockReleasePrompt.open = true
    mockReleasePrompt.isAdmin = true
    mockReleasePrompt.releaseVersion = '0.5.1'

    render(<AppHeader />)

    expect(screen.getByTestId('release-upgrade-dialog')).toHaveTextContent('0.5.1 admin')
  })

  // ---------------------------------------------------------------------------
  // Unified admin alerts popover — the pill is a popover trigger; clicking
  // it opens a list of every active alert with its own GuardedLink to the
  // relevant admin tab so users can choose exactly which one they want to fix.
  // ---------------------------------------------------------------------------

  // The trigger is now a <button> (Popover trigger), not a link. We give
  // it a stable data-testid because GuardedLink doesn't forward IDs.
  const triggerSelector = 'header-admin-alerts-trigger'

  // Helper: scan the popover panel for an alert row. Each row is a
  // <button> with an accessible "open the related page" name and a stable
  // data-testid. We deliberately do NOT render rows as anchors anymore —
  // see the comment on `alertsPopoverOpen` in AppHeader.tsx for why
  // navigation is a browser-native document load.
  function findAlertRow(label: string): HTMLElement | null {
    const rows = screen.queryAllByRole('button', { name: /open the related page/i })
    return rows.find((row) => (row.textContent ?? '').includes(label)) ?? null
  }

  it('hides the admin alerts pill from non-admin users even when migrations are blocking', () => {
    mockMigrationStatus = {
      isLoading: false,
      status: {
        release: '0.5.1',
        pending_required_count: 3,
        blocking_required_count: 2,
        is_blocking: true,
        override_active: false,
      },
    }

    render(<AppHeader />)

    expect(screen.queryByTestId(triggerSelector)).not.toBeInTheDocument()
  })

  it('shows the admin alerts pill for blocking migrations with red styling and a row that deep-links to the Migrations tab', () => {
    mockIsAdmin = true
    mockMigrationStatus = {
      isLoading: false,
      status: {
        release: '0.5.1',
        pending_required_count: 3,
        blocking_required_count: 2,
        is_blocking: true,
        override_active: false,
      },
    }

    render(<AppHeader />)

    const trigger = screen.getByTestId(triggerSelector)
    expect(trigger.tagName).toBe('BUTTON')
    expect(trigger.textContent ?? '').toContain('Alerts:')
    expect(trigger.textContent ?? '').toContain('2')
    // Blocking migrations are a red-severity source — the trigger inherits
    // the worst severity across visible sources.
    expect(trigger.className).toMatch(/text-red-500/)
    // The hover label is now a CTA ("Click to see the list..."), not a
    // single destination — confirm the breakdown is still embedded.
    expect(trigger.getAttribute('title') ?? '').toContain('Migrations required: 2')
    expect(trigger.getAttribute('title') ?? '').toMatch(/Click to see the list/i)

    // The popover panel (mocked to always render) should contain exactly
    // one row, linking to the migrations tab.
    const row = findAlertRow('Migrations required')
    expect(row).not.toBeNull()
    expect(row?.textContent ?? '').toContain('2')
    // Regression for "clicking the alert doesn't do anything": rows are
    // <button>s that programmatically load the route. Verify that the
    // click handler actually fires and targets the migrations tab.
    fireEvent.click(row!)
    expect(mockRouterPush).toHaveBeenCalledWith('/admin/security/migrations')
  })

  it('shows the admin alerts pill for version-metadata bootstrap (amber-severity)', () => {
    mockIsAdmin = true
    mockMigrationStatus = {
      isLoading: false,
      status: {
        release: '0.5.1',
        pending_required_count: 0,
        blocking_required_count: 0,
        is_blocking: false,
        override_active: false,
        needs_version_bootstrap: true,
        version_bootstrap_required_count: 2,
        requires_attention: true,
      },
    }

    render(<AppHeader />)

    const trigger = screen.getByTestId(triggerSelector)
    expect(trigger.textContent ?? '').toContain('2')
    expect(trigger.className).toMatch(/text-amber-500/)
    expect(trigger.getAttribute('title') ?? '').toContain('Version metadata needed: 2')

    const row = findAlertRow('Version metadata needed')
    expect(row).not.toBeNull()
    fireEvent.click(row!)
    expect(mockRouterPush).toHaveBeenCalledWith('/admin/security/migrations')
  })

  it('renders one popover row per active admin alert source and picks worst severity for the trigger', () => {
    mockIsAdmin = true
    mockMigrationStatus = {
      isLoading: false,
      status: {
        release: '0.5.1',
        pending_required_count: 0,
        blocking_required_count: 0,
        is_blocking: false,
        override_active: false,
        needs_version_bootstrap: true,
        version_bootstrap_required_count: 1,
        requires_attention: true,
      },
    }
    mockKeycloakHealth = {
      isLoading: false,
      summary: {
        configured: true,
        reachable: false,
        realm: 'caipe',
        invariants: null,
        has_issues: true,
        cached: false,
        fetched_at: '2026-05-24T13:00:00.000Z',
      },
    }

    render(<AppHeader />)

    const trigger = screen.getByTestId(triggerSelector)
    // Keycloak unreachable (red) + version metadata bootstrap (amber, 1) → total 2, red wins on the trigger.
    expect(trigger.textContent ?? '').toContain('2')
    expect(trigger.className).toMatch(/text-red-500/)
    const title = trigger.getAttribute('title') ?? ''
    expect(title).toContain('Keycloak realm caipe unreachable')
    expect(title).toContain('Version metadata needed: 1')

    // Both rows must be navigable from the popover, each linking to its
    // own admin tab so lower-severity alerts remain visible and actionable.
    const keycloakRow = findAlertRow('Keycloak realm caipe unreachable')
    expect(keycloakRow).not.toBeNull()
    expect(keycloakRow?.className ?? '').toMatch(/text-red-500/)

    const versionRow = findAlertRow('Version metadata needed')
    expect(versionRow).not.toBeNull()
    expect(versionRow?.className ?? '').toMatch(/text-amber-500/)

    // Each row navigates independently — clicking the keycloak row
    // must load the Keycloak tab and clicking the version row must
    // load the Migrations tab (no cross-talk).
    fireEvent.click(keycloakRow!)
    expect(mockRouterPush).toHaveBeenLastCalledWith('/admin/security/keycloak')
    fireEvent.click(versionRow!)
    expect(mockRouterPush).toHaveBeenLastCalledWith('/admin/security/migrations')
    expect(mockRouterPush).toHaveBeenCalledTimes(2)
  })

  it('labels Keycloak admin authorization errors without calling the realm unreachable', () => {
    mockIsAdmin = true
    mockKeycloakHealth = {
      isLoading: false,
      summary: {
        configured: true,
        reachable: true,
        status: 'admin_authorization_error',
        realm: 'caipe',
        invariants: null,
        has_issues: true,
        cached: false,
        fetched_at: '2026-05-24T13:00:00.000Z',
      },
    }

    render(<AppHeader />)

    const trigger = screen.getByTestId(triggerSelector)
    expect(trigger.textContent ?? '').toContain('1')
    const title = trigger.getAttribute('title') ?? ''
    expect(title).toContain('Keycloak admin API authorization failed')
    expect(title).not.toContain('unreachable')
    expect(findAlertRow('Keycloak admin API authorization failed')).not.toBeNull()
  })

  it('shows the admin alerts pill for failing Keycloak invariants with a row that deep-links to the Keycloak tab', () => {
    mockIsAdmin = true
    mockKeycloakHealth = {
      isLoading: false,
      summary: {
        configured: true,
        reachable: true,
        realm: 'caipe',
        invariants: {
          total: 18,
          passing: 14,
          failing: 4,
          unknown: 0,
          reconcile_now_recommended: true,
        },
        has_issues: true,
        cached: false,
        fetched_at: '2026-05-24T13:00:00.000Z',
      },
    }

    render(<AppHeader />)

    const trigger = screen.getByTestId(triggerSelector)
    expect(trigger.textContent ?? '').toContain('4')
    expect(trigger.className).toMatch(/text-amber-500/)
    expect(trigger.getAttribute('title') ?? '').toMatch(/Keycloak invariants? failing: 4/)

    const row = findAlertRow('Keycloak invariant')
    expect(row).not.toBeNull()
    expect(row?.textContent ?? '').toContain('4')
    fireEvent.click(row!)
    expect(mockRouterPush).toHaveBeenCalledWith('/admin/security/keycloak')
  })

  it('hides the admin alerts pill when no admin alert sources are active', () => {
    mockIsAdmin = true
    mockMigrationStatus = {
      isLoading: false,
      status: {
        release: '0.5.1',
        pending_required_count: 0,
        blocking_required_count: 0,
        is_blocking: false,
        override_active: false,
      },
    }
    mockKeycloakHealth = {
      isLoading: false,
      summary: {
        configured: true,
        reachable: true,
        realm: 'caipe',
        invariants: {
          total: 18,
          passing: 18,
          failing: 0,
          unknown: 0,
          reconcile_now_recommended: false,
        },
        has_issues: false,
        cached: false,
        fetched_at: '2026-05-24T13:00:00.000Z',
      },
    }

    render(<AppHeader />)

    expect(screen.queryByTestId(triggerSelector)).not.toBeInTheDocument()
    expect(screen.queryAllByRole('button', { name: /open .* tab to fix/i })).toHaveLength(0)
  })

  it('dismisses the alerts popover and loads the route in a single click — regression for "clicking the alert doesn\'t do anything"', () => {
    // Reproduces the bug where rows were anchored `<a>` elements inside
    // a popover whose own outside-click listener unmounted the `<a>`
    // before the browser dispatched the click event — leaving the
    // user staring at an unchanged page. The fix: rows are buttons,
    // navigation is programmatic, and we close the popover *after*
    // starting it. This test pins both halves of that contract.
    mockIsAdmin = true
    mockKeycloakHealth = {
      isLoading: false,
      summary: {
        configured: true,
        reachable: true,
        realm: 'caipe',
        invariants: {
          total: 18,
          passing: 14,
          failing: 4,
          unknown: 0,
          reconcile_now_recommended: true,
        },
        has_issues: true,
        cached: false,
        fetched_at: '2026-05-24T13:00:00.000Z',
      },
    }

    render(<AppHeader />)

    // Open the popover via its controlled trigger so we can observe
    // a subsequent close transition. The mock's <PopoverTrigger> just
    // passes through, so we click the inner <button> which carries
    // the onClick that flips `alertsPopoverOpen` to true.
    const trigger = screen.getByTestId(triggerSelector)
    fireEvent.click(trigger)
    expect(popoverOpenProps).toContain(true)
    popoverOpenProps.length = 0 // discard the open transition

    const row = findAlertRow('Keycloak invariant')
    expect(row).not.toBeNull()
    fireEvent.click(row!)

    expect(mockRouterPush).toHaveBeenCalledWith('/admin/security/keycloak')
    // …AND AppHeader sets alertsPopoverOpen to false on the same
    // click, so the user lands on the destination tab without a
    // dangling floating layer.
    expect(popoverOpenProps).toContain(false)
  })

  it('hides the admin alerts pill for non-admin sessions even when Keycloak has_issues', () => {
    mockIsAdmin = false
    mockKeycloakHealth = {
      isLoading: false,
      summary: {
        configured: true,
        reachable: true,
        realm: 'caipe',
        invariants: {
          total: 18,
          passing: 14,
          failing: 4,
          unknown: 0,
          reconcile_now_recommended: true,
        },
        has_issues: true,
        cached: false,
        fetched_at: '2026-05-24T13:00:00.000Z',
      },
    }

    render(<AppHeader />)

    expect(screen.queryByTestId(triggerSelector)).not.toBeInTheDocument()
  })
})
