/**
 * Unit tests for SharedConversations component
 *
 * Tests:
 * - Renders section heading
 * - Renders shared-with-me and team tabs
 * - Default active tab is "Shared with me"
 * - Switching tabs shows the correct content
 * - Shows empty state for each tab when empty
 * - Each tab shows correct empty message
 * - Shows loading skeletons while the fetch is in flight
 * - Renders conversation cards fetched via apiClient.getSharedConversations
 * - Tab switching clears old content and shows new content
 */

import React from 'react'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'

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
  Users2: (props: unknown) => <svg data-testid="icon-users2" {...props} />,
  Users: (props: unknown) => <svg data-testid="icon-users" {...props} />,
  MessageSquare: (props: unknown) => <svg data-testid="icon-message-square" {...props} />,
  Clock: (props: unknown) => <svg data-testid="icon-clock" {...props} />,
  Bot: (props: unknown) => <svg data-testid="icon-bot" {...props} />,
}))

jest.mock('@/lib/utils', () => ({
  cn: (...args: unknown[]) => args.filter(Boolean).join(' '),
  formatRelativeTimeCompact: () => 'Just now',
}))

jest.mock('next-auth/react', () => ({
  useSession: () => ({ data: { user: { email: 'test@example.com' } }, status: 'authenticated' }),
}))

const mockGetSharedConversations = jest.fn()
jest.mock('@/lib/api-client', () => ({
  apiClient: {
    getSharedConversations: (...args: unknown[]) => mockGetSharedConversations(...args),
  },
}))

// ============================================================================
// Imports — after mocks
// ============================================================================

import { SharedConversations } from '../SharedConversations'

// ============================================================================
// Helpers
// ============================================================================

/** `team` items carry a non-empty `shared_with_teams` so they land in the Team tab too. */
function makeRawItems(prefix: string, count: number, opts: { team?: boolean } = {}) {
  return Array.from({ length: count }, (_, i) => ({
    _id: `${prefix}-${i}`,
    title: `${prefix} Chat ${i + 1}`,
    updated_at: new Date().toISOString(),
    metadata: { total_messages: 5 },
    owner_id: 'owner@example.com',
    sharing: { shared_with_teams: opts.team ? ['team-1'] : [] },
  }))
}

function neverResolves() {
  return new Promise(() => {})
}

// ============================================================================
// Tests
// ============================================================================

describe('SharedConversations', () => {
  beforeEach(() => {
    mockGetSharedConversations.mockReset()
    mockGetSharedConversations.mockResolvedValue({ items: [] })
  })

  it('renders the section heading', () => {
    render(<SharedConversations />)
    expect(screen.getByText('Shared Conversations')).toBeInTheDocument()
  })

  it('renders data-testid', () => {
    render(<SharedConversations />)
    expect(screen.getByTestId('shared-conversations')).toBeInTheDocument()
  })

  it('renders share tabs', () => {
    render(<SharedConversations />)
    expect(screen.getByTestId('shared-tab-shared-with-me')).toBeInTheDocument()
    expect(screen.getByTestId('shared-tab-team')).toBeInTheDocument()
    expect(screen.queryByTestId('shared-tab-everyone')).not.toBeInTheDocument()
  })

  it('renders tab labels', () => {
    render(<SharedConversations />)
    expect(screen.getByText('Shared with me')).toBeInTheDocument()
    expect(screen.getByText('Team')).toBeInTheDocument()
    expect(screen.queryByText('Everyone')).not.toBeInTheDocument()
  })

  describe('loading state', () => {
    it('shows skeletons while the fetch is in flight', () => {
      mockGetSharedConversations.mockReturnValue(neverResolves())
      render(<SharedConversations />)
      const skeletons = screen.getAllByTestId('skeleton')
      expect(skeletons.length).toBe(3)
    })
  })

  describe('empty states', () => {
    it('shows "Shared with me" empty message by default', async () => {
      render(<SharedConversations />)
      expect(await screen.findByTestId('shared-empty')).toBeInTheDocument()
      expect(screen.getByText('No conversations shared with you yet.')).toBeInTheDocument()
    })

    it('shows "Team" empty message when Team tab is active', async () => {
      render(<SharedConversations />)
      await waitFor(() => expect(mockGetSharedConversations).toHaveBeenCalled())
      fireEvent.click(screen.getByTestId('shared-tab-team'))
      expect(screen.getByText('No team-shared conversations yet.')).toBeInTheDocument()
    })
  })

  describe('with data', () => {
    it('renders shared-with-me conversations by default', async () => {
      mockGetSharedConversations.mockResolvedValue({ items: makeRawItems('me', 2) })
      render(<SharedConversations />)
      expect(await screen.findByText('me Chat 1')).toBeInTheDocument()
      expect(screen.getByText('me Chat 2')).toBeInTheDocument()
    })

    it('renders team conversations when Team tab is clicked', async () => {
      mockGetSharedConversations.mockResolvedValue({
        items: [...makeRawItems('me', 1), ...makeRawItems('team', 2, { team: true })],
      })
      render(<SharedConversations />)
      await screen.findByText('me Chat 1')
      fireEvent.click(screen.getByTestId('shared-tab-team'))
      expect(screen.getByText('team Chat 1')).toBeInTheDocument()
      expect(screen.getByText('team Chat 2')).toBeInTheDocument()
      expect(screen.queryByText('me Chat 1')).not.toBeInTheDocument()
    })

    it('switching tabs updates visible conversations', async () => {
      mockGetSharedConversations.mockResolvedValue({
        items: [...makeRawItems('me', 1), ...makeRawItems('team', 1, { team: true })],
      })
      render(<SharedConversations />)
      expect(await screen.findByText('me Chat 1')).toBeInTheDocument()

      fireEvent.click(screen.getByTestId('shared-tab-team'))
      expect(screen.queryByText('me Chat 1')).not.toBeInTheDocument()
      expect(screen.getByText('team Chat 1')).toBeInTheDocument()

      fireEvent.click(screen.getByTestId('shared-tab-shared-with-me'))
      expect(screen.getByText('me Chat 1')).toBeInTheDocument()
    })

    it('does not show empty state when items exist', async () => {
      mockGetSharedConversations.mockResolvedValue({ items: makeRawItems('me', 1) })
      render(<SharedConversations />)
      await screen.findByText('me Chat 1')
      expect(screen.queryByTestId('shared-empty')).not.toBeInTheDocument()
    })
  })
})
