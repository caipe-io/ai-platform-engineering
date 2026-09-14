/**
 * @jest-environment node
 */

const mockWrite = jest.fn();
const mockGetAuditBackend = jest.fn(() => ({ write: mockWrite }));

jest.mock("@/lib/audit", () => ({
  getAuditBackend: () => mockGetAuditBackend(),
}));

import {
  buildDecisionEvent,
  buildGrantEvent,
  emitDecisionAudit,
  emitGrantAudit,
  emitReconcileAudit,
} from "../audit";

const subject = { type: "user" as const, id: "alice" };
const resource = { type: "agent" as const, id: "platform-engineer" };

beforeEach(() => {
  jest.clearAllMocks();
  mockGetAuditBackend.mockReturnValue({ write: mockWrite });
});

describe("buildDecisionEvent — UnifiedAuditEvent conformance", () => {
  it("maps decision→outcome and builds resource_ref the tab renders", () => {
    const e = buildDecisionEvent(subject, resource, "use", { decision: "DENY", reason: "NO_CAPABILITY", retriable: false });
    expect(e).toMatchObject({
      type: "cas_decision",
      outcome: "deny", // tab reads `outcome`, not `decision`
      action: "use",
      resource_ref: "agent:platform-engineer", // tab reads `resource_ref`
      resource_type: "agent",
      resource_id: "platform-engineer",
      reason_code: "NO_CAPABILITY",
      pdp: "openfga",
      source: "cas",
      component: "cas",
      subject_ref: "user:alice",
    });
    expect(e.subject_hash).toMatch(/^sha256:/);
    expect(e.subject_hash).not.toContain("alice"); // salted, not raw
  });

  it("maps ALLOW→allow and carries tenant + correlation + trace from context", () => {
    const e = buildDecisionEvent(subject, resource, "use", { decision: "ALLOW", reason: "OK", retriable: false }, {
      tenantId: "acme",
      correlationId: "corr-1",
      traceId: "t-1",
      spanId: "s-1",
    });
    expect(e).toMatchObject({ outcome: "allow", tenant_id: "acme", correlation_id: "corr-1", trace_id: "t-1", span_id: "s-1" });
  });

  it("records decision path and trusted workflow run context when present", () => {
    const e = buildDecisionEvent(
      subject,
      resource,
      "use",
      { decision: "ALLOW", reason: "OK", retriable: false, via: "tuple" },
      { correlationId: "wfrun-20260611200000-abc" },
      { workflowRunId: "wfrun-20260611200000-abc" },
    );

    expect(e).toMatchObject({
      outcome: "allow",
      decision_via: "tuple",
      workflow_run_id: "wfrun-20260611200000-abc",
    });
  });

  it("defaults tenant to 'default' and omits trace fields when absent", () => {
    const e = buildDecisionEvent(subject, resource, "read", { decision: "ALLOW", reason: "OK", retriable: false });
    expect(e.tenant_id).toBe("default");
    expect(e.trace_id).toBeUndefined();
    expect(e.span_id).toBeUndefined();
  });
});

