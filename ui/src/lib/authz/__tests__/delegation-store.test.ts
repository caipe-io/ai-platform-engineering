/** @jest-environment node */
import { insertDelegation, readDelegation, revokeDelegationRecord } from "../delegation-store";
const mockFind = jest.fn();
const mockUpdate = jest.fn();
const mockCollection = jest.fn(() => ({ findOne: mockFind, findOneAndUpdate: mockUpdate }));
jest.mock("@/lib/mongodb", () => ({ isMongoDBConfigured: true, getCollection: (...args: unknown[]) => mockCollection(...args) }));
const identity = { issuer: "https://identity.example.test", subject: { type: "user" as const, id: "test-user" }, clientId: "browser", expiresAt: 10 ** 10 };
const intent = { service: { id: "test-service", client_id: "example-service" }, job_id: "test-job",
  scope: [{ resource: { type: "agent" as const, id: "example" }, action: "use" as const }], expires_at: "2026-10-25T12:00:00Z" };
beforeEach(() => { jest.clearAllMocks(); mockUpdate.mockImplementation(async (_filter, change) => change.$setOnInsert); });
it("writes a single immutable approval with unique ID and majority acknowledgement", async () => {
  const record = await insertDelegation(identity, intent, "approval-1");
  expect(record).toMatchObject({ ...intent, user_id: "test-user", issuer: identity.issuer, version: 1, revoked_at: null });
  expect(record._id).toBe("approval-1");
  expect(mockUpdate).toHaveBeenCalledWith({ _id: "approval-1" }, { $setOnInsert: record },
    { upsert: true, returnDocument: "after", writeConcern: { w: "majority" }, timeoutMS: 5000 });
  expect(mockCollection).toHaveBeenCalledWith("access_delegations");
});
it("a replay cannot change scope, owner or expiry, nor undo revocation", async () => {
  mockUpdate.mockResolvedValue({ ...intent, _id: "approval-1", issuer: identity.issuer, user_id: "test-user", version: 2, revoked_at: "now" });
  expect(await insertDelegation(identity, intent, "approval-1")).toMatchObject({ revoked_at: "now", version: 2 });
  await expect(insertDelegation(identity, { ...intent, job_id: "other-job" }, "approval-1")).rejects.toMatchObject({ status: 409 });
  await expect(insertDelegation({ ...identity, subject: { type: "user", id: "other-user" } }, intent, "approval-1")).rejects.toMatchObject({ status: 409 });
});
it("reads primary majority state without a replica-local cache", async () => {
  await readDelegation("example"); await readDelegation("example");
  expect(mockFind).toHaveBeenCalledTimes(2);
  expect(mockFind).toHaveBeenCalledWith({ _id: "example" }, { readPreference: "primary", readConcern: { level: "majority" }, timeoutMS: 5000 });
});
it("atomically binds revocation to owner/issuer and changes the version once", async () => {
  mockUpdate.mockResolvedValue({ ...intent, revoked_at: "now", version: 2 });
  await revokeDelegationRecord("example", identity);
  expect(mockUpdate).toHaveBeenCalledWith({ _id: "example", issuer: identity.issuer, user_id: "test-user", revoked_at: null },
    { $set: { revoked_at: expect.any(String) }, $inc: { version: 1 } },
    { returnDocument: "after", writeConcern: { w: "majority" }, timeoutMS: 5000 });
});
it("a repeated revoke reads the same record without extending expiry or changing scope", async () => {
  mockUpdate.mockResolvedValue(null); mockFind.mockResolvedValue({ ...intent, revoked_at: "now", version: 2 });
  expect(await revokeDelegationRecord("example", identity)).toMatchObject({ version: 2, expires_at: intent.expires_at });
  expect(mockFind).toHaveBeenCalledWith({ _id: "example", issuer: identity.issuer, user_id: "test-user" }, expect.anything());
});
