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

  it.each(['example:legacy', 'example%3Aliteral', 'example/legacy?query#fragment'])(
    'encodes conversation IDs at read boundaries: %s', async id => {
      mockFetch.mockResolvedValue(mockSuccessResponse({ items: [] }));
      await apiClient.getConversation(id);
      await apiClient.getMessages(id);
      await apiClient.getTurns(id);
      const base = `/api/chat/conversations/${encodeURIComponent(id)}`;
      expect(mockFetch.mock.calls.map(([url]: [string]) => new URL(url, 'https://example.test').pathname)).toEqual([
        base, `${base}/messages`, `${base}/turns`,
      ]);
    },
  );

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

describe('APIClient — console output', () => {
  const logSpy = console.log as jest.Mock;
  const errorSpy = console.error as jest.Mock;
  const secretBody = 'secret-body-marker';

  beforeEach(() => {
    mockFetch.mockReset();
    logSpy.mockClear();
    errorSpy.mockClear();
  });

  function allOutput(): string {
    return JSON.stringify([...logSpy.mock.calls, ...errorSpy.mock.calls]);
  }

  it('does not log the response body or data preview on success', async () => {
    mockFetch.mockResolvedValue(mockSuccessResponse({ title: secretBody }));
    await apiClient.getConversation('conv-1');
    expect(allOutput()).not.toContain(secretBody);
  });

  it('does not log the request URL or status by default', async () => {
    mockFetch.mockResolvedValue(mockSuccessResponse({ ok: 1 }));
    await apiClient.getConversation('conv-1');
    expect(logSpy).not.toHaveBeenCalled();
  });

  describe.each([false, true])('with uiDebugLogging=%s', (uiDebugLogging) => {
    it.each([null, undefined])('does not log response content when data is %s', async (data) => {
      const appWindow = window as unknown as { __APP_CONFIG__?: { uiDebugLogging: boolean } };
      appWindow.__APP_CONFIG__ = { uiDebugLogging };
      try {
        mockFetch.mockResolvedValue({
          ok: true,
          status: 200,
          statusText: 'OK',
          text: () => Promise.resolve(JSON.stringify({ success: true, data, error: secretBody })),
        });

        await expect(apiClient.getConversation('conv-1')).rejects.toThrow(secretBody);
        expect(allOutput()).not.toContain(secretBody);
        expect(errorSpy).toHaveBeenCalledWith('[APIClient] Result data is undefined/null');
      } finally {
        delete appWindow.__APP_CONFIG__;
      }
    });
  });

  it('does not log the error body on a non-OK response', async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 500,
      statusText: 'Server Error',
      text: () => Promise.resolve(JSON.stringify({ error: secretBody })),
    });
    await expect(apiClient.getConversation('conv-1')).rejects.toThrow(secretBody);
    expect(allOutput()).not.toContain(secretBody);
    expect(errorSpy).toHaveBeenCalledWith(
      '[APIClient] Error response:',
      { status: 500, statusText: 'Server Error' },
    );
  });

  it('does not put a non-JSON error body in the thrown error or logs', async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 502,
      statusText: '',
      text: () => Promise.resolve(secretBody),
    });
    await expect(apiClient.getConversation('conv-1')).rejects.toThrow('HTTP 502');
    expect(allOutput()).not.toContain(secretBody);
  });

  it('does not log the response text when JSON parsing fails', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      statusText: 'OK',
      text: () => Promise.resolve(`not json ${secretBody}`),
    });
    await expect(apiClient.getConversation('conv-1')).rejects.toThrow('Invalid JSON response from server');
    expect(allOutput()).not.toContain(secretBody);
  });

  it('logs request and status lines when uiDebugLogging is enabled', async () => {
    (window as unknown as { __APP_CONFIG__?: unknown }).__APP_CONFIG__ = { uiDebugLogging: true };
    try {
      mockFetch.mockResolvedValue(mockSuccessResponse({ ok: 1 }));
      await apiClient.getConversation('conv-1');
      expect(logSpy.mock.calls.map(c => String(c[0])).join('\n')).toContain('Making request to');
    } finally {
      delete (window as unknown as { __APP_CONFIG__?: unknown }).__APP_CONFIG__;
    }
  });
});
