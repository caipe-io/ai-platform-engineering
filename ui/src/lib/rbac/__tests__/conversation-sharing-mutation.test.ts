/** @jest-environment node */
import { ObjectId } from 'mongodb';
import { deleteConversationsPermanently } from '@/app/api/chat/conversations/delete-permanently';
import {
  commitConversationSharingMutation, resumeConversationSharingMutation, withConversationSharingLock,
  type ConversationSharingMutation,
} from '../conversation-sharing-mutation';

const revoke = jest.fn();
jest.mock('@/lib/rbac/openfga-owned-resources-reconcile', () => ({
  deleteAllConversationRelationshipTuples: (...args: unknown[]) => revoke(...args),
}));

const journal = new Map<string, ConversationSharingMutation>();
const locks = new Set<string>();
const guard = Object.assign(jest.fn(async () => {}), {
  runExclusive: async <T,>(effect: () => Promise<T>): Promise<T> => { await guard(); return effect(); },
});
const access = new Map<string, unknown>();
const tuples = new Set<string>();
const persistConversation = jest.fn();
const findConversation = jest.fn();
const insertJournal = jest.fn();
const persistAccess = jest.fn();
const updateAccess = jest.fn();
const deleteJournal = jest.fn();
const reconcile = jest.fn();

jest.mock('@/lib/authz', () => ({ reconcileTupleDiff: (...args: unknown[]) => reconcile(...args) }));
jest.mock('@/lib/api-middleware', () => ({ ApiError: jest.requireActual('@/lib/api-error').ApiError }));
jest.mock('@/lib/mongodb', () => ({ getCollection: async (name: string) => {
  if (name === 'conversation_mutation_locks') return {
    insertOne: async ({ _id }: { _id: string }) => {
      if (locks.has(_id)) throw Object.assign(new Error('busy'), { code: 11000 });
      locks.add(_id);
    },
    deleteOne: async ({ _id }: { _id: string }) => locks.delete(_id),
    updateOne: async () => ({ matchedCount: 1 }),
    findOne: async () => null,
  };
  if (name === 'conversation_share_mutations') return {
    insertOne: (...args: unknown[]) => insertJournal(...args),
    findOne: async ({ _id }: { _id: string }) => journal.get(_id),
    deleteOne: (...args: unknown[]) => deleteJournal(...args),
  };
  if (name === 'sharing_access') return { updateOne: (...args: unknown[]) => persistAccess(...args), updateMany: (...args: unknown[]) => updateAccess(...args) };
  if (name === 'conversations') return {
    updateOne: (...args: unknown[]) => persistConversation(...args),
    findOne: (...args: unknown[]) => findConversation(...args),
  };
  throw new Error(`Unexpected collection ${name}`);
} }));

function intent(): ConversationSharingMutation {
  return {
    _id: 'example-chat',
    grants: { writes: [
      { user: 'user:existing', relation: 'reader', object: 'conversation:example-chat' },
      { user: 'user:new', relation: 'reader', object: 'conversation:example-chat' },
    ], deletes: [] },
    accessInserts: [{ _id: new ObjectId(), conversation_id: 'example-chat', granted_by: 'owner@example.com',
      granted_to: 'reader@example.com', permission: 'view', granted_at: new Date() }],
    conversationUpdate: { $set: { 'sharing.shared_with': ['reader@example.com'] } },
  };
}

beforeEach(() => {
  jest.resetAllMocks();
  journal.clear(); locks.clear(); access.clear(); tuples.clear();
  tuples.add('user:existing/reader/conversation:example-chat');
  tuples.add('service_account:unrelated/writer/conversation:example-chat');
  insertJournal.mockImplementation(async (value: ConversationSharingMutation) => { journal.set(value._id, value); });
  deleteJournal.mockImplementation(async ({ _id }: { _id: string }) => { journal.delete(_id); });
  persistConversation.mockResolvedValue({ matchedCount: 1 });
  findConversation.mockResolvedValue({ _id: 'example-chat' });
  persistAccess.mockImplementation(async ({ _id }, { $setOnInsert }) => {
    if (!access.has(String(_id))) access.set(String(_id), $setOnInsert);
  });
  reconcile.mockImplementation(async (diff: ConversationSharingMutation['grants']) => {
    const key = (t: typeof diff.writes[number]) => `${t.user}/${t.relation}/${t.object}`;
    for (const t of diff.writes) tuples.add(key(t));
    for (const t of diff.deletes) tuples.delete(key(t));
  });
});

it.each(['commit', 'resume'])('completes a user-only permission change without an empty database update (%s)', async (mode) => {
  const mutation = intent();
  mutation.conversationUpdate = { $set: {} };
  mutation.accessUpdates = [{
    filter: { conversation_id: 'example-chat', granted_to: 'reader@example.com', revoked_at: null },
    update: { $set: { permission: 'view' } },
  }];
  // DocumentDB rejects the empty operator even after grants and access rows save.
  persistConversation.mockRejectedValue(new Error('Update document requires atomic operators'));
  if (mode === 'resume') journal.set(mutation._id, mutation);

  await withConversationSharingLock('example-chat', () => mode === 'commit'
    ? commitConversationSharingMutation(mutation, guard)
    : resumeConversationSharingMutation('example-chat', guard));

  expect(reconcile).toHaveBeenCalledWith(mutation.grants, { source: 'conversation_sharing' });
  expect(updateAccess).toHaveBeenCalledWith(mutation.accessUpdates[0].filter, mutation.accessUpdates[0].update);
  expect(persistConversation).not.toHaveBeenCalled();
  expect(findConversation).toHaveBeenCalledWith({ _id: 'example-chat' }, { projection: { _id: 1 } });
  expect(journal.size).toBe(0);
  expect(locks.size).toBe(0);
});

