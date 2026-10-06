// assisted-by Codex Codex-sonnet-4-6

import { render, screen, waitFor } from '@testing-library/react'

const mockUpdateConversationSharing = jest.fn()
const mockPush = jest.fn()

jest.mock('next/navigation', () => ({
  useRouter: () => ({ push: mockPush }),
}))

jest.mock('@/store/chat-store', () => ({
  useChatStore: (selector: unknown) => selector({
    updateConversationSharing: mockUpdateConversationSharing,
  }),
}))

jest.mock('@/lib/api-client', () => ({
  apiClient: {
    searchUsers: jest.fn().mockResolvedValue([]),
    shareConversation: jest.fn(),
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

    expect(screen.getByText('Shared by')).toBeInTheDocument()
    expect(screen.queryByPlaceholderText('Search by email or team name...')).not.toBeInTheDocument()
  })
})
