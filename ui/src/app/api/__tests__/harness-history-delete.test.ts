/** @jest-environment node */
import { deleteConversationsPermanently } from '../chat/conversations/delete-permanently';
const calls: string[] = [];
const fence = jest.fn();
const deleteRows = jest.fn(async () => { calls.push('delete'); });
jest.mock('@/lib/mongodb', () => ({ getCollection: async (name: string) => name === 'harness_deleted_contexts' ? { bulkWrite: fence } : { deleteMany: deleteRows } }));
beforeEach(() => { calls.length = 0; fence.mockReset().mockImplementation(async () => { calls.push('fence'); }); deleteRows.mockClear(); });
it('durably fences visible and execution contexts before removing history', async () => {
  await deleteConversationsPermanently([{ _id: 'conversation-example', execution_context_id: 'runtime-example', participants: [] }]);
  expect(calls).toEqual(['fence', 'delete', 'delete']);
  expect(fence.mock.calls[0][0].map((op: { updateOne: { filter: { _id: string } } }) => op.updateOne.filter._id)).toEqual(['conversation-example', 'runtime-example']);
});
it('preserves all history when the producer fence cannot be stored', async () => {
  fence.mockRejectedValueOnce(new Error('database unavailable'));
  await expect(deleteConversationsPermanently([{ _id: 'conversation-example', participants: [] }])).rejects.toThrow('database unavailable');
  expect(deleteRows).not.toHaveBeenCalled();
});
