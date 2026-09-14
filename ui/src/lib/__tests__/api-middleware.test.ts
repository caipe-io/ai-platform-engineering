/**
 * Tests for API middleware utilities
 * Covers error handling, validation, pagination, responses, and auth
 * @jest-environment node
 */

const mockNextResponseJson = jest.fn((data: unknown, init?: { status?: number }) => ({
  _isNextResponse: true,
  data,
  status: init?.status ?? 200,
}));
jest.mock('next/server', () => ({
  NextRequest: Request,
  NextResponse: {
    json: (...args: unknown[]) => mockNextResponseJson(...args),
  },
}));

import { NextRequest } from 'next/server';
import { createCredentialError } from '@/lib/credentials/errors';

jest.mock('next-auth', () => ({
  getServerSession: jest.fn(),
}));

jest.mock('@/lib/mongodb', () => ({
  getCollection: jest.fn(),
}));

jest.mock('@/lib/jwt-validation', () => ({
  validateBearerJWT: jest.fn().mockRejectedValue(new Error('mock: not implemented')),
  validateLocalSkillsJWT: jest.fn().mockResolvedValue(null),
}));

jest.mock('@/lib/catalog-api-keys', () => ({
  verifyCatalogApiKey: jest.fn().mockResolvedValue(null),
}));

const mockGetConfig = jest.fn((key: string) => key === 'ssoEnabled');
jest.mock('@/lib/config', () => ({
  getConfig: (...args: unknown[]) => mockGetConfig(...args),
}));

jest.mock('@/lib/rbac/openfga', () => ({
  checkOpenFgaTuple: jest.fn(),
}));

jest.mock('@/lib/rbac/keycloak-authz', () => ({
  checkPermission: jest.fn().mockResolvedValue({ allowed: false, reason: 'DENY_NO_CAPABILITY' }),
}));

const mockAuditWrite = jest.fn();
jest.mock('@/lib/audit', () => ({
  getAuditBackend: () => ({ write: mockAuditWrite }),
}));

const mockGetServerSession = jest.requireMock('next-auth').getServerSession;
const mockGetCollection = jest.requireMock('@/lib/mongodb').getCollection;
const mockValidateBearerJWT = jest.requireMock('@/lib/jwt-validation').validateBearerJWT;
const mockValidateLocalSkillsJWT = jest.requireMock('@/lib/jwt-validation').validateLocalSkillsJWT;
const mockVerifyCatalogApiKey = jest.requireMock('@/lib/catalog-api-keys').verifyCatalogApiKey;
const mockCheckOpenFgaTuple = jest.requireMock('@/lib/rbac/openfga').checkOpenFgaTuple;
const mockCheckPermission = jest.requireMock('@/lib/rbac/keycloak-authz').checkPermission;

beforeEach(() => {
  mockGetConfig.mockImplementation((key: string) => key === 'ssoEnabled');
  mockAuditWrite.mockClear();
  mockVerifyCatalogApiKey.mockReset().mockResolvedValue(null);
  mockValidateLocalSkillsJWT.mockReset().mockResolvedValue(null);
  delete process.env.CAIPE_UNSAFE_RBAC_BYPASS;
  delete process.env.CAIPE_SESSION_AUTH_CACHE_TTL_MS;
});

describe('getAuthFromBearerOrSession scoped credentials', () => {
  it('rejects an invalid catalog API key', async () => {
    const request = new Request('http://test.com/api/skills', {
      headers: { 'X-Caipe-Catalog-Key': 'sk_invalid.secret' },
    }) as unknown as NextRequest;

    await expect(getAuthFromBearerOrSession(request)).rejects.toMatchObject({
      statusCode: 401,
      code: 'CATALOG_KEY_INVALID',
    });
    expect(mockVerifyCatalogApiKey).toHaveBeenCalledWith('sk_invalid.secret');
  });

  it('binds a valid catalog API key to its owner for catalog reads', async () => {
    mockVerifyCatalogApiKey.mockResolvedValue('owner-sub');
    const request = new Request('http://test.com/api/skills?include_content=true', {
      headers: { 'X-Caipe-Catalog-Key': 'sk_valid.secret' },
    }) as unknown as NextRequest;

    const result = await getAuthFromBearerOrSession(request);

    expect(result.user.email).toBe('owner-sub');
    expect(result.session).toMatchObject({
      sub: 'owner-sub',
      principalType: 'catalog_api_key',
      authScopes: ['catalog:read'],
    });
    expect(result.session).not.toHaveProperty('catalogKey');
  });

  it.each([
    ['GET', '/api/credentials/oauth-connectors'],
    ['GET', '/api/dynamic-agents/available'],
    ['GET', '/api/mcp-servers'],
    ['GET', '/api/workflow-configs'],
    ['POST', '/api/ai/assist'],
    ['GET', '/api/chat/conversations'],
    ['PUT', '/api/files/content'],
    ['POST', '/api/projects'],
    ['GET', '/api/projects/backstage/lookup'],
    ['POST', '/api/tome/mcp'],
  ])('rejects a valid catalog API key on %s %s', async (method, path) => {
    mockVerifyCatalogApiKey.mockResolvedValue('owner-sub');
    const request = new Request(`http://test.com${path}`, {
      method,
      headers: { 'X-Caipe-Catalog-Key': 'sk_valid.secret' },
    }) as unknown as NextRequest;

    await expect(getAuthFromBearerOrSession(request)).rejects.toMatchObject({
      statusCode: 403,
      code: 'CATALOG_KEY_NOT_ALLOWED',
    });
  });

  it('accepts a scoped local skills token only for catalog reads', async () => {
    mockValidateLocalSkillsJWT.mockResolvedValue({
      email: 'owner@example.com',
      name: 'Owner',
      groups: [],
      sub: 'owner-sub',
      tokenType: 'skills_api_key',
      scopes: ['skills:read'],
      audience: 'caipe-skills-api',
      issuer: 'caipe-ui',
    });
    const request = new Request('http://test.com/api/skills', {
      headers: { Authorization: 'Bearer local-token' },
    }) as unknown as NextRequest;

    const result = await getAuthFromBearerOrSession(request);

    expect(result.session).toMatchObject({
      sub: 'owner-sub',
      principalType: 'skills_api_key',
      authScopes: ['skills:read'],
    });
  });

  it.each([
    ['GET', '/api/credentials/oauth-connectors'],
    ['GET', '/api/dynamic-agents/available'],
    ['GET', '/api/mcp-servers'],
    ['GET', '/api/workflow-configs'],
    ['POST', '/api/ai/assist'],
    ['GET', '/api/chat/conversations'],
    ['PUT', '/api/files/content'],
    ['POST', '/api/projects'],
    ['GET', '/api/projects/backstage/lookup'],
    ['POST', '/api/tome/mcp'],
  ])('rejects a valid local skills token on %s %s', async (method, path) => {
    mockValidateLocalSkillsJWT.mockResolvedValue({
      email: 'owner@example.com',
      name: 'Owner',
      groups: [],
      sub: 'owner-sub',
      tokenType: 'skills_api_key',
      scopes: ['skills:read'],
      audience: 'caipe-skills-api',
      issuer: 'caipe-ui',
    });
    const request = new Request(`http://test.com${path}`, {
      method,
      headers: { Authorization: 'Bearer local-token' },
    }) as unknown as NextRequest;

    await expect(getAuthFromBearerOrSession(request)).rejects.toMatchObject({
      statusCode: 403,
      code: 'SKILLS_TOKEN_NOT_ALLOWED',
    });
    expect(mockValidateBearerJWT).not.toHaveBeenCalled();
  });
});

