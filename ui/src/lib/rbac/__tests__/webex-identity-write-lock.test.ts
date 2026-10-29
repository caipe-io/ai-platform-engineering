/** @jest-environment node */
import { MongoServerError } from "mongodb";
const mockInsert = jest.fn();
const mockDelete = jest.fn();
jest.mock("@/lib/mongodb", () => ({ getCollection: async () => ({ insertOne: mockInsert, deleteOne: mockDelete }) }));
import { withWebexIdentityWriteLock } from "../webex-identity-write-lock";
beforeEach(() => { jest.resetAllMocks(); });
test("releases only its own nonce even after a failed save", async () => {
  await expect(withWebexIdentityWriteLock(async () => { throw new Error("Save failed"); })).rejects.toThrow("Save failed");
  expect(mockDelete).toHaveBeenCalledWith({ _id: "identity-write", nonce: mockInsert.mock.calls[0][0].nonce });
});
test("never runs a write when another replica holds the lock", async () => {
  mockInsert.mockRejectedValue(new MongoServerError({ code: 11000, message: "busy" }));
  const write = jest.fn();
  await expect(withWebexIdentityWriteLock(write)).rejects.toMatchObject({ code: "WEBEX_LINK_BUSY" });
  expect(write).not.toHaveBeenCalled();
  expect(mockDelete).not.toHaveBeenCalled();
});
