/**
 * @jest-environment node
 */

// The engine fns must be created INSIDE the factory: index.ts builds its
// singleton engine at module load (before outer consts initialize), so the
// factory cannot reference variables declared after the hoisted imports.
jest.mock("../engines/openfga", () => {
  const check = jest.fn();
  const batchCheck = jest.fn();
  const listObjects = jest.fn();
  const grant = jest.fn();
  const revoke = jest.fn();
  return {
    __esModule: true,
    createOpenFgaEngine: () => ({ check, batchCheck, listObjects }),
    createOpenFgaAdmin: () => ({ grant, revoke }),
    describeFgaCheck: jest.fn(),
    getEngineStats: jest.fn(() => ({ circuitState: "closed", cacheSize: 0, cacheHits: 0, cacheMisses: 0, cacheHitRatio: 0 })),
    __mocks: { check, batchCheck, listObjects, grant, revoke },
  };
});
// Audit is a no-op in tests (Mongo unconfigured).
jest.mock("@/lib/mongodb", () => ({ getCollection: jest.fn(), isMongoDBConfigured: false }));

const mockEmitGrantAudit = jest.fn();
const mockEmitDecisionAudit = jest.fn();
const mockEmitBatchDecisionAudit = jest.fn();
const mockEmitListObjectsDecisionAudit = jest.fn();
jest.mock("../audit", () => {
  const actual = jest.requireActual("../audit");
  return {
    ...actual,
    emitDecisionAudit: (...args: unknown[]) => mockEmitDecisionAudit(...args),
    emitBatchDecisionAudit: (...args: unknown[]) => mockEmitBatchDecisionAudit(...args),
    emitListObjectsDecisionAudit: (...args: unknown[]) => mockEmitListObjectsDecisionAudit(...args),
    emitGrantAudit: (...args: unknown[]) => mockEmitGrantAudit(...args),
  };
});

import * as openfgaEngine from "../engines/openfga";
const { check: mockCheck, batchCheck: mockBatch, listObjects: mockListObjects, grant: mockGrant, revoke: mockRevoke } = (
  openfgaEngine as unknown as {
    __mocks: { check: jest.Mock; batchCheck: jest.Mock; listObjects: jest.Mock; grant: jest.Mock; revoke: jest.Mock };
  }
).__mocks;

import {
  authorize,
  authorizeMany,
  authorizeOrThrow,
  filterAccessible,
  listAccessible,
  grant,
  revoke,
  AuthzDeniedError,
  describeFgaCheck,
  getEngineStats,
  type AuthorizeResult,
} from "../index";

const ALLOW: AuthorizeResult = { decision: "ALLOW", reason: "OK", retriable: false };
const DENY: AuthorizeResult = { decision: "DENY", reason: "NO_CAPABILITY", retriable: false };

beforeEach(() => jest.clearAllMocks());

describe("authorize", () => {
  it("returns the engine's decision", async () => {
    mockCheck.mockResolvedValue(ALLOW);
    const r = await authorize({ subject: { type: "user", id: "u" }, resource: { type: "agent", id: "a" }, action: "use" });
    expect(r.decision).toBe("ALLOW");
  });
});

describe("authorizeOrThrow", () => {
  it("resolves on ALLOW", async () => {
    mockCheck.mockResolvedValue(ALLOW);
    await expect(
      authorizeOrThrow({ subject: { type: "user", id: "u" }, resource: { type: "agent", id: "a" }, action: "use" }),
    ).resolves.toBeUndefined();
  });
  it("throws AuthzDeniedError on DENY", async () => {
    mockCheck.mockResolvedValue(DENY);
    await expect(
      authorizeOrThrow({ subject: { type: "user", id: "u" }, resource: { type: "agent", id: "a" }, action: "use" }),
    ).rejects.toBeInstanceOf(AuthzDeniedError);
  });
});

describe("filterAccessible", () => {
  it("returns only the ALLOWed ids", async () => {
    mockBatch.mockResolvedValue(new Map([["a", ALLOW], ["b", DENY], ["c", ALLOW]]));
    const out = await filterAccessible({ type: "user", id: "u" }, "discover", "agent", ["a", "b", "c"]);
    expect(out).toEqual(["a", "c"]);
  });
  it("short-circuits an empty id list without calling the engine", async () => {
    const out = await filterAccessible({ type: "user", id: "u" }, "discover", "agent", []);
    expect(out).toEqual([]);
    expect(mockBatch).not.toHaveBeenCalled();
  });
});

