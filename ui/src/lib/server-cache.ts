import "server-only";

import { createHash, randomUUID } from "crypto";
import { createClient, type RedisClientType } from "redis";

export type CachePolicy = {
  namespace: string;
  freshMs: number;
  /** Total lifetime from computation, including the fresh window. */
  staleMs: number;
  maxEntries?: number;
  forceRefresh?: boolean;
};

export type CacheState = "hit" | "stale" | "miss" | "shared";

export type CacheResult<T> = {
  value: T;
  state: CacheState;
  computedAt: number;
};

type CacheEnvelope = {
  computedAt: number;
  value: unknown;
};

type LocalEntry = CacheEnvelope & {
  hardExpiresAt: number;
};

export type CacheMetrics = {
  hits: number;
  stale: number;
  misses: number;
  shared: number;
  loads: number;
  loadFailures: number;
  redisErrors: number;
  circuitOpen: number;
  cacheAgeMsTotal: number;
  cacheAgeSamples: number;
};

const DEFAULT_MAX_ENTRIES = 500;
const DEFAULT_LOAD_CONCURRENCY = 2;
const DEFAULT_LOAD_DEADLINE_MS = 5_000;
const DEFAULT_REDIS_OPERATION_DEADLINE_MS = 1_000;
const DEFAULT_REFRESH_WAIT_DEADLINE_MS = 20_000;
const REDIS_COOLDOWN_MS = 30_000;
const REDIS_LEASE_MS = 15_000;
const REDIS_POLL_MS = 75;
const localEntries = new Map<string, LocalEntry>();
const inFlight = new Map<string, Promise<CacheResult<unknown>>>();
const backgroundRefreshes = new Map<string, Promise<CacheResult<unknown>>>();
const metrics: CacheMetrics = {
  hits: 0,
  stale: 0,
  misses: 0,
  shared: 0,
  loads: 0,
  loadFailures: 0,
  redisErrors: 0,
  circuitOpen: 0,
  cacheAgeMsTotal: 0,
  cacheAgeSamples: 0,
};

let redisClient: RedisClientType | undefined;
let redisUrl: string | undefined;
let redisConnection: Promise<RedisClientType | undefined> | undefined;
let circuitOpenUntil = 0;
let activeLoads = 0;
const loadWaiters: Array<{ resolve: () => void; cancelled: boolean }> = [];

function positiveNumberFromEnv(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

async function withinDeadline<T>(operation: Promise<T>, deadline: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Redis operation deadline exceeded")), deadline);
    timer.unref?.();
    void operation.then(resolve, reject).finally(() => clearTimeout(timer));
  });
}

function canonicalize(value: unknown): unknown {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value instanceof Date) return value.toJSON();

  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nested]) => [key, canonicalize(nested)]),
  );
}

function cacheKey(policy: CachePolicy, key: unknown): string {
  const digest = createHash("sha256").update(JSON.stringify(canonicalize(key))).digest("hex");
  return `caipe:cache:v1:${policy.namespace}:${digest}`;
}

function validatePolicy(policy: CachePolicy): boolean {
  if (!Number.isFinite(policy.freshMs) || !Number.isFinite(policy.staleMs)) {
    throw new Error("Cache TTLs must be finite milliseconds");
  }
  if (policy.freshMs <= 0) return false;
  if (policy.staleMs < policy.freshMs) {
    throw new Error("Cache staleMs must be greater than or equal to freshMs");
  }
  return true;
}

function readEnvelope(raw: string | null): CacheEnvelope | undefined {
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw) as CacheEnvelope;
    if (typeof parsed.computedAt !== "number" || !("value" in parsed)) return undefined;
    return parsed;
  } catch {
    return undefined;
  }
}

function countAge(computedAt: number): void {
  metrics.cacheAgeMsTotal += Math.max(0, Date.now() - computedAt);
  metrics.cacheAgeSamples += 1;
}

