/**
 * @jest-environment node
 */
/**
 * Tests for GET /api/skills — Skills Gateway API
 *
 * Covers:
 * - Bearer JWT auth accepted (mock validateBearerJWT)
 * - Session auth still works (mock getServerSession)
 * - 401 when no auth provided
 * - Query param filtering: q, source, tags
 * - Pagination: page, page_size, has_more
 * - Backward compat: no query params returns all skills
 */

// ============================================================================
// Mocks — must be declared before any imports that reference them
// ============================================================================

const mockNextResponseJson = jest.fn(
  (data: unknown, init?: { status?: number }) => ({
    json: async () => data,
    status: init?.status ?? 200,
  }),
);

jest.mock('next/server', () => ({
  NextRequest: Request,
  NextResponse: { json: (...args: unknown[]) => mockNextResponseJson(...args) },
}));

jest.mock('next-auth', () => ({ getServerSession: jest.fn() }));
const mockGetServerSession =
  jest.requireMock<{ getServerSession: jest.Mock }>('next-auth').getServerSession;

jest.mock('@/lib/auth-config', () => ({
  authOptions: {},
  isBootstrapAdmin: jest.fn().mockReturnValue(false),
  REQUIRED_ADMIN_GROUP: '',
}));

jest.mock('@/lib/mongodb', () => ({
  getCollection: jest.fn(),
  isMongoDBConfigured: false,
}));

jest.mock('@/lib/jwt-validation', () => ({
  validateBearerJWT: jest.fn(),
  validateLocalSkillsJWT: jest.fn().mockResolvedValue(null),
}));
const mockValidateBearerJWT =
  jest.requireMock<{ validateBearerJWT: jest.Mock }>('@/lib/jwt-validation')
    .validateBearerJWT;

jest.mock('@/lib/config', () => ({
  getConfig: jest.fn().mockReturnValue(true),
}));

// Mock the skill-templates-loader used by aggregateLocally via dynamic import.
// Jest's manual mock factory handles dynamic imports within the same module.
const mockLoadTemplates = jest.fn().mockReturnValue([]);
jest.mock('@/app/api/skills/skill-templates-loader', () => ({
  loadSkillTemplatesInternal: (...args: unknown[]) => mockLoadTemplates(...args),
}));

jest.spyOn(console, 'error').mockImplementation(() => {});
jest.spyOn(console, 'warn').mockImplementation(() => {});

// ============================================================================
// Helpers
// ============================================================================

import type { NextRequest } from 'next/server';

function makeRequest(
  url: string,
  headers?: Record<string, string>,
): NextRequest {
  return new Request(
    new URL(url, 'http://localhost:3000'),
    headers ? { headers } : undefined,
  ) as unknown as NextRequest;
}

function sessionWith(email: string) {
  return {
    user: { email, name: 'Test User' },
    role: 'admin',
  };
}

// Import GET handler AFTER all mocks
import { GET } from '../skills/route';

// ============================================================================
// Sample skill catalog for tests
// ============================================================================

function sampleTemplates() {
  return [
    {
      id: 'deploy-k8s',
      name: 'deploy-k8s',
      description: 'Deploy to Kubernetes cluster',
      content: '# Deploy',
      category: 'ops',
      icon: 'rocket',
      tags: ['kubernetes', 'deploy'],
    },
    {
      id: 'lint-python',
      name: 'lint-python',
      description: 'Lint Python code with ruff',
      content: '# Lint',
      category: 'quality',
      icon: 'check',
      tags: ['python', 'lint'],
    },
    {
      id: 'test-integration',
      name: 'test-integration',
      description: 'Run integration test suite',
      content: '# Test',
      category: 'quality',
      icon: 'test',
      tags: ['test', 'integration'],
    },
    {
      id: 'monitor-alerts',
      name: 'monitor-alerts',
      description: 'Set up monitoring alerts',
      content: '# Monitor',
      category: 'ops',
      icon: 'bell',
      tags: ['monitoring', 'alerts'],
    },
  ];
}

// ============================================================================
// Tests
// ============================================================================

const originalEnv = process.env;

