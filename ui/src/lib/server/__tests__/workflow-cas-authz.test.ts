/**
 * @jest-environment node
 */

const mockAuthorize = jest.fn();
const mockAuthorizeMany = jest.fn();
const mockEmitDecisionAudit = jest.fn();

jest.mock("@/lib/authz", () => ({
  authorize: (...a: unknown[]) => mockAuthorize(...a),
  authorizeMany: (...a: unknown[]) => mockAuthorizeMany(...a),
}));

jest.mock("@/lib/authz/audit", () => ({
  emitDecisionAudit: (...a: unknown[]) => mockEmitDecisionAudit(...a),
}));

import {
  filterAccessibleWorkflowConfigs,
  requireWorkflowAccess,
  requireWorkflowRunAccess,
  workflowSubjectFromSession,
  workflowAccessAllowed,
} from "../workflow-cas-authz";

const ALLOW = { decision: "ALLOW", reason: "OK", retriable: false };
const DENY = { decision: "DENY", reason: "NO_CAPABILITY", retriable: false };
const session = { sub: "alice", org: "acme" };

beforeEach(() => jest.clearAllMocks());

describe("workflowAccessAllowed", () => {
  it("returns false (no PDP call) when there is no subject", async () => {
    expect(await workflowAccessAllowed({}, "wf-1", "read")).toBe(false);
    expect(mockAuthorize).not.toHaveBeenCalled();
  });

  it("allows org admins without a per-workflow check", async () => {
    mockAuthorize.mockResolvedValueOnce(ALLOW); // org-admin check
    expect(await workflowAccessAllowed(session, "wf-1", "read")).toBe(true);
    expect(mockAuthorize).toHaveBeenCalledTimes(1);
    expect(mockAuthorize).toHaveBeenCalledWith(
      expect.objectContaining({ resource: { type: "organization", id: "caipe" }, action: "manage" }),
      expect.anything(),
    );
  });

  it("falls back to the per-workflow task check for non-admins", async () => {
    mockAuthorize
      .mockResolvedValueOnce(DENY) // not org admin
      .mockResolvedValueOnce(ALLOW); // task#read allowed
    expect(await workflowAccessAllowed(session, "wf-1", "read")).toBe(true);
    expect(mockAuthorize).toHaveBeenLastCalledWith(
      expect.objectContaining({ resource: { type: "task", id: "wf-1" }, action: "read" }),
      expect.anything(),
    );
  });

  it("returns false when both org-admin and task checks deny", async () => {
    mockAuthorize.mockResolvedValue(DENY);
    expect(await workflowAccessAllowed(session, "wf-1", "delete")).toBe(false);
  });

  it("graphs a service-account caller and tolerates a missing org", async () => {
    mockAuthorize.mockResolvedValueOnce(DENY).mockResolvedValueOnce(ALLOW);
    expect(await workflowAccessAllowed({ sub: "bot", isServiceAccount: true }, "wf-1", "read")).toBe(true);
    expect(mockAuthorize).toHaveBeenCalledWith(
      expect.objectContaining({ subject: { type: "service_account", id: "bot" } }),
      expect.anything(),
    );
  });
});

describe("requireWorkflowAccess", () => {
  it("throws 401 (NO_SUBJECT) when subject is missing", async () => {
    await expect(requireWorkflowAccess({}, "wf-1", "read")).rejects.toMatchObject({ statusCode: 401 });
  });

  it("throws 403 with a clean code (no task#read leak) on deny", async () => {
    mockAuthorize.mockResolvedValue(DENY);
    await expect(requireWorkflowAccess(session, "wf-1", "read")).rejects.toMatchObject({
      statusCode: 403,
      code: "WORKFLOW_FORBIDDEN",
      reason: "forbidden",
    });
  });

  it("resolves when access is allowed", async () => {
    mockAuthorize.mockResolvedValueOnce(DENY).mockResolvedValueOnce(ALLOW);
    await expect(requireWorkflowAccess(session, "wf-1", "read")).resolves.toBeUndefined();
  });

  it("throws 503 instead of 403 when CAS is unavailable", async () => {
    mockAuthorize.mockResolvedValue({ decision: "DENY", reason: "AUTHZ_UNAVAILABLE", retriable: true });
    await expect(requireWorkflowAccess(session, "wf-1", "read")).rejects.toMatchObject({
      statusCode: 503,
      code: "AUTHZ_UNAVAILABLE",
    });
  });
});

