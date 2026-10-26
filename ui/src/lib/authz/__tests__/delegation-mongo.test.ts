/** @jest-environment node */
import { randomUUID } from "crypto";
import { MongoClient, type Db } from "mongodb";
import { insertDelegation, readDelegation, revokeDelegationRecord } from "../delegation-store";
import { authorizeDelegated } from "../delegations";
let mockDb: Db;
const mockPermission = jest.fn();
jest.mock("@/lib/mongodb", () => ({ isMongoDBConfigured: true, getCollection: (name: string) => mockDb.collection(name) }));
jest.mock("../engines/openfga", () => ({ checkDelegationPermission: (...args: unknown[]) => mockPermission(...args) }));
jest.mock("../audit", () => ({ emitDelegationAudit: jest.fn() }));
jest.mock("../index", () => ({ authorize: jest.fn() }));

const uri = process.env.CAS_DELEGATION_TEST_MONGODB_URI;
const describeMongo = uri ? describe : describe.skip;
describeMongo("delegation persistence with real MongoDB", () => {
  let primary: MongoClient; let peer: MongoClient; let peerDb: Db;
  const user = { issuer: "https://identity.example.test", subject: { type: "user" as const, id: "test-user" }, clientId: "browser", expiresAt: 10 ** 10 };
  const service = { ...user, subject: { type: "service_account" as const, id: "test-service" }, clientId: "example-service" };
  const intent = { service: { id: "test-service", client_id: "example-service" }, job_id: "test-job",
    scope: [{ resource: { type: "agent" as const, id: "example" }, action: "use" as const }], expires_at: new Date(Date.now() + 3600_000).toISOString() };
  beforeAll(async () => {
    primary = await new MongoClient(uri!).connect(); peer = await new MongoClient(uri!).connect();
    const database = `cas_delegation_test_${randomUUID().replaceAll("-", "")}`;
    mockDb = primary.db(database); peerDb = peer.db(database);
  });
  afterAll(async () => { if (mockDb) await mockDb.dropDatabase(); await primary?.close(); await peer?.close(); });
  beforeEach(() => mockPermission.mockResolvedValue({ decision: "ALLOW", reason: "OK" }));

  it("publishes an approval durably to another connection and retries without duplicates", async () => {
    const id = randomUUID();
    await insertDelegation(user, intent, id);
    expect(await peerDb.collection("access_delegations").findOne({ _id: id as never })).toMatchObject({ user_id: "test-user", version: 1 });
    await Promise.all(Array.from({ length: 8 }, () => insertDelegation(user, intent, id)));
    expect(await peerDb.collection("access_delegations").countDocuments({ _id: id as never })).toBe(1);
  });
  it("does not allow a replay to overwrite scope, owner or revocation", async () => {
    const id = randomUUID(); await insertDelegation(user, intent, id);
    await revokeDelegationRecord(id, user);
    expect(await insertDelegation(user, intent, id)).toMatchObject({ version: 2, revoked_at: expect.any(String) });
    await expect(insertDelegation(user, { ...intent, job_id: "other" }, id)).rejects.toMatchObject({ status: 409 });
    expect(await readDelegation(id)).toMatchObject({ job_id: "test-job", version: 2 });
  });
  it("concurrent revocations are idempotent and visible to another connection", async () => {
    const id = randomUUID(); await insertDelegation(user, intent, id);
    const results = await Promise.all(Array.from({ length: 8 }, () => revokeDelegationRecord(id, user)));
    expect(results.every((record) => record?.version === 2)).toBe(true);
    expect(await peerDb.collection("access_delegations").findOne({ _id: id as never })).toMatchObject({ version: 2 });
    expect(await revokeDelegationRecord(id, { ...user, subject: { type: "user", id: "other-user" } })).toBeNull();
  });
  it("rejects revocation from a different connection while graph checks are in flight", async () => {
    const id = randomUUID(); await insertDelegation(user, intent, id);
    mockPermission.mockImplementationOnce(async () => {
      await peerDb.collection("access_delegations").updateOne({ _id: id as never }, { $set: { revoked_at: new Date().toISOString() }, $inc: { version: 1 } }, { writeConcern: { w: "majority" } });
      return { decision: "ALLOW", reason: "OK" };
    });
    expect(await authorizeDelegated(id, service, { ...intent.scope[0], job_id: "test-job" }, {}))
      .toMatchObject({ decision: "DENY", reason: "DELEGATION_REVOKED" });
  });
});
