/**
 * @jest-environment jsdom
 */
/**
 * Tests for APIClient conversation and archive methods
 *
 * Covers:
 * - deleteConversation (soft-delete)
 * - permanentDeleteConversation (hard delete)
 * - restoreConversation (restore from archive)
 * - getTrash (list trashed conversations)
 */

// The api-client module exports a singleton, so we test the full class
const mockFetch = jest.fn();
global.fetch = mockFetch;

// Suppress console.log/error in tests
jest.spyOn(console, 'log').mockImplementation(() => {});
jest.spyOn(console, 'error').mockImplementation(() => {});

import { apiClient } from '../api-client';

// ============================================================================
// Helpers
// ============================================================================

function mockSuccessResponse(data: unknown) {
  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    text: () => Promise.resolve(JSON.stringify({ success: true, data })),
  };
}

function mockErrorResponse(status: number, errorText: string) {
  return {
    ok: false,
    status,
    statusText: errorText,
    text: () => Promise.resolve(JSON.stringify({ error: errorText })),
  };
}

// ============================================================================
// Tests
// ============================================================================

describe('APIClient — Archive methods', () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  describe('getConversations', () => {
    it('requests only webui conversations by default', async () => {
      mockFetch.mockResolvedValue(
        mockSuccessResponse({ items: [], total: 0, page: 1, page_size: 100, has_more: false })
      );

      await apiClient.getConversations({ page_size: 100 });

      expect(mockFetch).toHaveBeenCalledTimes(1);
      const [url] = mockFetch.mock.calls[0];
      expect(url).toBe('/api/chat/conversations?page_size=100&client_type=webui');
    });
  });

  // --------------------------------------------------------------------------
  // deleteConversation (soft-delete by default)
  // --------------------------------------------------------------------------

  describe('deleteConversation', () => {
    it('calls DELETE /api/chat/conversations/:id without permanent flag', async () => {
      mockFetch.mockResolvedValue(mockSuccessResponse({ deleted: true, permanent: false }));

      const result = await apiClient.deleteConversation('test-conv-id');

      expect(mockFetch).toHaveBeenCalledTimes(1);
      const [url, options] = mockFetch.mock.calls[0];
      expect(url).toBe('/api/chat/conversations/test-conv-id');
      expect(options.method).toBe('DELETE');
      expect(result).toEqual({ deleted: true, permanent: false });
    });

    it('throws on non-OK response', async () => {
      mockFetch.mockResolvedValue(mockErrorResponse(404, 'Conversation not found'));

      await expect(apiClient.deleteConversation('nonexistent')).rejects.toThrow(
        'Conversation not found'
      );
    });
  });

  // --------------------------------------------------------------------------
  // permanentDeleteConversation
  // --------------------------------------------------------------------------

  describe('permanentDeleteConversation', () => {
    it('calls DELETE with ?permanent=true query parameter', async () => {
      mockFetch.mockResolvedValue(mockSuccessResponse({ deleted: true, permanent: true }));

      const result = await apiClient.permanentDeleteConversation('perm-del-id');

      expect(mockFetch).toHaveBeenCalledTimes(1);
      const [url, options] = mockFetch.mock.calls[0];
      expect(url).toBe('/api/chat/conversations/perm-del-id?permanent=true');
      expect(options.method).toBe('DELETE');
      expect(result).toEqual({ deleted: true, permanent: true });
    });

    it('preserves an accepted background cleanup response without reporting deletion complete', async () => {
      mockFetch.mockResolvedValue({
        ...mockSuccessResponse({ deleted: false, permanent: true, pending: true }),
        status: 202,
        statusText: 'Accepted',
      });

      const result = await apiClient.permanentDeleteConversation('example-conversation');

      expect(mockFetch).toHaveBeenCalledTimes(1);
      expect(result).toEqual({ deleted: false, permanent: true, pending: true });
    });

    it('throws on 403 (not owner)', async () => {
      mockFetch.mockResolvedValue(mockErrorResponse(403, 'Not authorized'));

      await expect(apiClient.permanentDeleteConversation('other-user')).rejects.toThrow(
        'Not authorized'
      );
    });
  });

  // --------------------------------------------------------------------------
  // restoreConversation
  // --------------------------------------------------------------------------

  describe('restoreConversation', () => {
    it('calls POST /api/chat/conversations/:id/restore', async () => {
      const restoredConv = {
        _id: 'restored-id',
        title: 'Restored Conversation',
        deleted_at: null,
        is_archived: false,
      };
      mockFetch.mockResolvedValue(mockSuccessResponse(restoredConv));

      const result = await apiClient.restoreConversation('restored-id');

      expect(mockFetch).toHaveBeenCalledTimes(1);
      const [url, options] = mockFetch.mock.calls[0];
      expect(url).toBe('/api/chat/conversations/restored-id/restore');
      expect(options.method).toBe('POST');
      expect(result).toEqual(restoredConv);
    });

    it('throws 400 if conversation is not in archive', async () => {
      mockFetch.mockResolvedValue(mockErrorResponse(400, 'Conversation is not in archive'));

      await expect(apiClient.restoreConversation('active-conv')).rejects.toThrow(
        'Conversation is not in archive'
      );
    });
  });

  // --------------------------------------------------------------------------
  // getTrash
  // --------------------------------------------------------------------------

  describe('getTrash', () => {
    it('calls GET /api/chat/conversations/trash without params', async () => {
      const trashData = {
        items: [{ _id: 'trashed-1', title: 'Deleted conv' }],
        total: 1,
        page: 1,
        page_size: 50,
      };
      mockFetch.mockResolvedValue(mockSuccessResponse(trashData));

      const result = await apiClient.getTrash();

      expect(mockFetch).toHaveBeenCalledTimes(1);
      const [url] = mockFetch.mock.calls[0];
      expect(url).toBe('/api/chat/conversations/trash');
      expect(result).toEqual(trashData);
    });

    it('calls GET with page_size query param when provided', async () => {
      mockFetch.mockResolvedValue(mockSuccessResponse({ items: [], total: 0, page: 1, page_size: 10 }));

      await apiClient.getTrash({ page_size: 10 });

      const [url] = mockFetch.mock.calls[0];
      expect(url).toBe('/api/chat/conversations/trash?page_size=10');
    });

    it('omits page_size when not provided (no empty params)', async () => {
      mockFetch.mockResolvedValue(mockSuccessResponse({ items: [], total: 0 }));

      await apiClient.getTrash({});

      const [url] = mockFetch.mock.calls[0];
      // Should NOT have a trailing ? or empty query string
      expect(url).toBe('/api/chat/conversations/trash');
    });

    it('throws on 401 (unauthenticated)', async () => {
      mockFetch.mockResolvedValue(mockErrorResponse(401, 'Unauthorized'));

      await expect(apiClient.getTrash()).rejects.toThrow();
    });
  });
});
