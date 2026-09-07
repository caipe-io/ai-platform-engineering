/**
 * Unit tests for InsightsWidget component
 *
 * Tests:
 * - Loading state: shows skeleton loader while the fetch is in flight
 * - Empty state: shows "Start chatting" message when stats resolve to null-ish
 * - Renders total conversations count
 * - Renders conversations this week
 * - Renders messages this week
 * - Renders top agents with usage counts
 * - Limits agents to top 3
 * - Shows singular "use" when agent count is 1
 * - "View all" link navigates to /insights
 * - Hides agents section when no favorite agents
 * - Renders data-testids for all key elements
 */

import React from 'react'
import { render, screen } from '@testing-library/react'

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
  TrendingUp: (props: unknown) => <svg data-testid="icon-trending-up" {...props} />,
  Bot: (props: unknown) => <svg data-testid="icon-bot" {...props} />,
  ArrowRight: (props: unknown) => <svg data-testid="icon-arrow-right" {...props} />,
}))

jest.mock('@/lib/utils', () => ({
  cn: (...args: unknown[]) => args.filter(Boolean).join(' '),
}))

jest.mock('next-auth/react', () => ({
  useSession: () => ({ data: { user: { email: 'test@example.com' } }, status: 'authenticated' }),
}))

const mockGetUserStats = jest.fn()
jest.mock('@/lib/api-client', () => ({
  apiClient: {
    getUserStats: () => mockGetUserStats(),
  },
}))

// ============================================================================
// Imports — after mocks
// ============================================================================

import { InsightsWidget } from '../InsightsWidget'

// ============================================================================
// Helpers
// ============================================================================

function makeStats(overrides: Record<string, unknown> = {}) {
  return {
    total_conversations: 42,
    conversations_this_week: 7,
    messages_this_week: 35,
    favorite_agents: [
      { name: 'github', count: 20 },
      { name: 'argocd', count: 15 },
      { name: 'aws', count: 10 },
    ],
    ...overrides,
  }
}

function neverResolves() {
  return new Promise(() => {})
}

// ============================================================================
// Tests
// ============================================================================

describe('InsightsWidget', () => {
  beforeEach(() => {
    mockGetUserStats.mockReset()
  })

  describe('loading state', () => {
    it('shows loading skeleton', () => {
      mockGetUserStats.mockReturnValue(neverResolves())
      render(<InsightsWidget />)
      expect(screen.getByTestId('insights-widget-loading')).toBeInTheDocument()
    })

    it('does not render stats while loading', () => {
      mockGetUserStats.mockReturnValue(neverResolves())
      render(<InsightsWidget />)
      expect(screen.queryByTestId('total-conversations')).not.toBeInTheDocument()
    })
  })

  describe('empty state', () => {
    it('shows "Start chatting" message when the fetch fails', async () => {
      mockGetUserStats.mockRejectedValue(new Error('nope'))
      render(<InsightsWidget />)
      expect(await screen.findByTestId('insights-widget-empty')).toBeInTheDocument()
      expect(screen.getByText('Start chatting to build your insights.')).toBeInTheDocument()
    })
  })

  describe('with stats', () => {
    it('renders the widget container', () => {
      mockGetUserStats.mockResolvedValue(makeStats())
      render(<InsightsWidget />)
      expect(screen.getByTestId('insights-widget')).toBeInTheDocument()
    })

    it('renders total conversations', async () => {
      mockGetUserStats.mockResolvedValue(makeStats())
      render(<InsightsWidget />)
      expect(await screen.findByTestId('total-conversations')).toHaveTextContent('42')
    })

    it('renders conversations this week', async () => {
      mockGetUserStats.mockResolvedValue(makeStats())
      render(<InsightsWidget />)
      expect(await screen.findByTestId('conversations-this-week')).toHaveTextContent('7 this week')
    })

    it('renders messages this week', async () => {
      mockGetUserStats.mockResolvedValue(makeStats())
      render(<InsightsWidget />)
      expect(await screen.findByTestId('messages-this-week-value')).toHaveTextContent('35')
    })

    it('renders the section title', () => {
      mockGetUserStats.mockResolvedValue(makeStats())
      render(<InsightsWidget />)
      expect(screen.getByText('Your Insights')).toBeInTheDocument()
    })

    it('renders "View all" link to /insights', () => {
      mockGetUserStats.mockResolvedValue(makeStats())
      render(<InsightsWidget />)
      const link = screen.getByTestId('view-all-insights')
      expect(link).toBeInTheDocument()
      expect(link).toHaveAttribute('href', '/insights')
    })
  })

  describe('favorite agents', () => {
    it('renders top agents with names and counts', async () => {
      mockGetUserStats.mockResolvedValue(makeStats())
      render(<InsightsWidget />)
      expect(await screen.findByTestId('agent-github')).toBeInTheDocument()
      expect(screen.getByTestId('agent-argocd')).toBeInTheDocument()
      expect(screen.getByTestId('agent-aws')).toBeInTheDocument()
      expect(screen.getByText('20 uses')).toBeInTheDocument()
      expect(screen.getByText('15 uses')).toBeInTheDocument()
      expect(screen.getByText('10 uses')).toBeInTheDocument()
    })

    it('limits to top 3 agents', async () => {
      mockGetUserStats.mockResolvedValue(
        makeStats({
          favorite_agents: [
            { name: 'github', count: 20 },
            { name: 'argocd', count: 15 },
            { name: 'aws', count: 10 },
            { name: 'slack', count: 5 },
          ],
        }),
      )
      render(<InsightsWidget />)
      expect(await screen.findByTestId('agent-github')).toBeInTheDocument()
      expect(screen.getByTestId('agent-argocd')).toBeInTheDocument()
      expect(screen.getByTestId('agent-aws')).toBeInTheDocument()
      expect(screen.queryByTestId('agent-slack')).not.toBeInTheDocument()
    })

    it('shows singular "use" when count is 1', async () => {
      mockGetUserStats.mockResolvedValue(makeStats({ favorite_agents: [{ name: 'github', count: 1 }] }))
      render(<InsightsWidget />)
      expect(await screen.findByText('1 use')).toBeInTheDocument()
    })

    it('hides agents section when no favorite agents', async () => {
      mockGetUserStats.mockResolvedValue(makeStats({ favorite_agents: [] }))
      render(<InsightsWidget />)
      await screen.findByTestId('total-conversations')
      expect(screen.queryByText('Top Agents')).not.toBeInTheDocument()
    })
  })
})
