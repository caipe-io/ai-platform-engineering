/**
 * Unit tests for HeroComposer
 *
 * Tests:
 * - Renders the heading, textarea, agent picker, and attachment control
 * - Enables sending for text or supported attachments
 * - Resolves the default agent on mount and passes it to AgentSelector
 * - Submitting uses the resolved/picked agent id, creates a conversation,
 *   stashes the pending turn, and navigates to /chat/{id}
 * - Falls back to resolveUsableChatAgentId() if no default resolved yet
 * - Surfaces a toast and re-enables the composer on failure
 */

import React from 'react'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'

// ============================================================================
// Mocks
// ============================================================================

jest.mock('lucide-react', () => {
  // eslint-disable-next-line react/display-name
  const stub = (name: string) => (props: unknown) => <svg data-testid={`icon-${name}`} {...props} />
  return new Proxy({}, { get: (_t, prop: string) => stub(prop) })
})

jest.mock('@/lib/utils', () => ({
  cn: (...args: unknown[]) => args.filter(Boolean).join(' '),
}))

jest.mock('@/components/chat/AgentSelector', () => ({
  AgentSelector: ({
    selectedAgentId,
    onSelectAgent,
  }: {
    selectedAgentId?: string
    onSelectAgent: (id: string) => void
  }) => (
    <div data-testid="agent-selector-stub" data-selected-agent-id={selectedAgentId ?? ''}>
      <button type="button" data-testid="agent-selector-pick" onClick={() => onSelectAgent('picked-agent')}>
        pick another agent
      </button>
    </div>
  ),
}))

const mockToast = jest.fn()
jest.mock('@/components/ui/toast', () => ({
  useToast: () => ({ toast: mockToast }),
}))

const mockPush = jest.fn()
jest.mock('next/navigation', () => ({
  useRouter: () => ({ push: mockPush }),
}))

const mockResolveUsableChatAgent = jest.fn()
const mockResolveUsableChatAgentId = jest.fn()
jest.mock('@/lib/chat-agent-selection', () => ({
  resolveUsableChatAgent: () => mockResolveUsableChatAgent(),
  resolveUsableChatAgentId: () => mockResolveUsableChatAgentId(),
}))

const mockSetPendingFirstMessage = jest.fn()
jest.mock('@/lib/pending-first-message', () => ({
  setPendingFirstMessage: (...args: unknown[]) => mockSetPendingFirstMessage(...args),
}))

const mockCreateConversation = jest.fn()
jest.mock('@/store/chat-store', () => ({
  useChatStore: {
    getState: () => ({ createConversation: (...args: unknown[]) => mockCreateConversation(...args) }),
  },
}))

// ============================================================================
// Imports — after mocks
// ============================================================================

import { HeroComposer } from '../HeroComposer'

// ============================================================================
// Tests
// ============================================================================

describe('HeroComposer', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockResolveUsableChatAgent.mockResolvedValue({
      id: 'default-agent',
      name: 'Default Agent',
      source: 'platform-default',
    })
    mockResolveUsableChatAgentId.mockResolvedValue('fallback-agent')
    mockCreateConversation.mockResolvedValue('new-conv-id')
  })

  it('renders the heading and input', () => {
    render(<HeroComposer />)
    expect(screen.getByRole('heading', { name: 'What would you like to do today?' })).toBeInTheDocument()
    expect(screen.getByTestId('hero-composer-input')).toBeInTheDocument()
  })

  it('keeps the composer concise', () => {
    render(<HeroComposer />)
    expect(
      screen.queryByText('Starts a new chat with the agent best suited to your request.'),
    ).not.toBeInTheDocument()
  })

  it('disables the send button when the input is empty', () => {
    render(<HeroComposer />)
    expect(screen.getByTestId('hero-composer-send')).toBeDisabled()
  })

  it('enables the send button once text is typed', () => {
    render(<HeroComposer />)
    fireEvent.change(screen.getByTestId('hero-composer-input'), { target: { value: 'How do I deploy?' } })
    expect(screen.getByTestId('hero-composer-send')).not.toBeDisabled()
  })

  it('places a working attachment control immediately before Send', async () => {
    render(<HeroComposer />)
    const attach = screen.getByRole('button', { name: 'Attach files' })
    const send = screen.getByTestId('hero-composer-send')
    expect(attach.nextElementSibling).toBe(send)
    expect(screen.queryByTestId('icon-Plus')).not.toBeInTheDocument()

    const file = new File(['hello'], 'example.txt', { type: 'text/plain' })
    fireEvent.change(screen.getByTestId('hero-composer-file-input'), {
      target: { files: [file] },
    })

    expect(await screen.findByText('example.txt')).toBeInTheDocument()
    expect(send).not.toBeDisabled()
    fireEvent.click(send)

    await waitFor(() => expect(mockSetPendingFirstMessage).toHaveBeenCalledWith(
      'new-conv-id',
      '',
      [expect.objectContaining({ name: 'example.txt', mime_type: 'text/plain' })],
    ))
  })

  it('resolves the default agent on mount and passes it to AgentSelector', async () => {
    render(<HeroComposer />)
    await waitFor(() =>
      expect(screen.getByTestId('agent-selector-stub')).toHaveAttribute('data-selected-agent-id', 'default-agent'),
    )
  })

  it('lets the user pick a different agent via AgentSelector', async () => {
    render(<HeroComposer />)
    await waitFor(() => expect(mockResolveUsableChatAgent).toHaveBeenCalled())
    fireEvent.click(screen.getByTestId('agent-selector-pick'))
    expect(screen.getByTestId('agent-selector-stub')).toHaveAttribute('data-selected-agent-id', 'picked-agent')
  })

  it('creates a conversation with the resolved default agent, stashes the message, and navigates', async () => {
    render(<HeroComposer />)
    await waitFor(() =>
      expect(screen.getByTestId('agent-selector-stub')).toHaveAttribute('data-selected-agent-id', 'default-agent'),
    )
    fireEvent.change(screen.getByTestId('hero-composer-input'), { target: { value: 'How do I deploy?' } })
    fireEvent.click(screen.getByTestId('hero-composer-send'))

    await waitFor(() => expect(mockCreateConversation).toHaveBeenCalledWith('default-agent'))
    expect(mockSetPendingFirstMessage).toHaveBeenCalledWith('new-conv-id', 'How do I deploy?', [])
    await waitFor(() => expect(mockPush).toHaveBeenCalledWith('/chat/new-conv-id'))
    expect(mockResolveUsableChatAgentId).not.toHaveBeenCalled()
  })

  it('falls back to resolveUsableChatAgentId() if no default has resolved yet', async () => {
    mockResolveUsableChatAgent.mockReturnValue(new Promise(() => {})) // never resolves
    render(<HeroComposer />)
    fireEvent.change(screen.getByTestId('hero-composer-input'), { target: { value: 'hello' } })
    fireEvent.click(screen.getByTestId('hero-composer-send'))

    await waitFor(() => expect(mockResolveUsableChatAgentId).toHaveBeenCalled())
    expect(mockCreateConversation).toHaveBeenCalledWith('fallback-agent')
  })

  it('shows a toast and stays usable if conversation creation fails', async () => {
    mockCreateConversation.mockRejectedValue(new Error('Backend unavailable'))
    render(<HeroComposer />)
    fireEvent.change(screen.getByTestId('hero-composer-input'), { target: { value: 'hello' } })
    fireEvent.click(screen.getByTestId('hero-composer-send'))

    await waitFor(() => expect(mockToast).toHaveBeenCalledWith('Backend unavailable', 'error'))
    expect(mockPush).not.toHaveBeenCalled()
  })
})
