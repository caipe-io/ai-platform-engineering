/**
 * @jest-environment node
 */
/**
 * Tests for User Settings API Routes
 *
 * Covers:
 * - GET /api/settings — get all user settings (with auto-creation of defaults)
 * - PUT /api/settings — update all settings (preferences, notifications, defaults)
 * - PATCH /api/settings/preferences — update preferences only
 * - PATCH /api/settings/notifications — update notifications only
 * - PATCH /api/settings/defaults — update defaults only
 *
 * Auth patterns tested:
 * - 401 when not authenticated
 * - Success when authenticated
 *
 * Settings sync tested:
 * - Default settings creation on first access
 * - Partial preference updates (font_size, font_family, gradient_theme, theme)
 * - Upsert behavior (create if not exist)
 * - Cross-device sync (same user, different preferences)
 */

import { NextRequest } from 'next/server';
import { ObjectId } from 'mongodb';

// ============================================================================
// Mocks
// ============================================================================

// Mock NextAuth
const mockGetServerSession = jest.fn();
jest.mock('next-auth', () => ({
  getServerSession: (...args: unknown[]) => mockGetServerSession(...args),
}));

// Mock auth config
jest.mock('@/lib/auth-config', () => ({
  authOptions: {},
  isBootstrapAdmin: jest.fn().mockReturnValue(false),
  REQUIRED_ADMIN_GROUP: '',
}));

jest.mock('@/lib/config', () => ({
  getConfig: (key: string) => key === 'ssoEnabled',
}));

// Mock MongoDB
const mockCollections: Record<string, unknown> = {};
const mockGetCollection = jest.fn((name: string) => {
  if (!mockCollections[name]) {
    mockCollections[name] = createMockCollection();
  }
  return Promise.resolve(mockCollections[name]);
});

jest.mock('@/lib/mongodb', () => ({
  getCollection: (...args: unknown[]) => mockGetCollection(...args),
  isMongoDBConfigured: true,
}));

// ============================================================================
// Helpers
// ============================================================================

function createMockCollection() {
  return {
    find: jest.fn().mockReturnValue({
      sort: jest.fn().mockReturnValue({
        toArray: jest.fn().mockResolvedValue([]),
      }),
    }),
    findOne: jest.fn().mockResolvedValue(null),
    findOneAndUpdate: jest.fn().mockResolvedValue(null),
    insertOne: jest.fn().mockResolvedValue({ insertedId: new ObjectId() }),
    updateOne: jest.fn().mockResolvedValue({ modifiedCount: 1 }),
    updateMany: jest.fn().mockResolvedValue({ modifiedCount: 0 }),
    deleteOne: jest.fn().mockResolvedValue({ deletedCount: 1 }),
    countDocuments: jest.fn().mockResolvedValue(0),
  };
}

function makeRequest(url: string, options: RequestInit = {}): NextRequest {
  return new NextRequest(new URL(url, 'http://localhost:3000'), options);
}

function authenticatedSession(email = 'user@example.com') {
  return {
    user: { email, name: 'Test User' },
    role: 'user',
  };
}

function resetMocks() {
  mockGetServerSession.mockReset();
  mockGetCollection.mockClear();
  Object.keys(mockCollections).forEach((key) => delete mockCollections[key]);
}

// ============================================================================
// Test imports (after mocks)
// ============================================================================

import { GET, PUT } from '../settings/route';
import { PATCH as PATCHPreferences } from '../settings/preferences/route';
import { PATCH as PATCHNotifications } from '../settings/notifications/route';
import { PATCH as PATCHDefaults } from '../settings/defaults/route';
import { DEFAULT_USER_SETTINGS } from '@/types/mongodb';

// ============================================================================
// Tests: GET /api/settings
// ============================================================================

