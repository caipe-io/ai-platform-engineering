/**
 * @jest-environment node
 *
 * CAS reconcileTupleDiff fail-closed behavior (grant/revoke mutations).
 */

const mockWriteOpenFgaTupleDiff = jest.fn();
const mockIsOpenFgaReconciliationEnabled = jest.fn();
const mockEmitReconcileAudit = jest.fn();
const mockInvalidateDecisionCache = jest.fn();
const mockReadTuples = jest.fn();
const mockDeleteExact = jest.fn();
const mockIsConfigured = jest.fn();

jest.mock("@/lib/rbac/openfga", () => ({
  writeOpenFgaTupleDiff: (...args: unknown[]) => mockWriteOpenFgaTupleDiff(...args),
  isOpenFgaReconciliationEnabled: () => mockIsOpenFgaReconciliationEnabled(),
  isOpenFgaConfigured: () => mockIsConfigured(),
  readOpenFgaTuples: (...args: unknown[]) => mockReadTuples(...args),
  deleteExactOpenFgaTuples: (...args: unknown[]) => mockDeleteExact(...args),
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
  purgeConversationRelationships,
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
  mockIsConfigured.mockReturnValue(true);
  mockReadTuples.mockReset().mockResolvedValue({ tuples: [] });
  mockDeleteExact.mockReset().mockResolvedValue({ enabled: true, writes: 0, deletes: 1 });
});

describe('purgeConversationRelationships', () => {
  const key = { object: 'conversation:example', user: 'team:example#member', relation: 'reader' };
  it('enumerates exact stored userset keys with bounded reads and monotonic deletion', async () => {
    mockReadTuples.mockResolvedValueOnce({ tuples: [{ key }], continuationToken: 'old-cursor' });
    expect(await purgeConversationRelationships('example')).toBe(true);
    expect(mockReadTuples).toHaveBeenCalledTimes(2);
    for (const [options] of mockReadTuples.mock.calls) expect(options).toEqual({
      tuple: { object: key.object }, pageSize: 100, signal: expect.any(AbortSignal),
    });
    expect(mockDeleteExact).toHaveBeenCalledWith([key], { monotonic: true, timeoutMs: 5000 });
    expect(mockInvalidateDecisionCache).toHaveBeenCalled();
  });
  it('returns pending after ten pages without scanning the entire tuple store', async () => {
    mockReadTuples.mockResolvedValue({ tuples: [{ key }], continuationToken: 'more' });
    expect(await purgeConversationRelationships('example')).toBe(false);
    expect(mockReadTuples).toHaveBeenCalledTimes(10); expect(mockDeleteExact).toHaveBeenCalledTimes(10);
  });
  it('invalidates cached grants after a partial failure and retains an error audit', async () => {
    mockReadTuples.mockResolvedValueOnce({ tuples: [{ key }] });
    mockDeleteExact.mockRejectedValueOnce(new Error('Write timed out'));
    await expect(purgeConversationRelationships('example')).rejects.toThrow('Write timed out');
    expect(mockInvalidateDecisionCache).toHaveBeenCalledTimes(1);
    expect(mockEmitReconcileAudit).toHaveBeenCalledWith({ writes: [], deletes: [key] }, expect.anything(),
      { source: 'conversation_purge' }, expect.objectContaining({ outcome: 'error' }));
  });
  it('never deletes tuples returned for another resource', async () => {
    mockReadTuples.mockResolvedValueOnce({ tuples: [{ key: { ...key, object: 'conversation:other' } }] });
    await expect(purgeConversationRelationships('example')).rejects.toThrow('Unexpected resource');
    expect(mockDeleteExact).not.toHaveBeenCalled();
  });
  it('supports installations without OpenFGA but fails closed when configured reconciliation is disabled', async () => {
    mockIsConfigured.mockReturnValue(false); expect(await purgeConversationRelationships('example')).toBe(true);
    mockIsConfigured.mockReturnValue(true); mockIsOpenFgaReconciliationEnabled.mockReturnValue(false);
    await expect(purgeConversationRelationships('example')).rejects.toThrow(OpenFgaReconcileRequiredError);
  });
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

  it("does not invalidate cache when the filtered diff is a no-op", async () => {
    mockWriteOpenFgaTupleDiff.mockResolvedValue({ enabled: true, writes: 0, deletes: 0 });

    await reconcileTupleDiff({ writes: [sampleWrite], deletes: [] });

    expect(mockInvalidateDecisionCache).not.toHaveBeenCalled();
    expect(mockEmitReconcileAudit).not.toHaveBeenCalled();
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