it('keeps a metadata-free intent pending if its conversation no longer exists', async () => {
  const mutation = intent();
  mutation.conversationUpdate = { $set: {} };
  findConversation.mockResolvedValue(null);

  await expect(commitConversationSharingMutation(mutation, guard))
    .rejects.toMatchObject({ statusCode: 404 });

  expect(persistConversation).not.toHaveBeenCalled();
  expect(journal.has('example-chat')).toBe(true);
  expect(deleteJournal).not.toHaveBeenCalled();
});

it('journals before grants, then resumes a failed metadata write without removing existing grants', async () => {
  persistConversation.mockRejectedValueOnce(new Error('Mongo unavailable'));
  await expect(withConversationSharingLock('example-chat', () => commitConversationSharingMutation(intent(), guard)))
    .rejects.toThrow('Mongo unavailable');
  expect(journal.has('example-chat')).toBe(true);
  expect(insertJournal.mock.invocationCallOrder[0]).toBeLessThan(reconcile.mock.invocationCallOrder[0]);
  expect(locks.size).toBe(0);
  await withConversationSharingLock('example-chat', () => resumeConversationSharingMutation('example-chat', guard));
  expect(journal.size).toBe(0);
  expect(access.size).toBe(1);
  expect(tuples).toEqual(new Set([
    'user:existing/reader/conversation:example-chat',
    'user:new/reader/conversation:example-chat',
    'service_account:unrelated/writer/conversation:example-chat',
  ]));
});

it('does not create grants unless the retry intent was durably saved', async () => {
  insertJournal.mockRejectedValueOnce(new Error('journal unavailable'));
  await expect(commitConversationSharingMutation(intent(), guard)).rejects.toThrow('journal unavailable');
  expect(reconcile).not.toHaveBeenCalled();
  expect(persistAccess).not.toHaveBeenCalled();
});

it('recovers a partial access-row write with the same IDs and no duplicate rows', async () => {
  const mutation = intent();
  mutation.accessInserts!.push({ ...mutation.accessInserts![0], _id: new ObjectId(), granted_to: 'secondary@example.com' });
  const save = persistAccess.getMockImplementation()!;
  persistAccess.mockImplementationOnce(save).mockRejectedValueOnce(new Error('partial insert'));
  await expect(commitConversationSharingMutation(mutation, guard)).rejects.toThrow('partial insert');
  expect(access.size).toBe(1);
  expect(journal.has('example-chat')).toBe(true);
  await resumeConversationSharingMutation('example-chat', guard);
  expect(access.size).toBe(2);
  expect(journal.size).toBe(0);
});

it('retains work when authorization fails and prevents competing mutations before side effects', async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const first = withConversationSharingLock('example-chat', async () => { await gate; });
  const effects = jest.fn();
  await expect(withConversationSharingLock('example-chat', effects)).rejects.toMatchObject({ statusCode: 409 });
  expect(effects).not.toHaveBeenCalled();
  release(); await first;
  reconcile.mockRejectedValueOnce(new Error('authorization unavailable'));
  await expect(commitConversationSharingMutation(intent(), guard)).rejects.toThrow('authorization unavailable');
  expect(journal.has('example-chat')).toBe(true);
  expect(persistAccess).not.toHaveBeenCalled();
  await resumeConversationSharingMutation('example-chat', guard);
  expect(journal.size).toBe(0);
});

it('retains the journal until both metadata and journal finalization succeed', async () => {
  deleteJournal.mockRejectedValueOnce(new Error('acknowledgement lost'));
  await expect(commitConversationSharingMutation(intent(), guard)).rejects.toThrow('acknowledgement lost');
  expect(journal.has('example-chat')).toBe(true);
  await resumeConversationSharingMutation('example-chat', guard);
  expect(access.size).toBe(1);
  expect(journal.size).toBe(0);
});

it('prevents permanent deletion from racing with a sharing writer', async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const writer = withConversationSharingLock('example-chat', async () => { await gate; });
  await expect(deleteConversationsPermanently([{ _id: 'example-chat' }]))
    .rejects.toMatchObject({ statusCode: 409 });
  expect(revoke).not.toHaveBeenCalled();
  release(); await writer;
});

it('retains recovery work and stops metadata writes when lease ownership is lost after grants', async () => {
  const ownership = Object.assign(jest.fn().mockResolvedValue(undefined), {
    runExclusive: async <T,>(effect: () => Promise<T>): Promise<T> => { await ownership(); return effect(); },
  });
  reconcile.mockImplementationOnce(async () => { ownership.mockRejectedValue(new Error('lease lost')); });
  await expect(commitConversationSharingMutation(intent(), ownership)).rejects.toThrow('lease lost');
  expect(journal.has('example-chat')).toBe(true);
  expect(persistAccess).not.toHaveBeenCalled();
  expect(persistConversation).not.toHaveBeenCalled();
  expect(deleteJournal).not.toHaveBeenCalled();
});
