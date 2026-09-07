/**
 * Unit tests for RecentChats component
 *
 * Tests:
 * - Renders conversation cards fetched via apiClient (mongodb mode)
 * - Limits displayed conversations to maxItems
 * - Shows loading skeletons while the fetch is in flight
 * - Shows empty state when no conversations
 * - Empty state has "Start a new chat" link
 * - Shows "New Chat" link in header
 * - Renders data-testid for the section
 * - Defaults maxItems to 6
 */

import React from 'react'
import { render, screen, waitFor } from '@testing-library/react'

// ============================================================================
// Mocks
// ============================================================================

jest.mock('next/link', () => {
  // eslint-disable-next-line react/display-name
  return React.forwardRef(({ children, href, className, ...props }: unknown, ref: unknown) => (
    <a ref={ref} href={href} className={className} data-testid={props['data-testid'] || `link-${href}`} {...props}>
      {children}
    </a>
  ))
})

jest.mock('lucide-react', () => ({
  MessageSquare: (props: unknown) => <svg data-testid="icon-message-square" {...props} />,
  Plus: (props: unknown) => <svg data-testid="icon-plus" {...props} />,
  Users2: (props: unknown) => <svg data-testid="icon-users2" {...props} />,
  Clock: (props: unknown) => <svg data-testid="icon-clock" {...props} />,
  Bot: (props: unknown) => <svg data-testid="icon-bot" {...props} />,
}))

jest.mock('@/lib/utils', () => ({
  cn: (...args: unknown[]) => args.filter(Boolean).join(' '),
  formatRelativeTimeCompact: () => 'Just now',
}))

let mockSessionStatus: 'authenticated' | 'unauthenticated' | 'loading' = 'authenticated'
jest.mock('next-auth/react', () => ({
  useSession: () => ({ data: { user: { email: 'test@example.com' } }, status: mockSessionStatus }),
}))

jest.mock('@/lib/storage-config', () => ({
  getStorageMode: () => 'mongodb',
}))

const mockGetConversations = jest.fn()
jest.mock('@/lib/api-client', () => ({
  apiClient: {
    getConversations: (...args: unknown[]) => mockGetConversations(...args),
  },
}))

jest.mock('@/store/chat-store', () => ({
  useChatStore: () => ({ conversations: [], loadConversationsFromServer: jest.fn() }),
}))

jest.mock('@/types/a2a', () => ({
  getAgentId: (conv: { participants?: Array<{ type: string; id: string }> }) =>
    conv.participants?.find((p) => p.type === 'agent')?.id,
}))

// ============================================================================
// Imports — after mocks
// ============================================================================

import { RecentChats } from '../RecentChats'

// ============================================================================
// Helpers
// ============================================================================

function makeRawConversations(count: number) {
  return Array.from({ length: count }, (_, i) => ({
    _id: `conv-${i}`,
    title: `Conversation ${i + 1}`,
    updated_at: new Date(Date.now() - i * 3600000).toISOString(),
    metadata: { total_messages: (i + 1) * 3 },
    sharing: { shared_with: [], shared_with_teams: [] },
  }))
}

function neverResolves() {
  return new Promise(() => {})
}

// ============================================================================
// Tests
// ============================================================================