jest.spyOn(console, 'error').mockImplementation(() => {});
jest.spyOn(console, 'log').mockImplementation(() => {});
jest.spyOn(console, 'warn').mockImplementation(() => {});

import {
  ApiError,
  handleApiError,
  withErrorHandler,
  validateRequired,
  validateEmail,
  validateUUID,
  validateConversationId,
  getPaginationParams,
  successResponse,
  paginatedResponse,
  errorResponse,
  requireOwnership,
  requireAdmin,
  requireRbacPermission,
  clearSessionAuthCacheForTests,
  getAuthFromBearerOrSession,
  getAuthenticatedUser,
  withAuth,
} from '../api-middleware';

beforeEach(() => {
  clearSessionAuthCacheForTests();
});

describe('ApiError', () => {
  it('creates with message and default status 500', () => {
    const err = new ApiError('Something went wrong');
    expect(err.message).toBe('Something went wrong');
    expect(err.statusCode).toBe(500);
    expect(err.code).toBeUndefined();
  });

  it('creates with custom status', () => {
    const err = new ApiError('Not found', 404);
    expect(err.statusCode).toBe(404);
  });

  it('creates with custom code', () => {
    const err = new ApiError('Validation failed', 400, 'VALIDATION_ERROR');
    expect(err.code).toBe('VALIDATION_ERROR');
  });

  it('name is ApiError', () => {
    const err = new ApiError('test');
    expect(err.name).toBe('ApiError');
  });

  it('is instanceof Error', () => {
    const err = new ApiError('test');
    expect(err instanceof Error).toBe(true);
  });
});

describe('handleApiError', () => {
  beforeEach(() => {
    mockNextResponseJson.mockClear();
  });

  it('handles ApiError → returns correct status and body', () => {
    const err = new ApiError('Resource not found', 404, 'NOT_FOUND');
    handleApiError(err);

    expect(mockNextResponseJson).toHaveBeenCalledWith(
      {
        success: false,
        error: 'Resource not found',
        code: 'NOT_FOUND',
        reason: undefined,
        action: undefined,
      },
      { status: 404 }
    );
  });

  it('handles ApiError with structured auth-error fields → propagates reason+action', () => {
    const err = new ApiError(
      'Sign in again',
      401,
      'BEARER_EXPIRED',
      'session_expired',
      'sign_in'
    );
    handleApiError(err);

    expect(mockNextResponseJson).toHaveBeenCalledWith(
      {
        success: false,
        error: 'Sign in again',
        code: 'BEARER_EXPIRED',
        reason: 'session_expired',
        action: 'sign_in',
      },
      { status: 401 }
    );
  });

  it('handles CredentialError → returns reason code and status', () => {
    const err = createCredentialError({
      reasonCode: 'browser_request_denied',
      message: 'Browser clients cannot retrieve credential material',
      status: 403,
      correlationId: 'corr-1',
    });
    handleApiError(err);

    expect(mockNextResponseJson).toHaveBeenCalledWith(
      {
        success: false,
        error: 'Browser clients cannot retrieve credential material',
        reason: 'browser_request_denied',
        correlationId: 'corr-1',
      },
      { status: 403 }
    );
  });

  it('handles generic Error → returns 500', () => {
    const err = new Error('Database connection failed');
    handleApiError(err);

    expect(mockNextResponseJson).toHaveBeenCalledWith(
      {
        success: false,
        error: 'Database connection failed',
      },
      { status: 500 }
    );
  });

  it('handles unknown error → returns 500 with Internal server error', () => {
    handleApiError('string error');
    expect(mockNextResponseJson).toHaveBeenCalledWith(
      {
        success: false,
        error: 'Internal server error',
      },
      { status: 500 }
    );

    mockNextResponseJson.mockClear();
    handleApiError(null);
    expect(mockNextResponseJson).toHaveBeenCalledWith(
      {
        success: false,
        error: 'Internal server error',
      },
      { status: 500 }
    );
  });
});

describe('withErrorHandler', () => {
  beforeEach(() => {
    mockNextResponseJson.mockClear();
  });

  it('calls handler normally', async () => {
    const mockHandler = jest.fn().mockResolvedValue({
      json: () => ({}),
      status: 200,
    });
    const wrapped = withErrorHandler(mockHandler);

    const req = new Request('http://test.com') as unknown as NextRequest;
    await wrapped(req);

    expect(mockHandler).toHaveBeenCalledWith(req, undefined);
  });

  it('catches errors and returns error response', async () => {
    const mockHandler = jest.fn().mockRejectedValue(new ApiError('Bad request', 400));
    const wrapped = withErrorHandler(mockHandler);

    const req = new Request('http://test.com') as unknown as NextRequest;
    const result = await wrapped(req);

    expect(result).toBeDefined();
    expect(result?._isNextResponse).toBe(true);
    expect(mockNextResponseJson).toHaveBeenCalledWith(
      { success: false, error: 'Bad request', code: undefined },
      { status: 400 }
    );
  });

  it('passes context to handler', async () => {
    const mockHandler = jest.fn().mockResolvedValue({ json: () => ({}) });
    const wrapped = withErrorHandler(mockHandler);

    const req = new Request('http://test.com') as unknown as NextRequest;
    const context = { params: { id: '123' } };
    await wrapped(req, context);

    expect(mockHandler).toHaveBeenCalledWith(req, context);
  });
});

