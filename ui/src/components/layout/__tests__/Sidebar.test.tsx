/**
 * Unit tests for Sidebar component — Live Status, Unviewed Messages, and visual states
 *
 * Covers:
 * - Live status indicator: green Radio icon with pulse animation for streaming conversations
 * - Unviewed messages indicator: blue dot on MessageSquare icon for completed background streams
 * - Date text: "Live" for streaming, "New response" for unviewed, formatted date otherwise
 * - Background/border styling: emerald for live, blue for unviewed, primary for active
 * - State transitions: live → unviewed → cleared lifecycle
 */

import React from 'react'
import { act, render, screen, fireEvent, waitFor } from '@testing-library/react'

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

const mockPush = jest.fn()
jest.mock('next/navigation', () => ({
  useRouter: () => ({
    push: mockPush,
    replace: jest.fn(),
  }),
}))

jest.mock('framer-motion', () => ({
  motion: {
    // eslint-disable-next-line react/display-name
    div: React.forwardRef((props: unknown, ref: unknown) => {
      const domProps = { ...props }
      delete domProps.initial
      delete domProps.animate
      delete domProps.exit
      delete domProps.transition
      const { children, ...rest } = domProps
      return <div ref={ref} {...rest}>{children}</div>
    }),
  },
  AnimatePresence: ({ children }: unknown) => <>{children}</>,
}))

let mockConversations: unknown[] = []
let mockActiveConversationId: string | null = null
const mockSetActiveConversation = jest.fn()
const mockCreateConversation = jest.fn(() => 'new-conv-id')
const mockDeleteConversation = jest.fn()
const mockUpdateConversationTitle = jest.fn().mockResolvedValue(undefined)
const mockLoadConversationsFromServer = jest.fn().mockResolvedValue(undefined)
const mockLoadMessagesFromServer = jest.fn().mockResolvedValue(undefined)
let mockConversationFilter = 'web'
let mockConversationHasMore = false
let mockIsLoadingMoreConversations = false
const mockIsConversationStreaming = jest.fn(() => false)
const mockHasUnviewedMessages = jest.fn(() => false)
const mockIsConversationInputRequired = jest.fn(() => false)

jest.mock('@/store/chat-store', () => {
  const getState = () => ({
    conversations: mockConversations,
    activeConversationId: mockActiveConversationId,
    conversationFilter: mockConversationFilter,
  })

  const store = (selector?: (s: unknown) => unknown) => {
    const state = {
      conversations: mockConversations,
      activeConversationId: mockActiveConversationId,
      setActiveConversation: mockSetActiveConversation,
      createConversation: mockCreateConversation,
      deleteConversation: mockDeleteConversation,
      updateConversationTitle: mockUpdateConversationTitle,
      loadConversationsFromServer: mockLoadConversationsFromServer,
      loadMessagesFromServer: mockLoadMessagesFromServer,
      conversationFilter: mockConversationFilter,
      conversationHasMore: mockConversationHasMore,
      isLoadingMoreConversations: mockIsLoadingMoreConversations,
      isConversationStreaming: mockIsConversationStreaming,
      hasUnviewedMessages: mockHasUnviewedMessages,
      isConversationInputRequired: mockIsConversationInputRequired,
    }
    return selector ? selector(state) : state
  }

  store.getState = getState
  store.setState = jest.fn()
  store.subscribe = jest.fn()

  return { useChatStore: store }
})

jest.mock('lucide-react', () => ({
  MessageSquare: (props: unknown) => <span data-testid="icon-message-square" {...props} />,
  MessageCircleQuestion: (props: unknown) => <span data-testid="icon-message-circle-question" {...props} />,
  Radio: (props: unknown) => <span data-testid="icon-radio" {...props} />,
  History: (props: unknown) => <span data-testid="icon-history" {...props} />,
  Loader2: (props: unknown) => <span data-testid="icon-loader" {...props} />,
  Plus: (props: unknown) => <span data-testid="icon-plus" {...props} />,
  Archive: (props: unknown) => <span data-testid="icon-archive" {...props} />,
  ArchiveRestore: (props: unknown) => <span data-testid="icon-archive-restore" {...props} />,
  Check: (props: unknown) => <span data-testid="icon-check" {...props} />,
  CalendarClock: (props: unknown) => <span data-testid="icon-calendar-clock" {...props} />,
  ChevronDown: (props: unknown) => <span data-testid="icon-chevron-down" {...props} />,
  ChevronLeft: (props: unknown) => <span data-testid="icon-chevron-left" {...props} />,
  ChevronRight: (props: unknown) => <span data-testid="icon-chevron-right" {...props} />,
  Code2: (props: unknown) => <span data-testid="icon-code" {...props} />,
  ListFilter: (props: unknown) => <span data-testid="icon-list-filter" {...props} />,
  Pencil: (props: unknown) => <span data-testid="icon-pencil" {...props} />,
  Sparkles: (props: unknown) => <span data-testid="icon-sparkles" {...props} />,
  Zap: (props: unknown) => <span data-testid="icon-zap" {...props} />,
  Database: (props: unknown) => <span data-testid="icon-database" {...props} />,
  Globe: (props: React.ComponentProps<'span'>) => <span data-testid="icon-globe" {...props} />,
  HardDrive: (props: unknown) => <span data-testid="icon-hard-drive" {...props} />,
  Users2: (props: unknown) => <span data-testid="icon-users2" {...props} />,
  Shield: (props: unknown) => <span data-testid="icon-shield" {...props} />,
  Users: (props: unknown) => <span data-testid="icon-users" {...props} />,
  TrendingUp: (props: unknown) => <span data-testid="icon-trending-up" {...props} />,
  RefreshCw: (props: unknown) => <span data-testid="icon-refresh" {...props} />,
  Search: (props: unknown) => <span data-testid="icon-search" {...props} />,
  AlertCircle: (props: unknown) => <span data-testid="icon-alert-circle" {...props} />,
  Webhook: (props: unknown) => <span data-testid="icon-webhook" {...props} />,
  X: (props: unknown) => <span data-testid="icon-x" {...props} />,
}))