describe("listAccessible", () => {
  // Above LIST_OBJECTS_MIN_CANDIDATES (100, the API's own page-size cap) —
  // only a candidate list this large exercises the real list-objects path.
  const manyIds = Array.from({ length: 101 }, (_, i) => `id-${i}`);

  beforeEach(() => {
    mockListObjects.mockClear();
    mockBatch.mockClear();
    mockEmitDecisionAudit.mockClear();
    mockEmitBatchDecisionAudit.mockClear();
    mockEmitListObjectsDecisionAudit.mockClear();
  });

  describe("above the threshold — real list-objects lookup", () => {
    it("intersects the PDP's accessible set with the candidate ids — one PDP call regardless of candidate count", async () => {
      mockListObjects.mockResolvedValue({ ids: new Set(["id-0", "id-2", "id-999"]), reason: "OK" });
      const { accessible, reason } = await listAccessible({ type: "user", id: "u" }, "discover", "agent", manyIds);
      expect(reason).toBe("OK");
      expect(accessible).toEqual(["id-0", "id-2"]);
      expect(mockListObjects).toHaveBeenCalledTimes(1);
      expect(mockListObjects).toHaveBeenCalledWith({ type: "user", id: "u" }, "discover", "agent");
      expect(mockBatch).not.toHaveBeenCalled();
    });

    it("fails closed (empty) and surfaces the reason when the PDP is unavailable", async () => {
      mockListObjects.mockResolvedValue({ ids: new Set(manyIds), reason: "AUTHZ_UNAVAILABLE" });
      const { accessible, reason } = await listAccessible({ type: "user", id: "u" }, "discover", "agent", manyIds);
      expect(reason).toBe("AUTHZ_UNAVAILABLE");
      // Empty even though the (irrelevant, stale) ids Set is non-empty — the
      // caller must not read a PDP outage as "these are accessible".
      expect(accessible).toEqual([]);
    });

    it("audits the lookup exactly once, passing the raw accessible set and candidate list through", async () => {
      mockListObjects.mockResolvedValue({ ids: new Set(["id-0"]), reason: "OK" });
      await listAccessible({ type: "user", id: "u" }, "discover", "agent", manyIds);
      expect(mockEmitListObjectsDecisionAudit).toHaveBeenCalledTimes(1);
      expect(mockEmitListObjectsDecisionAudit).toHaveBeenCalledWith(
        { type: "user", id: "u" },
        "discover",
        "agent",
        manyIds,
        new Set(["id-0"]),
        "OK",
        {},
      );
    });
  });

  describe("at/below the threshold — falls back to authorizeMany's per-candidate batch", () => {
    it("checks candidates directly instead of expanding the subject's whole accessible set", async () => {
      mockBatch.mockResolvedValue(new Map([["a", ALLOW], ["b", DENY], ["c", ALLOW]]));
      const { accessible, reason } = await listAccessible(
        { type: "user", id: "u" },
        "discover",
        "agent",
        ["a", "b", "c"],
      );
      expect(reason).toBe("OK");
      expect(accessible).toEqual(["a", "c"]);
      expect(mockBatch).toHaveBeenCalledTimes(1);
      expect(mockBatch).toHaveBeenCalledWith({ type: "user", id: "u" }, "discover", "agent", ["a", "b", "c"]);
      expect(mockListObjects).not.toHaveBeenCalled();
      // authorizeMany already audits this as its own batch row.
      expect(mockEmitListObjectsDecisionAudit).not.toHaveBeenCalled();
    });

    it("preserves candidates that independently resolved to ALLOW, even if another candidate's check was unavailable", async () => {
      // Matches plain per-candidate check semantics (and pre-existing
      // filterResourcesByPermission behavior): one candidate's transient PDP
      // failure must not hide another candidate that already resolved.
      mockBatch.mockResolvedValue(
        new Map([
          ["a", ALLOW],
          ["b", { decision: "DENY" as const, reason: "AUTHZ_UNAVAILABLE" as const, retriable: true }],
        ]),
      );
      const { accessible, reason } = await listAccessible({ type: "user", id: "u" }, "discover", "agent", ["a", "b"]);
      expect(reason).toBe("AUTHZ_UNAVAILABLE");
      expect(accessible).toEqual(["a"]);
    });

    it("exactly at the threshold (100) still uses the per-candidate batch, not list-objects", async () => {
      const ids = Array.from({ length: 100 }, (_, i) => `id-${i}`);
      mockBatch.mockResolvedValue(new Map(ids.map((id) => [id, ALLOW])));
      await listAccessible({ type: "user", id: "u" }, "discover", "agent", ids);
      expect(mockBatch).toHaveBeenCalledTimes(1);
      expect(mockListObjects).not.toHaveBeenCalled();
    });
  });

  it("short-circuits an empty candidate list without calling the engine", async () => {
    const { accessible, reason } = await listAccessible({ type: "user", id: "u" }, "discover", "agent", []);
    expect(accessible).toEqual([]);
    expect(reason).toBe("OK");
    expect(mockListObjects).not.toHaveBeenCalled();
    expect(mockBatch).not.toHaveBeenCalled();
    expect(mockEmitListObjectsDecisionAudit).not.toHaveBeenCalled();
  });
});