describe('requireRbacPermission organization ReBAC', () => {
  beforeEach(() => {
    mockCheckOpenFgaTuple.mockReset();
    mockCheckPermission.mockReset();
    mockCheckPermission.mockResolvedValue({ allowed: false, reason: 'DENY_NO_CAPABILITY' });
    delete process.env.BOOTSTRAP_ADMIN_EMAILS;
    delete process.env.CAIPE_ORG_KEY;
    delete process.env.CAIPE_UNSAFE_RBAC_BYPASS;
  });

  it('allows admin UI management via organization can_manage', async () => {
    mockCheckOpenFgaTuple.mockResolvedValue({ allowed: true });

    await expect(
      requireRbacPermission(
        {
          accessToken: 'token',
          sub: 'alice-sub',
          org: 'default',
          user: { email: 'alice@example.com' },
        },
        'admin_ui',
        'admin'
      )
    ).resolves.toBeUndefined();

    expect(mockCheckOpenFgaTuple).toHaveBeenCalledWith({
      user: 'user:alice-sub',
      relation: 'can_manage',
      object: 'organization:caipe',
    });
  });

  it('allows admin UI read-only access via organization can_audit', async () => {
    mockCheckOpenFgaTuple.mockResolvedValue({ allowed: true });

    await requireRbacPermission(
      {
        accessToken: 'token',
        sub: 'auditor-sub',
        user: { email: 'auditor@example.com' },
      },
      'admin_ui',
      'view'
    );

    expect(mockCheckOpenFgaTuple).toHaveBeenCalledWith({
      user: 'user:auditor-sub',
      relation: 'can_audit',
      object: 'organization:caipe',
    });
  });

  it('allows RAG datasource admin through the RAG admin surface tuple', async () => {
    mockCheckOpenFgaTuple
      .mockResolvedValueOnce({ allowed: true })
      .mockResolvedValueOnce({ allowed: false });

    await expect(
      requireRbacPermission(
        {
          accessToken: 'token',
          sub: 'rag-admin-sub',
          user: { email: 'rag-admin@example.com' },
        },
        'rag',
        'admin'
      )
    ).resolves.toBeUndefined();

    expect(mockCheckOpenFgaTuple).toHaveBeenCalledWith({
      user: 'user:rag-admin-sub',
      relation: 'can_manage',
      object: 'admin_surface:rag_datasources',
    });
    expect(mockCheckOpenFgaTuple).toHaveBeenCalledTimes(1);
  });

  it('denies RAG datasource admin when the RAG admin surface tuple is absent', async () => {
    mockCheckOpenFgaTuple.mockResolvedValueOnce({ allowed: false });

    await expect(
      requireRbacPermission(
        {
          accessToken: 'token',
          sub: 'rag-reader-sub',
          user: { email: 'rag-reader@example.com' },
        },
        'rag',
        'admin'
      )
    ).rejects.toMatchObject({ statusCode: 403 });

    expect(mockCheckOpenFgaTuple).toHaveBeenCalledWith({
      user: 'user:rag-reader-sub',
      relation: 'can_manage',
      object: 'admin_surface:rag_datasources',
    });
    expect(mockCheckOpenFgaTuple).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['view', 'can_use'],
    ['query', 'can_search'],
    ['invoke', 'can_search'],
    ['kb.query', 'can_search'],
    ['ingest', 'can_ingest'],
    ['kb.ingest', 'can_ingest'],
  ] as const)('maps RAG %s to organization#%s', async (scope, relation) => {
    process.env.CAIPE_ORG_KEY = 'example-org';
    mockCheckOpenFgaTuple.mockResolvedValue({ allowed: true });

    await requireRbacPermission(
      {
        accessToken: 'token',
        sub: 'test-user-subject',
        user: { email: 'test-user@example.test' },
      },
      'rag',
      scope,
    );

    expect(mockCheckOpenFgaTuple).toHaveBeenCalledWith({
      user: 'user:test-user-subject',
      relation,
      object: 'organization:example-org',
    });
  });

  it('does not allow legacy realm role fallback when OpenFGA denies', async () => {
    mockCheckOpenFgaTuple.mockResolvedValue({ allowed: false });

    await expect(
      requireRbacPermission(
        {
          accessToken: ['eyJhbGciOiJub25lIn0', 'eyJyZWFsbV9hY2Nlc3MiOnsicm9sZXMiOlsiYWRtaW4iXX19', ''].join('.'),
          sub: 'legacy-admin-sub',
          user: { email: 'legacy@example.com' },
        },
        'admin_ui',
        'admin'
      )
    ).rejects.toMatchObject({ statusCode: 403 });
  });

  it('uses legacy mocked PDP only in tests when OpenFGA is unconfigured', async () => {
    mockCheckOpenFgaTuple.mockRejectedValue(new Error('OPENFGA_HTTP is not set'));
    mockCheckPermission.mockResolvedValue({ allowed: true });

    await expect(
      requireRbacPermission(
        {
          accessToken: 'token',
          sub: 'legacy-test-sub',
          user: { email: 'legacy-test@example.com' },
        },
        'admin_ui',
        'view'
      )
    ).resolves.toBeUndefined();

    expect(mockCheckPermission).toHaveBeenCalledWith({
      accessToken: 'token',
      resource: 'admin_ui',
      scope: 'view',
    });
  });

  it('uses legacy mocked PDP in tests when a legacy session has no subject', async () => {
    mockCheckPermission.mockResolvedValue({ allowed: true });

    await expect(
      requireRbacPermission(
        {
          accessToken: 'legacy-token-without-sub',
          user: { email: 'legacy-session@example.com' },
        },
        'chat',
        'invoke'
      )
    ).resolves.toBeUndefined();

    expect(mockCheckOpenFgaTuple).not.toHaveBeenCalled();
    expect(mockCheckPermission).toHaveBeenCalledWith({
      accessToken: 'legacy-token-without-sub',
      resource: 'chat',
      scope: 'invoke',
    });
  });

  it('denies through legacy mocked PDP in tests when OpenFGA is unconfigured', async () => {
    mockCheckOpenFgaTuple.mockRejectedValue(new Error('OPENFGA_HTTP is not set'));
    mockCheckPermission.mockResolvedValue({ allowed: false, reason: 'DENY_NO_CAPABILITY' });

    await expect(
      requireRbacPermission(
        {
          accessToken: 'token',
          sub: 'legacy-denied-sub',
          user: { email: 'legacy-denied@example.com' },
        },
        'admin_ui',
        'view'
      )
    ).rejects.toMatchObject({ statusCode: 403 });
  });

  it('uses bootstrap admin emails only as break-glass fallback', async () => {
    process.env.BOOTSTRAP_ADMIN_EMAILS = 'bootstrap@example.com';
    mockCheckOpenFgaTuple.mockResolvedValue({ allowed: false });

    await expect(
      requireRbacPermission(
        {
          accessToken: 'token',
          sub: 'bootstrap-sub',
          user: { email: 'bootstrap@example.com' },
        },
        'admin_ui',
        'admin'
      )
    ).resolves.toBeUndefined();
  });

  it('allows all RBAC decisions behind the unsafe bypass flag', async () => {
    process.env.CAIPE_UNSAFE_RBAC_BYPASS = 'true';
    const warnMock = jest.mocked(console.warn);
    warnMock.mockClear();

    await expect(
      requireRbacPermission(
        {
          role: 'admin',
          user: { email: 'anonymous@local' },
        },
        'admin_ui',
        'admin'
      )
    ).resolves.toBeUndefined();

    expect(mockCheckOpenFgaTuple).not.toHaveBeenCalled();
    expect(mockCheckPermission).not.toHaveBeenCalled();
    expect(warnMock).toHaveBeenCalledWith(expect.stringContaining('RBAC IS DISABLED'));
  });
});

