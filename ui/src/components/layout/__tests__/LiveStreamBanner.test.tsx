/**
 * Unit tests for LiveStreamBanner component
 *
 * Covers:
 * - Hidden when no conversations are streaming
 * - Visible with singular message for 1 streaming conversation
 * - Visible with plural message for multiple streaming conversations
 * - Contains accessibility attributes (role="status", aria-live)
 * - Shows label text matching streaming count
 */

import React from 'react'
import { render, screen } from '@testing-library/react'

// ============================================================================
// Mocks — must be before imports
// ============================================================================

jest.mock("@/lib/agentic-apps/use-chat-session-recovery", () => ({ useChatSessionRecovery: jest.fn() }));

let mockStreamingConversations = new Map<string, unknown>()

jest.mock('@/store/chat-store', () => {
  const store = (selector?: (s: unknown) => unknown) => {
    const state = {
      streamingConversations: mockStreamingConversations,
      externalActivity: {},
    }
    return selector ? selector(state) : state
  }

  store.getState = () => ({ streamingConversations: mockStreamingConversations })
  store.setState = jest.fn()
  store.subscribe = jest.fn()

  return { useChatStore: store }
})

jest.mock('lucide-react', () => ({
  Radio: (props: unknown) => <span data-testid="icon-radio" {...props} />,
}))

// ============================================================================
// Imports — after mocks
// ============================================================================

import { LiveStreamBanner } from '../LiveStreamBanner'

// ============================================================================
// Tests
// ============================================================================

describe('LiveStreamBanner', () => {
  beforeEach(() => {
    mockStreamingConversations = new Map()
  })

  it('renders nothing when no conversations are streaming', () => {
    const { container } = render(<LiveStreamBanner />)

    expect(container.firstChild).toBeNull()
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
  })

  it('renders singular message for 1 streaming conversation', () => {
    mockStreamingConversations = new Map([
      ['conv-1', { conversationId: 'conv-1', messageId: 'msg-1', client: {} }],
    ])

    render(<LiveStreamBanner />)

    expect(screen.getByText(/1 live response in progress/)).toBeInTheDocument()
  })

  it('renders plural message for multiple streaming conversations', () => {
    mockStreamingConversations = new Map([
      ['conv-1', { conversationId: 'conv-1', messageId: 'msg-1', client: {} }],
      ['conv-2', { conversationId: 'conv-2', messageId: 'msg-2', client: {} }],
    ])

    render(<LiveStreamBanner />)

    expect(screen.getByText(/2 live responses in progress/)).toBeInTheDocument()
  })

  it('shows label text matching streaming count', () => {
    mockStreamingConversations = new Map([
      ['conv-1', { conversationId: 'conv-1', messageId: 'msg-1', client: {} }],
    ])

    render(<LiveStreamBanner />)

    expect(screen.getByText('1 live response in progress')).toBeInTheDocument()
  })

  it('has accessible role="status" and aria-live="polite"', () => {
    mockStreamingConversations = new Map([
      ['conv-1', { conversationId: 'conv-1', messageId: 'msg-1', client: {} }],
    ])

    render(<LiveStreamBanner />)

    const banner = screen.getByRole('status')
    expect(banner).toBeInTheDocument()
    expect(banner).toHaveAttribute('aria-live', 'polite')
  })

  it('renders the Radio icon', () => {
    mockStreamingConversations = new Map([
      ['conv-1', { conversationId: 'conv-1', messageId: 'msg-1', client: {} }],
    ])

    render(<LiveStreamBanner />)

    expect(screen.getByTestId('icon-radio')).toBeInTheDocument()
  })
})
