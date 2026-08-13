import React, { useEffect, useState } from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';

const mockUpdateConversationSharing = jest.fn();
const mockSearchUsers = jest.fn();

jest.mock('@/store/chat-store', () => ({
  useChatStore: (selector: unknown) => selector({
    updateConversationSharing: mockUpdateConversationSharing,
  }),
}));

jest.mock('@/lib/api-client', () => ({
  apiClient: {
    searchUsers: (...args: unknown[]) => mockSearchUsers(...args),
    shareConversation: jest.fn(),
  },
}));

import { ShareDialog } from '../ShareDialog';

type SharingSnapshot = {
  is_public?: boolean;
  shared_with?: string[];
  shared_with_teams?: string[];
  team_permissions?: Record<string, 'view' | 'comment'>;
  share_link_enabled?: boolean;
};

const initialSharing: SharingSnapshot = {
  is_public: false,
  shared_with: [],
  shared_with_teams: [],
  share_link_enabled: false,
};

function success(data: unknown) {
  return Promise.resolve({
    ok: true,
    status: 200,
    statusText: '',
    json: async () => ({ success: true, data }),
  });
}

describe('ShareDialog search performance', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockSearchUsers.mockResolvedValue([]);
  });

  it('loads sharing metadata and team options only once when the store feeds sharing back as a new prop', async () => {
    let shareGets = 0;
    let teamGets = 0;
    ;(global.fetch as jest.Mock).mockImplementation((url: string) => {
      if (url.includes('/api/dynamic-agents/teams')) {
        teamGets += 1;
        return success([]);
      }
      if (url.includes('/share')) {
        shareGets += 1;
        return success({ sharing: initialSharing, access_list: [] });
      }
      return success({});
    });

    function Harness() {
      const [sharing, setSharing] = useState<SharingSnapshot>(initialSharing);
      useEffect(() => {
        mockUpdateConversationSharing.mockImplementation((_id, nextSharing: SharingSnapshot) => {
          setSharing({ ...nextSharing });
        });
      }, []);
      return (
        <ShareDialog
          conversationId="conversation-1"
          conversationTitle="Example conversation"
          open
          onOpenChange={jest.fn()}
          initialSharing={sharing}
        />
      );
    }

    render(<Harness />);

    await waitFor(() => expect(shareGets).toBe(1));
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 25));
    });

    expect(shareGets).toBe(1);
    expect(teamGets).toBe(1);
  });

  it('caches teams and ignores results from an older query', async () => {
    let teamGets = 0;
    let resolveOld: ((value: Array<{ email: string; name: string }>) => void) | undefined;
    let resolveNew: ((value: Array<{ email: string; name: string }>) => void) | undefined;

    ;(global.fetch as jest.Mock).mockImplementation((url: string) => {
      if (url.includes('/api/dynamic-agents/teams')) {
        teamGets += 1;
        return success([]);
      }
      if (url.includes('/share')) {
        return success({ sharing: initialSharing, access_list: [] });
      }
      return success({});
    });
    mockSearchUsers.mockImplementation((query: string) => new Promise((resolve) => {
      if (query === 'old') resolveOld = resolve;
      if (query === 'new') resolveNew = resolve;
    }));

    render(
      <ShareDialog
        conversationId="conversation-1"
        conversationTitle="Example conversation"
        open
        onOpenChange={jest.fn()}
        initialSharing={initialSharing}
      />,
    );

    const search = screen.getByPlaceholderText('Search by email or team name...');
    fireEvent.change(search, { target: { value: 'old' } });
    await waitFor(() => expect(mockSearchUsers).toHaveBeenCalledWith('old'));

    fireEvent.change(search, { target: { value: 'new' } });
    await waitFor(() => expect(mockSearchUsers).toHaveBeenCalledWith('new'));

    await act(async () => {
      resolveNew?.([{ email: 'new-user@example.com', name: 'New User' }]);
    });
    await waitFor(() => expect(screen.getByText('New User')).toBeInTheDocument());

    await act(async () => {
      resolveOld?.([{ email: 'old-user@example.com', name: 'Old User' }]);
    });

    expect(screen.queryByText('Old User')).not.toBeInTheDocument();
    expect(screen.getByText('New User')).toBeInTheDocument();
    expect(teamGets).toBe(1);
  });
});