describe('GET /api/skills — Skills Gateway', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env = { ...originalEnv };
    jest.requireMock('@/lib/mongodb').isMongoDBConfigured = false;
    mockLoadTemplates.mockReturnValue(sampleTemplates());
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  it('uses persisted skills without masking edits or deletions with disk templates', async () => {
    mockGetServerSession.mockResolvedValue(sessionWith('test-user@example.com'));
    const mongo = jest.requireMock('@/lib/mongodb');
    mongo.isMongoDBConfigured = true;
    let rows = [{ id: 'deploy-k8s', name: 'deploy-k8s', skill_content: 'Edited content', is_system: true }];
    mongo.getCollection.mockImplementation(async (name: string) => ({
      find: () => ({ toArray: async () => name === 'agent_skills' ? rows : [] }),
    }));
    const response = await GET(makeRequest('/api/skills?include_content=true'));
    expect((await response.json()).skills).toEqual([
      expect.objectContaining({ source: 'agent_skills', content: 'Edited content' }),
    ]);
    rows = [];
    expect((await (await GET(makeRequest('/api/skills'))).json()).skills).toEqual([]);
    expect(mockLoadTemplates).not.toHaveBeenCalled();
  });

  // --------------------------------------------------------------------------
  // Authentication
  // --------------------------------------------------------------------------

  describe('authentication', () => {
    it('accepts Bearer JWT auth', async () => {
      mockValidateBearerJWT.mockResolvedValue({
        email: 'cli@example.com',
        name: 'CLI User',
        groups: [],
      });

      const req = makeRequest('/api/skills', {
        Authorization: 'Bearer valid-jwt-token',
      });
      const res = await GET(req);

      expect(res.status).toBe(200);
      expect(mockValidateBearerJWT).toHaveBeenCalledWith('valid-jwt-token');
      expect(mockGetServerSession).not.toHaveBeenCalled();
    });

    it('falls back to session auth when no Bearer header', async () => {
      mockGetServerSession.mockResolvedValue(sessionWith('user@example.com'));

      const req = makeRequest('/api/skills');
      const res = await GET(req);

      expect(res.status).toBe(200);
      expect(mockValidateBearerJWT).not.toHaveBeenCalled();
      expect(mockGetServerSession).toHaveBeenCalled();
    });

    it('returns 401 when no auth provided', async () => {
      mockGetServerSession.mockResolvedValue(null);

      const req = makeRequest('/api/skills');
      const res = await GET(req);

      expect(res.status).toBe(401);
    });
  });

  // --------------------------------------------------------------------------
  // Backward compatibility
  // --------------------------------------------------------------------------

  describe('backward compatibility', () => {
    it('returns all skills with no query params', async () => {
      mockGetServerSession.mockResolvedValue(sessionWith('user@example.com'));

      const req = makeRequest('/api/skills');
      const res = await GET(req);

      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.skills).toHaveLength(4);
      expect(data.meta.total).toBe(4);
      // No pagination fields when page not specified
      expect(data.meta.page).toBeUndefined();
      expect(data.meta.page_size).toBeUndefined();
      expect(data.meta.has_more).toBeUndefined();
    });
  });

  // --------------------------------------------------------------------------
  // Query param filtering
  // --------------------------------------------------------------------------

  describe('query param filtering', () => {
    beforeEach(() => {
      mockGetServerSession.mockResolvedValue(sessionWith('user@example.com'));
    });

    it('filters by q (text search in name)', async () => {
      const req = makeRequest('/api/skills?q=deploy');
      const res = await GET(req);

      const data = await res.json();
      expect(data.skills).toHaveLength(1);
      expect(data.skills[0].name).toBe('deploy-k8s');
    });

    it('filters by q (text search in description)', async () => {
      const req = makeRequest('/api/skills?q=ruff');
      const res = await GET(req);

      const data = await res.json();
      expect(data.skills).toHaveLength(1);
      expect(data.skills[0].name).toBe('lint-python');
    });

    it('q search is case-insensitive', async () => {
      const req = makeRequest('/api/skills?q=KUBERNETES');
      const res = await GET(req);

      const data = await res.json();
      expect(data.skills).toHaveLength(1);
      expect(data.skills[0].name).toBe('deploy-k8s');
    });

    it('filters by source', async () => {
      // All local templates are "default" source
      const req = makeRequest('/api/skills?source=default');
      const res = await GET(req);

      const data = await res.json();
      expect(data.skills).toHaveLength(4);
    });

    it('source filter with no matches returns empty', async () => {
      const req = makeRequest('/api/skills?source=hub');
      const res = await GET(req);

      const data = await res.json();
      expect(data.skills).toHaveLength(0);
      expect(data.meta.total).toBe(0);
    });

    it('filters by tags (match any)', async () => {
      const req = makeRequest('/api/skills?tags=python,monitoring');
      const res = await GET(req);

      const data = await res.json();
      expect(data.skills).toHaveLength(2);
      const names = data.skills.map((s: unknown) => s.name).sort();
      expect(names).toEqual(['lint-python', 'monitor-alerts']);
    });

    it('combines q and tags filters', async () => {
      const req = makeRequest('/api/skills?q=lint&tags=python');
      const res = await GET(req);

      const data = await res.json();
      expect(data.skills).toHaveLength(1);
      expect(data.skills[0].name).toBe('lint-python');
    });
  });

  // --------------------------------------------------------------------------
  // Pagination
  // --------------------------------------------------------------------------

  describe('pagination', () => {
    beforeEach(() => {
      mockGetServerSession.mockResolvedValue(sessionWith('user@example.com'));
    });

    it('returns first page with page_size', async () => {
      const req = makeRequest('/api/skills?page=1&page_size=2');
      const res = await GET(req);

      const data = await res.json();
      expect(data.skills).toHaveLength(2);
      expect(data.meta.total).toBe(4);
      expect(data.meta.page).toBe(1);
      expect(data.meta.page_size).toBe(2);
      expect(data.meta.has_more).toBe(true);
    });

    it('returns second page', async () => {
      const req = makeRequest('/api/skills?page=2&page_size=2');
      const res = await GET(req);

      const data = await res.json();
      expect(data.skills).toHaveLength(2);
      expect(data.meta.page).toBe(2);
      expect(data.meta.has_more).toBe(false);
    });

    it('returns empty page when past end', async () => {
      const req = makeRequest('/api/skills?page=10&page_size=2');
      const res = await GET(req);

      const data = await res.json();
      expect(data.skills).toHaveLength(0);
      expect(data.meta.total).toBe(4);
      expect(data.meta.has_more).toBe(false);
    });

    it('clamps page_size to max 100', async () => {
      const req = makeRequest('/api/skills?page=1&page_size=999');
      const res = await GET(req);

      const data = await res.json();
      expect(data.meta.page_size).toBe(100);
    });

    it('pagination works with filters', async () => {
      const req = makeRequest(
        '/api/skills?source=default&page=1&page_size=1',
      );
      const res = await GET(req);

      const data = await res.json();
      expect(data.skills).toHaveLength(1);
      expect(data.meta.total).toBe(4); // 4 default skills total
      expect(data.meta.has_more).toBe(true);
    });
  });
});
