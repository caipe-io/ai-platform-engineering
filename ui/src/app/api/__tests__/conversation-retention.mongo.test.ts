/** @jest-environment node */
import { MongoClient, ObjectId, type Db } from 'mongodb';
import { NextRequest } from 'next/server';
import { ARCHIVE_RETENTION_MS, deleteConversationsPermanently, purgeExpiredConversations } from '../chat/conversations/delete-permanently';
import { POST as restore } from '../chat/conversations/[id]/restore/route';
import type { Conversation } from '@/types/mongodb';

let mockDb: Db;
let mockHook: (name: string, method: string, args: unknown[]) => Promise<void>;
const mockPurgeRelationships = jest.fn();
jest.mock('@/lib/authz', () => ({ purgeConversationRelationships: (...args: unknown[]) => mockPurgeRelationships(...args) }));
jest.mock('@/lib/mongodb', () => ({ getCollection: async (name: string) => new Proxy(mockDb.collection(name), {
  get(target, key) {
    const method = Reflect.get(target, key);
    if (typeof method !== 'function') return method;
    if (!['findOneAndUpdate', 'deleteMany', 'deleteOne', 'updateOne', 'findOne'].includes(String(key))) return method.bind(target);
    return async (...args: unknown[]) => { await mockHook(name, String(key), args); return method.apply(target, args); };
  },
}) }));
jest.mock('@/lib/rbac/conversation-implicit-authz', () => ({ requireConversationResourcePermission: jest.fn() }));
jest.mock('@/lib/api-middleware', () => ({
  ApiError: jest.requireActual('@/lib/api-error').ApiError,
  validateConversationId: () => true,
  successResponse: (data: unknown, status = 200) => Response.json({ data }, { status }),
  withAuth: async (request: Request, handler: (request: Request, user: unknown, session: unknown) => Promise<Response>) =>
    handler(request, { email: 'owner@example.test' }, { sub: 'owner-subject' }),
  withErrorHandler: (handler: (...args: unknown[]) => Promise<Response>) => async (...args: unknown[]) => {
    try { return await handler(...args); }
    catch (error) { const e = error as { statusCode?: number; code?: string }; return Response.json({ code: e.code }, { status: e.statusCode ?? 500 }); }
  },
}));
const integration = process.env.CAIPE_TEST_MONGODB_URI ? describe : describe.skip;
jest.setTimeout(30_000);
integration('canonical retention lifecycle on isolated MongoDB', () => {
  let client: MongoClient;
  const now = new Date('2026-01-15T12:00:00Z');
  const expiredAt = new Date(now.getTime() - ARCHIVE_RETENTION_MS);
  const children = ['messages', 'turns', 'feedback', 'conversation_bookmarks', 'sharing_access', 'harness_gateway_bindings'];
  beforeAll(async () => {
    const uri = process.env.CAIPE_TEST_MONGODB_URI!;
    if (!['localhost', '127.0.0.1'].includes(new URL(uri).hostname)) throw new Error('Use isolated loopback test MongoDB');
    client = await MongoClient.connect(uri); mockDb = client.db(`test_retention_${new ObjectId()}`);
  });
  afterAll(async () => { await mockDb.dropDatabase(); await client.close(); });
  beforeEach(async () => {
    jest.restoreAllMocks(); await mockDb.dropDatabase(); mockHook = async () => undefined;
    mockPurgeRelationships.mockReset().mockResolvedValue(true);
  });
  async function seed(id: string, deleted_at: Date | undefined = expiredAt, owner = 'owner@example.test') {
    const doc = { _id: id, owner_id: owner, owner_subject: 'owner-subject', client_type: 'webui',
      participants: [{ type: 'agent', id: 'example-agent' }], sharing: {}, created_at: new Date('2025-01-01'),
      ...(deleted_at ? { deleted_at } : {}) } as Conversation;
    await mockDb.collection<Conversation>('conversations').insertOne(doc);
    for (const name of children) await mockDb.collection(name).insertOne({ conversation_id: id, content: 'Example' });
    for (const name of ['checkpoints_conversation', 'checkpoint_writes_conversation']) {
      await mockDb.collection(name).insertOne({ thread_id: id });
    }
    return doc;
  }
  const restoreRequest = (id: string) => restore(new NextRequest(`https://example.test/api/chat/conversations/${id}/restore`, { method: 'POST' }),
    { params: Promise.resolve({ id }) });

  it('purges the seven-day boundary across owners while preserving active and recent archives', async () => {
    await seed('first-owner'); await seed('second-owner', expiredAt, 'other@example.test');
    await seed('recent', new Date(expiredAt.getTime() + 1)); await seed('active', undefined);
    // seed's default is expired; explicitly remove the soft-delete field.
    await mockDb.collection<Conversation>('conversations').updateOne({ _id: 'active' }, { $unset: { deleted_at: '' }, $set: { is_archived: true } });
    expect(await purgeExpiredConversations(now)).toEqual({ examined: 2, deleted: 2, failed: 0 });
    expect((await mockDb.collection<Conversation>('conversations').find({}).toArray()).map(x => x._id).sort()).toEqual(['active', 'recent']);
    for (const name of children) expect(await mockDb.collection(name).countDocuments({ conversation_id: 'first-owner' })).toBe(0);
    expect(await mockDb.collection('checkpoints_conversation').countDocuments({ thread_id: 'first-owner' })).toBe(0);
    expect(mockPurgeRelationships).toHaveBeenCalledWith('first-owner');
  });

  it('preserves all data when restore wins after candidate selection but before claim', async () => {
    await seed('restored'); let response: Response | undefined;
    mockHook = async (name, method) => {
      if (name === 'conversations' && method === 'findOneAndUpdate' && !response) response = await restoreRequest('restored');
    };
    expect(await purgeExpiredConversations(now)).toEqual({ examined: 1, deleted: 0, failed: 0 });
    expect(response!.status).toBe(200);
    expect(await mockDb.collection('messages').countDocuments({ conversation_id: 'restored' })).toBe(1);
    expect((await mockDb.collection<Conversation>('conversations').findOne({ _id: 'restored' }))!.deleted_at).toBeUndefined();
  });

  it('returns a clear restore conflict once purge has claimed the parent', async () => {
    await seed('claimed'); let response: Response | undefined;
    mockHook = async (name, method) => { if (name === 'messages' && method === 'deleteMany' && !response) response = await restoreRequest('claimed'); };
    expect((await purgeExpiredConversations(now)).deleted).toBe(1);
    expect(response!.status).toBe(409); expect(await response!.json()).toEqual({ code: 'CONVERSATION_PURGING' });
  });

  it('retains retry evidence after auth cleanup fails and backs off so another owner progresses', async () => {
    await seed('failed'); mockPurgeRelationships.mockRejectedValueOnce(new Error('PDP unavailable'));
    expect(await purgeExpiredConversations(now, 1)).toEqual({ examined: 1, deleted: 0, failed: 1 });
    const pending = await mockDb.collection<Conversation>('conversations').findOne({ _id: 'failed' });
    expect(pending!.purge).toBeDefined(); expect(pending!.purge!.retry_after.getTime()).toBeGreaterThan(now.getTime());
    await seed('other-owner', expiredAt, 'other@example.test');
    expect(await purgeExpiredConversations(new Date(now.getTime() + 60_000), 1)).toEqual({ examined: 1, deleted: 1, failed: 0 });
    expect((await purgeExpiredConversations(new Date(now.getTime() + 6 * 60_000), 1)).deleted).toBe(1);
    expect(await mockDb.collection('conversations').countDocuments()).toBe(0);
  });

  it('does not let an old worker delete a parent whose lease was reclaimed', async () => {
    await seed('reclaimed'); let changed = false;
    mockHook = async (name, method) => {
      if (name === 'messages' && method === 'deleteMany' && !changed) {
        changed = true; await mockDb.collection<Conversation>('conversations').updateOne({ _id: 'reclaimed' }, {
          $set: { 'purge.token': 'new-attempt', 'purge.lease_until': new Date(now.getTime() + 60_000) },
        });
      }
    };
    expect((await purgeExpiredConversations(now)).deleted).toBe(0);
    expect((await mockDb.collection<Conversation>('conversations').findOne({ _id: 'reclaimed' }))!.purge!.token).toBe('new-attempt');
  });

  it('allows exactly one of two replicas to claim and clean the same candidate', async () => {
    await seed('replica-race'); let arrivals = 0;
    let release!: () => void; const bothSelected = new Promise<void>(resolve => { release = resolve; });
    mockHook = async (name, method) => {
      if (name === 'conversations' && method === 'findOneAndUpdate') {
        arrivals++; if (arrivals === 2) release(); await bothSelected;
      }
    };
    const results = await Promise.all([purgeExpiredConversations(now), purgeExpiredConversations(now)]);
    expect(results.reduce((n, result) => n + result.deleted, 0)).toBe(1);
    expect(results.reduce((n, result) => n + result.failed, 0)).toBe(0);
    expect(mockPurgeRelationships).toHaveBeenCalledTimes(1);
    expect(await mockDb.collection('conversations').countDocuments()).toBe(0);
    expect(await mockDb.collection('messages').countDocuments()).toBe(0);
  });

  it('bounds GridFS cleanup and reports manual deletion as pending until the next attempt', async () => {
    const doc = await seed('large-files');
    const owned = Array.from({ length: 1001 }, () => ({ _id: new ObjectId(), metadata: { namespace: ['example-agent', doc._id, 'filesystem'] } }));
    const unrelated = { _id: new ObjectId(), metadata: { namespace: ['example-agent', 'other-conversation', 'filesystem'] } };
    await mockDb.collection('agent_files.files').insertMany([...owned, unrelated]);
    await mockDb.collection('agent_files.chunks').insertMany([...owned, unrelated].map(file => ({ files_id: file._id, data: 'Example' })));
    const first = await deleteConversationsPermanently([doc], { now });
    expect(first).toMatchObject({ deleted: 0, pending: 1, filesDeleted: 1000 });
    expect(await mockDb.collection('conversations').countDocuments()).toBe(1);
    expect((await deleteConversationsPermanently([doc], { now: new Date(now.getTime() + 1000) })).deleted).toBe(1);
    expect(await mockDb.collection('agent_files.files').findOne({ _id: unrelated._id })).not.toBeNull();
    expect(await mockDb.collection('agent_files.chunks').countDocuments({ files_id: unrelated._id })).toBe(1);
  });

  it('does not silently truncate explicit manual deletion lists to the background batch limit', async () => {
    const docs = await Promise.all(Array.from({ length: 101 }, (_, index) => seed(`manual-${index}`)));
    expect((await deleteConversationsPermanently(docs, { now })).deleted).toBe(101);
    expect(await mockDb.collection('conversations').countDocuments()).toBe(0);
  });

  it('finishes a pending manual file batch before filling the sweep with newly expired conversations', async () => {
    const pending = await seed('queued-files');
    const files = Array.from({ length: 1001 }, () => ({
      _id: new ObjectId(), metadata: { namespace: ['example-agent', pending._id, 'filesystem'] },
    }));
    await mockDb.collection('agent_files.files').insertMany(files);
    await mockDb.collection('agent_files.chunks').insertMany(files.map(file => ({ files_id: file._id, data: 'Example' })));

    expect(await deleteConversationsPermanently([pending], { now })).toMatchObject({
      deleted: 0, pending: 1, filesDeleted: 1000,
    });
    await Promise.all(Array.from({ length: 100 }, (_, index) =>
      seed(`fresh-${String(index).padStart(3, '0')}`, expiredAt, 'other@example.test')));
    mockPurgeRelationships.mockClear();

    expect(await purgeExpiredConversations(new Date(now.getTime() + 1000), 100)).toEqual({
      examined: 100, deleted: 100, failed: 0,
    });
    expect(mockPurgeRelationships.mock.calls[0]).toEqual([pending._id]);
    expect(await mockDb.collection<Conversation>('conversations').findOne({ _id: pending._id })).toBeNull();
    expect(await mockDb.collection('conversations').countDocuments()).toBe(1);
    expect(await mockDb.collection('agent_files.files').countDocuments()).toBe(0);
    expect(await mockDb.collection('agent_files.chunks').countDocuments()).toBe(0);
  });

  it('uses fresh lease and retry clocks after earlier slow operations', async () => {
    await seed('first'); await seed('second');
    let elapsed = 0; jest.spyOn(Date, 'now').mockImplementation(() => 1000 + elapsed);
    let laterLease: Date | undefined;
    mockHook = async (name, method, args) => {
      if (name === 'messages' && method === 'deleteMany') elapsed += 16 * 60_000;
      if (name === 'conversations' && method === 'findOneAndUpdate') {
        const mutation = args[1] as { $set?: { purge?: { lease_until: Date } } };
        if (elapsed) laterLease = mutation.$set?.purge?.lease_until;
      }
    };
    expect((await purgeExpiredConversations(now)).deleted).toBe(2);
    expect(laterLease!.getTime()).toBe(now.getTime() + 31 * 60_000);
  });

  it('does not falsely queue manual deletion when restore won its claim race', async () => {
    const doc = await seed('manual-restore'); let restored = false;
    mockHook = async (name, method) => {
      if (name === 'conversations' && method === 'findOneAndUpdate' && !restored) {
        restored = true; await mockDb.collection<Conversation>('conversations').updateOne({ _id: doc._id }, { $unset: { deleted_at: '' } });
      }
    };
    await expect(deleteConversationsPermanently([doc], { now })).rejects.toMatchObject({ code: 'CONVERSATION_CHANGED', statusCode: 409 });
    expect(await mockDb.collection('messages').countDocuments({ conversation_id: doc._id })).toBe(1);
  });
});