describe('validateRequired', () => {
  it('passes when all fields present', () => {
    const data = { name: 'John', email: 'john@test.com' };
    expect(() => validateRequired(data, ['name', 'email'])).not.toThrow();
  });

  it('throws ApiError 400 for missing fields', () => {
    const data = { name: 'John' };
    expect(() => validateRequired(data, ['name', 'email'])).toThrow(ApiError);
    expect(() => validateRequired(data, ['name', 'email'])).toThrow('Missing required fields: email');
  });

  it('lists all missing fields in message', () => {
    const data = {};
    expect(() => validateRequired(data, ['a', 'b', 'c'])).toThrow('Missing required fields: a, b, c');
  });

  it('code is VALIDATION_ERROR', () => {
    const data = {};
    try {
      validateRequired(data, ['x']);
    } catch (e) {
      expect(e).toBeInstanceOf(ApiError);
      expect((e as ApiError).code).toBe('VALIDATION_ERROR');
      expect((e as ApiError).statusCode).toBe(400);
    }
  });
});

describe('validateEmail', () => {
  it('valid emails return true', () => {
    expect(validateEmail('user@example.com')).toBe(true);
    expect(validateEmail('test.user@domain.co.uk')).toBe(true);
    expect(validateEmail('a@b.co')).toBe(true);
  });

  it('invalid emails return false - missing @', () => {
    expect(validateEmail('userexample.com')).toBe(false);
  });

  it('invalid emails return false - missing domain', () => {
    expect(validateEmail('user@')).toBe(false);
  });

  it('invalid emails return false - spaces', () => {
    expect(validateEmail('user @example.com')).toBe(false);
    expect(validateEmail('user@example.com ')).toBe(false);
  });

  it('invalid emails return false - no TLD', () => {
    expect(validateEmail('user@domain')).toBe(false);
  });
});

describe('validateUUID', () => {
  it('valid UUID returns true', () => {
    expect(validateUUID('550e8400-e29b-41d4-a716-446655440000')).toBe(true);
    expect(validateUUID('6ba7b810-9dad-11d1-80b4-00c04fd430c8')).toBe(true);
    expect(validateUUID('AAAAAAAA-BBBB-4CCC-DDDD-EEEEEEEEEEEE')).toBe(true);
  });

  it('invalid UUID returns false - wrong format', () => {
    expect(validateUUID('not-a-uuid')).toBe(false);
    expect(validateUUID('550e8400-e29b-41d4-a716')).toBe(false);
  });

  it('invalid UUID returns false - too short', () => {
    expect(validateUUID('550e8400-e29b-41d4-a71')).toBe(false);
  });

  it('invalid UUID returns false - invalid chars', () => {
    expect(validateUUID('550e8400-e29b-41d4-a716-44665544000g')).toBe(false);
  });
});

describe('validateConversationId', () => {
  it('accepts UUIDs and legacy URL-safe identifiers', () => {
    expect(validateConversationId('550e8400-e29b-41d4-a716-446655440000')).toBe(true);
    expect(validateConversationId('legacy-demo-conversation')).toBe(true);
    expect(validateConversationId('legacy.chat:thread_42')).toBe(true);
  });

  it('rejects unsafe, ambiguous, and overlong identifiers', () => {
    expect(validateConversationId('')).toBe(false);
    expect(validateConversationId('../conversation')).toBe(false);
    expect(validateConversationId('conversation?archived=true')).toBe(false);
    expect(validateConversationId('$conversation')).toBe(false);
    expect(validateConversationId('conversation with spaces')).toBe(false);
    expect(validateConversationId('a'.repeat(129))).toBe(false);
  });
});

describe('getPaginationParams', () => {
  it('defaults to page 1, pageSize 20', () => {
    const req = new Request('http://test.com/api') as unknown as NextRequest;
    expect(getPaginationParams(req)).toEqual({ page: 1, pageSize: 20, skip: 0 });
  });

  it('parses custom page and page_size', () => {
    const req = new Request('http://test.com/api?page=3&page_size=50') as unknown as NextRequest;
    expect(getPaginationParams(req)).toEqual({ page: 3, pageSize: 50, skip: 100 });
  });

  it('throws for page < 1', () => {
    const req = new Request('http://test.com/api?page=0') as unknown as NextRequest;
    expect(() => getPaginationParams(req)).toThrow(ApiError);
    expect(() => getPaginationParams(req)).toThrow('Page must be >= 1');
  });

  it('throws for pageSize < 1 or > 100', () => {
    const req1 = new Request('http://test.com/api?page_size=0') as unknown as NextRequest;
    expect(() => getPaginationParams(req1)).toThrow('Page size must be between 1 and 100');

    const req2 = new Request('http://test.com/api?page_size=101') as unknown as NextRequest;
    expect(() => getPaginationParams(req2)).toThrow('Page size must be between 1 and 100');
  });

  it('calculates skip correctly', () => {
    const req = new Request('http://test.com/api?page=5&page_size=10') as unknown as NextRequest;
    expect(getPaginationParams(req)).toEqual({ page: 5, pageSize: 10, skip: 40 });
  });
});

describe('successResponse', () => {
  beforeEach(() => {
    mockNextResponseJson.mockClear();
  });

  it('returns success:true with data', () => {
    successResponse({ id: '123', name: 'test' });
    expect(mockNextResponseJson).toHaveBeenCalledWith(
      { success: true, data: { id: '123', name: 'test' } },
      { status: 200 }
    );
  });

  it('default status 200', () => {
    successResponse({});
    expect(mockNextResponseJson).toHaveBeenCalledWith(expect.any(Object), { status: 200 });
  });

  it('custom status', () => {
    successResponse({ created: true }, 201);
    expect(mockNextResponseJson).toHaveBeenCalledWith(
      { success: true, data: { created: true } },
      { status: 201 }
    );
  });
});

describe('paginatedResponse', () => {
  beforeEach(() => {
    mockNextResponseJson.mockClear();
  });

  it('returns items, total, page, page_size', () => {
    paginatedResponse([{ id: 1 }, { id: 2 }], 50, 1, 20);
    expect(mockNextResponseJson).toHaveBeenCalledWith({
      success: true,
      data: {
        items: [{ id: 1 }, { id: 2 }],
        total: 50,
        page: 1,
        page_size: 20,
        has_more: true,
      },
    });
  });

  it('has_more true when more pages', () => {
    paginatedResponse([], 100, 1, 20);
    expect(mockNextResponseJson).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ has_more: true }),
      })
    );
  });

  it('has_more false on last page', () => {
    paginatedResponse([{ id: 1 }, { id: 2 }], 22, 2, 20);
    expect(mockNextResponseJson).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ has_more: false }),
      })
    );
  });
});