jest.mock('@/components/ui/button', () => ({
  Button: ({ children, ...props }: unknown) => <button {...props}>{children}</button>,
}))

jest.mock('@/components/ui/scroll-area', () => ({
  ScrollArea: ({ children, viewportRef, ...props }: {
    children: React.ReactNode
    viewportRef?: React.RefObject<HTMLDivElement | null>
  }) => <div ref={viewportRef} {...props}>{children}</div>,
}))

jest.mock('@/components/ui/tooltip', () => ({
  Tooltip: ({ children }: unknown) => <>{children}</>,
  TooltipContent: ({ children }: unknown) => <>{children}</>,
  TooltipProvider: ({ children }: unknown) => <>{children}</>,
  TooltipTrigger: ({ children }: unknown) => <>{children}</>,
}))

const mockToast = jest.fn()
jest.mock('@/components/ui/toast', () => ({
  useToast: () => ({ toast: mockToast }),
}))

jest.mock('@/lib/storage-config', () => ({
  getStorageMode: () => 'mongodb',
  getStorageModeDisplay: () => 'MongoDB',
}))

let mockSchedulerEnabled = true
let mockAutonomousAgentsEnabled = true
jest.mock('@/lib/config', () => ({
  getConfig: (key: string) => {
    if (key === 'schedulerEnabled') return mockSchedulerEnabled
    if (key === 'autonomousAgentsEnabled') return mockAutonomousAgentsEnabled
    return undefined
  },
}))

jest.mock('@/lib/utils', () => ({
  cn: (...args: unknown[]) => args.filter(Boolean).join(' '),
  formatDate: () => 'Jan 1, 2026',
  truncateText: (text: string) => text,
}))

jest.mock('@/components/gallery/UseCaseBuilder', () => ({
  UseCaseBuilderDialog: () => null,
}))

jest.mock('@/components/chat/RecycleBinDialog', () => ({
  RecycleBinDialog: () => null,
}))

jest.mock('@/components/chat/ShareButton', () => ({
  ShareButton: ({ isOwner, isSharedWithViewer, sharedBy, sharing }: unknown) => {
    const hasSharingConfig = Boolean(
      (sharing?.shared_with?.length ?? 0) > 0 ||
      (sharing?.shared_with_teams?.length ?? 0) > 0 ||
      sharing?.share_link_enabled
    )
    // assisted-by Codex Codex-sonnet-4-6
    const isShared = Boolean(isSharedWithViewer || hasSharingConfig)

    return isOwner || isSharedWithViewer ? (
      <button
        data-testid="share-button"
        data-owner={String(Boolean(isOwner))}
        data-shared-viewer={String(Boolean(isSharedWithViewer))}
        data-shared={String(isShared)}
        data-shared-by={sharedBy || ''}
      >
        {isShared ? (
          <span data-testid="icon-users2" />
        ) : (
          <span data-testid="icon-share2" />
        )}
        Share
        {isSharedWithViewer && sharedBy ? <span>Shared by {sharedBy}</span> : null}
      </button>
    ) : null
  },
}))

// NewChatButton is exercised by its own test suite; stub it here so the
// Sidebar tests don't depend on its agent-avatar / dynamic-agent fetch tree.
jest.mock('@/components/chat/NewChatButton', () => ({
  NewChatButton: () => <button data-testid="new-chat-button">New Chat</button>,
}))

jest.mock('@/lib/api-client', () => ({
  apiClient: {
    createConversation: jest.fn().mockResolvedValue({ _id: 'new-id', title: 'New', created_at: new Date().toISOString(), updated_at: new Date().toISOString() }),
  },
}))

const mockListAutonomousTasks = jest.fn()
jest.mock('@/components/autonomous/api', () => ({
  autonomousApi: {
    listTasks: (...args: unknown[]) => mockListAutonomousTasks(...args),
  },
}))

// ============================================================================
// Imports — after mocks
// ============================================================================

import { Sidebar } from '../Sidebar'

// ============================================================================
// Helpers
// ============================================================================

function makeConv(id: string, title: string, overrides: unknown = {}) {
  return {
    id,
    title,
    createdAt: new Date(),
    updatedAt: new Date(),
    messages: [],
    streamEvents: [],
    ...overrides,
  }
}

const defaultProps = {
  activeTab: 'chat' as const,
  collapsed: false,
  onCollapse: jest.fn(),
}

function selectConversationTab(label: string) {
  fireEvent.mouseDown(screen.getByRole('tab', { name: label }), { button: 0, ctrlKey: false })
}

// ============================================================================
// Tests
// ============================================================================