function remember(key: string, envelope: CacheEnvelope, staleMs: number, maxEntries: number): void {
  localEntries.delete(key);
  localEntries.set(key, { ...envelope, hardExpiresAt: envelope.computedAt + staleMs });
  while (localEntries.size > maxEntries) localEntries.delete(localEntries.keys().next().value!);
}

function readLocal(key: string, policy: CachePolicy): CacheResult<unknown> | undefined {
  const entry = localEntries.get(key);
  if (!entry) return undefined;
  const now = Date.now();
  if (entry.hardExpiresAt <= now || entry.computedAt + policy.staleMs <= now) {
    localEntries.delete(key);
    return undefined;
  }
  localEntries.delete(key);
  localEntries.set(key, entry);
  const state: CacheState = now - entry.computedAt < policy.freshMs ? "hit" : "stale";
  metrics[state === "hit" ? "hits" : "stale"] += 1;
  countAge(entry.computedAt);
  return { value: entry.value, state, computedAt: entry.computedAt };
}

async function getRedis(): Promise<RedisClientType | undefined> {
  const configuredUrl = process.env.CAIPE_CACHE_REDIS_URL;
  if (!configuredUrl || Date.now() < circuitOpenUntil) {
    if (configuredUrl && Date.now() < circuitOpenUntil) metrics.circuitOpen += 1;
    return undefined;
  }
  if (redisClient && redisUrl === configuredUrl && redisClient.isOpen) return redisClient;
  if (redisConnection && redisUrl === configuredUrl) return redisConnection;
  redisUrl = configuredUrl;
  const connection = (async (): Promise<RedisClientType | undefined> => {
    let candidate: RedisClientType | undefined;
    try {
      if (redisClient?.isOpen) await redisClient.close();
      candidate = createClient({ url: configuredUrl, socket: { connectTimeout: 1_000, reconnectStrategy: false } });
      candidate.on("error", () => undefined);
      await withinDeadline(candidate.connect(), positiveNumberFromEnv("CAIPE_CACHE_REDIS_OPERATION_DEADLINE_MS", DEFAULT_REDIS_OPERATION_DEADLINE_MS));
      redisClient = candidate;
      return candidate;
    } catch {
      metrics.redisErrors += 1;
      circuitOpenUntil = Date.now() + REDIS_COOLDOWN_MS;
      if (candidate?.isOpen) candidate.destroy();
      if (redisClient?.isOpen) redisClient.destroy();
      redisClient = undefined;
      return undefined;
    }
  })();
  redisConnection = connection;
  try {
    return await connection;
  } finally {
    if (redisConnection === connection) redisConnection = undefined;
  }
}

async function redisOperation<T>(operation: (client: RedisClientType) => Promise<T>): Promise<T | undefined> {
  const client = await getRedis();
  if (!client) return undefined;
  try {
    const deadline = positiveNumberFromEnv("CAIPE_CACHE_REDIS_OPERATION_DEADLINE_MS", DEFAULT_REDIS_OPERATION_DEADLINE_MS);
    return await withinDeadline(operation(client), deadline);
  } catch {
    metrics.redisErrors += 1;
    circuitOpenUntil = Date.now() + REDIS_COOLDOWN_MS;
    if (redisClient === client) redisClient = undefined;
    if (client.isOpen) client.destroy();
    return undefined;
  }
}

async function readRedis(key: string, policy: CachePolicy): Promise<CacheResult<unknown> | undefined> {
  const raw = await redisOperation<string | null>((client) =>
    client.get(key).then((value) => (typeof value === "string" ? value : null)),
  );
  const envelope = readEnvelope(typeof raw === "string" ? raw : null);
  if (!envelope) return undefined;
  const age = Date.now() - envelope.computedAt;
  if (age >= policy.staleMs) return undefined;
  remember(key, envelope, policy.staleMs, policy.maxEntries ?? DEFAULT_MAX_ENTRIES);
  const state: CacheState = age < policy.freshMs ? "hit" : "stale";
  metrics[state === "hit" ? "hits" : "stale"] += 1;
  countAge(envelope.computedAt);
  return { value: envelope.value, state, computedAt: envelope.computedAt };
}