describe('errorResponse', () => {
  beforeEach(() => {
    mockNextResponseJson.mockClear();
  });

  it('returns success:false with error message', () => {
    errorResponse('Something failed');
    expect(mockNextResponseJson).toHaveBeenCalledWith(
      { success: false, error: 'Something failed', code: undefined },
      { status: 400 }
    );
  });

  it('includes status code', () => {
    errorResponse('Forbidden', 403);
    expect(mockNextResponseJson).toHaveBeenCalledWith(expect.any(Object), { status: 403 });
  });

  it('includes error code if provided', () => {
    errorResponse('Not found', 404, 'NOT_FOUND');
    expect(mockNextResponseJson).toHaveBeenCalledWith(
      { success: false, error: 'Not found', code: 'NOT_FOUND', reason: undefined, action: undefined },
      { status: 404 }
    );
  });

  it('includes reason and action when provided (structured auth-error contract)', () => {
    errorResponse('Sign in again', 401, 'BEARER_EXPIRED', 'session_expired', 'sign_in');
    expect(mockNextResponseJson).toHaveBeenCalledWith(
      {
        success: false,
        error: 'Sign in again',
        code: 'BEARER_EXPIRED',
        reason: 'session_expired',
        action: 'sign_in',
      },
      { status: 401 }
    );
  });
});

describe('requireOwnership', () => {
  it('passes when IDs match', () => {
    expect(() => requireOwnership('user-123', 'user-123')).not.toThrow();
  });

  it('throws ApiError 403 when IDs differ with structured auth-error fields', () => {
    expect(() => requireOwnership('owner-1', 'user-2')).toThrow(ApiError);
    expect(() => requireOwnership('owner-1', 'user-2')).toThrow(
      'You do not have access to this resource.'
    );
    try {
      requireOwnership('owner-1', 'user-2');
    } catch (e) {
      const err = e as ApiError;
      expect(err.statusCode).toBe(403);
      expect(err.code).toBe('FORBIDDEN');
      expect(err.reason).toBe('forbidden');
      expect(err.action).toBe('contact_admin');
    }
  });
});

describe('getAuthenticatedUser', () => {
  beforeEach(() => {
    mockGetServerSession.mockReset();
    mockGetCollection.mockReset();
  });

  it('throws 401 with structured auth-error fields when no session', async () => {
    mockGetServerSession.mockResolvedValue(null);

    const req = new Request('http://test.com') as unknown as NextRequest;
    await expect(getAuthenticatedUser(req)).rejects.toThrow(ApiError);
    await expect(getAuthenticatedUser(req)).rejects.toMatchObject({
      statusCode: 401,
      code: 'NOT_SIGNED_IN',
      reason: 'not_signed_in',
      action: 'sign_in',
    });
  });

  it('throws 401 when session has no user email', async () => {
    mockGetServerSession.mockResolvedValue({ user: { name: 'Test' } });

    const req = new Request('http://test.com') as unknown as NextRequest;
    await expect(getAuthenticatedUser(req)).rejects.toMatchObject({
      statusCode: 401,
      reason: 'not_signed_in',
    });
  });

  it('returns the local dev auth principal only when dev anonymous auth is enabled', async () => {
    process.env.CAIPE_UNSAFE_RBAC_BYPASS = 'true';
    mockGetConfig.mockImplementation((key: string) => {
      if (key === 'ssoEnabled') return false;
      if (key === 'allowDevAdminWhenSsoDisabled') return true;
      if (key === 'unsafeRbacBypassEnabled') return true;
      return undefined;
    });
    mockGetServerSession.mockResolvedValue(null);

    const req = new Request('http://test.com') as unknown as NextRequest;
    const result = await getAuthenticatedUser(req, { allowAnonymous: true });

    expect(result.user).toEqual({
      email: 'anonymous@local',
      name: 'Anonymous Local Admin',
      role: 'admin',
    });
    expect(result.session).toEqual({
      sub: 'anonymous-local-dev',
      org: 'caipe',
      role: 'admin',
      user: {
        email: 'anonymous@local',
        name: 'Anonymous Local Admin',
        role: 'admin',
      },
      canViewAdmin: true,
      canAccessDynamicAgents: true,
    });
  });

  it('does not provide an anonymous fallback when the unsafe bypass is disabled', async () => {
    mockGetConfig.mockImplementation((key: string) => {
      if (key === 'ssoEnabled') return false;
      if (key === 'allowDevAdminWhenSsoDisabled') return true;
      return undefined;
    });
    mockGetServerSession.mockResolvedValue(null);

    const req = new Request('http://test.com') as unknown as NextRequest;
    await expect(getAuthenticatedUser(req, { allowAnonymous: true })).rejects.toMatchObject({
      statusCode: 401,
      reason: 'not_signed_in',
    });
  });

  it('throws 403 when the session failed the Web UI admission group check', async () => {
    mockGetServerSession.mockResolvedValue({
      user: { email: 'blocked@test.com', name: 'Blocked User' },
      role: 'user',
      isAuthorized: false,
    });

    const req = new Request('http://test.com') as unknown as NextRequest;
    await expect(getAuthenticatedUser(req)).rejects.toMatchObject({
      statusCode: 403,
      code: 'WEB_UI_ACCESS_DENIED',
      reason: 'missing_required_group',
      action: 'contact_admin',
    });
  });

  it('does not persist or inspect profile data for sessions denied by the admission gate', async () => {
    mockGetServerSession.mockResolvedValue({
      user: { email: 'blocked@test.com', name: 'Blocked User' },
      sub: 'blocked-sub',
      isAuthorized: false,
    });

    const req = new Request('http://test.com') as unknown as NextRequest;
    await expect(getAuthenticatedUser(req)).rejects.toMatchObject({
      code: 'WEB_UI_ACCESS_DENIED',
    });
    expect(mockGetCollection).not.toHaveBeenCalled();
  });

  it('ignores stale isAuthorized=false when SSO is disabled for local development', async () => {
    mockGetConfig.mockImplementation((key: string) => (key === 'ssoEnabled' ? false : undefined));
    mockGetServerSession.mockResolvedValue({
      user: { email: 'local@test.com', name: 'Local User' },
      role: 'user',
      isAuthorized: false,
    });
    mockGetCollection.mockResolvedValue({
      findOne: jest.fn().mockResolvedValue(null),
    });

    const req = new Request('http://test.com') as unknown as NextRequest;
    const result = await getAuthenticatedUser(req);

    expect(result.user).toEqual({
      email: 'local@test.com',
      name: 'Local User',
      role: 'user',
    });
  });

  it('returns user when session has email', async () => {
    mockGetServerSession.mockResolvedValue({
      user: { email: 'user@test.com', name: 'Test User' },
      role: 'user',
    });
    mockGetCollection.mockResolvedValue({
      findOne: jest.fn().mockResolvedValue(null),
    });

    const req = new Request('http://test.com') as unknown as NextRequest;
    const result = await getAuthenticatedUser(req);

    expect(result.user).toEqual({
      email: 'user@test.com',
      name: 'Test User',
      role: 'user',
    });
    expect(result.session).toBeDefined();
  });

  it('persists keycloak_sub on the MongoDB user profile', async () => {
    const updateOne = jest.fn().mockResolvedValue({ matchedCount: 1 });
    mockGetServerSession.mockResolvedValue({
      user: { email: 'user@test.com', name: 'Test User' },
      role: 'user',
      sub: 'test-keycloak-sub',
    });
    mockGetCollection.mockResolvedValue({
      findOne: jest.fn().mockResolvedValue(null),
      updateOne,
    });

    const req = new Request('http://test.com') as unknown as NextRequest;
    await getAuthenticatedUser(req);

    expect(updateOne).toHaveBeenCalledWith(
      { email: 'user@test.com' },
      expect.objectContaining({
        $set: expect.objectContaining({
          keycloak_sub: 'test-keycloak-sub',
          'metadata.keycloak_sub': 'test-keycloak-sub',
        }),
      }),
      { upsert: true }
    );
  });

  it('does not promote MongoDB metadata.role to product admin', async () => {
    mockGetServerSession.mockResolvedValue({
      user: { email: 'admin@test.com', name: 'Admin' },
      role: 'user',
    });
    mockGetCollection.mockResolvedValue({
      findOne: jest.fn().mockResolvedValue({
        email: 'admin@test.com',
        metadata: { role: 'admin' },
      }),
    });

    const req = new Request('http://test.com') as unknown as NextRequest;
    const result = await getAuthenticatedUser(req);

    expect(result.user.role).toBe('user');
  });

  it('caches valid cookie sessions for repeated API calls', async () => {
    process.env.CAIPE_SESSION_AUTH_CACHE_TTL_MS = '10000';
    const updateOne = jest.fn().mockResolvedValue({ matchedCount: 1 });
    mockGetServerSession.mockResolvedValue({
      user: { email: 'alice@test.com', name: 'Alice' },
      role: 'user',
      sub: 'alice-sub',
    });
    mockGetCollection.mockResolvedValue({ updateOne });

    const makeRequest = () =>
      new Request('http://test.com/api/admin/slack/channels', {
        headers: { cookie: 'next-auth.session-token=alice-session' },
      }) as unknown as NextRequest;

    const first = await getAuthenticatedUser(makeRequest());
    const second = await getAuthenticatedUser(makeRequest());

    expect(first.user).toEqual(second.user);
    expect(mockGetServerSession).toHaveBeenCalledTimes(1);
    expect(updateOne).toHaveBeenCalledTimes(1);
  });

  it('does not cache session auth when no cookie header is present', async () => {
    mockGetServerSession.mockResolvedValue({
      user: { email: 'nocookie@test.com', name: 'No Cookie' },
      role: 'user',
    });

    const makeRequest = () =>
      new Request('http://test.com/api/admin/slack/channels') as unknown as NextRequest;

    await getAuthenticatedUser(makeRequest());
    await getAuthenticatedUser(makeRequest());

    expect(mockGetServerSession).toHaveBeenCalledTimes(2);
  });

  it('refreshes session auth after the cache ttl expires', async () => {
    process.env.CAIPE_SESSION_AUTH_CACHE_TTL_MS = '50';
    const nowSpy = jest.spyOn(Date, 'now').mockReturnValue(1000);
    mockGetServerSession.mockResolvedValue({
      user: { email: 'ttl@test.com', name: 'TTL User' },
      role: 'user',
    });

    const makeRequest = () =>
      new Request('http://test.com/api/admin/slack/channels', {
        headers: { cookie: 'next-auth.session-token=ttl-session' },
      }) as unknown as NextRequest;

    await getAuthenticatedUser(makeRequest());
    nowSpy.mockReturnValue(1049);
    await getAuthenticatedUser(makeRequest());
    nowSpy.mockReturnValue(1051);
    await getAuthenticatedUser(makeRequest());

    expect(mockGetServerSession).toHaveBeenCalledTimes(2);
    nowSpy.mockRestore();
  });

  it('does not cache sessions denied by the Web UI admission gate', async () => {
    mockGetServerSession
      .mockResolvedValueOnce({
        user: { email: 'blocked@test.com', name: 'Blocked User' },
        role: 'user',
        isAuthorized: false,
      })
      .mockResolvedValueOnce({
        user: { email: 'blocked@test.com', name: 'Blocked User' },
        role: 'user',
        isAuthorized: true,
      });

    const makeRequest = () =>
      new Request('http://test.com/api/admin/slack/channels', {
        headers: { cookie: 'next-auth.session-token=blocked-session' },
      }) as unknown as NextRequest;

    await expect(getAuthenticatedUser(makeRequest())).rejects.toMatchObject({
      code: 'WEB_UI_ACCESS_DENIED',
    });

    const result = await getAuthenticatedUser(makeRequest());

    expect(result.user.email).toBe('blocked@test.com');
    expect(mockGetServerSession).toHaveBeenCalledTimes(2);
  });

  it('keeps bearer authentication outside the cookie session cache', async () => {
    mockValidateLocalSkillsJWT.mockResolvedValue(null);
    mockValidateBearerJWT.mockResolvedValue({
      email: 'service@test.com',
      name: 'Service Account',
      sub: 'service-sub',
      org: 'caipe',
    });

    const makeRequest = () =>
      new Request('http://test.com/api/admin/slack/channels', {
        headers: {
          authorization: 'Bearer service-token',
          cookie: 'next-auth.session-token=browser-session',
        },
      }) as unknown as NextRequest;

    await getAuthFromBearerOrSession(makeRequest());
    await getAuthFromBearerOrSession(makeRequest());

    expect(mockGetServerSession).not.toHaveBeenCalled();
    expect(mockValidateBearerJWT).toHaveBeenCalledTimes(2);
  });
});