describe('ShareDialog access management', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockSearchUsers.mockResolvedValue([]);
  });

  it('updates permission and removes direct access through the sharing API', async () => {
    const recipient = 'recipient@example.com';
    const shared: SharingSnapshot = {
      ...initialSharing,
      shared_with: [recipient],
    };

    ;(global.fetch as jest.Mock).mockImplementation((url: string, options?: RequestInit) => {
      if (url.includes('/api/dynamic-agents/teams')) return success([]);
      if (url.includes('/share') && options?.method === 'PATCH') {
        return success({
          sharing: shared,
        });
      }
      if (url.includes('/share') && options?.method === 'DELETE') {
        return success({
          sharing: { ...initialSharing, shared_with: [] },
        });
      }
      if (url.includes('/share')) {
        return success({
          sharing: shared,
          access_list: [{ granted_to: recipient, permission: 'view' }],
        });
      }
      return success({});
    });

    render(
      <ShareDialog
        conversationId="conversation-1"
        conversationTitle="Example conversation"
        open
        onOpenChange={jest.fn()}
        initialSharing={shared}
      />,
    );

    const permission = await screen.findByRole('combobox', { name: `Permission for ${recipient}` });
    await waitFor(() => expect(permission).toHaveValue('view'));

    fireEvent.change(permission, { target: { value: 'comment' } });
    await waitFor(() => {
      expect(global.fetch).toHaveBeenCalledWith(
        '/api/chat/conversations/conversation-1/share',
        expect.objectContaining({
          method: 'PATCH',
          body: JSON.stringify({ email: recipient, permission: 'comment' }),
        }),
      );
    });
    await waitFor(() => expect(permission).toHaveValue('comment'));

    fireEvent.click(screen.getByRole('button', { name: `Remove access for ${recipient}` }));
    await waitFor(() => {
      expect(global.fetch).toHaveBeenCalledWith(
        '/api/chat/conversations/conversation-1/share',
        expect.objectContaining({
          method: 'DELETE',
          body: JSON.stringify({ email: recipient }),
        }),
      );
      expect(screen.queryByText(recipient)).not.toBeInTheDocument();
    });
  });

  it('keeps the permission controls the same width while an update is pending', async () => {
    const recipient = 'recipient@example.com';
    const shared: SharingSnapshot = {
      ...initialSharing,
      shared_with: [recipient],
    };
    let resolvePermissionUpdate: ((value: unknown) => void) | undefined;

    ;(global.fetch as jest.Mock).mockImplementation((url: string, options?: RequestInit) => {
      if (url.includes('/api/dynamic-agents/teams')) return success([]);
      if (url.includes('/share') && options?.method === 'PATCH') {
        return new Promise((resolve) => {
          resolvePermissionUpdate = resolve;
        });
      }
      if (url.includes('/share')) {
        return success({
          sharing: shared,
          access_list: [{ granted_to: recipient, permission: 'comment' }],
        });
      }
      return success({});
    });

    render(
      <ShareDialog
        conversationId="conversation-1"
        conversationTitle="Example conversation"
        open
        onOpenChange={jest.fn()}
        initialSharing={shared}
      />,
    );

    const permission = await screen.findByRole('combobox', { name: `Permission for ${recipient}` });
    await waitFor(() => expect(permission).toHaveValue('comment'));
    const statusSlot = screen.getByTestId(`permission-status-${recipient}`);
    const controls = statusSlot.parentElement;
    expect(controls?.children).toHaveLength(3);
    expect(statusSlot).toHaveClass('h-4', 'w-4');

    fireEvent.change(permission, { target: { value: 'view' } });

    await waitFor(() => expect(statusSlot.querySelector('.animate-spin')).toBeInTheDocument());
    expect(permission).toHaveValue('view');
    expect(controls?.children).toHaveLength(3);

    await act(async () => {
      resolvePermissionUpdate?.(await success({ sharing: shared }));
    });
    await waitFor(() => expect(statusSlot.querySelector('.animate-spin')).not.toBeInTheDocument());
    expect(controls?.children).toHaveLength(3);
  });

  it('retains a known permission while sharing metadata refreshes', async () => {
    const recipient = 'recipient@example.com';
    const shared: SharingSnapshot = {
      ...initialSharing,
      shared_with: [recipient],
    };
    let shareGetCount = 0;
    let resolveRefresh: ((value: unknown) => void) | undefined;

    ;(global.fetch as jest.Mock).mockImplementation((url: string) => {
      if (url.includes('/api/dynamic-agents/teams')) return success([]);
      if (url.includes('/share')) {
        shareGetCount += 1;
        if (shareGetCount === 1) {
          return success({
            sharing: shared,
            access_list: [{ granted_to: recipient, permission: 'comment' }],
          });
        }
        return new Promise((resolve) => {
          resolveRefresh = resolve;
        });
      }
      return success({});
    });

    const props = {
      conversationId: 'conversation-1',
      conversationTitle: 'Example conversation',
      onOpenChange: jest.fn(),
      initialSharing: shared,
    };
    const { rerender } = render(<ShareDialog {...props} open />);

    const permission = await screen.findByRole('combobox', { name: `Permission for ${recipient}` });
    await waitFor(() => expect(permission).toHaveValue('comment'));

    rerender(<ShareDialog {...props} open={false} />);
    rerender(<ShareDialog {...props} open />);

    expect(screen.getByRole('combobox', { name: `Permission for ${recipient}` })).toHaveValue('comment');

    await act(async () => {
      resolveRefresh?.(await success({
        sharing: shared,
        access_list: [{ granted_to: recipient, permission: 'comment' }],
      }));
    });
  });

  it('shows a neutral loading value instead of defaulting to Can view before permissions load', async () => {
    const recipient = 'recipient@example.com';
    const shared: SharingSnapshot = {
      ...initialSharing,
      shared_with: [recipient],
    };
    let resolveShareGet: ((value: unknown) => void) | undefined;

    ;(global.fetch as jest.Mock).mockImplementation((url: string) => {
      if (url.includes('/api/dynamic-agents/teams')) return success([]);
      if (url.includes('/share')) {
        return new Promise((resolve) => {
          resolveShareGet = resolve;
        });
      }
      return success({});
    });

    render(
      <ShareDialog
        conversationId="conversation-1"
        conversationTitle="Example conversation"
        open
        onOpenChange={jest.fn()}
        initialSharing={shared}
      />,
    );

    const permission = await screen.findByRole('combobox', { name: `Permission for ${recipient}` });
    expect(permission).toHaveValue('');
    expect(permission).toBeDisabled();
    expect(screen.getByRole('option', { name: 'Loading…' })).toBeInTheDocument();

    await act(async () => {
      resolveShareGet?.(await success({
        sharing: shared,
        access_list: [{ granted_to: recipient, permission: 'comment' }],
      }));
    });

    await waitFor(() => expect(permission).toHaveValue('comment'));
    expect(permission).toBeEnabled();
  });
});