describe('GET /api/settings', () => {
  beforeEach(resetMocks);

  it('returns 401 when not authenticated', async () => {
    mockGetServerSession.mockResolvedValue(null);
    const req = makeRequest('/api/settings');
    const res = await GET(req);
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.success).toBe(false);
  });

  it('creates default settings for new users', async () => {
    mockGetServerSession.mockResolvedValue(authenticatedSession());
    const col = createMockCollection();
    const createdSettings = {
      _id: new ObjectId(),
      user_id: 'user@example.com',
      ...DEFAULT_USER_SETTINGS,
      updated_at: new Date(),
    };
    col.findOneAndUpdate.mockResolvedValue(createdSettings);
    // Mock users collection for admin check in withAuth
    const usersCol = createMockCollection();
    usersCol.findOne.mockResolvedValue(null);
    mockCollections['users'] = usersCol;
    mockCollections['user_settings'] = col;

    const req = makeRequest('/api/settings');
    const res = await GET(req);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);

    // Verify the atomic upsert was called with defaults
    expect(col.findOneAndUpdate).toHaveBeenCalledTimes(1);
    expect(col.findOneAndUpdate).toHaveBeenCalledWith(
      { user_id: 'user@example.com' },
      {
        $setOnInsert: expect.objectContaining({
          user_id: 'user@example.com',
          preferences: expect.objectContaining({
            theme: 'dark',
            font_size: 'medium',
            font_family: 'inter',
            gradient_theme: 'default',
          }),
          updated_at: expect.any(Date),
        }),
      },
      { upsert: true, returnDocument: 'after' },
    );
    expect(col.insertOne).not.toHaveBeenCalled();
  });

  it('returns existing settings without re-creating defaults', async () => {
    mockGetServerSession.mockResolvedValue(authenticatedSession());
    const existingSettings = {
      _id: new ObjectId(),
      user_id: 'user@example.com',
      preferences: {
        theme: 'midnight',
        gradient_theme: 'ocean',
        font_family: 'ibm-plex',
        font_size: 'large',
        sidebar_collapsed: true,
        context_panel_visible: false,
        debug_mode: false,
        code_theme: 'onedark',
      },
      notifications: DEFAULT_USER_SETTINGS.notifications,
      defaults: DEFAULT_USER_SETTINGS.defaults,
      updated_at: new Date(),
    };

    const col = createMockCollection();
    col.findOneAndUpdate.mockResolvedValue(existingSettings);
    const usersCol = createMockCollection();
    usersCol.findOne.mockResolvedValue(null);
    mockCollections['users'] = usersCol;
    mockCollections['user_settings'] = col;

    const req = makeRequest('/api/settings');
    const res = await GET(req);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.data.preferences.theme).toBe('midnight');
    expect(body.data.preferences.gradient_theme).toBe('ocean');
    expect(body.data.preferences.font_family).toBe('ibm-plex');

    // insertOne should NOT be called since settings already exist
    expect(col.findOneAndUpdate).toHaveBeenCalledTimes(1);
    expect(col.insertOne).not.toHaveBeenCalled();
  });
});

// ============================================================================
// Tests: PUT /api/settings
// ============================================================================