describe('withAuth', () => {
  beforeEach(() => {
    mockGetServerSession.mockReset();
    mockGetCollection.mockReset();
    mockCheckOpenFgaTuple.mockResolvedValue({ allowed: true });
  });

  it('calls handler with user and session when authenticated', async () => {
    mockGetServerSession.mockResolvedValue({
      user: { email: 'user@test.com', name: 'User' },
      role: 'user',
      sub: 'user-sub',
    });
    mockGetCollection.mockResolvedValue({
      findOne: jest.fn().mockResolvedValue(null),
    });

    const handler = jest.fn().mockResolvedValue('handler-result');
    const req = new Request('http://test.com') as unknown as NextRequest;

    const result = await withAuth(req, handler);

    expect(result).toBe('handler-result');
    expect(handler).toHaveBeenCalledWith(
      req,
      { email: 'user@test.com', name: 'User', role: 'user' },
      expect.objectContaining({ user: expect.any(Object), role: 'user' })
    );
  });

  it('throws when not authenticated', async () => {
    mockGetServerSession.mockResolvedValue(null);

    const handler = jest.fn();
    const req = new Request('http://test.com') as unknown as NextRequest;

    await expect(withAuth(req, handler)).rejects.toMatchObject({
      statusCode: 401,
      reason: 'not_signed_in',
    });
    expect(handler).not.toHaveBeenCalled();
  });

  it('does not call handler when the session failed the Web UI admission gate', async () => {
    mockGetServerSession.mockResolvedValue({
      user: { email: 'blocked@test.com', name: 'Blocked User' },
      role: 'user',
      isAuthorized: false,
    });

    const handler = jest.fn();
    const req = new Request('http://test.com') as unknown as NextRequest;

    await expect(withAuth(req, handler)).rejects.toMatchObject({
      statusCode: 403,
      code: 'WEB_UI_ACCESS_DENIED',
    });
    expect(handler).not.toHaveBeenCalled();
  });

  // Read-only admin endpoints that handle their own resource-level RBAC must
  // not also require the broader `admin_ui#view` gate. Otherwise a viewer with
  // `system_config:platform_settings#read` cannot load the configured platform
  // defaults even though the route-level permission allows that read.
  describe('route RBAC policy resolution', () => {
    function viewerSession() {
      mockGetServerSession.mockResolvedValue({
        user: { email: 'viewer@test.com', name: 'Read-Only Viewer' },
        role: 'user',
        sub: 'viewer-sub',
        accessToken: 'mock-viewer-token',
      });
      mockGetCollection.mockResolvedValue({
        findOne: jest.fn().mockResolvedValue(null),
      });
    }

    function loggedCapabilities(): string[] {
      return mockAuditWrite.mock.calls
        .map((call) => call[0] as { action?: string })
        .map((event) => event.action)
        .filter((capability): capability is string => typeof capability === 'string');
    }

    it('lets a non-admin signed-in user reach GET /api/admin/platform-config with an explicit system_config read audit row', async () => {
      viewerSession();
      mockCheckOpenFgaTuple.mockResolvedValue({ allowed: true });
      (console.log as jest.Mock).mockClear();

      const handler = jest.fn().mockResolvedValue('config-payload');
      const req = new Request('http://test.com/api/admin/platform-config', {
        method: 'GET',
      }) as unknown as NextRequest;

      const result = await withAuth(req, handler);

      expect(result).toBe('config-payload');
      expect(handler).toHaveBeenCalledTimes(1);
      // Confirm the BFF asked OpenFGA for baseline org access, proving the
      // admin_ui#view gate was bypassed and the narrower in-route
      // system_config check is free to run.
      const calls = mockCheckOpenFgaTuple.mock.calls as Array<[
        { user: string; relation: string; object: string },
      ]>;
      const relations = calls.map((c) => c[0]?.relation);
      expect(relations).toContain('can_use');
      expect(relations).not.toContain('can_audit'); // admin_ui#view → can_audit
      expect(loggedCapabilities()).toContain('system_config#read');
      expect(loggedCapabilities()).not.toContain('admin_ui#view');
    });

    it.each([
      ['/api/users/me', 'GET', 'can_read_self'],
      ['/api/users/me', 'PATCH', 'can_manage_self'],
      ['/api/users/search?q=alice', 'GET', 'can_search_directory'],
      ['/api/auth/my-roles', 'GET', 'can_read_self'],
      ['/api/settings/preferences', 'GET', 'can_manage_self'],
      ['/api/settings/preferences', 'PATCH', 'can_manage_self'],
      ['/api/feedback', 'POST', 'can_submit_feedback'],
      ['/api/chat/conversations', 'GET', 'can_chat'],
      ['/api/dynamic-agents/models', 'GET', 'can_chat'],
      ['/api/dynamic-agents/available', 'GET', 'can_chat'],
      ['/api/files/list', 'GET', 'can_use_files'],
      ['/api/files/content', 'POST', 'can_use_files'],
      ['/api/ai/review', 'POST', 'can_use_ai_assist'],
      ['/api/credentials/retrieve', 'POST', 'can_use_credentials'],
    ])('maps %s %s to explicit OpenFGA relation %s', async (path, method, expectedRelation) => {
      viewerSession();
      mockCheckOpenFgaTuple.mockResolvedValue({ allowed: true });
      mockCheckOpenFgaTuple.mockClear();

      const handler = jest.fn().mockResolvedValue('ok');
      const req = new Request(`http://test.com${path}`, { method }) as unknown as NextRequest;

      await expect(withAuth(req, handler)).resolves.toBe('ok');

      const calls = mockCheckOpenFgaTuple.mock.calls as Array<[
        { user: string; relation: string; object: string },
      ]>;
      const relations = calls.map((c) => c[0]?.relation);
      expect(relations).toContain(expectedRelation);
      expect(relations).not.toContain('can_use');
    });

    // Regression (2026-06-04): skill authoring is a self-service member
    // feature. The coarse BFF gate for creating/configuring/deleting skills
    // must resolve to the member-level `can_use` relation, NOT the admin-only
    // `can_manage`. Per-skill ownership is enforced separately inside the
    // route handlers via `requireResourcePermission`. Before this fix the
    // `skill#configure` / `skill#delete` pairs fell through to `can_manage`,
    // which locked every generic member out of the Skill Builder ("You do not
    // have permission to perform this action.").
    it.each([
      ['/api/skills/configs', 'POST', 'can_use'],
      ['/api/skills/configs', 'PUT', 'can_use'],
      ['/api/skills/configs?id=skill-1', 'DELETE', 'can_use'],
      ['/api/catalog-api-keys', 'POST', 'can_use'],
    ])('lets a member reach %s %s via the member-level %s relation', async (
      path,
      method,
      expectedRelation,
    ) => {
      viewerSession();
      mockCheckOpenFgaTuple.mockResolvedValue({ allowed: true });
      mockCheckOpenFgaTuple.mockClear();

      const handler = jest.fn().mockResolvedValue('ok');
      const req = new Request(`http://test.com${path}`, { method }) as unknown as NextRequest;

      await expect(withAuth(req, handler)).resolves.toBe('ok');

      const calls = mockCheckOpenFgaTuple.mock.calls as Array<[
        { user: string; relation: string; object: string },
      ]>;
      const relations = calls.map((c) => c[0]?.relation);
      expect(relations).toContain(expectedRelation);
      expect(relations).not.toContain('can_manage');
    });

    // Regression (2026-07-12): the autonomous-agents proxy is per-user by
    // design (per-task ownership is enforced by the FastAPI backend via the
    // X-Authenticated-User-* headers; per-agent access by dynamic-agents/CAS).
    // `/api/autonomous` had no entry in the legacy policy map, so non-GET
    // calls fell through to admin_ui#manage — locking every regular member
    // out of creating autonomous tasks ("You do not have permission to
    // perform this action.") even when their team held both autonomous
    // grants. The coarse BFF gate must resolve to the member-level
    // chat#invoke (can_chat), not an admin capability.
    it.each([
      ['/api/autonomous/tasks', 'GET', 'can_chat'],
      ['/api/autonomous/tasks', 'POST', 'can_chat'],
      ['/api/autonomous/tasks/task-1', 'PUT', 'can_chat'],
      ['/api/autonomous/tasks/task-1', 'DELETE', 'can_chat'],
      ['/api/autonomous/tasks/task-1/run', 'POST', 'can_chat'],
    ])('lets a member reach %s %s via the member-level %s relation', async (
      path,
      method,
      expectedRelation,
    ) => {
      viewerSession();
      mockCheckOpenFgaTuple.mockResolvedValue({ allowed: true });
      mockCheckOpenFgaTuple.mockClear();

      const handler = jest.fn().mockResolvedValue('ok');
      const req = new Request(`http://test.com${path}`, { method }) as unknown as NextRequest;

      await expect(withAuth(req, handler)).resolves.toBe('ok');

      const calls = mockCheckOpenFgaTuple.mock.calls as Array<[
        { user: string; relation: string; object: string },
      ]>;
      const relations = calls.map((c) => c[0]?.relation);
      expect(relations).toContain(expectedRelation);
      // admin_ui#manage → can_manage, admin_ui#view → can_audit: the old
      // fallthrough relations that must no longer be consulted.
      expect(relations).not.toContain('can_manage');
      expect(relations).not.toContain('can_audit');
    });

    it('denies a member skill create when OpenFGA has no can_use tuple', async () => {
      viewerSession();
      mockCheckOpenFgaTuple.mockResolvedValue({ allowed: false });
      mockCheckPermission.mockResolvedValue({
        allowed: false,
        reason: 'DENY_NO_CAPABILITY',
      });

      const handler = jest.fn();
      const req = new Request('http://test.com/api/skills/configs', {
        method: 'POST',
      }) as unknown as NextRequest;

      await expect(withAuth(req, handler)).rejects.toMatchObject({
        statusCode: 403,
        reason: 'pdp_denied',
      });
      expect(handler).not.toHaveBeenCalled();

      const calls = mockCheckOpenFgaTuple.mock.calls as Array<[
        { user: string; relation: string; object: string },
      ]>;
      const relations = calls.map((c) => c[0]?.relation);
      expect(relations).toContain('can_use');
    });

    it('still gates PATCH /api/admin/platform-config behind admin_ui#manage', async () => {
      viewerSession();
      // The viewer is signed in but has no admin tuple — OpenFGA denies.
      mockCheckOpenFgaTuple.mockResolvedValue({ allowed: false });
      // Keycloak legacy fallback also denies.
      mockCheckPermission.mockResolvedValue({
        allowed: false,
        reason: 'DENY_NO_CAPABILITY',
      });

      const handler = jest.fn();
      const req = new Request('http://test.com/api/admin/platform-config', {
        method: 'PATCH',
      }) as unknown as NextRequest;

      await expect(withAuth(req, handler)).rejects.toMatchObject({
        statusCode: 403,
        reason: 'pdp_denied',
      });
      expect(handler).not.toHaveBeenCalled();

      // Confirm the BFF asked OpenFGA for `can_manage` (the relation that
      // the `admin_ui#manage` RBAC pair maps to).
      const calls = mockCheckOpenFgaTuple.mock.calls as Array<[
        { user: string; relation: string; object: string },
      ]>;
      const relations = calls.map((c) => c[0]?.relation);
      expect(relations).toContain('can_manage');
    });

    it('still gates other GET /api/admin/* endpoints behind admin_ui#view', async () => {
      viewerSession();
      mockCheckOpenFgaTuple.mockResolvedValue({ allowed: false });
      mockCheckPermission.mockResolvedValue({
        allowed: false,
        reason: 'DENY_NO_CAPABILITY',
      });

      const handler = jest.fn();
      const req = new Request('http://test.com/api/admin/users', {
        method: 'GET',
      }) as unknown as NextRequest;

      await expect(withAuth(req, handler)).rejects.toMatchObject({
        statusCode: 403,
        reason: 'pdp_denied',
      });
      expect(handler).not.toHaveBeenCalled();

      // Confirm the BFF asked OpenFGA for `can_audit` (the relation that
      // the `admin_ui#view` RBAC pair maps to).
      const calls = mockCheckOpenFgaTuple.mock.calls as Array<[
        { user: string; relation: string; object: string },
      ]>;
      const relations = calls.map((c) => c[0]?.relation);
      expect(relations).toContain('can_audit');
    });

    it.each([
      ['/api/workflow-configs', 'GET', 'can_use', 'dynamic_agent#view'],
      ['/api/workflow-configs', 'POST', 'can_use', 'dynamic_agent#view'],
      ['/api/workflow-configs', 'PUT', 'can_use', 'dynamic_agent#view'],
      ['/api/workflow-runs', 'GET', 'can_use', 'dynamic_agent#view'],
      ['/api/schedules', 'GET', 'can_use', 'dynamic_agent#view'],
      ['/api/schedules/schedule-1', 'PATCH', 'can_use', 'dynamic_agent#invoke'],
      ['/api/schedules/schedule-1', 'DELETE', 'can_use', 'dynamic_agent#invoke'],
      ['/api/unclassified-feature', 'GET', 'can_audit', 'admin_ui#view'],
      ['/api/unclassified-feature', 'POST', 'can_manage', 'admin_ui#manage'],
    ])('maps fallback route %s %s to explicit %s capability', async (
      path,
      method,
      expectedRelation,
      expectedCapability
    ) => {
      viewerSession();
      mockCheckOpenFgaTuple.mockResolvedValue({ allowed: true });
      mockCheckOpenFgaTuple.mockClear();
      (console.log as jest.Mock).mockClear();

      const handler = jest.fn().mockResolvedValue('ok');
      const req = new Request(`http://test.com${path}`, { method }) as unknown as NextRequest;

      await expect(withAuth(req, handler)).resolves.toBe('ok');

      const calls = mockCheckOpenFgaTuple.mock.calls as Array<[
        { user: string; relation: string; object: string },
      ]>;
      const relations = calls.map((c) => c[0]?.relation);
      expect(relations).toContain(expectedRelation);
      expect(loggedCapabilities()).toContain(expectedCapability);
    });
  });
});

