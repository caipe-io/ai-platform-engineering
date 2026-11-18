/** @jest-environment node */
import { deleteConversationsPermanently } from '../delete-permanently';

const mockRevoke = jest.fn();
const mockDelete = jest.fn();
const mockGetCollection = jest.fn();
jest.mock('@/lib/rbac/openfga-owned-resources-reconcile', () => ({
  deleteAllConversationRelationshipTuples: (...args: unknown[]) => mockRevoke(...args),
}));
jest.mock('@/lib/mongodb', () => ({
  getCollection: (...args: unknown[]) => mockGetCollection(...args),
}));

beforeEach(() => {
  jest.resetAllMocks();
  mockRevoke.mockResolvedValue({ enabled: true });
  mockDelete.mockResolvedValue({ deletedCount: 1 });
  mockGetCollection.mockImplementation(async (name: string) => ({
    deleteMany: (filter: unknown) => mockDelete(name, filter),
    insertOne: jest.fn().mockResolvedValue({}),
    updateOne: jest.fn().mockResolvedValue({ matchedCount: 1 }),
    deleteOne: jest.fn().mockResolvedValue({}),
  }));
});

it('retains owning records when authorization cleanup fails and permits retry', async () => {
  const items = [{ _id: 'example-chat' }];
  mockRevoke.mockRejectedValueOnce(new Error('authorization unavailable'));
  await expect(deleteConversationsPermanently(items)).rejects.toThrow('authorization unavailable');
  expect(mockDelete).not.toHaveBeenCalled();
  await deleteConversationsPermanently(items);
  expect(mockDelete).toHaveBeenLastCalledWith('conversations', { _id: { $in: ['example-chat'] } });
});

it('deletes scoped sharing data and agent checkpoints before deleting owners', async () => {
  await deleteConversationsPermanently([
    { _id: 'example-agent', participants: [{ type: 'agent', id: 'example' }] },
    { _id: 'example-chat' },
  ]);
  expect(mockRevoke.mock.calls).toEqual([['example-agent'], ['example-chat']]);
  expect(mockDelete).toHaveBeenCalledWith('sharing_access', {
    conversation_id: { $in: ['example-agent'] },
  });
  expect(mockDelete).toHaveBeenCalledWith('checkpoints_conversation', {
    thread_id: { $in: ['example-agent'] },
  });
  expect(mockDelete).toHaveBeenLastCalledWith('conversations', {
    _id: { $in: ['example-chat'] },
  });
});

it('retains owning records if associated-data cleanup fails', async () => {
  mockDelete.mockRejectedValueOnce(new Error('database unavailable'));
  await expect(deleteConversationsPermanently([{ _id: 'example-chat' }]))
    .rejects.toThrow('database unavailable');
  expect(mockDelete.mock.calls.map(([name]) => name)).not.toContain('conversations');
});

it('does nothing for an empty deletion', async () => {
  await deleteConversationsPermanently([]);
  expect(mockRevoke).not.toHaveBeenCalled();
  expect(mockGetCollection).not.toHaveBeenCalled();
});
