import { fireEvent, render, screen, waitFor } from '@testing-library/react'

const mockUpdateConversationSharing = jest.fn()
const mockPush = jest.fn()

jest.mock('next/navigation', () => ({
  useRouter: () => ({ push: mockPush }),
}))

jest.mock('@/store/chat-store', () => ({
  useChatStore: (selector: unknown) => selector({ updateConversationSharing: mockUpdateConversationSharing }),
}))

jest.mock('@/lib/api-client', () => ({
  apiClient: {
    searchUsers: jest.fn().mockResolvedValue([]),
    shareConversation: jest.fn(),
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
      if (url.includes('/share') && opts?.method === 'POST') {
        sharing = { ...sharing, shared_with_teams: ['platform'] }
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
      const postCalls = (global.fetch as jest.Mock).mock.calls.filter(
        ([url, opts]: [string, unknown]) => url.includes('/share') && opts?.method === 'POST',
      )
      expect(postCalls.length).toBeGreaterThan(0)
      const body = JSON.parse(postCalls[0][1].body)
      expect(body).toEqual({ team_ids: ['platform'], permission: 'comment' })
    })
  })
})