describe('requireAdmin', () => {
  beforeEach(() => {
    mockCheckOpenFgaTuple.mockReset();
  });

  it('does not throw for OpenFGA organization admin session', async () => {
    mockCheckOpenFgaTuple.mockResolvedValue({ allowed: true });
    await expect(requireAdmin({ sub: 'admin-sub', user: { email: 'admin@test.com' } })).resolves.toBeUndefined();
  });

  it('throws ApiError 403 for non-admin relationship with contact_admin hint', async () => {
    mockCheckOpenFgaTuple.mockResolvedValue({ allowed: false });
    await expect(requireAdmin({ sub: 'user-sub', user: { email: 'user@test.com' } })).rejects.toMatchObject({
      statusCode: 403,
      reason: 'pdp_denied',
      action: 'contact_admin',
    });
  });

  it('throws ApiError 401 when no subject or token is present', async () => {
    await expect(requireAdmin({})).rejects.toMatchObject({
      statusCode: 401,
      reason: 'session_expired',
    });
  });

  it('throws ApiError 503 when OpenFGA is unavailable', async () => {
    mockCheckOpenFgaTuple.mockRejectedValue(new Error('OpenFGA down'));
    await expect(requireAdmin({ sub: 'user-sub', user: { email: 'user@test.com' } })).rejects.toMatchObject({
      statusCode: 503,
      reason: 'pdp_unavailable',
    });
  });
});
