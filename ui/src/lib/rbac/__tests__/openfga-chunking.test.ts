/**
 * @jest-environment node
 *
 * Unit tests for OpenFGA write chunking — both the pure
 * `chunkOpenFgaDiff` helper and the chunked `writeOpenFgaTuples`
 * end-to-end with the global `fetch` mocked.
 *
 * Why this matters: OpenFGA's HTTP `Write` API caps each call at 100
 * tuple operations. Identity-group-sync reconciliation for users with
 * 100+ matching group claims (real corporate AD case) was historically
 * blowing past this and leaving Mongo populated with no backing
 * tuples. The chunking + self-compensation here is the load-bearing
 * fix; these tests pin its observable behavior.
 *
 * assisted-by Cursor claude-opus-4-7
 */

import {
  chunkOpenFgaDiff,
  type OpenFgaTupleKey,
  type TeamResourceTupleDiff,
} from "../openfga";

function tuple(i: number, kind: "w" | "d" = "w"): OpenFgaTupleKey {
  return {
    user: `user:u-${kind}-${i}`,
    relation: "member",
    object: `team:t-${kind}-${i}`,
  };
}

function makeDiff(writes: number, deletes: number): TeamResourceTupleDiff {
  return {
    writes: Array.from({ length: writes }, (_, i) => tuple(i, "w")),
    deletes: Array.from({ length: deletes }, (_, i) => tuple(i, "d")),
  };
}

describe("chunkOpenFgaDiff", () => {
  it("returns the same diff in a single chunk when total <= limit", () => {
    const diff = makeDiff(40, 10);
    const chunks = chunkOpenFgaDiff(diff, 100);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toBe(diff);
  });

  it("splits into multiple chunks of <= limit each", () => {
    const diff = makeDiff(250, 0);
    const chunks = chunkOpenFgaDiff(diff, 100);
    expect(chunks).toHaveLength(3);
    expect(chunks[0].writes).toHaveLength(100);
    expect(chunks[1].writes).toHaveLength(100);
    expect(chunks[2].writes).toHaveLength(50);
    // No tuple is dropped or duplicated across chunks.
    const flat = chunks.flatMap((c) => c.writes.map((t) => t.user));
    expect(new Set(flat).size).toBe(250);
  });

  it("counts writes and deletes against the same per-call budget", () => {
    // OpenFGA's 100-op limit applies to writes + deletes combined per
    // Write call. This test pins that behavior so we don't accidentally
    // start sending 100+100 in one chunk.
    const diff = makeDiff(80, 80);
    const chunks = chunkOpenFgaDiff(diff, 100);
    for (const chunk of chunks) {
      expect(chunk.writes.length + chunk.deletes.length).toBeLessThanOrEqual(100);
    }
    // 160 ops with limit 100 → exactly two chunks.
    expect(chunks).toHaveLength(2);
    const totalWrites = chunks.reduce((sum, c) => sum + c.writes.length, 0);
    const totalDeletes = chunks.reduce((sum, c) => sum + c.deletes.length, 0);
    expect(totalWrites).toBe(80);
    expect(totalDeletes).toBe(80);
  });

  it("drains writes before deletes in chunk order (deterministic for tests/logs)", () => {
    const diff = makeDiff(150, 50);
    const chunks = chunkOpenFgaDiff(diff, 100);
    expect(chunks).toHaveLength(2);
    // First chunk: 100 writes, 0 deletes.
    expect(chunks[0].writes).toHaveLength(100);
    expect(chunks[0].deletes).toHaveLength(0);
    // Second chunk: remaining 50 writes + 50 deletes.
    expect(chunks[1].writes).toHaveLength(50);
    expect(chunks[1].deletes).toHaveLength(50);
  });

  it("handles an empty diff as a single empty chunk", () => {
    const diff = makeDiff(0, 0);
    const chunks = chunkOpenFgaDiff(diff, 100);
    expect(chunks).toHaveLength(1);
    expect(chunks[0].writes).toHaveLength(0);
    expect(chunks[0].deletes).toHaveLength(0);
  });
});

