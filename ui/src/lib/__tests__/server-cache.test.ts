/** @jest-environment node */

import { getCacheMetrics, getOrLoad, resetServerCacheForTests } from "@/lib/server-cache";

const policy = { namespace: "insights:test", freshMs: 100, staleMs: 500 };

describe("server cache", () => {
  beforeEach(async () => {
    delete process.env.CAIPE_CACHE_REDIS_URL;
    delete process.env.CAIPE_CACHE_LOAD_CONCURRENCY;
    delete process.env.CAIPE_CACHE_LOAD_DEADLINE_MS;
    await resetServerCacheForTests();
  });

  afterEach(() => jest.restoreAllMocks());

  it("uses deterministic keys for object key order", async () => {
    const loader = jest.fn().mockResolvedValue({ answer: 42 });
    await getOrLoad(policy, { b: 2, a: 1 }, loader);
    const result = await getOrLoad(policy, { a: 1, b: 2 }, loader);

    expect(loader).toHaveBeenCalledTimes(1);
    expect(result.state).toBe("hit");
  });

  it("coalesces local concurrent loads", async () => {
    let resolveLoader: (value: { answer: number }) => void;
    const loader = jest.fn(
      () => new Promise<{ answer: number }>((resolve) => { resolveLoader = resolve; }),
    );
    const first = getOrLoad(policy, "same", loader);
    const second = getOrLoad(policy, "same", loader);
    await new Promise(setImmediate);
    resolveLoader!({ answer: 42 });

    expect((await first).state).toBe("miss");
    expect((await second).state).toBe("shared");
    expect(loader).toHaveBeenCalledTimes(1);
  });

  it("serves a stale snapshot while refreshing", async () => {
    const now = jest.spyOn(Date, "now");
    now.mockReturnValue(1_000);
    await getOrLoad(policy, "stale", async () => ({ answer: 1 }));
    now.mockReturnValue(1_101);
    const loader = jest.fn().mockResolvedValue({ answer: 2 });

    const stale = await getOrLoad(policy, "stale", loader);
    expect(stale).toMatchObject({ value: { answer: 1 }, state: "stale" });
    await Promise.resolve();
    await Promise.resolve();
    now.mockReturnValue(1_102);
    expect((await getOrLoad(policy, "stale", loader)).value).toEqual({ answer: 2 });
  });

  it("keeps one background refresh while stale callers continue", async () => {
    const now = jest.spyOn(Date, "now");
    now.mockReturnValue(1_000);
    await getOrLoad(policy, "single-refresh", async () => ({ answer: 1 }));
    now.mockReturnValue(1_101);
    let resolveLoader: (value: { answer: number }) => void;
    const loader = jest.fn(() => new Promise<{ answer: number }>((resolve) => { resolveLoader = resolve; }));

    expect((await getOrLoad(policy, "single-refresh", loader)).state).toBe("stale");
    await new Promise(setImmediate);
    expect((await getOrLoad(policy, "single-refresh", loader)).state).toBe("stale");
    expect(loader).toHaveBeenCalledTimes(1);
    resolveLoader!({ answer: 2 });
  });

  it("removes timed-out loader waiters before waking later work", async () => {
    process.env.CAIPE_CACHE_LOAD_CONCURRENCY = "1";
    process.env.CAIPE_CACHE_LOAD_DEADLINE_MS = "20";
    let releaseFirst: (value: { answer: number }) => void;
    const first = getOrLoad(policy, "queue-first", () => new Promise<{ answer: number }>((resolve) => { releaseFirst = resolve; }));
    await new Promise(setImmediate);
    await expect(getOrLoad(policy, "queue-expired", async () => ({ answer: 2 }))).rejects.toThrow("queue deadline");
    const third = getOrLoad(policy, "queue-live", async () => ({ answer: 3 }));
    releaseFirst!({ answer: 1 });

    await expect(first).resolves.toMatchObject({ value: { answer: 1 } });
    await expect(third).resolves.toMatchObject({ value: { answer: 3 } });
  });

  it("bypasses caching when freshMs is disabled", async () => {
    const loader = jest.fn().mockResolvedValue({ answer: 42 });
    await getOrLoad({ ...policy, freshMs: 0, staleMs: 0 }, "disabled", loader);
    await getOrLoad({ ...policy, freshMs: 0, staleMs: 0 }, "disabled", loader);

    expect(loader).toHaveBeenCalledTimes(2);
  });

  it("honors a reduced hard TTL for an existing local snapshot", async () => {
    const now = jest.spyOn(Date, "now");
    now.mockReturnValue(1_000);
    await getOrLoad(policy, "reduced-ttl", async () => ({ answer: 1 }));
    now.mockReturnValue(1_100);

    const result = await getOrLoad({ ...policy, freshMs: 10, staleMs: 50 }, "reduced-ttl", async () => ({ answer: 2 }));

    expect(result).toMatchObject({ value: { answer: 2 }, state: "miss" });
  });

  it("does not retain failed loads", async () => {
    const loader = jest.fn().mockRejectedValueOnce(new Error("example failure")).mockResolvedValue({ answer: 42 });
    await expect(getOrLoad(policy, "failure", loader)).rejects.toThrow("example failure");
    await expect(getOrLoad(policy, "failure", loader)).resolves.toMatchObject({ state: "miss" });
    expect(getCacheMetrics().loadFailures).toBe(1);
  });
});