describe("authorizeMany", () => {
  beforeEach(() => {
    mockEmitDecisionAudit.mockClear();
    mockEmitBatchDecisionAudit.mockClear();
  });

  it("delegates to the engine batch", async () => {
    mockBatch.mockResolvedValue(new Map([["a", ALLOW]]));
    const r = await authorizeMany({ type: "user", id: "u" }, "read", "task", ["a"]);
    expect(r.get("a")?.decision).toBe("ALLOW");
    expect(mockBatch).toHaveBeenCalledWith({ type: "user", id: "u" }, "read", "task", ["a"]);
  });

  it("audits the whole filter as one event, not one per id", async () => {
    const ids = Array.from({ length: 50 }, (_, i) => `agent-${i}`);
    mockBatch.mockResolvedValue(new Map(ids.map((id) => [id, DENY])));

    await authorizeMany({ type: "user", id: "u" }, "discover", "agent", ids);

    // The regression this guards: 50 ids used to mean 50 audit rows.
    expect(mockEmitBatchDecisionAudit).toHaveBeenCalledTimes(1);
    expect(mockEmitDecisionAudit).not.toHaveBeenCalled();
    const [, action, resourceType, results] = mockEmitBatchDecisionAudit.mock.calls[0];
    expect(action).toBe("discover");
    expect(resourceType).toBe("agent");
    expect((results as Map<string, unknown>).size).toBe(50);
  });

  it("filterAccessible inherits the single-event audit", async () => {
    mockBatch.mockResolvedValue(
      new Map([
        ["a", ALLOW],
        ["b", DENY],
      ]),
    );

    const out = await filterAccessible({ type: "user", id: "u" }, "discover", "agent", ["a", "b"]);

    expect(out).toEqual(["a"]);
    expect(mockEmitBatchDecisionAudit).toHaveBeenCalledTimes(1);
  });
});

describe("grant / revoke (PAP)", () => {
  const ctx = { caller: { type: "user" as const, id: "alice" }, tenantId: "acme", correlationId: "c-1" };

  beforeEach(() => {
    mockEmitGrantAudit.mockClear();
  });

  it("grant delegates to the admin engine and emits audit", async () => {
    const intent = { resource: { type: "agent" as const, id: "pe" }, grantee: { type: "team" as const, id: "eng" }, capability: "use" as const };
    await grant(intent, ctx);
    expect(mockGrant).toHaveBeenCalledWith(intent);
    expect(mockEmitGrantAudit).toHaveBeenCalledWith("grant", intent, ctx, { outcome: "success" });
  });
  it("revoke delegates to the admin engine and emits audit", async () => {
    const intent = { resource: { type: "agent" as const, id: "pe" }, grantee: { type: "everyone" as const }, capability: "use" as const };
    await revoke(intent, ctx);
    expect(mockRevoke).toHaveBeenCalledWith(intent);
    expect(mockEmitGrantAudit).toHaveBeenCalledWith("revoke", intent, ctx, { outcome: "success" });
  });
  it("emits error audit when the PDP write fails", async () => {
    const intent = { resource: { type: "agent" as const, id: "pe" }, grantee: { type: "team" as const, id: "eng" }, capability: "use" as const };
    mockGrant.mockRejectedValueOnce(new Error("OpenFGA write failed"));
    await expect(grant(intent, ctx)).rejects.toThrow("OpenFGA write failed");
    expect(mockEmitGrantAudit).toHaveBeenCalledWith("grant", intent, ctx, {
      outcome: "error",
      reasonCode: "PDP_WRITE_FAILED",
    });
  });
  it("emits error audit when revoke PDP write fails", async () => {
    const intent = { resource: { type: "agent" as const, id: "pe" }, grantee: { type: "team" as const, id: "eng" }, capability: "use" as const };
    mockRevoke.mockRejectedValueOnce(new Error("OpenFGA write failed"));
    await expect(revoke(intent, ctx)).rejects.toThrow("OpenFGA write failed");
    expect(mockEmitGrantAudit).toHaveBeenCalledWith("revoke", intent, ctx, {
      outcome: "error",
      reasonCode: "PDP_WRITE_FAILED",
    });
  });
});

describe("re-exports", () => {
  it("surfaces describeFgaCheck and getEngineStats from the engine", () => {
    expect(describeFgaCheck).toBeDefined();
    expect(getEngineStats).toBeDefined();
    expect(getEngineStats()).toMatchObject({ circuitState: "closed" });
  });
});
