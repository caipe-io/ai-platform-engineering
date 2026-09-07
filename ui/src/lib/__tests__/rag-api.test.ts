/**
 * @jest-environment jsdom
 */

jest.spyOn(console, 'log').mockImplementation(() => {});
jest.spyOn(console, 'warn').mockImplementation(() => {});
jest.spyOn(console, 'error').mockImplementation(() => {});

import {
  hasPermission,
  Permission,
  getUserInfo,
  getDataSources,
  searchDocuments,
  deleteDataSource,
  getHealthStatus,
  getJobStatus,
  getIngestors,
  ingestUrl,
  RagApiError,
  type UserInfo,
} from '../rag-api';

beforeEach(() => {
  jest.clearAllMocks();
  (global.fetch as jest.Mock) = jest.fn();
});

// ────────────────────────────────────────────────────────────────
// hasPermission
// ────────────────────────────────────────────────────────────────

describe('hasPermission', () => {
  it('returns false for null userInfo', () => {
    expect(hasPermission(null, Permission.READ)).toBe(false);
    expect(hasPermission(null, Permission.INGEST)).toBe(false);
    expect(hasPermission(null, Permission.DELETE)).toBe(false);
  });

  it('returns false when permissions is undefined', () => {
    const userInfo: UserInfo = {
      email: 'test@example.com',
      role: 'user',
      is_authenticated: true,
    };
    expect(hasPermission(userInfo, Permission.READ)).toBe(false);
  });

  it('returns false when permissions is not an array', () => {
    const userInfo = {
      email: 'test@example.com',
      role: 'user',
      is_authenticated: true,
      permissions: { read: true } as unknown as typeof Permission.READ[],
    } as UserInfo;
    expect(hasPermission(userInfo, Permission.READ)).toBe(false);
  });

  it('returns true when permission is in array', () => {
    const userInfo: UserInfo = {
      email: 'test@example.com',
      role: 'admin',
      is_authenticated: true,
      permissions: [Permission.READ, Permission.INGEST, Permission.DELETE],
    };
    expect(hasPermission(userInfo, Permission.READ)).toBe(true);
    expect(hasPermission(userInfo, Permission.INGEST)).toBe(true);
    expect(hasPermission(userInfo, Permission.DELETE)).toBe(true);
  });

  it('returns false when permission is not in array', () => {
    const userInfo: UserInfo = {
      email: 'test@example.com',
      role: 'user',
      is_authenticated: true,
      permissions: [Permission.READ],
    };
    expect(hasPermission(userInfo, Permission.READ)).toBe(true);
    expect(hasPermission(userInfo, Permission.INGEST)).toBe(false);
    expect(hasPermission(userInfo, Permission.DELETE)).toBe(false);
  });

  it('checks specific Permission constants (READ, INGEST, DELETE)', () => {
    const readOnlyUser: UserInfo = {
      email: 'reader@example.com',
      role: 'viewer',
      is_authenticated: true,
      permissions: [Permission.READ],
    };
    expect(hasPermission(readOnlyUser, Permission.READ)).toBe(true);
    expect(hasPermission(readOnlyUser, Permission.INGEST)).toBe(false);
    expect(hasPermission(readOnlyUser, Permission.DELETE)).toBe(false);

    const ingestUser: UserInfo = {
      ...readOnlyUser,
      permissions: [Permission.READ, Permission.INGEST],
    };
    expect(hasPermission(ingestUser, Permission.INGEST)).toBe(true);
    expect(hasPermission(ingestUser, Permission.DELETE)).toBe(false);

    const deleteUser: UserInfo = {
      ...readOnlyUser,
      permissions: [Permission.READ, Permission.INGEST, Permission.DELETE],
    };
    expect(hasPermission(deleteUser, Permission.DELETE)).toBe(true);
  });
});

// ────────────────────────────────────────────────────────────────
// getUserInfo
// ────────────────────────────────────────────────────────────────