describe("filterAccessibleWorkflowConfigs", () => {
  const configs = [{ _id: "wf-a" }, { _id: "wf-b" }, { _id: "wf-c" }];
  const getId = (c: { _id: string }) => c._id;

  it("returns everything for org admins (one batched call avoided)", async () => {
    mockAuthorize.mockResolvedValueOnce(ALLOW); // org admin
    const out = await filterAccessibleWorkflowConfigs(session, configs, getId, "read");
    expect(out).toEqual(configs);
    expect(mockAuthorizeMany).not.toHaveBeenCalled();
  });

  it("does not let the org-admin bypass restore an unreconciled workflow", async () => {
    mockAuthorize.mockResolvedValueOnce(ALLOW);
    const pendingConfigs = [
      { _id: "wf-ready", authz_sync_state: "ready", authz_revision: 2, authz_last_synced_revision: 2 },
      { _id: "wf-pending", authz_sync_state: "pending", authz_revision: 3, authz_last_synced_revision: 2 },
    ];

    const out = await filterAccessibleWorkflowConfigs(
      session,
      pendingConfigs,
      getId,
      "read",
    );

    expect(out).toEqual([pendingConfigs[0]]);
    expect(mockAuthorizeMany).not.toHaveBeenCalled();
  });

  it("filters non-admins to the accessible subset via one batch call", async () => {
    mockAuthorize.mockResolvedValueOnce(DENY); // not admin
    mockAuthorizeMany.mockResolvedValue(
      new Map([
        ["wf-a", ALLOW],
        ["wf-b", DENY],
        ["wf-c", ALLOW],
      ]),
    );
    const out = await filterAccessibleWorkflowConfigs(session, configs, getId, "read");
    expect(out).toEqual([{ _id: "wf-a" }, { _id: "wf-c" }]);
    expect(mockAuthorizeMany).toHaveBeenCalledWith(
      { type: "user", id: "alice" },
      "read",
      "task",
      ["wf-a", "wf-b", "wf-c"],
      expect.anything(),
    );
  });

  it("throws 503 when any batch decision is unavailable", async () => {
    mockAuthorize.mockResolvedValueOnce(DENY); // not admin
    mockAuthorizeMany.mockResolvedValue(
      new Map([
        ["wf-a", ALLOW],
        ["wf-b", { decision: "DENY", reason: "AUTHZ_UNAVAILABLE", retriable: true }],
      ]),
    );
    await expect(filterAccessibleWorkflowConfigs(session, configs, getId, "read")).rejects.toMatchObject({
      statusCode: 503,
      code: "AUTHZ_UNAVAILABLE",
    });
  });

  it("returns [] when there is no subject", async () => {
    expect(await filterAccessibleWorkflowConfigs({}, configs, getId)).toEqual([]);
  });

  it("returns [] for an empty config list without consulting the PDP", async () => {
    expect(await filterAccessibleWorkflowConfigs(session, [], getId)).toEqual([]);
    expect(mockAuthorize).not.toHaveBeenCalled();
  });
});

