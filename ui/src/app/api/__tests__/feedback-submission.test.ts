/**
 * @jest-environment node
 */
/**
 * Tests for POST /api/feedback — unified feedback submission route
 *
 * Covers:
 * - Langfuse score fan-out: web sends 2 scores, Slack with channel sends 3
 * - MongoDB writes: web uses insertOne, Slack uses updateOne (upsert)
 * - Granular feedback value override (e.g. "wrong_answer" instead of "thumbs_down")
 * - Comment combining (reason + additionalFeedback)
 * - Validation (missing fields, invalid feedbackType)
 */

import { NextRequest } from 'next/server';

// ============================================================================
// Mocks
// ============================================================================

const mockGetServerSession = jest.fn();
jest.mock('next-auth', () => ({
  getServerSession: (...args: unknown[]) => mockGetServerSession(...args),
}));

jest.mock('@/lib/auth-config', () => ({
  authOptions: {},
}));

const mockValidateBearerJWT = jest.fn();
jest.mock('@/lib/jwt-validation', () => ({
  LocalSkillsJWTValidationError: class LocalSkillsJWTValidationError extends Error {},
  validateLocalSkillsJWT: jest.fn().mockResolvedValue(null),
  validateBearerJWT: (...args: unknown[]) => mockValidateBearerJWT(...args),
}));

// Langfuse mock — the route creates a singleton Langfuse client.
// We mock the constructor to return our spy object.
const mockScore = jest.fn();
const mockFlushAsync = jest.fn().mockResolvedValue(undefined);

jest.mock('langfuse', () => ({
  Langfuse: jest.fn().mockImplementation(() => ({
    score: (...args: unknown[]) => mockScore(...args),
    flushAsync: (...args: unknown[]) => mockFlushAsync(...args),
  })),
}));

// MongoDB mock
const mockInsertOne = jest.fn().mockResolvedValue({ insertedId: 'test-id' });
const mockUpdateOne = jest.fn().mockResolvedValue({ upsertedCount: 1 });

jest.mock('@/lib/mongodb', () => ({
  getCollection: jest.fn(() =>
    Promise.resolve({
      insertOne: (...args: unknown[]) => mockInsertOne(...args),
      updateOne: (...args: unknown[]) => mockUpdateOne(...args),
    }),
  ),
  get isMongoDBConfigured() {
    return true;
  },
}));

jest.spyOn(console, 'log').mockImplementation(() => {});
jest.spyOn(console, 'warn').mockImplementation(() => {});
jest.spyOn(console, 'error').mockImplementation(() => {});

// ============================================================================
// Dynamic import — ensures env vars are set before module-level reads
// ============================================================================

let POST: unknown;

beforeAll(async () => {
  // Set Langfuse env vars before the route module reads them
  process.env.LANGFUSE_SECRET_KEY = 'test-secret';
  process.env.LANGFUSE_PUBLIC_KEY = 'test-public';
  process.env.LANGFUSE_HOST = 'https://langfuse.test';

  const mod = await import('../feedback/route');
  POST = mod.POST;
});

// ============================================================================
// Helpers
// ============================================================================

function makePostRequest(body: Record<string, unknown>, bearerToken?: string): NextRequest {
  return new NextRequest('http://localhost:3000/api/feedback', {
    method: 'POST',
    body: JSON.stringify(body),
    headers: {
      'Content-Type': 'application/json',
      ...(bearerToken ? { Authorization: `Bearer ${bearerToken}` } : {}),
    },
  });
}

function webSession() {
  return { user: { email: 'alice@example.com' } };
}

function resetMocks() {
  mockGetServerSession.mockReset();
  mockScore.mockClear();
  mockFlushAsync.mockClear();
  mockInsertOne.mockClear();
  mockUpdateOne.mockClear();
  mockValidateBearerJWT.mockReset();
  mockValidateBearerJWT.mockResolvedValue({
    sub: 'slack-human-subject',
    email: 'linked-user@example.com',
    name: 'Linked User',
    org: 'default',
    isServiceAccount: false,
  });
}

// ============================================================================
// Tests
// ============================================================================