describe('PUT /api/settings', () => {
  beforeEach(resetMocks);

  it('returns 401 when not authenticated', async () => {
    mockGetServerSession.mockResolvedValue(null);
    const req = makeRequest('/api/settings', {
      method: 'PUT',
      body: JSON.stringify({ preferences: { theme: 'dark' } }),
    });
    const res = await PUT(req);
    expect(res.status).toBe(401);
  });

  it('updates preferences via PUT', async () => {
    mockGetServerSession.mockResolvedValue(authenticatedSession());
    const col = createMockCollection();
    const updatedSettings = {
      _id: new ObjectId(),
      user_id: 'user@example.com',
      preferences: { ...DEFAULT_USER_SETTINGS.preferences, theme: 'midnight', font_size: 'large' },
      notifications: DEFAULT_USER_SETTINGS.notifications,
      defaults: DEFAULT_USER_SETTINGS.defaults,
      updated_at: new Date(),
    };
    col.findOne.mockResolvedValue(updatedSettings);
    const usersCol = createMockCollection();
    usersCol.findOne.mockResolvedValue(null);
    mockCollections['users'] = usersCol;
    mockCollections['user_settings'] = col;

    const req = makeRequest('/api/settings', {
      method: 'PUT',
      body: JSON.stringify({
        preferences: { theme: 'midnight', font_size: 'large' },
      }),
    });

    const res = await PUT(req);
    expect(res.status).toBe(200);

    // Verify updateOne was called with dot-notation for nested updates
    expect(col.updateOne).toHaveBeenCalledTimes(1);
    const updateCall = col.updateOne.mock.calls[0];
    expect(updateCall[0]).toEqual({ user_id: 'user@example.com' });
    const $set = updateCall[1].$set;
    expect($set['preferences.theme']).toBe('midnight');
    expect($set['preferences.font_size']).toBe('large');
    expect($set.updated_at).toBeInstanceOf(Date);
    // Upsert should be true
    expect(updateCall[2]).toEqual({ upsert: true });
  });

  it('updates notifications via PUT', async () => {
    mockGetServerSession.mockResolvedValue(authenticatedSession());
    const col = createMockCollection();
    col.findOne.mockResolvedValue({
      _id: new ObjectId(),
      user_id: 'user@example.com',
      ...DEFAULT_USER_SETTINGS,
      notifications: { ...DEFAULT_USER_SETTINGS.notifications, email_enabled: false },
      updated_at: new Date(),
    });
    const usersCol = createMockCollection();
    usersCol.findOne.mockResolvedValue(null);
    mockCollections['users'] = usersCol;
    mockCollections['user_settings'] = col;

    const req = makeRequest('/api/settings', {
      method: 'PUT',
      body: JSON.stringify({
        notifications: { email_enabled: false },
      }),
    });

    const res = await PUT(req);
    expect(res.status).toBe(200);

    const $set = col.updateOne.mock.calls[0][1].$set;
    expect($set['notifications.email_enabled']).toBe(false);
  });

  it('updates defaults via PUT', async () => {
    mockGetServerSession.mockResolvedValue(authenticatedSession());
    const col = createMockCollection();
    col.findOne.mockResolvedValue({
      _id: new ObjectId(),
      user_id: 'user@example.com',
      ...DEFAULT_USER_SETTINGS,
      updated_at: new Date(),
    });
    const usersCol = createMockCollection();
    usersCol.findOne.mockResolvedValue(null);
    mockCollections['users'] = usersCol;
    mockCollections['user_settings'] = col;

    const req = makeRequest('/api/settings', {
      method: 'PUT',
      body: JSON.stringify({
        defaults: { default_model: 'claude-3.5-sonnet' },
      }),
    });

    const res = await PUT(req);
    expect(res.status).toBe(200);

    const $set = col.updateOne.mock.calls[0][1].$set;
    expect($set['defaults.default_model']).toBe('claude-3.5-sonnet');
  });

  it('updates all sections at once via PUT', async () => {
    mockGetServerSession.mockResolvedValue(authenticatedSession());
    const col = createMockCollection();
    col.findOne.mockResolvedValue({
      _id: new ObjectId(),
      user_id: 'user@example.com',
      ...DEFAULT_USER_SETTINGS,
      updated_at: new Date(),
    });
    const usersCol = createMockCollection();
    usersCol.findOne.mockResolvedValue(null);
    mockCollections['users'] = usersCol;
    mockCollections['user_settings'] = col;

    const req = makeRequest('/api/settings', {
      method: 'PUT',
      body: JSON.stringify({
        preferences: { theme: 'nord', gradient_theme: 'sunset' },
        notifications: { weekly_summary: true },
        defaults: { auto_title_conversations: false },
      }),
    });

    const res = await PUT(req);
    expect(res.status).toBe(200);

    const $set = col.updateOne.mock.calls[0][1].$set;
    expect($set['preferences.theme']).toBe('nord');
    expect($set['preferences.gradient_theme']).toBe('sunset');
    expect($set['notifications.weekly_summary']).toBe(true);
    expect($set['defaults.auto_title_conversations']).toBe(false);
  });
});

// ============================================================================
// Tests: PATCH /api/settings/preferences
// ============================================================================