describe("requireWorkflowRunAccess", () => {
  const ownedRun = {
    _id: "run-1",
    workflow_config_id: "wf-1",
    owner_subject: { type: "user" as const, id: "alice" },
  };
  const otherRun = {
    _id: "run-2",
    workflow_config_id: "wf-2",
    owner_subject: { type: "user" as const, id: "bob" },
  };

  it("allows the persisted run owner without a config-level check", async () => {
    await expect(requireWorkflowRunAccess(session, ownedRun, "resume")).resolves.toBeUndefined();
    expect(mockAuthorize).not.toHaveBeenCalled();
  });

  it("audits owner-scoped workflow run reads that bypass config-level CAS", async () => {
    await expect(requireWorkflowRunAccess(session, ownedRun, "read")).resolves.toBeUndefined();

    expect(mockAuthorize).not.toHaveBeenCalled();
    expect(mockEmitDecisionAudit).toHaveBeenCalledWith(
      { type: "user", id: "alice" },
      { type: "task", id: "wf-1" },
      "read",
      { decision: "ALLOW", reason: "OK", retriable: false, via: "workflow_run_owner" },
      { tenantId: "acme" },
      { workflowRunId: "run-1" },
    );
  });

  it("denies non-owner non-admin access to owner-scoped runs without falling back to workflow access", async () => {
    mockAuthorize.mockResolvedValueOnce(DENY); // not org-admin
    await expect(requireWorkflowRunAccess(session, otherRun, "read")).rejects.toMatchObject({
      statusCode: 403,
      code: "WORKFLOW_RUN_FORBIDDEN",
    });
    // Only the org-admin check fires; no per-workflow-config CAS call
    expect(mockAuthorize).toHaveBeenCalledTimes(1);
    expect(mockAuthorize).toHaveBeenCalledWith(
      expect.objectContaining({ resource: { type: "organization", id: "caipe" }, action: "manage" }),
      expect.anything(),
    );
  });

  it("allows org-admins to read any run regardless of sharing settings", async () => {
    mockAuthorize.mockResolvedValueOnce(ALLOW); // org-admin
    await expect(requireWorkflowRunAccess(session, otherRun, "read")).resolves.toBeUndefined();
    expect(mockEmitDecisionAudit).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      "read",
      expect.objectContaining({ via: "workflow_run_org_admin" }),
      expect.anything(),
      expect.anything(),
    );
  });

  it("allows org-admins to cancel/delete any run", async () => {
    mockAuthorize.mockResolvedValue(ALLOW); // org-admin
    await expect(requireWorkflowRunAccess(session, otherRun, "cancel")).resolves.toBeUndefined();
    await expect(requireWorkflowRunAccess(session, otherRun, "delete")).resolves.toBeUndefined();
  });

  it("audits non-owner denials for owner-scoped workflow runs", async () => {
    mockAuthorize.mockResolvedValueOnce(DENY); // not org-admin
    await expect(requireWorkflowRunAccess(session, otherRun, "read")).rejects.toMatchObject({
      statusCode: 403,
      code: "WORKFLOW_RUN_FORBIDDEN",
    });

    expect(mockEmitDecisionAudit).toHaveBeenCalledWith(
      { type: "user", id: "alice" },
      { type: "task", id: "wf-2" },
      "read",
      {
        decision: "DENY",
        reason: "NO_CAPABILITY",
        retriable: false,
        via: "workflow_run_owner_mismatch",
      },
      { tenantId: "acme" },
      { workflowRunId: "run-2" },
    );
  });

  it("maps legacy run reads to workflow read when no owner subject was stored", async () => {
    const legacyRun = { _id: "run-legacy", workflow_config_id: "wf-2" };
    mockAuthorize.mockResolvedValueOnce(DENY).mockResolvedValueOnce(ALLOW);
    await expect(requireWorkflowRunAccess(session, legacyRun, "read")).resolves.toBeUndefined();
    expect(mockAuthorize).toHaveBeenLastCalledWith(
      expect.objectContaining({ resource: { type: "task", id: "wf-2" }, action: "read" }),
      expect.anything(),
    );
  });

  it("maps legacy resume/cancel/update checks to workflow write", async () => {
    const legacyRun = { _id: "run-legacy", workflow_config_id: "wf-2" };
    mockAuthorize.mockResolvedValueOnce(DENY).mockResolvedValueOnce(ALLOW);
    await expect(requireWorkflowRunAccess(session, legacyRun, "cancel")).resolves.toBeUndefined();
    expect(mockAuthorize).toHaveBeenLastCalledWith(
      expect.objectContaining({ resource: { type: "task", id: "wf-2" }, action: "write" }),
      expect.anything(),
    );
  });

  it("maps legacy run deletion to workflow delete", async () => {
    const legacyRun = { _id: "run-legacy", workflow_config_id: "wf-2" };
    mockAuthorize.mockResolvedValueOnce(DENY).mockResolvedValueOnce(ALLOW);
    await expect(requireWorkflowRunAccess(session, legacyRun, "delete")).resolves.toBeUndefined();
    expect(mockAuthorize).toHaveBeenLastCalledWith(
      expect.objectContaining({ resource: { type: "task", id: "wf-2" }, action: "delete" }),
      expect.anything(),
    );
  });
});