describe('getUserInfo', () => {
  it('calls /api/user/info with credentials: include', async () => {
    const mockUserInfo: UserInfo = {
      email: 'user@example.com',
      role: 'admin',
      is_authenticated: true,
      permissions: [Permission.READ, Permission.INGEST],
    };
    (global.fetch as jest.Mock).mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(mockUserInfo),
    });

    const result = await getUserInfo();

    expect(global.fetch).toHaveBeenCalledWith('/api/user/info', {
      credentials: 'include',
    });
    expect(result).toEqual(mockUserInfo);
  });

  it('returns user info on success', async () => {
    const mockUserInfo: UserInfo = {
      email: 'test@example.com',
      role: 'user',
      is_authenticated: true,
      permissions: [Permission.READ],
    };
    (global.fetch as jest.Mock).mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(mockUserInfo),
    });

    const result = await getUserInfo();

    expect(result).toEqual(mockUserInfo);
    expect(result.email).toBe('test@example.com');
    expect(result.permissions).toContain(Permission.READ);
  });

  it('throws on non-200 response', async () => {
    (global.fetch as jest.Mock).mockResolvedValue({
      ok: false,
      status: 401,
    });

    await expect(getUserInfo()).rejects.toThrow(
      'Failed to fetch user info: 401'
    );
  });

  it('converts object permissions to array format', async () => {
    (global.fetch as jest.Mock).mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          email: 'user@example.com',
          role: 'admin',
          is_authenticated: true,
          permissions: { can_read: true, can_ingest: true, can_delete: false },
        }),
    });

    const result = await getUserInfo();

    expect(result.permissions).toEqual(['read', 'ingest']);
  });
});

// ────────────────────────────────────────────────────────────────
// API functions
// ────────────────────────────────────────────────────────────────

describe('getDataSources', () => {
  it('calls correct endpoint with GET method', async () => {
    const mockData = {
      success: true,
      datasources: [],
      count: 0,
    };
    (global.fetch as jest.Mock).mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(mockData),
    });

    const result = await getDataSources();

    expect(global.fetch).toHaveBeenCalledWith(
      expect.stringContaining('/api/rag/v1/datasources'),
      expect.objectContaining({ method: 'GET', credentials: 'include' })
    );
    expect(result).toEqual(mockData);
  });

  it('handles errors', async () => {
    (global.fetch as jest.Mock).mockResolvedValue({
      ok: false,
      status: 500,
      statusText: 'Internal Server Error',
    });

    await expect(getDataSources()).rejects.toThrow(
      'API Error: 500 Internal Server Error'
    );
  });
});

describe('searchDocuments', () => {
  it('calls POST /api/rag/v1/query with params in body', async () => {
    const mockResults = [{ id: '1', score: 0.9, text: 'doc1', metadata: {} }];
    (global.fetch as jest.Mock).mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(mockResults),
    });

    const result = await searchDocuments({
      query: 'test query',
      limit: 10,
    });

    expect(global.fetch).toHaveBeenCalledWith(
      '/api/rag/v1/query',
      expect.objectContaining({
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: 'test query', limit: 10 }),
      })
    );
    expect(result).toEqual(mockResults);
  });

  it('passes all parameters correctly', async () => {
    (global.fetch as jest.Mock).mockResolvedValue({
      ok: true,
      json: () => Promise.resolve([]),
    });

    await searchDocuments({
      query: 'search',
      limit: 20,
      similarity_threshold: 0.7,
      filters: { source: 'confluence' },
      datasource_id: 'ds-1',
    });

    const callBody = JSON.parse((global.fetch as jest.Mock).mock.calls[0][1].body);
    expect(callBody).toMatchObject({
      query: 'search',
      limit: 20,
      similarity_threshold: 0.7,
      filters: { source: 'confluence' },
      datasource_id: 'ds-1',
    });
  });

  it('handles errors', async () => {
    (global.fetch as jest.Mock).mockResolvedValue({
      ok: false,
      status: 400,
      statusText: 'Bad Request',
    });

    await expect(
      searchDocuments({ query: 'invalid' })
    ).rejects.toThrow('API Error: 400 Bad Request');
  });
});

describe('deleteDataSource', () => {
  it('calls DELETE with datasource_id param', async () => {
    (global.fetch as jest.Mock).mockResolvedValue({
      ok: true,
      status: 204,
      json: () => Promise.resolve({}),
    });

    await deleteDataSource('ds-123');

    expect(global.fetch).toHaveBeenCalledWith(
      expect.stringContaining('/api/rag/v1/datasource?datasource_id=ds-123'),
      expect.objectContaining({ method: 'DELETE', credentials: 'include' })
    );
  });

  it('handles errors', async () => {
    (global.fetch as jest.Mock).mockResolvedValue({
      ok: false,
      status: 404,
      statusText: 'Not Found',
    });

    await expect(deleteDataSource('nonexistent')).rejects.toThrow(
      'API Error: 404 Not Found'
    );
  });
});

describe('getHealthStatus', () => {
  it('calls GET /api/rag/healthz', async () => {
    (global.fetch as jest.Mock).mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ status: 'healthy' }),
    });

    const result = await getHealthStatus();

    expect(global.fetch).toHaveBeenCalledWith(
      expect.stringContaining('/api/rag/healthz'),
      expect.objectContaining({ method: 'GET' })
    );
    expect(result).toEqual({ status: 'healthy' });
  });
});