describe('PATCH /api/settings/preferences', () => {
  beforeEach(resetMocks);

  it('returns 401 when not authenticated', async () => {
    mockGetServerSession.mockResolvedValue(null);
    const req = makeRequest('/api/settings/preferences', {
      method: 'PATCH',
      body: JSON.stringify({ theme: 'dark' }),
    });
    const res = await PATCHPreferences(req);
    expect(res.status).toBe(401);
  });

  it('updates font_size preference', async () => {
    mockGetServerSession.mockResolvedValue(authenticatedSession());
    const col = createMockCollection();
    col.findOne.mockResolvedValue({
      _id: new ObjectId(),
      user_id: 'user@example.com',
      preferences: { ...DEFAULT_USER_SETTINGS.preferences, font_size: 'x-large' },
      updated_at: new Date(),
    });
    const usersCol = createMockCollection();
    usersCol.findOne.mockResolvedValue(null);
    mockCollections['users'] = usersCol;
    mockCollections['user_settings'] = col;

    const req = makeRequest('/api/settings/preferences', {
      method: 'PATCH',
      body: JSON.stringify({ font_size: 'x-large' }),
    });

    const res = await PATCHPreferences(req);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);

    const $set = col.updateOne.mock.calls[0][1].$set;
    expect($set['preferences.font_size']).toBe('x-large');
    expect($set.updated_at).toBeInstanceOf(Date);
  });

  it('updates font_family preference', async () => {
    mockGetServerSession.mockResolvedValue(authenticatedSession());
    const col = createMockCollection();
    col.findOne.mockResolvedValue({
      _id: new ObjectId(),
      user_id: 'user@example.com',
      preferences: { ...DEFAULT_USER_SETTINGS.preferences, font_family: 'ibm-plex' },
      updated_at: new Date(),
    });
    const usersCol = createMockCollection();
    usersCol.findOne.mockResolvedValue(null);
    mockCollections['users'] = usersCol;
    mockCollections['user_settings'] = col;

    const req = makeRequest('/api/settings/preferences', {
      method: 'PATCH',
      body: JSON.stringify({ font_family: 'ibm-plex' }),
    });

    const res = await PATCHPreferences(req);
    expect(res.status).toBe(200);

    const $set = col.updateOne.mock.calls[0][1].$set;
    expect($set['preferences.font_family']).toBe('ibm-plex');
  });

  it('updates gradient_theme preference', async () => {
    mockGetServerSession.mockResolvedValue(authenticatedSession());
    const col = createMockCollection();
    col.findOne.mockResolvedValue({
      _id: new ObjectId(),
      user_id: 'user@example.com',
      preferences: { ...DEFAULT_USER_SETTINGS.preferences, gradient_theme: 'sunset' },
      updated_at: new Date(),
    });
    const usersCol = createMockCollection();
    usersCol.findOne.mockResolvedValue(null);
    mockCollections['users'] = usersCol;
    mockCollections['user_settings'] = col;

    const req = makeRequest('/api/settings/preferences', {
      method: 'PATCH',
      body: JSON.stringify({ gradient_theme: 'sunset' }),
    });

    const res = await PATCHPreferences(req);
    expect(res.status).toBe(200);

    const $set = col.updateOne.mock.calls[0][1].$set;
    expect($set['preferences.gradient_theme']).toBe('sunset');
  });

  it('updates theme preference', async () => {
    mockGetServerSession.mockResolvedValue(authenticatedSession());
    const col = createMockCollection();
    col.findOne.mockResolvedValue({
      _id: new ObjectId(),
      user_id: 'user@example.com',
      preferences: { ...DEFAULT_USER_SETTINGS.preferences, theme: 'tokyo' },
      updated_at: new Date(),
    });
    const usersCol = createMockCollection();
    usersCol.findOne.mockResolvedValue(null);
    mockCollections['users'] = usersCol;
    mockCollections['user_settings'] = col;

    const req = makeRequest('/api/settings/preferences', {
      method: 'PATCH',
      body: JSON.stringify({ theme: 'tokyo' }),
    });

    const res = await PATCHPreferences(req);
    expect(res.status).toBe(200);

    const $set = col.updateOne.mock.calls[0][1].$set;
    expect($set['preferences.theme']).toBe('tokyo');
  });

  it('updates multiple preferences at once', async () => {
    mockGetServerSession.mockResolvedValue(authenticatedSession());
    const col = createMockCollection();
    col.findOne.mockResolvedValue({
      _id: new ObjectId(),
      user_id: 'user@example.com',
      preferences: {
        ...DEFAULT_USER_SETTINGS.preferences,
        font_size: 'large',
        font_family: 'source-sans',
        gradient_theme: 'ocean',
        theme: 'nord',
      },
      updated_at: new Date(),
    });
    const usersCol = createMockCollection();
    usersCol.findOne.mockResolvedValue(null);
    mockCollections['users'] = usersCol;
    mockCollections['user_settings'] = col;

    const req = makeRequest('/api/settings/preferences', {
      method: 'PATCH',
      body: JSON.stringify({
        font_size: 'large',
        font_family: 'source-sans',
        gradient_theme: 'ocean',
        theme: 'nord',
      }),
    });

    const res = await PATCHPreferences(req);
    expect(res.status).toBe(200);

    const $set = col.updateOne.mock.calls[0][1].$set;
    expect($set['preferences.font_size']).toBe('large');
    expect($set['preferences.font_family']).toBe('source-sans');
    expect($set['preferences.gradient_theme']).toBe('ocean');
    expect($set['preferences.theme']).toBe('nord');
  });

  it('uses upsert to create settings if user has none', async () => {
    mockGetServerSession.mockResolvedValue(authenticatedSession('newuser@example.com'));
    const col = createMockCollection();
    col.findOne.mockResolvedValue({
      user_id: 'newuser@example.com',
      preferences: { font_size: 'small' },
      updated_at: new Date(),
    });
    const usersCol = createMockCollection();
    usersCol.findOne.mockResolvedValue(null);
    mockCollections['users'] = usersCol;
    mockCollections['user_settings'] = col;

    const req = makeRequest('/api/settings/preferences', {
      method: 'PATCH',
      body: JSON.stringify({ font_size: 'small' }),
    });

    const res = await PATCHPreferences(req);
    expect(res.status).toBe(200);

    const updateCall = col.updateOne.mock.calls[0];
    expect(updateCall[0]).toEqual({ user_id: 'newuser@example.com' });
    // Verify upsert: true is passed
    expect(updateCall[2]).toEqual({ upsert: true });
  });
});

