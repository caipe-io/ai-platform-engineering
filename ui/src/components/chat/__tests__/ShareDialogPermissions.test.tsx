
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { apiClient } from '@/lib/api-client'

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

beforeEach(() => { jest.clearAllMocks() })

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

it('does not restore a removed recipient from an older sharing GET', async () => {
  let finishLoad!: (response: unknown) => void;
  ;(global.fetch as jest.Mock).mockImplementation((url: string) => url.includes('/share')
    ? new Promise((resolve) => { finishLoad = resolve })
    : Promise.resolve({ ok: true, json: async () => ({ data: [] }) }))
  mockRevokeConversationShare.mockResolvedValue({ sharing: { shared_with: [], shared_with_teams: [] } })
  render(<ShareDialog conversationId="example-chat" conversationTitle="Example" open onOpenChange={jest.fn()}
    initialSharing={{ shared_with: ['recipient@example.com'], shared_with_teams: [] }} />)
  fireEvent.click(screen.getByLabelText('Remove access for recipient@example.com'))
  await waitFor(() => expect(screen.queryByText('recipient@example.com')).not.toBeInTheDocument())
  mockUpdateConversationSharing.mockClear()
  await act(async () => finishLoad({ ok: true, json: async () => ({ data: {
    sharing: { shared_with: ['recipient@example.com'], shared_with_teams: [] },
    access_list: [{ granted_to: 'recipient@example.com', permission: 'comment' }],
  } }) }))
  expect(screen.queryByText('recipient@example.com')).not.toBeInTheDocument()
  expect(mockUpdateConversationSharing).not.toHaveBeenCalled()
})

it('discards responses from a previous conversation, without overwriting the sidebar', async () => {
  let finishFirst!: (response: unknown) => void;
  ;(global.fetch as jest.Mock).mockImplementation((url: string) => {
    if (url.includes('/primary/share')) return new Promise((resolve) => { finishFirst = resolve })
    return Promise.resolve({ ok: true, json: async () => ({ data: {
      sharing: { shared_with: ['current@example.com'], shared_with_teams: [] }, access_list: [],
    } }) })
  })
  const props = { conversationTitle: 'Example', open: true, onOpenChange: jest.fn(), canManageSharing: false }
  const { rerender } = render(<ShareDialog {...props} conversationId="primary" />)
  rerender(<ShareDialog {...props} conversationId="secondary" />)
  await waitFor(() => expect(screen.getByText('current@example.com')).toBeInTheDocument())
  mockUpdateConversationSharing.mockClear()
  await act(async () => finishFirst({ ok: true, json: async () => ({ data: {
    sharing: { shared_with: ['stale@example.com'], shared_with_teams: [] }, access_list: [],
  } }) }))
  expect(screen.getByText('current@example.com')).toBeInTheDocument()
  expect(screen.queryByText('stale@example.com')).not.toBeInTheDocument()
  expect(mockUpdateConversationSharing).not.toHaveBeenCalled()
})

function sharingResponse(permission: 'view' | 'comment' = 'view') {
  return { ok: true, status: 200, json: async () => ({ data: {
    sharing: { shared_with: ['recipient@example.com'], shared_with_teams: [] },
    access_list: [{ granted_to: 'recipient@example.com', permission }],
  } }) };
}

it('keeps a new conversation and its pending removal intact when an older removal finishes', async () => {
  let finishFirst!: (value: unknown) => void;
  let finishSecond!: (value: unknown) => void;
  mockRevokeConversationShare
    .mockImplementationOnce(() => new Promise((resolve) => { finishFirst = resolve }))
    .mockImplementationOnce(() => new Promise((resolve) => { finishSecond = resolve }))
  ;(global.fetch as jest.Mock).mockImplementation(async () => sharingResponse())
  const props = { conversationTitle: 'Example', open: true, onOpenChange: jest.fn() }
  const { rerender } = render(<ShareDialog {...props} conversationId="primary" />)
  await waitFor(() => expect(screen.getByLabelText('Permission for recipient@example.com')).toBeEnabled())
  fireEvent.click(screen.getByLabelText('Remove access for recipient@example.com'))
  rerender(<ShareDialog {...props} conversationId="secondary" />)
  await waitFor(() => expect(screen.getByLabelText('Permission for recipient@example.com')).toBeEnabled())
  mockUpdateConversationSharing.mockClear()
  fireEvent.click(screen.getByLabelText('Remove access for recipient@example.com'))
  await act(async () => finishFirst({ sharing: { shared_with: [], shared_with_teams: [] } }))
  expect(screen.getByText('recipient@example.com')).toBeInTheDocument()
  expect(screen.getByLabelText('Remove access for recipient@example.com')).toBeDisabled()
  expect(mockUpdateConversationSharing).toHaveBeenCalledWith('primary', expect.objectContaining({ shared_with: [] }))
  expect(mockUpdateConversationSharing).not.toHaveBeenCalledWith('secondary', expect.anything())
  await act(async () => finishSecond({ sharing: { shared_with: [], shared_with_teams: [] } }))
  expect(screen.queryByText('recipient@example.com')).not.toBeInTheDocument()
})

