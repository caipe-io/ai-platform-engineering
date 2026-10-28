/** @jest-environment node */
import { claimSecondaryIdentity, SecondaryIdentityClaimConflict } from "../secondary-identity-store";
const mockCollection = { createIndex: jest.fn(), insertOne: jest.fn(), findOne: jest.fn() };
jest.mock("@/lib/mongodb", () => ({ getCollection: async () => mockCollection }));
beforeEach(() => { jest.resetAllMocks(); });
it("requires a unique canonical-subject index before reserving a binding", async () => {
  await claimSecondaryIdentity("identity-key", "canonical-user");
  expect(mockCollection.createIndex).toHaveBeenCalledWith({ subject: 1 }, { unique: true, name: "secondary_auth_subject_unique" });
  expect(mockCollection.insertOne).toHaveBeenCalledWith(expect.objectContaining({ _id: "identity-key", subject: "canonical-user" }));
});
it("fails closed if uniqueness cannot be established", async () => {
  mockCollection.createIndex.mockRejectedValue(new Error("database unavailable"));
  await expect(claimSecondaryIdentity("key", "user")).rejects.toThrow("database unavailable");
  expect(mockCollection.insertOne).not.toHaveBeenCalled();
});
it("permits retries of exactly the same binding", async () => {
  mockCollection.insertOne.mockRejectedValue({ code: 11000 });
  mockCollection.findOne.mockResolvedValue({ subject: "user" });
  await expect(claimSecondaryIdentity("key", "user")).resolves.toBeUndefined();
});
it.each([null, { subject: "different-user" }])("rejects identity or subject reassignment %j", async existing => {
  mockCollection.insertOne.mockRejectedValue({ code: 11000 });
  mockCollection.findOne.mockResolvedValue(existing);
  await expect(claimSecondaryIdentity("key", "user")).rejects.toBeInstanceOf(SecondaryIdentityClaimConflict);
});
