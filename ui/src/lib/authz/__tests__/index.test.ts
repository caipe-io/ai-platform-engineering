/**
 * @jest-environment node
 */

// The engine fns must be created INSIDE the factory: index.ts builds its
// singleton engine at module load (before outer consts initialize), so the
// factory cannot reference variables declared after the hoisted imports.
jest.mock("../engines/openfga", () => {
  const check = jest.fn();
  const batchCheck = jest.fn();
  const grant = jest.fn();
  const revoke = jest.fn();
  return {
    __esModule: true,
    createOpenFgaEngine: () => ({ check, batchCheck }),
    createOpenFgaAdmin: () => ({ grant, revoke }),
    describeFgaCheck: jest.fn(),
    getEngineStats: jest.fn(() => ({ circuitState: "closed", cacheSize: 0, cacheHits: 0, cacheMisses: 0, cacheHitRatio: 0 })),
    __mocks: { check, batchCheck, grant, revoke },
  };
});
// Audit is a no-op in tests (Mongo unconfigured).
jest.mock("@/lib/mongodb", () => ({
  getCollection: jest.fn(async () => ({
    findOne: jest.fn(async () => null),
    find: jest.fn(() => ({ toArray: jest.fn(async () => []) })),
  })),
  isMongoDBConfigured: false,
}));

const mockEmitGrantAudit = jest.fn();
jest.mock("../audit", () => {
  const actual = jest.requireActual("../audit");
  return {
    ...actual,
    emitDecisionAudit: jest.fn(),
    emitGrantAudit: (...args: unknown[]) => mockEmitGrantAudit(...args),
  };
});

import * as openfgaEngine from "../engines/openfga";
const { check: mockCheck, batchCheck: mockBatch, grant: mockGrant, revoke: mockRevoke } = (
  openfgaEngine as unknown as { __mocks: { check: jest.Mock; batchCheck: jest.Mock; grant: jest.Mock; revoke: jest.Mock } }
).__mocks;

import {
  authorize,
  authorizeMany,
  authorizeOrThrow,
  filterAccessible,
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

describe("authorizeMany", () => {
  it("delegates to the engine batch", async () => {
    mockBatch.mockResolvedValue(new Map([["a", ALLOW]]));
    const r = await authorizeMany({ type: "user", id: "u" }, "read", "task", ["a"]);
    expect(r.get("a")?.decision).toBe("ALLOW");
    expect(mockBatch).toHaveBeenCalledWith({ type: "user", id: "u" }, "read", "task", ["a"]);
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
