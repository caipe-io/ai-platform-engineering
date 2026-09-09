/**
 * @jest-environment node
 *
 * CAS reconcileTupleDiff fail-closed behavior (grant/revoke mutations).
 */

const mockWriteOpenFgaTupleDiff = jest.fn();
const mockIsOpenFgaReconciliationEnabled = jest.fn();
const mockEmitReconcileAudit = jest.fn();
const mockInvalidateDecisionCache = jest.fn();
const mockVerifyOpenFgaTupleDiff = jest.fn();

jest.mock("@/lib/rbac/openfga", () => ({
  writeOpenFgaTupleDiff: (...args: unknown[]) => mockWriteOpenFgaTupleDiff(...args),
  isOpenFgaReconciliationEnabled: () => mockIsOpenFgaReconciliationEnabled(),
  verifyOpenFgaTupleDiff: (...args: unknown[]) => mockVerifyOpenFgaTupleDiff(...args),
}));

jest.mock("../audit", () => ({
  emitReconcileAudit: (...args: unknown[]) => mockEmitReconcileAudit(...args),
}));

jest.mock("../engines/openfga", () => ({
  invalidateDecisionCache: () => mockInvalidateDecisionCache(),
}));

import {
  OpenFgaReconcileRequiredError,
  reconcileTupleDiff,
} from "../reconcile";

const sampleWrite = {
  user: "user:alice",
  relation: "owner",
  object: "mcp_server:mcp-ops",
};

beforeEach(() => {
  jest.clearAllMocks();
  mockIsOpenFgaReconciliationEnabled.mockReturnValue(true);
  mockWriteOpenFgaTupleDiff.mockResolvedValue({ enabled: true, writes: 1, deletes: 0 });
  mockVerifyOpenFgaTupleDiff.mockResolvedValue(undefined);
});

describe("reconcileTupleDiff", () => {
  it("applies writes and invalidates the decision cache on success", async () => {
    const diff = { writes: [sampleWrite], deletes: [] };

    const result = await reconcileTupleDiff(diff, { source: "mcp_server_create" });

    expect(result).toEqual({ enabled: true, writes: 1, deletes: 0 });
    expect(mockWriteOpenFgaTupleDiff).toHaveBeenCalledWith(diff);
    expect(mockInvalidateDecisionCache).toHaveBeenCalledTimes(1);
    expect(mockEmitReconcileAudit).toHaveBeenCalledWith(
      diff,
      result,
      expect.objectContaining({ source: "mcp_server_create" }),
    );
  });

  it("verifies the intended tuple state at higher consistency when requested", async () => {
    const diff = { writes: [sampleWrite], deletes: [] };

    await reconcileTupleDiff(diff, { verifyHigherConsistency: true });

    expect(mockVerifyOpenFgaTupleDiff).toHaveBeenCalledWith(diff);
  });

  it("fails closed when higher-consistency verification fails", async () => {
    mockVerifyOpenFgaTupleDiff.mockRejectedValue(new Error("verification lag"));

    await expect(reconcileTupleDiff(
      { writes: [sampleWrite], deletes: [] },
      { verifyHigherConsistency: true },
    )).rejects.toThrow("verification lag");
  });

  it("does not invalidate cache when the filtered diff is a no-op", async () => {
    mockWriteOpenFgaTupleDiff.mockResolvedValue({ enabled: true, writes: 0, deletes: 0 });

    await reconcileTupleDiff({ writes: [sampleWrite], deletes: [] });

    expect(mockInvalidateDecisionCache).not.toHaveBeenCalled();
  });

  it("throws OpenFgaReconcileRequiredError when reconciliation is disabled but a diff was requested", async () => {
    mockIsOpenFgaReconciliationEnabled.mockReturnValue(false);
    mockWriteOpenFgaTupleDiff.mockResolvedValue({ enabled: false, writes: 0, deletes: 0 });

    await expect(
      reconcileTupleDiff({ writes: [sampleWrite], deletes: [] }),
    ).rejects.toThrow(OpenFgaReconcileRequiredError);

    expect(mockEmitReconcileAudit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ enabled: false }),
      expect.anything(),
      expect.objectContaining({ outcome: "error" }),
    );
  });

  it("allows empty diffs when reconciliation is disabled", async () => {
    mockIsOpenFgaReconciliationEnabled.mockReturnValue(false);
    mockWriteOpenFgaTupleDiff.mockResolvedValue({ enabled: false, writes: 0, deletes: 0 });

    const result = await reconcileTupleDiff({ writes: [], deletes: [] });

    expect(result).toEqual({ enabled: false, writes: 0, deletes: 0 });
  });

  it("rethrows PDP write failures and records an error audit event", async () => {
    mockWriteOpenFgaTupleDiff.mockRejectedValue(new Error("OpenFGA unavailable"));

    await expect(
      reconcileTupleDiff({ writes: [sampleWrite], deletes: [] }, { source: "team_resources" }),
    ).rejects.toThrow("OpenFGA unavailable");

    expect(mockEmitReconcileAudit).toHaveBeenCalledWith(
      expect.anything(),
      { enabled: true, writes: 0, deletes: 0 },
      expect.objectContaining({ source: "team_resources" }),
      expect.objectContaining({ outcome: "error", reasonCode: "OpenFGA unavailable" }),
    );
    expect(mockInvalidateDecisionCache).not.toHaveBeenCalled();
  });
});
