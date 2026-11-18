/** @jest-environment node */
import { withResourceMutationLock, type MutationLockGuard } from '../agent-mutation-lock';

interface Lock { _id: string; token: string; expires_at: Date }
const rows = new Map<string, Lock>();
const remove = jest.fn();
const update = jest.fn();
const read = jest.fn();
jest.mock('@/lib/api-middleware', () => ({ ApiError: jest.requireActual('@/lib/api-error').ApiError }));
jest.mock('@/lib/mongodb', () => ({ getCollection: async () => ({
  insertOne: async (row: Lock) => {
    if (rows.has(row._id)) throw Object.assign(new Error('duplicate'), { code: 11000 });
    rows.set(row._id, row);
  },
  findOne: (...args: unknown[]) => read(...args),
  updateOne: (...args: unknown[]) => update(...args),
  deleteOne: (...args: unknown[]) => remove(...args),
}) }));

const run = <T,>(operation: (guard: MutationLockGuard) => Promise<T>) =>
  withResourceMutationLock('example_locks', 'example', 'Access change in progress', operation, { leaseMs: 60_000 });
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => { resolve = r; });
  return { promise, resolve };
}
beforeEach(() => {
  jest.useFakeTimers().setSystemTime(new Date('2026-01-01T00:00:00Z'));
  jest.resetAllMocks(); rows.clear();
  read.mockImplementation(async ({ _id }) => { const row = rows.get(_id); return row && { ...row }; });
  update.mockImplementation(async (filter, change) => {
    const row = rows.get(filter._id);
    const expiry = row?.expires_at.getTime();
    const matches = row && row.token === filter.token
      && (!filter.expires_at.$lte || expiry! <= filter.expires_at.$lte.getTime())
      && (!filter.expires_at.$gt || expiry! > filter.expires_at.$gt.getTime());
    if (!matches) return { matchedCount: 0 };
    if (change.$set) Object.assign(row, change.$set);
    if (change.$max) row.expires_at = new Date(Math.max(expiry!, change.$max.expires_at.getTime()));
    return { matchedCount: 1 };
  });
  remove.mockImplementation(async ({ _id, token }) => {
    if (rows.get(_id)?.token === token) rows.delete(_id);
  });
});
afterEach(() => { jest.useRealTimers(); });

it('reclaims an abandoned lease using its observed token and expiry', async () => {
  rows.set('example', { _id: 'example', token: 'abandoned', expires_at: new Date(Date.now() - 1) });
  expect(await run(async () => 'saved')).toBe('saved');
  expect(update).toHaveBeenCalledWith(
    { _id: 'example', token: 'abandoned', expires_at: { $lte: expect.any(Date) } },
    { $set: { token: expect.any(String), expires_at: expect.any(Date) } },
  );
  expect(rows.size).toBe(0);
});

it('renews an active lease through a long mutation and rejects a competing writer', async () => {
  const gate = deferred(); const started = deferred();
  const first = run(async () => { started.resolve(); await gate.promise; });
  await started.promise;
  await jest.advanceTimersByTimeAsync(100_000);
  const effects = jest.fn();
  await expect(run(effects)).rejects.toMatchObject({ statusCode: 409 });
  expect(effects).not.toHaveBeenCalled();
  expect(rows.get('example')!.expires_at.getTime()).toBeGreaterThan(Date.now());
  gate.resolve(); await first;
  expect(rows.size).toBe(0);
});

it('stops an expired writer before its next step and cannot release its replacement lock', async () => {
  const oldGate = deferred(); const oldStarted = deferred(); const newGate = deferred(); const newStarted = deferred();
  const staleEffects = jest.fn();
  const first = run(async (guard) => { oldStarted.resolve(); await oldGate.promise; await guard(); staleEffects(); });
  const rejected = expect(first).rejects.toMatchObject({ statusCode: 409 });
  await oldStarted.promise;
  jest.setSystemTime(Date.now() + 60_001); // Suspended process: no heartbeat was delivered.
  const second = run(async () => { newStarted.resolve(); await newGate.promise; });
  await newStarted.promise;
  const replacement = rows.get('example')!.token;
  oldGate.resolve(); await rejected;
  expect(staleEffects).not.toHaveBeenCalled();
  expect(rows.get('example')?.token).toBe(replacement);
  newGate.resolve(); await second;
  expect(rows.size).toBe(0);
});

it('recovers an expired row after a failed release without hiding a successful mutation', async () => {
  remove.mockRejectedValueOnce(new Error('release unavailable'));
  const log = jest.spyOn(console, 'error').mockImplementation(() => {});
  try {
    expect(await run(async () => 'saved')).toBe('saved');
    expect(rows.size).toBe(1);
    jest.setSystemTime(Date.now() + 60_001);
    expect(await run(async () => 'retried')).toBe('retried');
    expect(rows.size).toBe(0);
  } finally { log.mockRestore(); }
});

it('does not take over a lock renewed or replaced after the stale-owner read', async () => {
  rows.set('example', { _id: 'example', token: 'old', expires_at: new Date(Date.now() - 1) });
  read.mockImplementationOnce(async () => {
    const previous = { ...rows.get('example')! };
    rows.set('example', { _id: 'example', token: 'new-owner', expires_at: new Date(Date.now() + 60_000) });
    return previous;
  });
  const effects = jest.fn();
  await expect(run(effects)).rejects.toMatchObject({ statusCode: 409 });
  expect(effects).not.toHaveBeenCalled();
  expect(rows.get('example')?.token).toBe('new-owner');
});

it('stops further mutation steps when a heartbeat cannot confirm ownership', async () => {
  const started = deferred(); const gate = deferred(); const effects = jest.fn();
  const log = jest.spyOn(console, 'error').mockImplementation(() => {});
  try {
    const first = run(async (guard) => { started.resolve(); await gate.promise; await guard(); effects(); });
    const rejected = expect(first).rejects.toMatchObject({ statusCode: 409 });
    await started.promise;
    update.mockRejectedValueOnce(new Error('renewal unavailable'));
    await jest.advanceTimersByTimeAsync(20_000);
    gate.resolve(); await rejected;
    expect(effects).not.toHaveBeenCalled();
    expect(rows.size).toBe(0);
  } finally { log.mockRestore(); }
});
