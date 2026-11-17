
import { fireEvent, render, screen, waitFor } from '@testing-library/react'

const mockUpdateConversationSharing = jest.fn()
const mockPush = jest.fn()

jest.mock('next/navigation', () => ({
  useRouter: () => ({ push: mockPush }),
}))
const mockRevokeConversationShare = jest.fn()

jest.mock('@/store/chat-store', () => ({
  useChatStore: (selector: unknown) => selector({
    updateConversationSharing: mockUpdateConversationSharing,
  }),
}))

jest.mock('@/lib/api-client', () => ({
  apiClient: {
    searchUsers: jest.fn().mockResolvedValue([]),
    shareConversation: jest.fn(),
    updateConversationSharePermission: jest.fn(),
    revokeConversationShare: (...args: unknown[]) => mockRevokeConversationShare(...args),
  },
}))

import { ShareDialog } from '../ShareDialog'

describe('ShareDialog permissions', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  it('shows direct edit permission in the shared-recipient details modal', async () => {
    ;(global.fetch as jest.Mock).mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        data: {
          sharing: {
            is_public: false,
            shared_with: ['recipient@example.com'],
            shared_with_teams: [],
            share_link_enabled: false,
          },
          access_list: [
            {
              granted_to: 'recipient@example.com',
              permission: 'comment',
            },
          ],
        },
      }),
    })

    render(
      <ShareDialog
        conversationId="conv-123"
        conversationTitle="Shared edit chat"
        open
        onOpenChange={jest.fn()}
        canManageSharing={false}
        sharedBy="owner@example.com"
        initialSharing={{
          is_public: false,
          shared_with: ['recipient@example.com'],
          shared_with_teams: [],
          share_link_enabled: false,
        }}
      />
    )

    await waitFor(() => {
      expect(screen.getByText('recipient@example.com')).toBeInTheDocument()
      expect(screen.getByText('Can edit')).toBeInTheDocument()
    })

    expect(screen.getByText(/Chat sharing does not grant agent access/)).toBeInTheDocument()
    expect(screen.getByText('Shared by')).toBeInTheDocument()
    expect(screen.queryByPlaceholderText('Search by email or team name...')).not.toBeInTheDocument()
  })

  it('loads sharing once even when initialSharing receives a new object identity', async () => {
    ;(global.fetch as jest.Mock).mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        data: {
          sharing: {
            is_public: false,
            shared_with: ['recipient@example.com'],
            shared_with_teams: [],
            share_link_enabled: false,
          },
          access_list: [],
        },
      }),
    })

    const props = {
      conversationId: 'conv-123',
      conversationTitle: 'Stable sharing load',
      open: true,
      onOpenChange: jest.fn(),
      initialSharing: {
        is_public: false,
        shared_with: ['recipient@example.com'],
        shared_with_teams: [],
        share_link_enabled: false,
      },
    }
    const { rerender } = render(<ShareDialog {...props} />)
    await waitFor(() => {
      expect((global.fetch as jest.Mock).mock.calls.filter(([url]) => url.includes('/share'))).toHaveLength(1)
    })

    rerender(<ShareDialog {...props} initialSharing={{ ...props.initialSharing }} />)
    await new Promise((resolve) => setTimeout(resolve, 25))

    expect((global.fetch as jest.Mock).mock.calls.filter(([url]) => url.includes('/share'))).toHaveLength(1)
  })

  it('revokes user access when the trash button is clicked', async () => {
    const updatedConversation = {
      sharing: {
        is_public: false,
        shared_with: [],
        shared_with_teams: [],
        share_link_enabled: false,
      },
    }
    mockRevokeConversationShare.mockResolvedValue(updatedConversation)
    ;(global.fetch as jest.Mock).mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        data: {
          sharing: {
            is_public: false,
            shared_with: ['recipient@example.com'],
            shared_with_teams: [],
            share_link_enabled: false,
          },
          access_list: [{ granted_to: 'recipient@example.com', permission: 'view' }],
        },
      }),
    })

    render(
      <ShareDialog
        conversationId="conv-123"
        conversationTitle="Remove sharing"
        open
        onOpenChange={jest.fn()}
        initialSharing={{
          is_public: false,
          shared_with: ['recipient@example.com'],
          shared_with_teams: [],
          share_link_enabled: false,
        }}
      />,
    )
    await waitFor(() => {
      expect(screen.getByLabelText('Remove access for recipient@example.com')).toBeInTheDocument()
    })

    fireEvent.click(screen.getByLabelText('Remove access for recipient@example.com'))

    await waitFor(() => {
      expect(mockRevokeConversationShare).toHaveBeenCalledWith(
        'conv-123',
        { email: 'recipient@example.com' },
      )
      expect(screen.queryByText('recipient@example.com')).not.toBeInTheDocument()
    })
  })
})