describe('Sidebar — Live Status Indicator', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockListAutonomousTasks.mockReset()
    mockListAutonomousTasks.mockReturnValue(new Promise(() => {}))
    mockLoadConversationsFromServer.mockReturnValue(new Promise<void>(() => {}))
    global.fetch = jest.fn(
      () => new Promise<Response>(() => {}),
    ) as unknown as typeof fetch
    mockConversations = []
    mockActiveConversationId = null
    mockSchedulerEnabled = true
    mockAutonomousAgentsEnabled = true
    mockConversationFilter = 'web'
    mockConversationHasMore = false
    mockIsLoadingMoreConversations = false
    mockIsConversationStreaming.mockImplementation(() => false)
    mockHasUnviewedMessages.mockImplementation(() => false)
    mockIsConversationInputRequired.mockImplementation(() => false)
    window.localStorage.clear()
  })

  describe('loading placeholders', () => {
    it('shows conversation-shaped rows while the initial history loads', async () => {
      let resolveConversations!: () => void
      mockLoadConversationsFromServer.mockReturnValueOnce(
        new Promise<void>((resolve) => {
          resolveConversations = resolve
        }),
      )

      render(<Sidebar {...defaultProps} />)

      expect(screen.getByTestId('conversation-list-skeleton')).toBeInTheDocument()
      expect(screen.queryByText('No conversations yet')).not.toBeInTheDocument()

      await act(async () => {
        resolveConversations()
      })

      await waitFor(() => {
        expect(screen.queryByTestId('conversation-list-skeleton')).not.toBeInTheDocument()
      })
      expect(screen.getByText('No conversations yet')).toBeInTheDocument()
    })

    it('shows the date immediately and skeleton-loads the agent name independently', async () => {
      let resolveAgents!: (response: Response) => void
      global.fetch = jest.fn(
        () => new Promise<Response>((resolve) => {
          resolveAgents = resolve
        }),
      ) as unknown as typeof fetch
      mockConversations = [
        makeConv('conv-1', 'Agent Chat', {
          participants: [{ type: 'agent', id: 'agent-1' }],
        }),
      ]

      render(<Sidebar {...defaultProps} />)

      expect(screen.getByText('Jan 1, 2026')).toBeInTheDocument()
      expect(screen.getByTestId('agent-name-skeleton')).toBeInTheDocument()

      await act(async () => {
        resolveAgents({
          json: async () => ({
            success: true,
            data: [{ _id: 'agent-1', name: 'Agent One' }],
          }),
        } as Response)
      })

      await waitFor(() => {
        expect(screen.queryByTestId('agent-name-skeleton')).not.toBeInTheDocument()
      })
      expect(screen.getByText(/Agent One/)).toBeInTheDocument()
    })
  })

  // --------------------------------------------------------------------------
  // Live status indicator (green radio icon)
  // --------------------------------------------------------------------------

  describe('live status indicator', () => {
    it('renders Radio icon for a streaming conversation', () => {
      mockConversations = [makeConv('conv-1', 'Test Chat')]
      mockIsConversationStreaming.mockImplementation((id: string) => id === 'conv-1')

      render(<Sidebar {...defaultProps} />)

      expect(screen.getByTestId('icon-radio')).toBeInTheDocument()
    })

    it('renders MessageSquare icon for a non-streaming conversation', () => {
      mockConversations = [makeConv('conv-1', 'Test Chat')]
      mockIsConversationStreaming.mockImplementation(() => false)

      render(<Sidebar {...defaultProps} />)

      expect(screen.getByTestId('icon-message-square')).toBeInTheDocument()
      expect(screen.queryByTestId('icon-radio')).not.toBeInTheDocument()
    })

    it('shows "Live" text for a streaming conversation', () => {
      mockConversations = [makeConv('conv-1', 'Test Chat')]
      mockIsConversationStreaming.mockImplementation((id: string) => id === 'conv-1')

      render(<Sidebar {...defaultProps} />)

      expect(screen.getByText('Live')).toBeInTheDocument()
    })

    it('applies emerald styling to the Radio icon', () => {
      mockConversations = [makeConv('conv-1', 'Test Chat')]
      mockIsConversationStreaming.mockImplementation((id: string) => id === 'conv-1')

      render(<Sidebar {...defaultProps} />)

      const radioIcon = screen.getByTestId('icon-radio')
      expect(radioIcon.className).toContain('text-emerald-500')
      expect(radioIcon.className).toContain('animate-pulse')
    })

    it('renders Radio for streaming and MessageSquare for non-streaming conversations', () => {
      mockConversations = [
        makeConv('conv-live', 'Live Chat'),
        makeConv('conv-idle', 'Idle Chat'),
      ]
      mockIsConversationStreaming.mockImplementation((id: string) => id === 'conv-live')

      render(<Sidebar {...defaultProps} />)

      expect(screen.getByTestId('icon-radio')).toBeInTheDocument()
      expect(screen.getByTestId('icon-message-square')).toBeInTheDocument()
    })
  })

  // --------------------------------------------------------------------------
  // Unviewed messages indicator (blue dot)
  // --------------------------------------------------------------------------

  describe('unviewed messages indicator', () => {
    it('shows "New response" text for an unviewed conversation', () => {
      mockConversations = [makeConv('conv-1', 'Test Chat')]
      mockHasUnviewedMessages.mockImplementation((id: string) => id === 'conv-1')

      render(<Sidebar {...defaultProps} />)

      expect(screen.getByText('New response')).toBeInTheDocument()
    })

    it('renders MessageSquare icon (not Radio) for unviewed conversations', () => {
      mockConversations = [makeConv('conv-1', 'Test Chat')]
      mockHasUnviewedMessages.mockImplementation((id: string) => id === 'conv-1')

      render(<Sidebar {...defaultProps} />)

      expect(screen.getByTestId('icon-message-square')).toBeInTheDocument()
      expect(screen.queryByTestId('icon-radio')).not.toBeInTheDocument()
    })

    it('applies blue styling to the MessageSquare icon for unviewed', () => {
      mockConversations = [makeConv('conv-1', 'Test Chat')]
      mockHasUnviewedMessages.mockImplementation((id: string) => id === 'conv-1')

      render(<Sidebar {...defaultProps} />)

      const icon = screen.getByTestId('icon-message-square')
      expect(icon.className).toContain('text-blue-500')
    })

    it('does NOT show unviewed indicator when conversation is streaming (live takes priority)', () => {
      mockConversations = [makeConv('conv-1', 'Test Chat')]
      mockIsConversationStreaming.mockImplementation((id: string) => id === 'conv-1')
      mockHasUnviewedMessages.mockImplementation((id: string) => id === 'conv-1')

      render(<Sidebar {...defaultProps} />)

      expect(screen.getByTestId('icon-radio')).toBeInTheDocument()
      expect(screen.getByText('Live')).toBeInTheDocument()
      expect(screen.queryByText('New response')).not.toBeInTheDocument()
    })
  })

  // --------------------------------------------------------------------------
  // Input-required indicator (amber question icon)
  // --------------------------------------------------------------------------

  describe('input-required indicator', () => {
    it('shows "Input needed" text for an input-required conversation', () => {
      mockConversations = [makeConv('conv-1', 'HITL Chat')]
      mockIsConversationInputRequired.mockImplementation((id: string) => id === 'conv-1')

      render(<Sidebar {...defaultProps} />)

      expect(screen.getByText('Input needed')).toBeInTheDocument()
    })

    it('renders MessageCircleQuestion icon for input-required conversations', () => {
      mockConversations = [makeConv('conv-1', 'HITL Chat')]
      mockIsConversationInputRequired.mockImplementation((id: string) => id === 'conv-1')

      render(<Sidebar {...defaultProps} />)

      expect(screen.getByTestId('icon-message-circle-question')).toBeInTheDocument()
      expect(screen.queryByTestId('icon-radio')).not.toBeInTheDocument()
      expect(screen.queryByTestId('icon-message-square')).not.toBeInTheDocument()
    })

    it('applies amber styling to the MessageCircleQuestion icon', () => {
      mockConversations = [makeConv('conv-1', 'HITL Chat')]
      mockIsConversationInputRequired.mockImplementation((id: string) => id === 'conv-1')

      render(<Sidebar {...defaultProps} />)

      const icon = screen.getByTestId('icon-message-circle-question')
      expect(icon.className).toContain('text-amber-500')
      expect(icon.className).toContain('animate-pulse')
    })

    it('does NOT show input-required indicator when conversation is streaming (live takes priority)', () => {
      mockConversations = [makeConv('conv-1', 'HITL Chat')]
      mockIsConversationStreaming.mockImplementation((id: string) => id === 'conv-1')
      mockIsConversationInputRequired.mockImplementation((id: string) => id === 'conv-1')

      render(<Sidebar {...defaultProps} />)

      expect(screen.getByTestId('icon-radio')).toBeInTheDocument()
      expect(screen.getByText('Live')).toBeInTheDocument()
      expect(screen.queryByText('Input needed')).not.toBeInTheDocument()
    })

    it('input-required takes priority over unviewed', () => {
      mockConversations = [makeConv('conv-1', 'HITL Chat')]
      mockIsConversationInputRequired.mockImplementation((id: string) => id === 'conv-1')
      mockHasUnviewedMessages.mockImplementation((id: string) => id === 'conv-1')

      render(<Sidebar {...defaultProps} />)

      expect(screen.getByTestId('icon-message-circle-question')).toBeInTheDocument()
      expect(screen.getByText('Input needed')).toBeInTheDocument()
      expect(screen.queryByText('New response')).not.toBeInTheDocument()
    })
  })

  // --------------------------------------------------------------------------
  // Normal (idle) state
  // --------------------------------------------------------------------------

  describe('normal conversation state', () => {
    it('shows formatted date for a normal conversation', () => {
      mockConversations = [makeConv('conv-1', 'Test Chat')]

      render(<Sidebar {...defaultProps} />)

      expect(screen.getByText('Jan 1, 2026')).toBeInTheDocument()
    })

    it('shows schedule title badge for scheduled conversations', () => {
      mockLoadConversationsFromServer.mockResolvedValue(undefined)
      mockConversations = [
        makeConv('conv-1', 'Scheduled Chat', {
          metadata: {
            source: 'scheduler',
            schedule_id: 'sched_ec7107dfab744ddd',
            schedule_title: 'Important Team 2 Meeting Prep',
          },
        }),
      ]

      render(<Sidebar {...defaultProps} />)

      selectConversationTab('Scheduled')
      expect(screen.getByText('Important Team 2 Meeting Prep')).toBeInTheDocument()
      expect(screen.queryByText('sched_ec7107dfab744ddd')).not.toBeInTheDocument()
    })

    it('falls back to schedule id when scheduled conversations have no title', () => {
      mockLoadConversationsFromServer.mockResolvedValue(undefined)
      mockConversations = [
        makeConv('conv-1', 'Scheduled Chat', {
          metadata: { source: 'scheduler', schedule_id: 'sched_ec7107dfab744ddd' },
        }),
      ]

      render(<Sidebar {...defaultProps} />)

      selectConversationTab('Scheduled')
      expect(screen.getByText('sched_ec7107dfab744ddd')).toBeInTheDocument()
    })

    it('shows an autonomous task title badge with distinct violet styling', () => {
      mockLoadConversationsFromServer.mockResolvedValue(undefined)
      mockConversations = [
        makeConv('conv-1', '[Autonomous] Review open pull requests', {
          source: 'autonomous',
          task_id: 'review-open-prs-a1b2',
          metadata: { task_name: 'Review open pull requests' },
        }),
      ]

      render(<Sidebar {...defaultProps} />)

      selectConversationTab('Autonomous')
      const badge = screen.getByText('Review open pull requests')
      expect(badge).toHaveClass(
        'border-violet-500/30',
        'bg-violet-500/10',
        'text-violet-700',
      )
      expect(badge).toHaveAttribute(
        'title',
        'Autonomous task review-open-prs-a1b2: Review open pull requests',
      )
    })

    it('uses the conversation title for existing autonomous conversations', () => {
      mockLoadConversationsFromServer.mockResolvedValue(undefined)
      mockConversations = [
        makeConv('conv-1', '[Autonomous] Legacy task title', {
          source: 'autonomous',
          task_id: 'legacy-task-a1b2',
        }),
      ]

      render(<Sidebar {...defaultProps} />)

      selectConversationTab('Autonomous')
      expect(screen.getByText('Legacy task title')).toHaveClass('border-violet-500/30')
    })

    it.each([
      { metadata: { task_id: 'legacy-task', task_name: 'Legacy task' } },
      {},
    ])('keeps legacy autonomous runs out of the Chat tab', (markers) => {
      mockConversations = [
        makeConv('legacy-autonomous', '[Autonomous] Legacy task', markers),
        makeConv('normal', 'Normal Chat'),
      ]
      render(<Sidebar {...defaultProps} />)
      selectConversationTab('Chat')
      expect(screen.getByText('Normal Chat')).toBeInTheDocument()
      expect(screen.queryByText('Legacy task')).not.toBeInTheDocument()
      selectConversationTab('Autonomous')
      expect(screen.getByText('Legacy task')).toBeInTheDocument()
      expect(screen.queryByText('Normal Chat')).not.toBeInTheDocument()
    })

    it('omits disabled automation tabs and does not fetch webhook tasks', () => {
      mockSchedulerEnabled = false
      mockAutonomousAgentsEnabled = false
      window.localStorage.setItem('caipe-chat-history-tab', 'autonomous')
      render(<Sidebar {...defaultProps} />)
      expect(screen.getByRole('tab', { name: 'Chat' })).toHaveAttribute('aria-selected', 'true')
      expect(screen.queryByRole('tab', { name: 'Autonomous' })).not.toBeInTheDocument()
      expect(screen.queryByRole('tab', { name: 'Scheduled' })).not.toBeInTheDocument()
      expect(mockListAutonomousTasks).not.toHaveBeenCalled()
      expect(mockLoadConversationsFromServer).toHaveBeenCalledWith({ filter: 'web' })
    })

    it('separates Chat, Scheduled, and Autonomous without leaving the History heading behind', () => {
      mockConversations = [
        makeConv('conv-normal', 'Normal Chat'),
        makeConv('conv-scheduled', 'Scheduled Chat', {
          metadata: { schedule_id: 'sched-1', schedule_title: 'Nightly report' },
        }),
        makeConv('conv-autonomous', '[Autonomous] Review alerts', {
          source: 'autonomous',
          task_id: 'review-alerts',
          metadata: { task_name: 'Review alerts' },
        }),
      ]
      // An old dropdown preference must not restore an unfiltered list.
      window.localStorage.setItem('caipe-chat-history-filter', 'all')
      render(<Sidebar {...defaultProps} />)

      expect(screen.getByRole('tablist', { name: 'Conversation views' })).toBeInTheDocument()
      expect(screen.queryByRole('combobox', { name: 'Filter chat history' })).not.toBeInTheDocument()
      expect(screen.getByRole('tab', { name: 'Chat' })).toHaveAttribute('aria-selected', 'true')
      expect(screen.getByRole('tabpanel', { name: 'Chat' })).toHaveTextContent('History')
      expect(screen.getByText('Normal Chat')).toBeInTheDocument()
      expect(screen.queryByText('Review alerts')).not.toBeInTheDocument()
      expect(screen.queryByText('Nightly report')).not.toBeInTheDocument()

      // These assertions are synchronous: there must be no outgoing title or
      // conversation retained by an exit animation during tab switches.
      selectConversationTab('Autonomous')
      expect(screen.getByRole('tabpanel', { name: 'Autonomous' })).toBeInTheDocument()
      expect(screen.queryByText('History')).not.toBeInTheDocument()
      expect(screen.getByText('Review alerts')).toBeInTheDocument()
      expect(screen.queryByText('Normal Chat')).not.toBeInTheDocument()
      expect(screen.queryByText('Nightly report')).not.toBeInTheDocument()
      expect(mockLoadConversationsFromServer).toHaveBeenLastCalledWith({ filter: 'autonomous' })

      selectConversationTab('Scheduled')
      expect(screen.getByText('Nightly report')).toBeInTheDocument()
      expect(screen.queryByText('Review alerts')).not.toBeInTheDocument()
      expect(screen.queryByText('History')).not.toBeInTheDocument()
      expect(mockLoadConversationsFromServer).toHaveBeenLastCalledWith({ filter: 'scheduled' })

      selectConversationTab('Chat')
      expect(screen.getByText('Normal Chat')).toBeInTheDocument()
      expect(screen.getAllByText('History')).toHaveLength(1)
      expect(screen.queryByText('Nightly report')).not.toBeInTheDocument()
      expect(screen.queryByText('Review alerts')).not.toBeInTheDocument()
      expect(mockLoadConversationsFromServer).toHaveBeenLastCalledWith({ filter: 'web' })
    })

    it('restores the selected conversation tab from browser storage', () => {
      mockConversations = [
        makeConv('conv-normal', 'Normal Chat'),
        makeConv('conv-autonomous', '[Autonomous] Review alerts', { source: 'autonomous' }),
      ]
      const { unmount } = render(<Sidebar {...defaultProps} />)

      selectConversationTab('Autonomous')
      expect(window.localStorage.getItem('caipe-chat-history-tab')).toBe('autonomous')
      unmount()
      mockLoadConversationsFromServer.mockClear()
      render(<Sidebar {...defaultProps} />)

      expect(screen.getByRole('tab', { name: 'Autonomous' })).toHaveAttribute('aria-selected', 'true')
      expect(screen.getByText('Review alerts')).toBeInTheDocument()
      expect(screen.queryByText('Normal Chat')).not.toBeInTheDocument()
      expect(mockLoadConversationsFromServer).toHaveBeenCalledWith({ filter: 'autonomous' })
    })

    it.each(['web', 'scheduled', 'autonomous'])('loads the next page for the %s tab', async (filter) => {
      window.localStorage.setItem('caipe-chat-history-tab', filter)
      mockConversationFilter = filter
      mockConversationHasMore = true
      mockLoadConversationsFromServer.mockResolvedValue(undefined)
      mockConversations = [makeConv('conv-normal', 'Normal Chat')]
      await act(async () => { render(<Sidebar {...defaultProps} />) })

      const viewport = screen.getByTestId('conversation-history-scroll')
      Object.defineProperties(viewport, {
        scrollHeight: { configurable: true, value: 600 },
        scrollTop: { configurable: true, value: 320 },
        clientHeight: { configurable: true, value: 240 },
      })
      fireEvent.scroll(viewport)

      expect(mockLoadConversationsFromServer).toHaveBeenCalledWith({
        filter,
        append: true,
      })
    })

    it('does not append the previous tab while the newly selected tab is loading', async () => {
      mockConversationHasMore = true
      mockLoadConversationsFromServer.mockResolvedValue(undefined)
      await act(async () => { render(<Sidebar {...defaultProps} />) })
      mockLoadConversationsFromServer.mockReturnValue(new Promise<void>(() => {}))

      selectConversationTab('Autonomous')
      const viewport = screen.getByTestId('conversation-history-scroll')
      fireEvent.scroll(viewport)
      expect(mockLoadConversationsFromServer).toHaveBeenLastCalledWith({ filter: 'autonomous' })
      expect(mockLoadConversationsFromServer).not.toHaveBeenCalledWith(
        expect.objectContaining({ append: true }),
      )
    })

    it('filters to webhook tasks owned by the current user', async () => {
      mockLoadConversationsFromServer.mockResolvedValueOnce(undefined)
      mockListAutonomousTasks.mockResolvedValue([
        {
          id: 'daily-branch-summary-41a9',
          name: 'Daily branch summary',
          agent: null,
          dynamic_agent_id: 'agent-1',
          prompt: 'Summarize the delivery.',
          trigger: { type: 'webhook', provider: 'github', has_secret: true },
          enabled: true,
          owner_id: 'test@test.com',
        },
        {
          id: 'other-owner-hook',
          name: 'Other owner hook',
          agent: null,
          dynamic_agent_id: 'agent-1',
          prompt: 'Ignore this task.',
          trigger: { type: 'webhook', provider: 'jira', has_secret: true },
          enabled: true,
          owner_id: 'other@test.com',
        },
      ])

      render(<Sidebar {...defaultProps} />)

      expect(mockListAutonomousTasks).toHaveBeenCalledTimes(1)
      expect(screen.queryByText('Daily branch summary')).not.toBeInTheDocument()

      selectConversationTab('Autonomous')
      const webhookSection = await screen.findByRole('button', { name: /Webhook Runs/ })
      expect(webhookSection).toHaveAttribute('aria-expanded', 'false')
      expect(screen.queryByText('Daily branch summary')).not.toBeInTheDocument()
      fireEvent.click(webhookSection)
      expect(webhookSection).toHaveAttribute('aria-expanded', 'true')
      expect(await screen.findByText('Daily branch summary')).toBeInTheDocument()
      expect(screen.queryByText('Other owner hook')).not.toBeInTheDocument()

      fireEvent.click(screen.getByTestId('webhook-task-daily-branch-summary-41a9'))
      expect(mockPush).toHaveBeenCalledWith(
        '/chat/webhooks/daily-branch-summary-41a9',
      )
    })

    it('does not show "Live" or "New response" for normal conversations', () => {
      mockConversations = [makeConv('conv-1', 'Test Chat')]

      render(<Sidebar {...defaultProps} />)

      expect(screen.queryByText('Live')).not.toBeInTheDocument()
      expect(screen.queryByText('New response')).not.toBeInTheDocument()
    })

    it('uses the share icon for owner conversations without sharing config', () => {
      mockConversations = [
        makeConv('conv-owner-private', 'Private Owner Chat', {
          owner_id: 'test@test.com',
        }),
      ]

      render(<Sidebar {...defaultProps} />)

      expect(screen.getByText('Private Owner Chat')).toBeInTheDocument()
      expect(screen.getByTestId('icon-share2')).toBeInTheDocument()
      expect(screen.queryByTestId('icon-users2')).not.toBeInTheDocument()
      expect(screen.getByTestId('share-button')).toHaveAttribute('data-owner', 'true')
      expect(screen.getByTestId('share-button')).toHaveAttribute('data-shared', 'false')
    })

    it('shows a shared badge for link-shared conversations', () => {
      mockConversations = [
        makeConv('conv-shared-link', 'Shared Link Chat', {
          owner_id: 'owner@test.com',
          // assisted-by Codex Codex-sonnet-4-6
          // Link-shared direct URLs should still render the non-public shared badge.
          sharing: {
            is_public: false,
            shared_with: [],
            shared_with_teams: [],
            share_link_enabled: true,
          },
        }),
      ]

      render(<Sidebar {...defaultProps} />)

      expect(screen.getByText('Shared Link Chat')).toBeInTheDocument()
      expect(screen.getByTestId('icon-users2')).toBeInTheDocument()
      expect(screen.queryByTestId('icon-globe')).not.toBeInTheDocument()
    })

    it('shows a shared badge for recipient access even without sharing arrays', () => {
      mockConversations = [
        makeConv('conv-recipient', 'Recipient Chat', {
          owner_id: 'owner@test.com',
          accessLevel: 'shared_readonly',
        }),
      ]

      render(<Sidebar {...defaultProps} />)

      expect(screen.getByText('Recipient Chat')).toBeInTheDocument()
      expect(screen.getByTestId('icon-users2')).toBeInTheDocument()
      expect(screen.getByText('Shared by owner@test.com')).toBeInTheDocument()
      expect(screen.getByTestId('share-button')).toHaveAttribute('data-owner', 'false')
      expect(screen.getByTestId('share-button')).toHaveAttribute('data-shared-viewer', 'true')
      expect(screen.getByTestId('share-button')).toHaveAttribute('data-shared-by', 'owner@test.com')
    })

    it('shows a shared badge from the server viewer flag without owner metadata', () => {
      mockConversations = [
        makeConv('conv-flagged-recipient', 'Flagged Recipient Chat', {
          isSharedWithViewer: true,
          sharing: {
            is_public: false,
            shared_with: [],
            shared_with_teams: [],
            share_link_enabled: false,
          },
        }),
      ]

      render(<Sidebar {...defaultProps} />)

      expect(screen.getByText('Flagged Recipient Chat')).toBeInTheDocument()
      expect(screen.getByTestId('icon-users2')).toBeInTheDocument()
      expect(screen.queryByTestId('icon-globe')).not.toBeInTheDocument()
      expect(screen.getByTestId('share-button')).toHaveAttribute('data-owner', 'false')
      expect(screen.getByTestId('share-button')).toHaveAttribute('data-shared-viewer', 'true')
    })

    it('shows the shared action icon to the owner without marking them as a recipient', () => {
      mockConversations = [
        makeConv('conv-owner-shared', 'Owner Shared Chat', {
          owner_id: 'test@test.com',
          sharing: {
            is_public: false,
            shared_with: ['teammate@test.com'],
            shared_with_teams: [],
            share_link_enabled: false,
          },
        }),
      ]

      render(<Sidebar {...defaultProps} />)

      expect(screen.getByText('Owner Shared Chat')).toBeInTheDocument()
      expect(screen.getByTestId('icon-users2')).toBeInTheDocument()
      expect(screen.queryByTestId('icon-globe')).not.toBeInTheDocument()
      expect(screen.getByTestId('share-button')).toHaveAttribute('data-owner', 'true')
      expect(screen.getByTestId('share-button')).toHaveAttribute('data-shared-viewer', 'false')
      expect(screen.getByTestId('share-button')).toHaveAttribute('data-shared', 'true')
    })

    it('does not treat legacy public conversations as shared', () => {
      mockConversations = [
        makeConv('conv-public', 'Public Chat', {
          owner_id: 'owner@test.com',
          sharing: {
            is_public: true,
            shared_with: [],
            shared_with_teams: [],
            share_link_enabled: false,
          },
        }),
      ]

      render(<Sidebar {...defaultProps} />)

      expect(screen.getByText('Public Chat')).toBeInTheDocument()
      expect(screen.queryByTestId('share-button')).not.toBeInTheDocument()
      expect(screen.queryByTestId('icon-share2')).not.toBeInTheDocument()
      expect(screen.queryByTestId('icon-users2')).not.toBeInTheDocument()
      expect(screen.queryByTestId('icon-globe')).not.toBeInTheDocument()
    })
  })

  // --------------------------------------------------------------------------
  // Mixed states (multiple conversations with different statuses)
  // --------------------------------------------------------------------------

  describe('mixed conversation states', () => {
    it('renders correct indicators for live, input-required, unviewed, and normal conversations', () => {
      mockConversations = [
        makeConv('conv-live', 'Live Chat'),
        makeConv('conv-hitl', 'HITL Chat'),
        makeConv('conv-unviewed', 'Unviewed Chat'),
        makeConv('conv-normal', 'Normal Chat'),
      ]
      mockIsConversationStreaming.mockImplementation((id: string) => id === 'conv-live')
      mockIsConversationInputRequired.mockImplementation((id: string) => id === 'conv-hitl')
      mockHasUnviewedMessages.mockImplementation((id: string) => id === 'conv-unviewed')

      render(<Sidebar {...defaultProps} />)

      expect(screen.getByText('Live')).toBeInTheDocument()
      expect(screen.getByText('Input needed')).toBeInTheDocument()
      expect(screen.getByText('New response')).toBeInTheDocument()
      expect(screen.getByText('Jan 1, 2026')).toBeInTheDocument()
      expect(screen.getByTestId('icon-radio')).toBeInTheDocument()
      expect(screen.getByTestId('icon-message-circle-question')).toBeInTheDocument()
    })
  })

  // --------------------------------------------------------------------------
  // Click behavior
  // --------------------------------------------------------------------------

  describe('conversation click behavior', () => {
    it('calls setActiveConversation when clicking a conversation', () => {
      mockConversations = [makeConv('conv-click', 'Clickable Chat')]

      render(<Sidebar {...defaultProps} />)

      fireEvent.click(screen.getByText('Clickable Chat'))

      expect(mockSetActiveConversation).toHaveBeenCalledWith('conv-click')
    })

    it('renames a conversation from the action buttons', async () => {
      mockConversations = [
        makeConv('conv-rename', 'Original Title', {
          owner_id: 'test@test.com',
        }),
      ]

      render(<Sidebar {...defaultProps} />)

      fireEvent.click(screen.getByRole('button', { name: 'Rename conversation' }))
      const titleInput = screen.getByRole('textbox', { name: 'Conversation title' })
      fireEvent.change(titleInput, { target: { value: 'Updated Title' } })
      fireEvent.click(screen.getByRole('button', { name: 'Save title' }))

      await waitFor(() => {
        expect(mockUpdateConversationTitle).toHaveBeenCalledWith('conv-rename', 'Updated Title')
        expect(screen.queryByRole('textbox', { name: 'Conversation title' })).not.toBeInTheDocument()
      })
    })

    it('cancels title editing without saving', () => {
      mockConversations = [
        makeConv('conv-rename', 'Original Title', {
          owner_id: 'test@test.com',
        }),
      ]

      render(<Sidebar {...defaultProps} />)

      fireEvent.click(screen.getByRole('button', { name: 'Rename conversation' }))
      fireEvent.change(screen.getByRole('textbox', { name: 'Conversation title' }), {
        target: { value: 'Discarded Title' },
      })
      fireEvent.click(screen.getByRole('button', { name: 'Cancel rename' }))

      expect(screen.queryByRole('textbox', { name: 'Conversation title' })).not.toBeInTheDocument()
      expect(screen.getByText('Original Title')).toBeInTheDocument()
      expect(mockUpdateConversationTitle).not.toHaveBeenCalled()
    })
  })

  // --------------------------------------------------------------------------
  // Archive failures
  // --------------------------------------------------------------------------

  describe('archive failure handling', () => {
    /** Clicks the archive action on the first conversation in the list. */
    function clickArchive() {
      const archiveButton = screen.getAllByTestId('icon-archive')[0].closest('button')
      expect(archiveButton).not.toBeNull()
      fireEvent.click(archiveButton as HTMLButtonElement)
    }

    it('reports the failure instead of claiming the conversation was archived', async () => {
      // The store restores the conversation when the server refuses (e.g. 403 on
      // a conversation shared with, but not owned by, the viewer).
      mockDeleteConversation.mockRejectedValue(new Error('Forbidden'))
      mockConversations = [
        makeConv('conv-shared', 'Shared Chat', { owner_id: 'owner@test.com' }),
        makeConv('conv-mine', 'My Chat', { owner_id: 'test@test.com' }),
      ]

      render(<Sidebar {...defaultProps} />)
      clickArchive()

      await waitFor(() => {
        expect(mockToast).toHaveBeenCalledWith(
          expect.stringContaining("Couldn't archive \"Shared Chat\""),
          'error',
          expect.any(Number),
        )
      })
      expect(mockToast).not.toHaveBeenCalledWith(
        expect.stringContaining('moved to Archive'),
        'success',
        expect.any(Number),
      )
    })

    it('confirms the archive when the server accepts it', async () => {
      mockDeleteConversation.mockResolvedValue(undefined)
      mockConversations = [
        makeConv('conv-mine', 'My Chat', { owner_id: 'test@test.com' }),
        makeConv('conv-other', 'Other Chat', { owner_id: 'test@test.com' }),
      ]

      render(<Sidebar {...defaultProps} />)
      clickArchive()

      await waitFor(() => {
        expect(mockToast).toHaveBeenCalledWith(
          '"My Chat" moved to Archive',
          'success',
          expect.any(Number),
        )
      })
    })
  })

  // --------------------------------------------------------------------------
  // Empty state
  // --------------------------------------------------------------------------

  describe('empty state', () => {
    it('shows empty state message after loading when no conversations exist', async () => {
      mockConversations = []
      mockLoadConversationsFromServer.mockResolvedValueOnce(undefined)

      render(<Sidebar {...defaultProps} />)

      expect(await screen.findByText('No conversations yet')).toBeInTheDocument()
      expect(screen.getByText('Start a new chat to begin')).toBeInTheDocument()
    })
  })

  describe('sidebar resizing', () => {
    it('drags in both directions and restores the saved browser width', async () => {
      const { unmount } = render(<Sidebar {...defaultProps} />)
      const resizeHandle = screen.getByRole('separator', { name: 'Resize chat sidebar' })
      const pointerEvent = (type: string, pointerId: number, clientX: number) => {
        const event = new MouseEvent(type, { bubbles: true, clientX })
        Object.defineProperty(event, 'pointerId', { value: pointerId })
        return event
      }

      fireEvent(resizeHandle, pointerEvent('pointerdown', 1, 320))
      fireEvent(resizeHandle, pointerEvent('pointermove', 1, 460))
      fireEvent(resizeHandle, pointerEvent('pointerup', 1, 460))
      expect(resizeHandle).toHaveAttribute('aria-valuenow', '460')

      fireEvent(resizeHandle, pointerEvent('pointerdown', 2, 460))
      fireEvent(resizeHandle, pointerEvent('pointermove', 2, 380))
      fireEvent(resizeHandle, pointerEvent('pointerup', 2, 380))
      expect(resizeHandle).toHaveAttribute('aria-valuenow', '380')
      expect(window.localStorage.getItem('caipe-chat-sidebar-width')).toBe('380')

      unmount()
      render(<Sidebar {...defaultProps} />)
      await waitFor(() => {
        expect(screen.getByRole('separator', { name: 'Resize chat sidebar' }))
          .toHaveAttribute('aria-valuenow', '380')
      })
    })
  })

  // --------------------------------------------------------------------------
  // Collapsed sidebar
  // --------------------------------------------------------------------------

  describe('collapsed sidebar', () => {
    it('does not render conversation titles when collapsed', () => {
      mockConversations = [makeConv('conv-1', 'Hidden Title')]

      render(<Sidebar {...defaultProps} collapsed={true} />)

      expect(screen.queryByText('Hidden Title')).not.toBeInTheDocument()
    })

    it('does not render "Live" or "New response" text when collapsed', () => {
      mockConversations = [makeConv('conv-1', 'Chat')]
      mockIsConversationStreaming.mockImplementation((id: string) => id === 'conv-1')

      render(<Sidebar {...defaultProps} collapsed={true} />)

      expect(screen.queryByText('Live')).not.toBeInTheDocument()
    })

    it('still renders icons when collapsed', () => {
      mockConversations = [makeConv('conv-1', 'Chat')]
      mockIsConversationStreaming.mockImplementation((id: string) => id === 'conv-1')

      render(<Sidebar {...defaultProps} collapsed={true} />)

      expect(screen.getByTestId('icon-radio')).toBeInTheDocument()
    })
  })
})