describe("writeOpenFgaTuples (chunked + self-compensating)", () => {
  const ORIGINAL_FETCH = global.fetch;
  const ORIGINAL_ENV = { ...process.env };

  beforeEach(() => {
    jest.resetModules();
    process.env.OPENFGA_HTTP = "http://openfga.test";
    process.env.OPENFGA_RECONCILIATION_ENABLED = "true";
    process.env.OPENFGA_STORE_NAME = "caipe-openfga-test";
  });

  afterEach(() => {
    global.fetch = ORIGINAL_FETCH;
    process.env = { ...ORIGINAL_ENV };
  });

  /**
   * Wire a fake `fetch` that:
   *  - GET /stores → returns one matching store (so getOpenFgaStoreId resolves).
   *  - POST .../read → empty tuples (filterTupleDiff uses Read for existence).
   *  - POST .../write → behavior is supplied by the per-test override.
   */
  function mockFetch(writeBehavior: (body: unknown) => Response | Promise<Response>) {
    let writeCallIndex = 0;
    const fetchMock = jest.fn(async (url: string, init?: RequestInit) => {
      const u = String(url);
      if (u.endsWith("/stores") && (!init || init.method === "GET" || !init.method)) {
        return new Response(
          JSON.stringify({ stores: [{ id: "store-id", name: "caipe-openfga-test" }] }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (u.includes("/read")) {
        return new Response(JSON.stringify({ tuples: [] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (u.includes("/check")) {
        return new Response(JSON.stringify({ allowed: false }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (u.includes("/write")) {
        writeCallIndex += 1;
        const body = init?.body ? JSON.parse(String(init.body)) : {};
        const result = await writeBehavior(body);
        return result;
      }
      return new Response("not found", { status: 404 });
    }) as unknown as typeof fetch;
    global.fetch = fetchMock;
    return {
      fetchMock,
      getWriteCallIndex: () => writeCallIndex,
    };
  }

  it("issues a single Write call for diffs <= 100 tuples", async () => {
    // filterTupleDiff drops deletes when Read finds no tuple; mock Read is
    // always empty, so we use a writes-only diff here to focus on chunking.
    const { writeOpenFgaTuples } = await import("../openfga");
    const writeBodies: unknown[] = [];
    mockFetch((body) => {
      writeBodies.push(body);
      return new Response("{}", { status: 200 });
    });
    const result = await writeOpenFgaTuples(makeDiff(50, 0));
    expect(result).toEqual({ enabled: true, writes: 50, deletes: 0 });
    expect(writeBodies).toHaveLength(1);
  });

  it("splits a 250-write diff into three Write calls", async () => {
    const { writeOpenFgaTuples } = await import("../openfga");
    const writeBodies: Array<{ writes?: { tuple_keys: unknown[] }; deletes?: { tuple_keys: unknown[] } }> = [];
    mockFetch((body) => {
      writeBodies.push(body as never);
      return new Response("{}", { status: 200 });
    });
    const result = await writeOpenFgaTuples(makeDiff(250, 0));
    expect(result).toEqual({ enabled: true, writes: 250, deletes: 0 });
    expect(writeBodies).toHaveLength(3);
    const totalWrites = writeBodies.reduce((sum, b) => sum + (b.writes?.tuple_keys.length ?? 0), 0);
    expect(totalWrites).toBe(250);
  });

  it("compensates already-applied chunks when a later chunk fails (entity_limit)", async () => {
    // First two chunks succeed; third throws 400. The function must
    // self-compensate by issuing a delete for the 200 already-applied
    // writes (chunked again to <= 100 per call).
    const { writeOpenFgaTuples } = await import("../openfga");
    const writeBodies: Array<{
      writes?: { tuple_keys: unknown[] };
      deletes?: { tuple_keys: unknown[] };
    }> = [];
    let callIdx = 0;
    mockFetch((body) => {
      writeBodies.push(body as never);
      callIdx += 1;
      if (callIdx === 3) {
        return new Response(
          JSON.stringify({ code: "exceeded_entity_limit" }),
          { status: 400 },
        );
      }
      return new Response("{}", { status: 200 });
    });

    await expect(writeOpenFgaTuples(makeDiff(250, 0))).rejects.toThrow(
      /OpenFGA tuple write failed/,
    );

    // 3 forward chunks (the third failed) + 2 compensation chunks
    // (200 deletes split into 100+100) = 5 total Write calls.
    expect(writeBodies).toHaveLength(5);
    // The compensation calls send DELETES of the same tuples we wrote,
    // not new writes.
    const compensation1 = writeBodies[3];
    const compensation2 = writeBodies[4];
    expect(compensation1.deletes?.tuple_keys).toHaveLength(100);
    expect(compensation2.deletes?.tuple_keys).toHaveLength(100);
    expect(compensation1.writes).toBeUndefined();
    expect(compensation2.writes).toBeUndefined();
  });

  it("logs (but does not throw from) a compensation failure; surfaces the original error", async () => {
    const { writeOpenFgaTuples } = await import("../openfga");
    const consoleErrSpy = jest.spyOn(console, "error").mockImplementation(() => {});
    try {
      let callIdx = 0;
      mockFetch(() => {
        callIdx += 1;
        // Forward call 1 succeeds; call 2 fails (forward); call 3 (the
        // first compensation call) also fails. The function must
        // surface the ORIGINAL forward error and log the compensation
        // failure.
        if (callIdx === 1) return new Response("{}", { status: 200 });
        if (callIdx === 2) {
          return new Response(JSON.stringify({ code: "exceeded_entity_limit" }), {
            status: 400,
          });
        }
        return new Response("compensation failed", { status: 500 });
      });

      await expect(writeOpenFgaTuples(makeDiff(150, 0))).rejects.toThrow(
        /400/, // original forward error
      );

      expect(consoleErrSpy).toHaveBeenCalledWith(
        expect.stringContaining("compensate"),
        expect.objectContaining({ compensationErr: expect.any(Error) }),
      );
    } finally {
      consoleErrSpy.mockRestore();
    }
  });

  it("retains structured validation diagnostics beyond the truncated public message", async () => {
    const { OpenFgaWriteError, writeOpenFgaTuples } = await import("../openfga");
    const message = `Invalid tuple 'document:example/${"x".repeat(220)}#parent@document:example/root'. Relation not found`;
    mockFetch(() => Response.json({ code: "validation_error", message, extra: "not retained" }, { status: 400 }));
    let thrown: unknown;
    try { await writeOpenFgaTuples(makeDiff(1, 0)); } catch (error) { thrown = error; }
    expect(thrown).toBeInstanceOf(OpenFgaWriteError);
    const error = thrown as InstanceType<typeof OpenFgaWriteError>;
    expect(error.status).toBe(400);
    expect(error.details).toEqual({ code: "validation_error", message });
    expect(Object.isFrozen(error.details)).toBe(true);
    expect(error.message).not.toContain("Relation not found");
    expect(error.message.length).toBeLessThanOrEqual("OpenFGA tuple write failed: 400 ".length + 200);
    expect(JSON.parse(JSON.stringify(error))).not.toHaveProperty("details");
    expect({ ...error }).not.toHaveProperty("details");
    const { handleApiError } = await import("@/lib/api-middleware");
    const log = jest.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const apiResponse = handleApiError(error);
      expect(apiResponse.status).toBe(500);
      expect(await apiResponse.json()).toEqual({ success: false, error: error.message });
    } finally {
      log.mockRestore();
    }
  });

  it("bounds retained fields and does not retain arbitrary upstream properties", async () => {
    const { writeOpenFgaTuples } = await import("../openfga");
    mockFetch(() => Response.json({ code: "c".repeat(256), message: "m".repeat(5000), debug: { value: "internal" } }, { status: 400 }));
    await expect(writeOpenFgaTuples(makeDiff(1, 0))).rejects.toMatchObject({
      details: { code: "c".repeat(128), message: "m".repeat(4096) },
    });
  });

  it.each([
    "<html>upstream unavailable</html>", "null", "[]", '"string"', "42",
    JSON.stringify({ code: 400, message: { nested: "not a string" } }),
    JSON.stringify({ debug: "not retained" }),
    JSON.stringify({ message: "x".repeat(17_000) }),
  ])("preserves the typed write failure without structured details for invalid response %#", async (body) => {
    const { OpenFgaWriteError, writeOpenFgaTuples } = await import("../openfga");
    mockFetch(() => new Response(body, { status: 400 }));
    await expect(writeOpenFgaTuples(makeDiff(1, 0))).rejects.toBeInstanceOf(OpenFgaWriteError);
    await expect(writeOpenFgaTuples(makeDiff(1, 0))).rejects.toMatchObject({ status: 400, details: undefined });
  });
});