async function acquireLoadSlot(): Promise<void> {
  const limit = positiveNumberFromEnv("CAIPE_CACHE_LOAD_CONCURRENCY", DEFAULT_LOAD_CONCURRENCY);
  const deadline = Date.now() + positiveNumberFromEnv("CAIPE_CACHE_LOAD_DEADLINE_MS", DEFAULT_LOAD_DEADLINE_MS);
  while (activeLoads >= limit) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error("Cache loader queue deadline exceeded");
    await new Promise<void>((resolve, reject) => {
      const waiter = { resolve: () => undefined, cancelled: false };
      const timer = setTimeout(() => {
        waiter.cancelled = true;
        const index = loadWaiters.indexOf(waiter);
        if (index >= 0) loadWaiters.splice(index, 1);
        reject(new Error("Cache loader queue deadline exceeded"));
      }, remaining);
      waiter.resolve = () => {
        clearTimeout(timer);
        resolve();
      };
      loadWaiters.push(waiter);
    });
  }
  activeLoads += 1;
}

function releaseLoadSlot(): void {
  activeLoads -= 1;
  let waiter = loadWaiters.shift();
  while (waiter?.cancelled) waiter = loadWaiters.shift();
  waiter?.resolve();
}

async function load<T>(loader: () => Promise<T>): Promise<T> {
  await acquireLoadSlot();
  metrics.loads += 1;
  try {
    return await loader();
  } catch (error) {
    metrics.loadFailures += 1;
    throw error;
  } finally {
    releaseLoadSlot();
  }
}

async function acquireLease(leaseKey: string, token: string): Promise<boolean | undefined> {
  const result = await redisOperation((client) => client.set(leaseKey, token, { NX: true, PX: REDIS_LEASE_MS }));
  return result === undefined ? undefined : result === "OK";
}

async function publishWithLease(key: string, leaseKey: string, token: string, envelope: CacheEnvelope, staleMs: number): Promise<boolean> {
  const payload = JSON.stringify(envelope);
  const result = await redisOperation((client) =>
    client.eval(
      "if redis.call('GET', KEYS[2]) == ARGV[1] then redis.call('SET', KEYS[1], ARGV[2], 'PX', ARGV[3]); redis.call('DEL', KEYS[2]); return 1 end; return 0",
      { keys: [key, leaseKey], arguments: [token, payload, String(staleMs)] },
    ),
  );
  return result === 1;
}

async function releaseLease(leaseKey: string, token: string): Promise<void> {
  await redisOperation((client) =>
    client.eval("if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) end; return 0", {
      keys: [leaseKey],
      arguments: [token],
    }),
  );
}

async function renewLease(leaseKey: string, token: string): Promise<boolean> {
  const result = await redisOperation((client) =>
    client.eval(
      "if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('PEXPIRE', KEYS[1], ARGV[2]) end; return 0",
      { keys: [leaseKey], arguments: [token, String(REDIS_LEASE_MS)] },
    ),
  );
  return result === 1;
}

async function waitForPublishedValue(key: string, policy: CachePolicy): Promise<CacheResult<unknown> | undefined> {
  const deadline = Date.now() + positiveNumberFromEnv("CAIPE_CACHE_REFRESH_WAIT_DEADLINE_MS", DEFAULT_REFRESH_WAIT_DEADLINE_MS);
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, REDIS_POLL_MS));
    const entry = await readRedis(key, policy);
    if (entry?.state === "hit") return entry;
  }
  return undefined;
}