describe('getJobStatus', () => {
  it('calls GET /api/rag/v1/job/:jobId', async () => {
    const mockJob = {
      job_id: 'job-1',
      datasource_id: 'ds-1',
      status: 'completed',
      created_at: '2024-01-01',
      updated_at: '2024-01-02',
    };
    (global.fetch as jest.Mock).mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(mockJob),
    });

    const result = await getJobStatus('job-1');

    expect(global.fetch).toHaveBeenCalledWith(
      expect.stringContaining('/api/rag/v1/job/job-1'),
      expect.objectContaining({ method: 'GET' })
    );
    expect(result).toEqual(mockJob);
  });
});

describe('getIngestors', () => {
  it('calls GET /api/rag/v1/ingestors', async () => {
    const mockIngestors = [
      {
        ingestor_id: 'ing-1',
        ingestor_type: 'webloader',
        created_at: '2024-01-01',
        metadata: {},
      },
    ];
    (global.fetch as jest.Mock).mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(mockIngestors),
    });

    const result = await getIngestors();

    expect(global.fetch).toHaveBeenCalledWith(
      expect.stringContaining('/api/rag/v1/ingestors'),
      expect.objectContaining({ method: 'GET' })
    );
    expect(result).toEqual(mockIngestors);
  });
});

describe('ingestUrl', () => {
  it('calls webloader endpoint for non-confluence ingest', async () => {
    (global.fetch as jest.Mock).mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          datasource_id: 'ds-1',
          job_id: 'job-1',
          message: 'Started',
        }),
    });

    await ingestUrl({
      url: 'https://example.com',
      description: 'Test',
      reload_interval: 86400,
    });

    expect(global.fetch).toHaveBeenCalledWith(
      '/api/rag/v1/ingest/webloader/url',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          url: 'https://example.com',
          description: 'Test',
          reload_interval: 86400,
        }),
      })
    );
  });

  it('calls confluence endpoint when ingest_type is confluence', async () => {
    (global.fetch as jest.Mock).mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          datasource_id: 'ds-2',
          job_id: 'job-2',
          message: 'Started',
        }),
    });

    await ingestUrl({
      url: 'https://confluence.example.com/page',
      ingest_type: 'confluence',
      description: 'Confluence page',
      get_child_pages: true,
      reload_interval: 86400,
    });

    expect(global.fetch).toHaveBeenCalledWith(
      '/api/rag/v1/ingest/confluence/page',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          url: 'https://confluence.example.com/page',
          description: 'Confluence page',
          get_child_pages: true,
          reload_interval: 86400,
        }),
      })
    );
  });
});

// ────────────────────────────────────────────────────────────────
// RagApiError — structured error extraction
// ────────────────────────────────────────────────────────────────

describe('RagApiError', () => {
  it('extracts code and serverMessage from a JSON error body', async () => {
    (global.fetch as jest.Mock).mockResolvedValue({
      ok: false,
      status: 409,
      statusText: 'Conflict',
      json: () =>
        Promise.resolve({
          code: 'TRANSFER_NOT_MEMBER_UNCONFIRMED',
          error: 'You are not a member of the destination team.',
        }),
    });

    expect.assertions(5);
    try {
      await getDataSources();
    } catch (err) {
      expect(err).toBeInstanceOf(RagApiError);
      const ragErr = err as RagApiError;
      // Legacy message shape preserved for backward compatibility.
      expect(ragErr.message).toBe('API Error: 409 Conflict');
      expect(ragErr.status).toBe(409);
      expect(ragErr.code).toBe('TRANSFER_NOT_MEMBER_UNCONFIRMED');
      expect(ragErr.serverMessage).toBe(
        'You are not a member of the destination team.',
      );
    }
  });

  it('falls back to status text when the error body is not JSON', async () => {
    (global.fetch as jest.Mock).mockResolvedValue({
      ok: false,
      status: 500,
      statusText: 'Internal Server Error',
      // No json() that resolves to an object — simulate empty/non-JSON body.
      json: () => Promise.reject(new SyntaxError('Unexpected end of JSON input')),
    });

    expect.assertions(4);
    try {
      await getDataSources();
    } catch (err) {
      expect(err).toBeInstanceOf(RagApiError);
      const ragErr = err as RagApiError;
      expect(ragErr.message).toBe('API Error: 500 Internal Server Error');
      expect(ragErr.code).toBeUndefined();
      expect(ragErr.serverMessage).toBeUndefined();
    }
  });
});
