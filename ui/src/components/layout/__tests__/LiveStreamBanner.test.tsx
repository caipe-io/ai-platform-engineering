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
import { fireEvent, render, screen } from '@testing-library/react'

// ============================================================================
// Mocks — must be before imports
// ============================================================================

jest.mock("@/lib/agentic-apps/use-chat-session-recovery", () => ({ useChatSessionRecovery: jest.fn() }));

let mockStreamingConversations = new Map<string, unknown>()
let mockConversations: Array<{ id: string; title: string }> = []

jest.mock('@/store/chat-store', () => {
  const store = (selector?: (s: unknown) => unknown) => {
    const state = {
      streamingConversations: mockStreamingConversations,
      externalActivity: {},
      conversations: mockConversations,
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
  MessageSquare: (props: unknown) => <span {...props} />,
  ChevronRight: (props: unknown) => <span {...props} />,
}))

jest.mock('next/link', () => ({
  __esModule: true,
  default: ({ onClick, ...props }: React.ComponentProps<'a'>) => (
    <a {...props} onClick={(event) => { event.preventDefault(); onClick?.(event) }} />
  ),
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
    mockConversations = []
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

  it('links directly to the only live conversation using its title', () => {
    mockStreamingConversations.set('primary', {})
    mockConversations = [{ id: 'primary', title: 'Example investigation' }]
    render(<LiveStreamBanner />)
    expect(screen.getByRole('link', { name: /Example investigation/ })).toHaveAttribute('href', '/chat/primary')
  })

  it('uses a neutral title for a stream outside the loaded conversation page', () => {
    mockStreamingConversations.set('unloaded', {})
    render(<LiveStreamBanner />)
    expect(screen.getByRole('link', { name: /Conversation/ })).toHaveAttribute('href', '/chat/unloaded')
  })

  it('encodes conversation identifiers as a single route segment', () => {
    mockStreamingConversations.set('example/secondary?tab=other', {})
    render(<LiveStreamBanner />)
    expect(screen.getByRole('link')).toHaveAttribute('href', '/chat/example%2Fsecondary%3Ftab%3Dother')
  })

  it('opens a bounded chooser for multiple streams and closes it on selection', () => {
    mockStreamingConversations = new Map([['primary', {}], ['secondary', {}]])
    mockConversations = [{ id: 'primary', title: 'First response' }, { id: 'secondary', title: 'Second response' }]
    render(<LiveStreamBanner />)
    expect(screen.queryByRole('link')).not.toBeInTheDocument()
    const trigger = screen.getByRole('button', { name: /Choose a response/ })
    expect(trigger).toHaveAttribute('aria-expanded', 'false')
    fireEvent.click(trigger)
    expect(trigger).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByRole('navigation', { name: 'Live responses' })).toHaveAttribute('id', trigger.getAttribute('aria-controls'))
    expect(screen.getByRole('link', { name: 'First response' })).toHaveAttribute('href', '/chat/primary')
    const secondary = screen.getByRole('link', { name: 'Second response' })
    expect(secondary).toHaveAttribute('href', '/chat/secondary')
    fireEvent.click(secondary)
    expect(screen.queryByText('Live responses')).not.toBeInTheDocument()
  })

  it('dismisses the chooser with Escape and restores trigger focus', () => {
    mockStreamingConversations = new Map([['primary', {}], ['secondary', {}]])
    render(<LiveStreamBanner />)
    const trigger = screen.getByRole('button', { name: /Choose a response/ })
    fireEvent.click(trigger)
    expect(screen.getByText('Live responses')).toBeInTheDocument()
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByText('Live responses')).not.toBeInTheDocument()
    expect(trigger).toHaveFocus()
  })

  it('updates the destination when streams finish without retaining stale links', () => {
    mockStreamingConversations = new Map([['primary', {}], ['secondary', {}]])
    const { rerender } = render(<LiveStreamBanner />)
    fireEvent.click(screen.getByRole('button', { name: /Choose a response/ }))
    mockStreamingConversations = new Map([['secondary', {}]])
    rerender(<LiveStreamBanner />)
    expect(screen.getByRole('link')).toHaveAttribute('href', '/chat/secondary')
    expect(screen.queryByText('Live responses')).not.toBeInTheDocument()
    mockStreamingConversations = new Map()
    rerender(<LiveStreamBanner />)
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
    mockStreamingConversations = new Map([['primary', {}], ['secondary', {}]])
    rerender(<LiveStreamBanner />)
    expect(screen.getByRole('button', { name: /Choose a response/ })).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByText('Live responses')).not.toBeInTheDocument()
  })
})
