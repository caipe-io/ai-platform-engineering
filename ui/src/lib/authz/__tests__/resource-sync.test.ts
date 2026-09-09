import {
  authzRevisionFilter,
  authzSyncPreCheck,
  currentAuthzRevision,
  hasActiveAuthzSync,
  nextAuthzRevision,
  runRevisionedAuthzSync,
} from "../resource-sync";

describe("revisioned authorization sync", () => {
  it("treats legacy documents as revision zero", () => {
    expect(currentAuthzRevision({})).toBe(0);
    expect(nextAuthzRevision({})).toBe(1);
    expect(authzRevisionFilter({})).toEqual({ authz_revision: { $exists: false } });
  });

  it("fails data access closed for pending and error revisions", () => {
    expect(authzSyncPreCheck({ authz_sync_state: "pending" })).toMatchObject({
      decision: "DENY",
      reason: "AUTHZ_SYNC_PENDING",
      retriable: true,
    });
    expect(authzSyncPreCheck({ authz_sync_state: "error" })).toMatchObject({
      decision: "DENY",
      reason: "AUTHZ_SYNC_ERROR",
      retriable: true,
    });
    expect(authzSyncPreCheck({
      authz_sync_state: "ready",
      authz_revision: 2,
      authz_last_synced_revision: 1,
    })).toMatchObject({
      decision: "DENY",
      reason: "AUTHZ_SYNC_ERROR",
    });
    expect(authzSyncPreCheck({
      authz_sync_state: "ready",
      authz_revision: 2,
      authz_last_synced_revision: 2,
    })).toBeNull();
    expect(authzSyncPreCheck({})).toBeNull();
  });

  it("only treats a recent pending revision as an active concurrent update", () => {
    const now = Date.parse("2026-09-08T08:00:00.000Z");
    expect(hasActiveAuthzSync({
      authz_sync_state: "pending",
      authz_sync_started_at: "2026-09-08T07:59:30.000Z",
    }, now)).toBe(true);
    expect(hasActiveAuthzSync({
      authz_sync_state: "pending",
      authz_sync_started_at: "2026-09-08T07:50:00.000Z",
    }, now)).toBe(false);
  });

  it("marks a reconciled revision ready", async () => {
    const order: string[] = [];
    const result = await runRevisionedAuthzSync({
      reconcile: async () => { order.push("reconcile"); },
      markReady: async () => { order.push("ready"); return { state: "ready" }; },
      markError: async () => { order.push("error"); },
    });
    expect(result).toEqual({ state: "ready" });
    expect(order).toEqual(["reconcile", "ready"]);
  });

  it("records a sanitized error state when reconciliation fails", async () => {
    const markError = jest.fn(async () => undefined);
    await expect(runRevisionedAuthzSync({
      reconcile: async () => { throw new Error("secret endpoint details"); },
      markReady: async () => ({ state: "ready" }),
      markError,
    })).rejects.toThrow("secret endpoint details");
    expect(markError).toHaveBeenCalledWith("OPENFGA_RECONCILIATION_FAILED");
  });
});