// ============================================================================
// Tests: PATCH /api/settings/notifications
// ============================================================================

describe('PATCH /api/settings/notifications', () => {
  beforeEach(resetMocks);

  it('returns 401 when not authenticated', async () => {
    mockGetServerSession.mockResolvedValue(null);
    const req = makeRequest('/api/settings/notifications', {
      method: 'PATCH',
      body: JSON.stringify({ email_enabled: false }),
    });
    const res = await PATCHNotifications(req);
    expect(res.status).toBe(401);
  });

  it('updates notification settings', async () => {
    mockGetServerSession.mockResolvedValue(authenticatedSession());
    const col = createMockCollection();
    col.findOne.mockResolvedValue({
      _id: new ObjectId(),
      user_id: 'user@example.com',
      notifications: {
        ...DEFAULT_USER_SETTINGS.notifications,
        email_enabled: false,
        weekly_summary: true,
      },
      updated_at: new Date(),
    });
    const usersCol = createMockCollection();
    usersCol.findOne.mockResolvedValue(null);
    mockCollections['users'] = usersCol;
    mockCollections['user_settings'] = col;

    const req = makeRequest('/api/settings/notifications', {
      method: 'PATCH',
      body: JSON.stringify({
        email_enabled: false,
        weekly_summary: true,
        platform_health: false,
      }),
    });

    const res = await PATCHNotifications(req);
    expect(res.status).toBe(200);

    const $set = col.updateOne.mock.calls[0][1].$set;
    expect($set['notifications.email_enabled']).toBe(false);
    expect($set['notifications.weekly_summary']).toBe(true);
    expect($set['notifications.platform_health']).toBe(false);
    expect($set.updated_at).toBeInstanceOf(Date);
  });
});

