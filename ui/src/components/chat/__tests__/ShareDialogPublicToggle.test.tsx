import { fireEvent, render, screen, waitFor } from '@testing-library/react'

const mockUpdateConversationSharing = jest.fn()
const mockPush = jest.fn()

jest.mock('next/navigation', () => ({
  useRouter: () => ({ push: mockPush }),
}))

const mockShareConversation = jest.fn()
jest.mock('@/store/chat-store', () => ({
  useChatStore: (selector: unknown) => selector({ updateConversationSharing: mockUpdateConversationSharing }),
}))

jest.mock('@/lib/api-client', () => ({
  apiClient: {
    searchUsers: jest.fn().mockResolvedValue([]),
    shareConversation: (...args: unknown[]) => mockShareConversation(...args),
    updateConversationSharePermission: jest.fn(),
    revokeConversationShare: jest.fn(),
  },
}))

import { ShareDialog } from '../ShareDialog'

describe('ShareDialog — public sharing removed', () => {
  const defaultProps = {
    conversationId: 'conv-123',
    conversationTitle: 'Test Conv',
    open: true,
    onOpenChange: jest.fn(),
  }

  beforeEach(() => {
    jest.clearAllMocks()
    mockShareConversation.mockResolvedValue(undefined)
    ;(global.fetch as jest.Mock).mockImplementation((url: string, opts?: unknown) => {
      if (url.includes('/api/dynamic-agents/teams')) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({ success: true, data: [] }),
        })
      }
      if (url.includes('/share') && (!opts || opts.method !== 'POST')) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({
            data: {
              sharing: {
                is_public: true,
                shared_with: [],
                shared_with_teams: [],
                share_link_enabled: false,
              },
            },
          }),
        })
      }
      return Promise.resolve({ ok: true, status: 200, json: async () => ({}) })
    })
  })

  it('does not render the Share with everyone toggle even for legacy public conversations', async () => {
    render(<ShareDialog {...defaultProps} />)

    await waitFor(() => {
      expect(screen.queryByText('Share with everyone')).not.toBeInTheDocument()
      expect(screen.queryByTestId('share-public-toggle')).not.toBeInTheDocument()
    })
  })

  it('does not mirror legacy is_public=true into client sharing state', async () => {
    render(<ShareDialog {...defaultProps} />)

    await waitFor(() => {
      expect(mockUpdateConversationSharing).toHaveBeenCalledWith(
        'conv-123',
        expect.objectContaining({ is_public: false }),
      )
    })
  })

  it('does not post is_public when sharing with teams', async () => {
    let sharing = {
      is_public: true,
      shared_with: [],
      shared_with_teams: [] as string[],
      share_link_enabled: false,
    }
    mockShareConversation.mockImplementation(async (_conversationId, request) => {
      sharing = { ...sharing, shared_with_teams: request.team_ids }
      return { sharing }
    })

    ;(global.fetch as jest.Mock).mockImplementation((url: string, opts?: unknown) => {
      if (url.includes('/api/dynamic-agents/teams')) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({
            success: true,
            data: [
              {
                _id: 'team-1',
                slug: 'platform',
                name: 'Platform Team',
                description: 'Core platform',
              },
            ],
          }),
        })
      }
      if (url.includes('/share') && (!opts || opts.method !== 'POST')) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({ data: { sharing } }),
        })
      }
      return Promise.resolve({ ok: true, status: 200, json: async () => ({}) })
    })

    render(<ShareDialog {...defaultProps} />)

    await waitFor(() => {
      expect(screen.getByPlaceholderText('Search by email or team name...')).toBeInTheDocument()
    })

    fireEvent.change(screen.getByPlaceholderText('Search by email or team name...'), {
      target: { value: 'plat' },
    })

    await waitFor(() => {
      expect(screen.getByText('Platform Team')).toBeInTheDocument()
    })

    fireEvent.click(screen.getByText('Platform Team'))

    await waitFor(() => {
      expect(mockShareConversation).toHaveBeenCalledWith(
        'conv-123',
        { team_ids: ['platform'], permission: 'comment' },
      )
    })
  })

  it('does not offer direct email sharing for an unprovisioned user', async () => {
    render(<ShareDialog {...defaultProps} />)
    const search = await screen.findByPlaceholderText('Search by email or team name...')

    fireEvent.change(search, { target: { value: 'not-logged-in@example.com' } })

    await waitFor(() => {
      expect(screen.getByText('No people or teams found')).toBeInTheDocument()
    })
    expect(screen.queryByText('Share with not-logged-in@example.com')).not.toBeInTheDocument()
    expect(screen.queryByText(/get access when they log in/i)).not.toBeInTheDocument()
  })
})
