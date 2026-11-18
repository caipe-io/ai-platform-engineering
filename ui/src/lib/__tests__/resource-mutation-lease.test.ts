/** @jest-environment node */
import { withResourceMutationLock, type MutationLockGuard } from '../agent-mutation-lock';

interface Lock { _id: string; token: string; expires_at: Date; effect_token?: string; effect_started_at?: Date; recovery_required?: boolean }
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
    const matches = (part: Record<string, unknown>): boolean => Object.entries(part).every(([key, value]) => {
      if (key === '$or') return (value as Record<string, unknown>[]).some(matches);
      const actual = row?.[key as keyof Lock];
      if (value && typeof value === 'object' && !(value instanceof Date)) {
        const condition = value as { $exists?: boolean; $gt?: Date; $lte?: Date };
        if ('$exists' in condition && (actual !== undefined) !== condition.$exists) return false;
        if (condition.$gt && (!(actual instanceof Date) || actual <= condition.$gt)) return false;
        if (condition.$lte && (!(actual instanceof Date) || actual > condition.$lte)) return false;
        return true;
      }
      return actual === value;
    });
    if (!row || !matches(filter)) return { matchedCount: 0 };
    if (change.$set) Object.assign(row, change.$set);
    if (change.$unset) for (const key of Object.keys(change.$unset)) delete row[key as keyof Lock];
    if (change.$max) row.expires_at = new Date(Math.max(row.expires_at.getTime(), change.$max.expires_at.getTime()));
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
    { _id: 'example', token: 'abandoned', expires_at: { $lte: expect.any(Date) }, effect_token: { $exists: false } },
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

it('does not allow takeover or cleanup while an outstanding grant write can still finish', async () => {
  const started = deferred(); const write = deferred();
  const history: string[] = [];
  let grantExists = false;
  const first = run(async (guard) => guard.runExclusive(async () => {
    started.resolve(); await write.promise;
    grantExists = true; history.push('grant acknowledged');
  }));
  await started.promise;
  jest.setSystemTime(Date.now() + 60_001);
  const cleanup = jest.fn(async () => { grantExists = false; history.push('cleanup'); });
  await expect(run(async (guard) => guard.runExclusive(cleanup))).rejects.toMatchObject({ statusCode: 409 });
  expect(cleanup).not.toHaveBeenCalled();
  expect(rows.get('example')?.effect_token).toBeDefined();
  write.resolve(); await first;
  await run(async (guard) => guard.runExclusive(cleanup));
  expect(grantExists).toBe(false);
  expect(history).toEqual(['grant acknowledged', 'cleanup']);
});

it('cannot start an old grant write after another owner has taken over and cleaned up', async () => {
  const started = deferred(); const gate = deferred();
  let grantExists = false;
  const staleGrant = jest.fn(async () => { grantExists = true; });
  const first = run(async (guard) => { started.resolve(); await gate.promise; await guard.runExclusive(staleGrant); });
  const rejected = expect(first).rejects.toMatchObject({ statusCode: 409 });
  await started.promise;
  jest.setSystemTime(Date.now() + 60_001);
  await run(async (guard) => guard.runExclusive(async () => { grantExists = false; }));
  gate.resolve(); await rejected;
  expect(staleGrant).not.toHaveBeenCalled();
  expect(grantExists).toBe(false);
});

it('keeps an uncertain write pinned even if its acknowledgement failed before a late server write', async () => {
  const lateWrite = deferred(); const log = jest.spyOn(console, 'error').mockImplementation(() => {});
  let grantExists = false;
  const lateCompletion = lateWrite.promise.then(() => { grantExists = true; });
  try {
    await expect(run(async (guard) => guard.runExclusive(async () => {
      throw new Error('connection lost after dispatch');
    }))).rejects.toMatchObject({ statusCode: 503, code: 'MUTATION_RECOVERY_REQUIRED' });
    jest.setSystemTime(Date.now() + 120_000);
    const cleanup = jest.fn(async () => { grantExists = false; });
    await expect(run(async (guard) => guard.runExclusive(cleanup))).rejects.toMatchObject({ statusCode: 503 });
    expect(cleanup).not.toHaveBeenCalled();
    expect(rows.get('example')?.effect_token).toBeDefined();
    lateWrite.resolve(); await lateCompletion;
    expect(grantExists).toBe(true);
    // Explicit operator recovery is safe only after confirming the old worker
    // and its downstream request have stopped; age alone is never sufficient.
    rows.delete('example');
    await run(async (guard) => guard.runExclusive(cleanup));
    expect(grantExists).toBe(false);
  } finally { log.mockRestore(); }
});

it('does not release a pin if the callback throws while an unawaited write is still outstanding', async () => {
  const started = deferred(); const gate = deferred();
  const first = run(async (guard) => {
    void guard.runExclusive(async () => { started.resolve(); await gate.promise; });
    throw new Error('callback failed');
  });
  const rejected = expect(first).rejects.toThrow('callback failed');
  await started.promise;
  jest.setSystemTime(Date.now() + 60_001);
  await expect(run(async () => {})).rejects.toMatchObject({ statusCode: 409 });
  gate.resolve(); await rejected;
  expect(rows.size).toBe(0);
});

it('rejects takeover if an effect is pinned after the initial stale-lock read', async () => {
  rows.set('example', { _id: 'example', token: 'old-owner', expires_at: new Date(Date.now() - 1) });
  read.mockImplementationOnce(async () => {
    const snapshot = { ...rows.get('example')! };
    rows.get('example')!.effect_token = 'outstanding-write';
    return snapshot;
  });
  const cleanup = jest.fn();
  await expect(run(cleanup)).rejects.toMatchObject({ statusCode: 409 });
  expect(cleanup).not.toHaveBeenCalled();
  expect(rows.get('example')?.token).toBe('old-owner');
  expect(rows.get('example')?.effect_token).toBe('outstanding-write');
});