// ============================================================================
// Tests: PATCH /api/settings/defaults
// ============================================================================

describe('PATCH /api/settings/defaults', () => {
  beforeEach(resetMocks);

  it('returns 401 when not authenticated', async () => {
    mockGetServerSession.mockResolvedValue(null);
    const req = makeRequest('/api/settings/defaults', {
      method: 'PATCH',
      body: JSON.stringify({ default_model: 'claude-3.5-sonnet' }),
    });
    const res = await PATCHDefaults(req);
    expect(res.status).toBe(401);
  });

  it('updates default settings', async () => {
    mockGetServerSession.mockResolvedValue(authenticatedSession());
    const col = createMockCollection();
    col.findOne.mockResolvedValue({
      _id: new ObjectId(),
      user_id: 'user@example.com',
      defaults: {
        ...DEFAULT_USER_SETTINGS.defaults,
        default_model: 'claude-3.5-sonnet',
        auto_title_conversations: false,
      },
      updated_at: new Date(),
    });
    const usersCol = createMockCollection();
    usersCol.findOne.mockResolvedValue(null);
    mockCollections['users'] = usersCol;
    mockCollections['user_settings'] = col;

    const req = makeRequest('/api/settings/defaults', {
      method: 'PATCH',
      body: JSON.stringify({
        default_model: 'claude-3.5-sonnet',
        auto_title_conversations: false,
      }),
    });

    const res = await PATCHDefaults(req);
    expect(res.status).toBe(200);

    const $set = col.updateOne.mock.calls[0][1].$set;
    expect($set['defaults.default_model']).toBe('claude-3.5-sonnet');
    expect($set['defaults.auto_title_conversations']).toBe(false);
  });
});

// ============================================================================
// Tests: Cross-device sync scenario
// ============================================================================

describe('Cross-device settings sync', () => {
  beforeEach(resetMocks);

  it('same user can update from different devices and settings converge', async () => {
    mockGetServerSession.mockResolvedValue(authenticatedSession('multi-device@example.com'));
    const col = createMockCollection();
    const usersCol = createMockCollection();
    usersCol.findOne.mockResolvedValue(null);
    mockCollections['users'] = usersCol;
    mockCollections['user_settings'] = col;

    // Device 1: changes font_size to large
    col.findOne.mockResolvedValue({
      _id: new ObjectId(),
      user_id: 'multi-device@example.com',
      preferences: { ...DEFAULT_USER_SETTINGS.preferences, font_size: 'large' },
      updated_at: new Date(),
    });

    const req1 = makeRequest('/api/settings/preferences', {
      method: 'PATCH',
      body: JSON.stringify({ font_size: 'large' }),
    });

    const res1 = await PATCHPreferences(req1);
    expect(res1.status).toBe(200);

    // Device 2: changes theme to midnight
    col.findOne.mockResolvedValue({
      _id: new ObjectId(),
      user_id: 'multi-device@example.com',
      preferences: {
        ...DEFAULT_USER_SETTINGS.preferences,
        font_size: 'large',
        theme: 'midnight',
      },
      updated_at: new Date(),
    });

    const req2 = makeRequest('/api/settings/preferences', {
      method: 'PATCH',
      body: JSON.stringify({ theme: 'midnight' }),
    });

    const res2 = await PATCHPreferences(req2);
    expect(res2.status).toBe(200);

    // Both updateOne calls should target the same user
    expect(col.updateOne.mock.calls[0][0]).toEqual({ user_id: 'multi-device@example.com' });
    expect(col.updateOne.mock.calls[1][0]).toEqual({ user_id: 'multi-device@example.com' });

    // First call sets font_size
    expect(col.updateOne.mock.calls[0][1].$set['preferences.font_size']).toBe('large');

    // Second call sets theme (without overwriting font_size, since dot-notation is used)
    expect(col.updateOne.mock.calls[1][1].$set['preferences.theme']).toBe('midnight');
    expect(col.updateOne.mock.calls[1][1].$set['preferences.font_size']).toBeUndefined();
  });
});
