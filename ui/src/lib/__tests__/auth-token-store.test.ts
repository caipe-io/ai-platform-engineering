// assisted-by Codex Codex-sonnet-4-6
const mockFindOne = jest.fn();
const mockUpdateOne = jest.fn();
const mockDeleteOne = jest.fn();

jest.mock("../mongodb", () => ({
  isMongoDBConfigured: true,
  getCollection: jest.fn(async () => ({
    findOne: mockFindOne,
    updateOne: mockUpdateOne,
    deleteOne: mockDeleteOne,
  })),
}));

import {
  deleteStoredTokens,
  getStoredTokens,
  resetTokenStore,
  storeTokens,
} from "../auth-token-store";

describe("auth-token-store", () => {
  beforeEach(() => {
    process.env.NEXTAUTH_SECRET = "test-secret-for-auth-token-store";
    resetTokenStore();
    mockFindOne.mockReset();
    mockUpdateOne.mockReset();
    mockDeleteOne.mockReset();
  });

  afterEach(() => {
    delete process.env.NEXTAUTH_SECRET;
  });

  it("stores tokens in L1 and writes encrypted data to MongoDB", async () => {
    const tokens = {
      accessToken: "access-token",
      refreshToken: "refresh-token",
      idToken: "id-token",
    };

    await storeTokens("user-1", tokens);

    expect(await getStoredTokens("user-1")).toEqual(tokens);
    expect(mockFindOne).not.toHaveBeenCalled();
    expect(mockUpdateOne).toHaveBeenCalledWith(
      { _id: "user-1" },
      expect.objectContaining({
        $set: expect.objectContaining({
          enc: expect.any(String),
          updatedAt: expect.any(Date),
        }),
      }),
      { upsert: true },
    );

    const enc = mockUpdateOne.mock.calls[0][1].$set.enc as string;
    expect(enc).not.toContain("access-token");
    expect(enc).not.toContain("refresh-token");
  });

  it("hydrates L1 from MongoDB on cache miss", async () => {
    const tokens = { accessToken: "l2-access", refreshToken: "l2-refresh" };

    await storeTokens("user-2", tokens);
    const enc = mockUpdateOne.mock.calls[0][1].$set.enc as string;
    resetTokenStore();
    mockFindOne.mockResolvedValue({ _id: "user-2", enc, updatedAt: new Date() });

    await expect(getStoredTokens("user-2")).resolves.toEqual(tokens);
    mockFindOne.mockClear();
    await expect(getStoredTokens("user-2")).resolves.toEqual(tokens);
    expect(mockFindOne).not.toHaveBeenCalled();
  });

  it("deletes tokens from both cache levels", async () => {
    await storeTokens("impersonation:one", { accessToken: "target-token" });

    await deleteStoredTokens("impersonation:one");

    expect(mockDeleteOne).toHaveBeenCalledWith({ _id: "impersonation:one" });
    mockFindOne.mockResolvedValue(null);
    await expect(getStoredTokens("impersonation:one")).resolves.toBeUndefined();
  });
});