it('does not roll back the current permission or show an old error after switching conversations', async () => {
  let failFirst!: (error: Error) => void;
  ;(global.fetch as jest.Mock).mockImplementation((url: string, options?: { method?: string }) => {
    if (options?.method === 'PATCH') return new Promise((_resolve, reject) => { failFirst = reject })
    return Promise.resolve(sharingResponse(url.includes('/secondary/') ? 'comment' : 'view'))
  })
  const alert = jest.spyOn(window, 'alert').mockImplementation(() => {})
  try {
    const props = { conversationTitle: 'Example', open: true, onOpenChange: jest.fn() }
    const { rerender } = render(<ShareDialog {...props} conversationId="primary" />)
    await waitFor(() => expect(screen.getByLabelText('Permission for recipient@example.com')).toBeEnabled())
    fireEvent.change(screen.getByLabelText('Permission for recipient@example.com'), { target: { value: 'comment' } })
    rerender(<ShareDialog {...props} conversationId="secondary" />)
    await waitFor(() => expect(screen.getByLabelText('Permission for recipient@example.com')).toHaveValue('comment'))
    await act(async () => failFirst(new Error('Previous change failed')))
    expect(screen.getByLabelText('Permission for recipient@example.com')).toHaveValue('comment')
    expect(screen.getByLabelText('Permission for recipient@example.com')).toBeEnabled()
    expect(alert).not.toHaveBeenCalled()
    expect(props.onOpenChange).not.toHaveBeenCalled()
  } finally { alert.mockRestore() }
})

it('ignores an older mutation after closing and reopening the same conversation', async () => {
  let finish!: (value: unknown) => void;
  mockRevokeConversationShare.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve }))
  ;(global.fetch as jest.Mock).mockImplementation(async () => sharingResponse())
  const props = { conversationId: 'example-chat', conversationTitle: 'Example', onOpenChange: jest.fn() }
  const { rerender } = render(<ShareDialog {...props} open />)
  await waitFor(() => expect(screen.getByLabelText('Permission for recipient@example.com')).toBeEnabled())
  fireEvent.click(screen.getByLabelText('Remove access for recipient@example.com'))
  rerender(<ShareDialog {...props} open={false} />)
  rerender(<ShareDialog {...props} open />)
  await waitFor(() => expect(screen.getByLabelText('Permission for recipient@example.com')).toBeEnabled())
  await act(async () => finish({ sharing: { shared_with: [], shared_with_teams: [] } }))
  expect(screen.getByText('recipient@example.com')).toBeInTheDocument()
  expect(screen.getByLabelText('Remove access for recipient@example.com')).toBeEnabled()
})

it.each(['permission', 'removal'] as const)('blocks new user/team shares while a %s action is pending', async (action) => {
  let finish!: (value: unknown) => void;
  const pending = new Promise((resolve) => { finish = resolve });
  ;(global.fetch as jest.Mock).mockImplementation((url: string, options?: { method?: string }) => {
    if (options?.method === 'PATCH') return pending;
    if (url.includes('/teams')) return Promise.resolve({ ok: true, json: async () => ({ data: [
      { _id: 'new-team', name: 'New team' },
    ] }) });
    return Promise.resolve(sharingResponse());
  })
  mockRevokeConversationShare.mockReturnValue(pending)
  ;(apiClient.searchUsers as jest.Mock).mockResolvedValue([{ email: 'new@example.com', name: 'New reader' }])
  ;(apiClient.shareConversation as jest.Mock).mockResolvedValue({ sharing: {
    shared_with: ['new@example.com'], shared_with_teams: [],
  } })
  render(<ShareDialog conversationId="example-chat" conversationTitle="Example" open onOpenChange={jest.fn()} />)
  await waitFor(() => expect(screen.getByLabelText('Permission for recipient@example.com')).toBeEnabled())
  if (action === 'permission') {
    fireEvent.change(screen.getByLabelText('Permission for recipient@example.com'), { target: { value: 'comment' } })
  } else {
    fireEvent.click(screen.getByLabelText('Remove access for recipient@example.com'))
  }
  fireEvent.change(screen.getByPlaceholderText('Search by email or team name...'), { target: { value: 'New' } })
  const userButton = await screen.findByRole('button', { name: /New reader/ })
  const teamButton = screen.getByRole('button', { name: /New team/ })
  expect(userButton).toBeDisabled()
  expect(teamButton).toBeDisabled()
  fireEvent.click(userButton)
  fireEvent.click(teamButton)
  expect(apiClient.shareConversation).not.toHaveBeenCalled()
  await act(async () => finish(action === 'permission'
    ? { ok: true, json: async () => ({ data: { sharing: { shared_with: ['recipient@example.com'], shared_with_teams: [] } } }) }
    : { sharing: { shared_with: [], shared_with_teams: [] } }))
  await waitFor(() => expect(screen.getByRole('button', { name: /New reader/ })).toBeEnabled())
  fireEvent.click(screen.getByRole('button', { name: /New reader/ }))
  await waitFor(() => expect(apiClient.shareConversation).toHaveBeenCalledTimes(1))
  await waitFor(() => expect(screen.getByLabelText('Remove access for new@example.com')).toBeEnabled())
})

it('rejects overlapping access handlers before React commits their pending state', async () => {
  let finish!: (value: unknown) => void;
  ;(global.fetch as jest.Mock).mockImplementation((_url: string, options?: { method?: string }) => {
    if (options?.method === 'PATCH') return new Promise((resolve) => { finish = resolve });
    return Promise.resolve(sharingResponse());
  })
  render(<ShareDialog conversationId="example-chat" conversationTitle="Example" open onOpenChange={jest.fn()} />)
  await waitFor(() => expect(screen.getByLabelText('Permission for recipient@example.com')).toBeEnabled())
  const permission = screen.getByLabelText('Permission for recipient@example.com')
  const remove = screen.getByLabelText('Remove access for recipient@example.com')
  act(() => {
    fireEvent.change(permission, { target: { value: 'comment' } })
    fireEvent.click(remove)
  })
  expect(mockRevokeConversationShare).not.toHaveBeenCalled()
  await act(async () => finish({ ok: true, json: async () => ({ data: {
    sharing: { shared_with: ['recipient@example.com'], shared_with_teams: [] },
  } }) }))
  expect(screen.getByLabelText('Remove access for recipient@example.com')).toBeEnabled()
})