describe("workflowSubjectFromSession", () => {
  it("extracts the stable owner subject persisted on workflow runs", () => {
    expect(workflowSubjectFromSession({ sub: "alice", isServiceAccount: false })).toEqual({
      type: "user",
      id: "alice",
    });
    expect(workflowSubjectFromSession({ sub: "bot", isServiceAccount: true })).toEqual({
      type: "service_account",
      id: "bot",
    });
  });
});

describe("requireWorkflowRunAccess — shared_with visibility", () => {
  const bobRun = {
    _id: "run-bob",
    workflow_config_id: "wf-1",
    owner_subject: { type: "user" as const, id: "bob" },
  };

  it("allows any authenticated non-admin to read when shared_with=workspace", async () => {
    const sharedRun = { ...bobRun, shared_with: "workspace" as const };
    mockAuthorize.mockResolvedValueOnce(DENY); // not org-admin
    await expect(requireWorkflowRunAccess(session, sharedRun, "read")).resolves.toBeUndefined();
    expect(mockEmitDecisionAudit).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      "read",
      expect.objectContaining({ via: "workflow_run_shared_workspace" }),
      expect.anything(),
      expect.anything(),
    );
  });

  it("blocks non-owner non-admins from write/delete even when shared_with=workspace", async () => {
    const sharedRun = { ...bobRun, shared_with: "workspace" as const };
    mockAuthorize.mockResolvedValue(DENY); // not org-admin
    await expect(requireWorkflowRunAccess(session, sharedRun, "write")).rejects.toMatchObject({
      statusCode: 403,
      code: "WORKFLOW_RUN_FORBIDDEN",
    });
    mockAuthorize.mockResolvedValue(DENY);
    await expect(requireWorkflowRunAccess(session, sharedRun, "delete")).rejects.toMatchObject({
      statusCode: 403,
      code: "WORKFLOW_RUN_FORBIDDEN",
    });
  });

  it("blocks non-owner reads when shared_with=private (or unset)", async () => {
    mockAuthorize.mockResolvedValueOnce(DENY); // not org-admin
    const privateRun = { ...bobRun, shared_with: "private" as const };
    await expect(requireWorkflowRunAccess(session, privateRun, "read")).rejects.toMatchObject({
      statusCode: 403,
      code: "WORKFLOW_RUN_FORBIDDEN",
    });
    // null / undefined defaults to "private"
    mockAuthorize.mockResolvedValueOnce(DENY);
    await expect(requireWorkflowRunAccess(session, { ...bobRun }, "read")).rejects.toMatchObject({
      statusCode: 403,
      code: "WORKFLOW_RUN_FORBIDDEN",
    });
  });

  it("throws 503 when CAS is unavailable during the org-admin check", async () => {
    mockAuthorize.mockResolvedValueOnce({ decision: "DENY", reason: "AUTHZ_UNAVAILABLE", retriable: true });
    await expect(requireWorkflowRunAccess(session, bobRun, "read")).rejects.toMatchObject({
      statusCode: 503,
      code: "AUTHZ_UNAVAILABLE",
    });
  });
});
