/** @jest-environment node */

type IndexKeys = Record<string, 1 | -1>;
type IndexOptions = { unique?: boolean; expireAfterSeconds?: number };
const mockCreateIndex = jest.fn<Promise<string>, [string, IndexKeys, IndexOptions]>();
const mockConnect = jest.fn();
const mockAggregate = jest.fn();
const mockDeleteMany = jest.fn();

jest.mock('mongodb', () => ({
  MongoClient: jest.fn().mockImplementation(() => ({
    connect: mockConnect,
    db: () => ({
      collection: (name: string) => ({
        createIndex: (keys: IndexKeys, options: IndexOptions) => mockCreateIndex(name, keys, options),
        aggregate: (...args: unknown[]) => mockAggregate(name, ...args),
        deleteMany: (...args: unknown[]) => mockDeleteMany(name, ...args),
        dropIndex: async () => undefined,
      }),
    }),
  })),
}));

const originalUri = process.env.MONGODB_URI;
const originalDatabase = process.env.MONGODB_DATABASE;
const isUserEmailIndex = (name: string, keys: IndexKeys) => name === 'users' && Object.hasOwn(keys, 'email');

beforeEach(() => {
  jest.resetModules();
  jest.useFakeTimers();
  jest.clearAllMocks();
  process.env.MONGODB_URI = 'mongodb://example.test/indexes';
  process.env.MONGODB_DATABASE = 'example';
  mockConnect.mockReset().mockResolvedValue(undefined);
  mockCreateIndex.mockReset().mockResolvedValue('existing');
  mockAggregate.mockReset().mockReturnValue({ toArray: async () => [] });
  mockDeleteMany.mockReset().mockResolvedValue({ deletedCount: 0 });
  jest.spyOn(console, 'log').mockImplementation(() => undefined);
  jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  jest.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  jest.useRealTimers();
  jest.restoreAllMocks();
  if (originalUri === undefined) delete process.env.MONGODB_URI;
  else process.env.MONGODB_URI = originalUri;
  if (originalDatabase === undefined) delete process.env.MONGODB_DATABASE;
  else process.env.MONGODB_DATABASE = originalDatabase;
});

async function warmup() {
  const api = await import('../mongodb');
  const connection = api.connectToDatabase();
  await jest.runAllTimersAsync();
  await connection;
  return api;
}

it('builds one index per collection at a time while other collections proceed', async () => {
  const active = new Set<string>();
  let peakCollections = 0;
  let overlappingBuilds = 0;
  let completed = 0;
  mockCreateIndex.mockImplementation(async name => {
    if (active.has(name)) {
      overlappingBuilds++;
      throw Object.assign(new Error('Existing index build in progress on the same collection'), { code: 14031 });
    }
    active.add(name);
    peakCollections = Math.max(peakCollections, active.size);
    await new Promise(resolve => setTimeout(resolve, 10));
    active.delete(name);
    completed++;
    return 'created';
  });

  const api = await warmup();
  expect(overlappingBuilds).toBe(0);
  expect(peakCollections).toBeGreaterThan(1);
  expect(completed).toBe(mockCreateIndex.mock.calls.length);
  expect(console.error).not.toHaveBeenCalled();
  await api.connectToDatabase();
  expect(mockConnect).toHaveBeenCalledTimes(1);
  expect(mockCreateIndex).toHaveBeenCalledTimes(completed);
});

it.each([
  { code: 285 }, { code: 12586 }, { code: 14031 },
  { message: 'Existing index build in progress on the same collection. Collection is limited to a single index build at a time.' },
])('retries an index build owned by another replica: %j', async error => {
  let attempts = 0;
  mockCreateIndex.mockImplementation(async (name, keys) => {
    if (isUserEmailIndex(name, keys) && ++attempts <= 2) throw error;
    return 'created';
  });
  await warmup();
  expect(attempts).toBe(3);
  expect(console.error).not.toHaveBeenCalled();
});

it.each([
  [{ code: 14031 }, 6],
  [{ code: 13, message: 'Unauthorized' }, 1],
] as const)('bounds conflict retries and does not retry unrelated failures: %j', async (error, expectedAttempts) => {
  let attempts = 0;
  let laterIndexBuilt = false;
  mockCreateIndex.mockImplementation(async (name, keys) => {
    if (isUserEmailIndex(name, keys)) { attempts++; throw error; }
    if (name === 'users' && Object.hasOwn(keys, 'keycloak_sub')) laterIndexBuilt = true;
    return 'created';
  });
  await warmup();
  expect(attempts).toBe(expectedAttempts);
  expect(laterIndexBuilt).toBe(true);
  expect(console.error).toHaveBeenCalledTimes(1);
});

it('preserves unique and TTL options through queued creation', async () => {
  await warmup();
  expect(mockCreateIndex).toHaveBeenCalledWith('users', { email: 1 }, { unique: true });
  expect(mockCreateIndex).toHaveBeenCalledWith('auth_sessions', { expiresAt: 1 }, { expireAfterSeconds: 0 });
});

it('preserves unique-key recovery and retries build contention after deduplication', async () => {
  let attempts = 0;
  mockCreateIndex.mockImplementation(async (name, keys) => {
    if (isUserEmailIndex(name, keys)) {
      attempts++;
      if (attempts === 1) throw { code: 11000 };
      if (attempts === 2) throw { code: 14031 };
    }
    return 'created';
  });
  mockAggregate.mockReturnValue({ toArray: async () => [
    { _id: { email: 'member@example.test' }, keepId: 'current', count: 2 },
  ] });
  mockDeleteMany.mockResolvedValue({ deletedCount: 1 });
  await warmup();
  expect(attempts).toBe(3);
  expect(mockDeleteMany).toHaveBeenCalledWith('users', { email: 'member@example.test', _id: { $ne: 'current' } });
  expect(console.error).not.toHaveBeenCalled();
});

it.each([85, 86])('preserves handling of existing index conflicts (%s)', async code => {
  let attempts = 0;
  mockCreateIndex.mockImplementation(async (name, keys) => {
    if (isUserEmailIndex(name, keys)) { attempts++; throw { code }; }
    return 'created';
  });
  await warmup();
  expect(attempts).toBe(1);
  expect(mockDeleteMany).not.toHaveBeenCalled();
  expect(console.error).not.toHaveBeenCalled();
});