describe("emitDecisionAudit", () => {
  it("writes the event through the audit backend", () => {
    emitDecisionAudit(subject, resource, "use", { decision: "ALLOW", reason: "OK", retriable: false });
    expect(mockWrite).toHaveBeenCalledTimes(1);
    expect(mockWrite.mock.calls[0][0]).toMatchObject({ type: "cas_decision", outcome: "allow" });
  });

  it("swallows backend lookup failures (never throws into the decision path)", () => {
    mockGetAuditBackend.mockImplementationOnce(() => {
      throw new Error("audit-service down");
    });
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
    expect(() => emitDecisionAudit(subject, resource, "use", { decision: "DENY", reason: "NO_CAPABILITY", retriable: false })).not.toThrow();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});

const grantIntent = {
  resource: { type: "agent" as const, id: "platform-engineer" },
  grantee: { type: "team" as const, id: "eng" },
  capability: "use" as const,
};
const caller = { type: "user" as const, id: "alice" };

describe("buildGrantEvent — policy-change audit conformance", () => {
  it("records caller, grantee, resource, capability, operation, outcome, and context", () => {
    const e = buildGrantEvent("grant", grantIntent, {
      caller,
      tenantId: "acme",
      correlationId: "corr-grant-1",
      traceId: "t-2",
    });
    expect(e).toMatchObject({
      type: "cas_grant",
      tenant_id: "acme",
      correlation_id: "corr-grant-1",
      subject_ref: "user:alice",
      actor_ref: "user:alice",
      caller_ref: "user:alice",
      grantee_ref: "team:eng",
      action: "use",
      operation: "grant",
      outcome: "success",
      resource_ref: "agent:platform-engineer",
      resource_type: "agent",
      resource_id: "platform-engineer",
      component: "cas",
      pdp: "openfga",
      source: "cas",
      trace_id: "t-2",
    });
    expect(e.subject_hash).toMatch(/^sha256:/);
    expect(e.actor_hash).toBe(e.subject_hash);
    expect(e.subject_hash).not.toContain("alice");
  });

  it("maps everyone grantee to user:*", () => {
    const e = buildGrantEvent("revoke", {
      ...grantIntent,
      grantee: { type: "everyone" },
    }, { caller, correlationId: "c-1" });
    expect(e).toMatchObject({ operation: "revoke", grantee_ref: "user:*", outcome: "success" });
  });

  it("records failed attempts with error outcome and reason_code", () => {
    const e = buildGrantEvent("grant", grantIntent, { caller, tenantId: "acme" }, {
      outcome: "error",
      reasonCode: "NO_CAPABILITY",
    });
    expect(e).toMatchObject({
      outcome: "error",
      reason_code: "NO_CAPABILITY",
      operation: "grant",
      caller_ref: "user:alice",
    });
  });

  it("requires ctx.caller", () => {
    expect(() => buildGrantEvent("grant", grantIntent, {})).toThrow(/ctx\.caller/);
  });
});

describe("emitGrantAudit", () => {
  it("writes cas_grant when caller is present", async () => {
    await emitGrantAudit("grant", grantIntent, { caller, tenantId: "acme", correlationId: "c-1" });
    expect(mockWrite).toHaveBeenCalledTimes(1);
    expect(mockWrite.mock.calls[0][0]).toMatchObject({
      type: "cas_grant",
      caller_ref: "user:alice",
      operation: "grant",
      outcome: "success",
    });
  });

  it("is a no-op without caller (never writes anonymous policy changes)", async () => {
    await emitGrantAudit("grant", grantIntent, { tenantId: "acme" });
    expect(mockWrite).not.toHaveBeenCalled();
  });

  it("persists failed attempts when outcome is error", async () => {
    await emitGrantAudit("revoke", grantIntent, { caller }, { outcome: "error", reasonCode: "PDP_WRITE_FAILED" });
    expect(mockWrite.mock.calls[0][0]).toMatchObject({
      outcome: "error",
      reason_code: "PDP_WRITE_FAILED",
      operation: "revoke",
    });
  });

  it("swallows backend lookup failures (never throws into the grant path)", async () => {
    mockGetAuditBackend.mockImplementationOnce(() => {
      throw new Error("audit-service down");
    });
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
    await expect(
      emitGrantAudit("grant", grantIntent, { caller }, { outcome: "error", reasonCode: "NO_CAPABILITY" }),
    ).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledWith("[cas/audit] Failed to enqueue audit event:", expect.any(Error));
    warn.mockRestore();
  });
});

describe("emitReconcileAudit", () => {
  it("does not record a successful reconcile when OpenFGA applies no changes", () => {
    emitReconcileAudit(
      { writes: [{ user: "user:alice" }], deletes: [] },
      { enabled: true, writes: 0, deletes: 0 },
      { source: "config_seed" },
    );

    expect(mockWrite).not.toHaveBeenCalled();
  });

  it("records applied and requested tuple counts with the human caller", () => {
    emitReconcileAudit(
      { writes: [{ user: "user:alice" }], deletes: [{ user: "user:bob" }] },
      { enabled: true, writes: 1, deletes: 1 },
      {
        caller,
        source: "team_resources",
        tenantId: "acme",
        correlationId: "reconcile-1",
        traceId: "trace-1",
      },
    );

    expect(mockWrite).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "cas_reconcile",
        source: "cas",
        reconcile_scope: "team_resources",
        action: "reconcile",
        resource_ref: "authorization_policy:openfga_relationship_tuples",
        resource_type: "authorization_policy",
        resource_id: "openfga_relationship_tuples",
        requested_writes: 1,
        requested_deletes: 1,
        writes: 1,
        deletes: 1,
        subject_ref: "user:alice",
        actor_ref: "user:alice",
        caller_ref: "user:alice",
        tenant_id: "acme",
        correlation_id: "reconcile-1",
        trace_id: "trace-1",
      }),
    );
  });

  it("uses a readable, sanitized system actor without a fabricated hash", () => {
    emitReconcileAudit(
      { writes: [], deletes: [{ user: "user:alice" }] },
      { enabled: true, writes: 0, deletes: 1 },
      { source: " Config Seed / Restart " },
      { outcome: "error", reasonCode: "PDP_WRITE_FAILED" },
    );

    const event = mockWrite.mock.calls[0][0];
    expect(event).toMatchObject({
      source: "cas",
      reconcile_scope: "Config Seed / Restart",
      subject_ref: "system:config-seed-restart",
      actor_ref: "system:config-seed-restart",
      requested_writes: 0,
      requested_deletes: 1,
      writes: 0,
      deletes: 1,
      outcome: "error",
      reason_code: "PDP_WRITE_FAILED",
    });
    expect(event.subject_hash).toBeUndefined();
    expect(event.actor_hash).toBeUndefined();
    expect(event.caller_ref).toBeUndefined();
  });

  it("preserves a service-account caller as a service-account principal", () => {
    emitReconcileAudit(
      { writes: [{ user: "service_account:reconciler" }], deletes: [] },
      { enabled: true, writes: 1, deletes: 0 },
      { caller: { type: "service_account", id: "reconciler" } },
    );

    const event = mockWrite.mock.calls[0][0];
    expect(event).toMatchObject({
      reconcile_scope: "cas-reconciler",
      subject_ref: "service_account:reconciler",
      actor_ref: "service_account:reconciler",
      caller_ref: "service_account:reconciler",
    });
    expect(event.subject_hash).toMatch(/^sha256:/);
    expect(event.actor_hash).toBe(event.subject_hash);
  });
});