describe('POST /api/feedback — Validation', () => {
  beforeEach(resetMocks);

  it('returns 400 when no identifier is provided', async () => {
    mockGetServerSession.mockResolvedValue(webSession());
    const res = await POST(makePostRequest({ feedbackType: 'like' }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.success).toBe(false);
    expect(body.message).toContain('required');
  });

  it('returns 400 when feedbackType is invalid', async () => {
    mockGetServerSession.mockResolvedValue(webSession());
    const res = await POST(
      makePostRequest({ conversationId: 'conv-1', feedbackType: 'meh' }),
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.message).toContain('feedbackType');
  });
});

describe('POST /api/feedback — Web: 2 Langfuse scores + insertOne', () => {
  beforeEach(resetMocks);

  it('sends exactly 2 Langfuse scores named "all web" and "all"', async () => {
    mockGetServerSession.mockResolvedValue(webSession());

    const res = await POST(
      makePostRequest({
        conversationId: 'conv-1',
        messageId: 'msg-1',
        feedbackType: 'like',
        reason: 'Great answer',
      }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.langfuseEnabled).toBe(true);

    // Exactly 2 scores
    expect(mockScore).toHaveBeenCalledTimes(2);

    const scoreNames = mockScore.mock.calls.map((c: unknown[]) => c[0].name);
    expect(scoreNames).toEqual(['all web', 'all']);

    // Both use the conversation ID as traceId (priority: conversationId > traceId > messageId)
    expect(mockScore.mock.calls[0][0].traceId).toBe('conv-1');
    expect(mockScore.mock.calls[1][0].traceId).toBe('conv-1');
  });

  it('writes to MongoDB via insertOne with correct fields', async () => {
    mockGetServerSession.mockResolvedValue(webSession());

    await POST(
      makePostRequest({
        conversationId: 'conv-1',
        messageId: 'msg-1',
        feedbackType: 'dislike',
        reason: 'Not helpful',
        additionalFeedback: 'wrong endpoint mentioned',
      }),
    );

    expect(mockInsertOne).toHaveBeenCalledTimes(1);
    expect(mockUpdateOne).not.toHaveBeenCalled();

    const doc = mockInsertOne.mock.calls[0][0];
    expect(doc.source).toBe('web');
    expect(doc.rating).toBe('negative');
    expect(doc.value).toBe('thumbs_down');
    expect(doc.comment).toBe('Not helpful: wrong endpoint mentioned');
    expect(doc.user_email).toBe('alice@example.com');
    expect(doc.conversation_id).toBe('conv-1');
  });
});

describe('POST /api/feedback — Slack with channel: 3 Langfuse scores + upsert', () => {
  beforeEach(resetMocks);

  it('sends 3 Langfuse scores: channel, "all slack channels", "all"', async () => {
    mockGetServerSession.mockResolvedValue(null); // Slack has no web session

    const res = await POST(
      makePostRequest({
        conversationId: 'slack-thread-123',
        messageId: 'msg-1',
        feedbackType: 'dislike',
        value: 'wrong_answer',
        reason: 'Cited wrong docs',
        source: 'slack',
        channelName: 'ask-platform',
        channelId: 'C12345',
        threadTs: 'thread-123',
        userId: 'U99',
        userEmail: 'bob@example.com',
      }, 'slack-human-token'),
    );
    expect(res.status).toBe(200);

    expect(mockScore).toHaveBeenCalledTimes(3);

    const scoreNames = mockScore.mock.calls.map((c: unknown[]) => c[0].name);
    expect(scoreNames).toEqual(['ask-platform', 'all slack channels', 'all']);

    // All scores use the granular value and the same traceId
    for (const call of mockScore.mock.calls) {
      expect(call[0].value).toBe('wrong_answer');
      expect(call[0].traceId).toBe('slack-thread-123');
      expect(call[0].dataType).toBe('CATEGORICAL');
    }
  });

  it('writes to MongoDB via updateOne (upsert) keyed on thread_ts + user_id', async () => {
    mockGetServerSession.mockResolvedValue(null);

    await POST(
      makePostRequest({
        conversationId: 'slack-thread-123',
        feedbackType: 'dislike',
        source: 'slack',
        channelName: 'ask-platform',
        channelId: 'C12345',
        threadTs: 'thread-123',
        userId: 'U99',
        userEmail: 'bob@example.com',
      }, 'slack-human-token'),
    );

    expect(mockUpdateOne).toHaveBeenCalledTimes(1);
    expect(mockInsertOne).not.toHaveBeenCalled();

    const [filter, update, options] = mockUpdateOne.mock.calls[0];
    // Upsert filter: keyed on message_id, user_id, source
    expect(filter).toEqual({
      message_id: 'thread-123',
      user_id: 'U99',
      source: 'slack',
    });
    // $set includes channel context and rating
    expect(update.$set.channel_name).toBe('ask-platform');
    expect(update.$set.rating).toBe('negative');
    expect(update.$set.conversation_id).toBe('slack-thread-123');
    expect(update.$set.user_email).toBe('linked-user@example.com');
    // $setOnInsert has created_at for first insert only
    expect(update.$setOnInsert).toHaveProperty('created_at');
    expect(options.upsert).toBe(true);
  });
});

describe('POST /api/feedback — Slack without channel: 2 Langfuse scores', () => {
  beforeEach(resetMocks);

  it('sends only 2 scores ("all slack channels" + "all") — skips duplicate channel score', async () => {
    mockGetServerSession.mockResolvedValue(null);

    await POST(
      makePostRequest({
        conversationId: 'slack-thread-456',
        feedbackType: 'like',
        source: 'slack',
        threadTs: 'thread-456',
        userId: 'U99',
        userEmail: 'carol@example.com',
      }, 'slack-human-token'),
    );

    // sourceScopeName = "all slack channels" (no channelName)
    // Score 2 guard: source=slack AND sourceScopeName !== "all slack channels" → FALSE → skipped
    // So only 2 scores total
    expect(mockScore).toHaveBeenCalledTimes(2);

    const scoreNames = mockScore.mock.calls.map((c: unknown[]) => c[0].name);
    expect(scoreNames).toEqual(['all slack channels', 'all']);
  });
});

describe('POST /api/feedback — Granular value override', () => {
  beforeEach(resetMocks);

  it('uses explicit value when it is in VALID_FEEDBACK_VALUES', async () => {
    mockGetServerSession.mockResolvedValue(webSession());

    await POST(
      makePostRequest({
        conversationId: 'conv-1',
        feedbackType: 'dislike',
        value: 'needs_detail',
      }),
    );

    // Langfuse score uses "needs_detail" not "thumbs_down"
    expect(mockScore.mock.calls[0][0].value).toBe('needs_detail');

    // MongoDB doc also stores the granular value, rating still from feedbackType
    const doc = mockInsertOne.mock.calls[0][0];
    expect(doc.value).toBe('needs_detail');
    expect(doc.rating).toBe('negative');
  });

  it('falls back to thumbs_up/thumbs_down for unknown values', async () => {
    mockGetServerSession.mockResolvedValue(webSession());

    await POST(
      makePostRequest({
        conversationId: 'conv-1',
        feedbackType: 'like',
        value: 'not_a_real_value',
      }),
    );

    expect(mockScore.mock.calls[0][0].value).toBe('thumbs_up');
    expect(mockInsertOne.mock.calls[0][0].value).toBe('thumbs_up');
  });
});

describe('POST /api/feedback — Comment combining', () => {
  beforeEach(resetMocks);

  it('joins reason and additionalFeedback with ": "', async () => {
    mockGetServerSession.mockResolvedValue(webSession());

    await POST(
      makePostRequest({
        conversationId: 'conv-1',
        feedbackType: 'dislike',
        reason: 'Wrong answer',
        additionalFeedback: 'The API endpoint was deprecated',
      }),
    );

    const doc = mockInsertOne.mock.calls[0][0];
    expect(doc.comment).toBe('Wrong answer: The API endpoint was deprecated');

    // Langfuse also gets the combined comment
    expect(mockScore.mock.calls[0][0].comment).toBe(
      'Wrong answer: The API endpoint was deprecated',
    );
  });

  it('sets comment to null in MongoDB and undefined in Langfuse when no reason given', async () => {
    mockGetServerSession.mockResolvedValue(webSession());

    await POST(
      makePostRequest({
        conversationId: 'conv-1',
        feedbackType: 'like',
      }),
    );

    const doc = mockInsertOne.mock.calls[0][0];
    expect(doc.comment).toBeNull();

    // Langfuse gets `comment || undefined` → undefined
    expect(mockScore.mock.calls[0][0].comment).toBeUndefined();
  });
});