async function refresh<T>(key: string, policy: CachePolicy, loader: () => Promise<T>, useLease: boolean): Promise<CacheResult<T>> {
  const leaseKey = `${key}:lease`;
  const token = randomUUID();
  const lease = useLease ? await acquireLease(leaseKey, token) : undefined;
  if (lease === false) {
    const published = await waitForPublishedValue(key, policy);
    if (published) return published as CacheResult<T>;
    throw new Error("Cache refresh is still in progress");
  }

  let ownsLease = lease === true;
  const renewal = ownsLease
    ? setInterval(() => {
        void renewLease(leaseKey, token).then((renewed) => {
          ownsLease &&= renewed;
        });
      }, Math.floor(REDIS_LEASE_MS / 3))
    : undefined;
  try {
    const value = JSON.parse(JSON.stringify(await load(loader))) as T;
    const envelope: CacheEnvelope = { value, computedAt: Date.now() };
    const published = ownsLease ? await publishWithLease(key, leaseKey, token, envelope, policy.staleMs) : false;
    if (useLease && lease && !published) throw new Error("Cache refresh lease was lost before publish");
    if (!useLease || lease === undefined || published) {
      remember(key, envelope, policy.staleMs, policy.maxEntries ?? DEFAULT_MAX_ENTRIES);
    }
    return { value, state: "miss", computedAt: envelope.computedAt };
  } finally {
    if (renewal) clearInterval(renewal);
    if (ownsLease) await releaseLease(leaseKey, token);
  }
}

export async function getOrLoad<T>(policy: CachePolicy, key: unknown, loader: () => Promise<T>): Promise<CacheResult<T>> {
  if (!validatePolicy(policy)) {
    return { value: await load(loader), state: "miss", computedAt: Date.now() };
  }
  const keyName = cacheKey(policy, key);
  const existing = inFlight.get(keyName);
  if (existing) {
    metrics.shared += 1;
    const result = await existing;
    return { ...result, state: "shared" } as CacheResult<T>;
  }

  const operation = (async (): Promise<CacheResult<T>> => {
    const local = policy.forceRefresh ? undefined : readLocal(keyName, policy);
    if (local?.state === "hit") return local as CacheResult<T>;
    const remote = policy.forceRefresh ? undefined : await readRedis(keyName, policy);
    if (remote?.state === "hit") return remote as CacheResult<T>;
    const stale = local?.state === "stale" ? local : remote?.state === "stale" ? remote : undefined;
    const redisAvailable = Boolean(await getRedis());
    if (stale) {
      if (!backgroundRefreshes.has(keyName)) {
        const refreshPromise = refresh(keyName, policy, loader, redisAvailable).finally(() => backgroundRefreshes.delete(keyName));
        backgroundRefreshes.set(keyName, refreshPromise as Promise<CacheResult<unknown>>);
        void refreshPromise.catch(() => undefined);
      }
      return stale as CacheResult<T>;
    }
    const background = backgroundRefreshes.get(keyName);
    if (background) {
      metrics.shared += 1;
      const result = await background;
      return { ...result, state: "shared" } as CacheResult<T>;
    }
    metrics.misses += 1;
    return refresh(keyName, policy, loader, redisAvailable);
  })();
  inFlight.set(keyName, operation as Promise<CacheResult<unknown>>);
  try {
    return await operation;
  } finally {
    inFlight.delete(keyName);
  }
}

export function getCacheMetrics(): CacheMetrics {
  return { ...metrics };
}

export async function resetServerCacheForTests(): Promise<void> {
  localEntries.clear();
  inFlight.clear();
  backgroundRefreshes.clear();
  activeLoads = 0;
  loadWaiters.splice(0).forEach((waiter) => waiter.resolve());
  Object.assign(metrics, {
    hits: 0,
    stale: 0,
    misses: 0,
    shared: 0,
    loads: 0,
    loadFailures: 0,
    redisErrors: 0,
    circuitOpen: 0,
    cacheAgeMsTotal: 0,
    cacheAgeSamples: 0,
  } satisfies CacheMetrics);
  circuitOpenUntil = 0;
  redisConnection = undefined;
  if (redisClient?.isOpen) await redisClient.close();
  redisClient = undefined;
  redisUrl = undefined;
}