describe('RecentChats', () => {
  beforeEach(() => {
    mockGetConversations.mockReset()
    mockGetConversations.mockResolvedValue({ items: [] })
    mockSessionStatus = 'authenticated'
  })

  it('does not get stuck on the loading skeleton when the session is unauthenticated', () => {
    mockSessionStatus = 'unauthenticated'
    render(<RecentChats />)
    expect(screen.queryByTestId('skeleton')).not.toBeInTheDocument()
    expect(screen.getByTestId('recent-chats-empty')).toBeInTheDocument()
    expect(mockGetConversations).not.toHaveBeenCalled()
  })

  it('renders the section heading', async () => {
    render(<RecentChats />)
    expect(screen.getByText('Recent Chats')).toBeInTheDocument()
    await waitFor(() => expect(mockGetConversations).toHaveBeenCalled())
  })

  it('renders data-testid', () => {
    render(<RecentChats />)
    expect(screen.getByTestId('recent-chats')).toBeInTheDocument()
  })

  it('renders the "New Chat" link', () => {
    render(<RecentChats />)
    expect(screen.getByTestId('new-chat-link')).toBeInTheDocument()
    expect(screen.getByTestId('new-chat-link')).toHaveAttribute('href', '/chat')
  })

  describe('loading state', () => {
    it('shows skeleton loaders while the fetch is in flight', () => {
      mockGetConversations.mockReturnValue(neverResolves())
      render(<RecentChats />)
      const skeletons = screen.getAllByTestId('skeleton')
      expect(skeletons.length).toBe(3)
    })

    it('does not render conversation cards while loading', () => {
      mockGetConversations.mockReturnValue(neverResolves())
      render(<RecentChats />)
      expect(screen.queryByText('Conversation 1')).not.toBeInTheDocument()
    })
  })

  describe('empty state', () => {
    it('shows empty state message when no conversations', async () => {
      render(<RecentChats />)
      expect(await screen.findByTestId('recent-chats-empty')).toBeInTheDocument()
      expect(screen.getByText('No conversations yet')).toBeInTheDocument()
    })

    it('has a "Start a new chat" link in empty state', async () => {
      render(<RecentChats />)
      expect(await screen.findByText('Start a new chat')).toBeInTheDocument()
    })
  })

  describe('with conversations', () => {
    it('renders conversation cards', async () => {
      mockGetConversations.mockResolvedValue({ items: makeRawConversations(3) })
      render(<RecentChats />)
      expect(await screen.findByText('Conversation 1')).toBeInTheDocument()
      expect(screen.getByText('Conversation 2')).toBeInTheDocument()
      expect(screen.getByText('Conversation 3')).toBeInTheDocument()
    })

    it('passes agent names through to conversation cards', async () => {
      mockGetConversations.mockResolvedValue({
        items: [
          {
            _id: 'conv-agent',
            title: 'Agent Chat',
            updated_at: new Date().toISOString(),
            metadata: {},
            sharing: { shared_with: [], shared_with_teams: [] },
            agent_name: 'Platform Helper',
          },
        ],
      })
      render(<RecentChats />)
      expect(await screen.findByText('Platform Helper')).toBeInTheDocument()
    })

    it('limits to maxItems (default 6)', async () => {
      mockGetConversations.mockResolvedValue({ items: makeRawConversations(10) })
      render(<RecentChats />)
      expect(await screen.findByText('Conversation 6')).toBeInTheDocument()
      expect(screen.queryByText('Conversation 7')).not.toBeInTheDocument()
    })

    it('respects custom maxItems', async () => {
      mockGetConversations.mockResolvedValue({ items: makeRawConversations(10) })
      render(<RecentChats maxItems={2} />)
      expect(await screen.findByText('Conversation 2')).toBeInTheDocument()
      expect(screen.queryByText('Conversation 3')).not.toBeInTheDocument()
    })

    it('renders fewer cards if conversations < maxItems', async () => {
      mockGetConversations.mockResolvedValue({ items: makeRawConversations(2) })
      render(<RecentChats maxItems={6} />)
      expect(await screen.findByText('Conversation 1')).toBeInTheDocument()
      expect(screen.getByText('Conversation 2')).toBeInTheDocument()
    })

    it('does not show empty state when conversations exist', async () => {
      mockGetConversations.mockResolvedValue({ items: makeRawConversations(1) })
      render(<RecentChats />)
      await screen.findByText('Conversation 1')
      expect(screen.queryByTestId('recent-chats-empty')).not.toBeInTheDocument()
    })
  })
})
