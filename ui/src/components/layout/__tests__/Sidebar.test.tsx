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
const mockIsConversationStreaming = jest.fn(() => false)
const mockHasUnviewedMessages = jest.fn(() => false)
const mockIsConversationInputRequired = jest.fn(() => false)

jest.mock('@/store/chat-store', () => {
  const getState = () => ({
    conversations: mockConversations,
    activeConversationId: mockActiveConversationId,
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
  Plus: (props: unknown) => <span data-testid="icon-plus" {...props} />,
  Archive: (props: unknown) => <span data-testid="icon-archive" {...props} />,
  ArchiveRestore: (props: unknown) => <span data-testid="icon-archive-restore" {...props} />,
  Check: (props: unknown) => <span data-testid="icon-check" {...props} />,
  ChevronLeft: (props: unknown) => <span data-testid="icon-chevron-left" {...props} />,
  ChevronRight: (props: unknown) => <span data-testid="icon-chevron-right" {...props} />,
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
  Webhook: (props: unknown) => <span data-testid="icon-webhook" {...props} />,
  X: (props: unknown) => <span data-testid="icon-x" {...props} />,
}))

jest.mock('@/components/ui/button', () => ({
  Button: ({ children, ...props }: unknown) => <button {...props}>{children}</button>,
}))

jest.mock('@/components/ui/scroll-area', () => ({
  ScrollArea: ({ children, ...props }: unknown) => <div {...props}>{children}</div>,
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
    mockIsConversationStreaming.mockImplementation(() => false)
    mockHasUnviewedMessages.mockImplementation(() => false)
    mockIsConversationInputRequired.mockImplementation(() => false)
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

      expect(screen.queryByText('Important Team 2 Meeting Prep')).not.toBeInTheDocument()
      fireEvent.click(screen.getByRole('button', { name: /Scheduled Runs/i }))
      expect(screen.getByText('Important Team 2 Meeting Prep')).toBeInTheDocument()
      expect(screen.queryByText('sched_ec7107dfab744ddd')).not.toBeInTheDocument()
    })

    it('falls back to schedule id when scheduled conversations have no title', () => {
      mockConversations = [
        makeConv('conv-1', 'Scheduled Chat', {
          metadata: { source: 'scheduler', schedule_id: 'sched_ec7107dfab744ddd' },
        }),
      ]

      render(<Sidebar {...defaultProps} />)

      fireEvent.click(screen.getByRole('button', { name: /Scheduled Runs/i }))
      expect(screen.getByText('sched_ec7107dfab744ddd')).toBeInTheDocument()
    })

    it('shows an autonomous task title badge with distinct violet styling', () => {
      mockConversations = [
        makeConv('conv-1', '[Autonomous] Review open pull requests', {
          source: 'autonomous',
          task_id: 'review-open-prs-a1b2',
          metadata: { task_name: 'Review open pull requests' },
        }),
      ]

      render(<Sidebar {...defaultProps} />)

      expect(screen.queryByText('Review open pull requests')).not.toBeInTheDocument()
      fireEvent.click(screen.getByRole('button', { name: /Autonomous Runs/i }))
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
      mockConversations = [
        makeConv('conv-1', '[Autonomous] Legacy task title', {
          source: 'autonomous',
          task_id: 'legacy-task-a1b2',
        }),
      ]

      render(<Sidebar {...defaultProps} />)

      fireEvent.click(screen.getByRole('button', { name: /Autonomous Runs/i }))
      expect(screen.getByText('Legacy task title')).toHaveClass('border-violet-500/30')
    })

    it('separates run conversations into collapsed sections above History', () => {
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

      render(<Sidebar {...defaultProps} />)

      const autonomous = screen.getByRole('button', { name: /Autonomous Runs/i })
      const scheduled = screen.getByRole('button', { name: /Scheduled Runs/i })
      const history = screen.getByTestId('conversation-section-history')

      expect(autonomous).toHaveAttribute('aria-expanded', 'false')
      expect(scheduled).toHaveAttribute('aria-expanded', 'false')
      expect(screen.queryByText('Review alerts')).not.toBeInTheDocument()
      expect(screen.queryByText('Nightly report')).not.toBeInTheDocument()
      expect(screen.getByText('Normal Chat')).toBeInTheDocument()
      expect(
        autonomous.compareDocumentPosition(history) & Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy()
      expect(
        scheduled.compareDocumentPosition(history) & Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy()

      fireEvent.click(autonomous)
      expect(autonomous).toHaveAttribute('aria-expanded', 'true')
      expect(screen.getByText('Review alerts')).toBeInTheDocument()
      expect(screen.queryByText('Nightly report')).not.toBeInTheDocument()
    })

    it('groups the current user webhook tasks in a nested collapsed section', async () => {
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

      const autonomous = await screen.findByRole('button', { name: /Autonomous Runs/i })
      expect(mockListAutonomousTasks).toHaveBeenCalledTimes(1)
      fireEvent.click(autonomous)

      const webhookRuns = screen.getByRole('button', { name: /Webhook Runs/i })
      expect(webhookRuns).toHaveAttribute('aria-expanded', 'false')
      expect(screen.queryByText('Daily branch summary')).not.toBeInTheDocument()

      fireEvent.click(webhookRuns)
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
