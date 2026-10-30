/** @jest-environment node */
import { MongoServerError } from "mongodb";
import { ApiError } from "@/lib/api-error";
const mockInsert = jest.fn();
const mockDelete = jest.fn();
jest.mock("@/lib/mongodb", () => ({ getCollection: async () => ({ insertOne: mockInsert, deleteOne: mockDelete }) }));
import { withWebexIdentityWriteLock } from "../webex-identity-write-lock";
beforeEach(() => { jest.resetAllMocks(); });
test("retains its lock when a remote save outcome is uncertain", async () => {
  await expect(withWebexIdentityWriteLock(async () => { throw new Error("Save failed"); })).rejects.toThrow("Save failed");
  expect(mockDelete).not.toHaveBeenCalled();
});
test("never runs a write when another replica holds the lock", async () => {
  mockInsert.mockRejectedValue(new MongoServerError({ code: 11000, message: "busy" }));
  const write = jest.fn();
  await expect(withWebexIdentityWriteLock(write)).rejects.toMatchObject({ code: "WEBEX_LINK_BUSY" });
  expect(write).not.toHaveBeenCalled();
  expect(mockDelete).not.toHaveBeenCalled();
});


test("releases only its own nonce after a completed save", async () => {
  await withWebexIdentityWriteLock(async () => "saved");
  expect(mockDelete).toHaveBeenCalledWith({ _id: "identity-write", nonce: mockInsert.mock.calls[0][0].nonce });
});

test("safe validation rejection releases the lock", async () => {
  await expect(withWebexIdentityWriteLock(async () => {
    throw new ApiError("conflict", 409, "WEBEX_ID_ALREADY_LINKED");
  })).rejects.toMatchObject({ code: "WEBEX_ID_ALREADY_LINKED" });
  expect(mockDelete).toHaveBeenCalled();
});
