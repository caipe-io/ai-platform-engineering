/**
 * @jest-environment node
 */

const mockInsertOne = jest.fn();
const mockFind = jest.fn();
const mockFindOne = jest.fn();
const mockUpdateOne = jest.fn();

jest.mock("@/lib/mongodb", () => ({
  isMongoDBConfigured: true,
  getCollection: jest.fn(async () => ({
    insertOne: mockInsertOne,
    find: mockFind,
    findOne: mockFindOne,
    updateOne: mockUpdateOne,
  })),
}));

describe("catalog-api-keys", () => {
  beforeEach(() => {
    jest.resetModules();
    mockInsertOne.mockReset();
    mockFind.mockReset();
    mockFindOne.mockReset();
    mockUpdateOne.mockReset();
    process.env.CAIPE_CATALOG_API_KEY_PEPPER = "test-pepper";
  });

  it("createCatalogApiKey stores hashed secret and returns full key once", async () => {
    mockInsertOne.mockResolvedValue({ insertedId: "x" });
    const { createCatalogApiKey } = await import("@/lib/catalog-api-keys");
    const { key, key_id } = await createCatalogApiKey("user-sub-1");

    expect(key_id).toMatch(/^sk_[A-Za-z0-9]{12}$/);
    expect(key.startsWith(`${key_id}.`)).toBe(true);
    expect(mockInsertOne).toHaveBeenCalledTimes(1);
    const doc = mockInsertOne.mock.calls[0]![0] as {
      key_hash: string;
      owner_user_id: string;
      scopes: string[];
    };
    expect(doc.owner_user_id).toBe("user-sub-1");
    expect(doc.scopes).toEqual(["catalog:read"]);
    const secret = key.slice(key_id.length + 1);
    expect(doc.key_hash).toMatch(/^scrypt:v1:[A-Za-z0-9_-]+$/);
    expect(doc.key_hash).not.toBe(secret);
  });

  it("verifyCatalogApiKey returns owner when hash matches", async () => {
    mockInsertOne.mockResolvedValue({ insertedId: "x" });
    const { createCatalogApiKey, verifyCatalogApiKey } = await import(
      "@/lib/catalog-api-keys"
    );
    const { key, key_id } = await createCatalogApiKey("owner-a");
    const doc = mockInsertOne.mock.calls[0]![0] as {
      key_hash: string;
      scopes: string[];
    };
    mockFindOne.mockResolvedValue({
      key_id,
      key_hash: doc.key_hash,
      owner_user_id: "owner-a",
      scopes: doc.scopes,
      revoked_at: null,
    });
    mockUpdateOne.mockResolvedValue({ modifiedCount: 1 });

    const owner = await verifyCatalogApiKey(key);
    expect(owner).toBe("owner-a");
  });

  it("verifyCatalogApiKey rejects a valid secret without catalog:read scope", async () => {
    mockInsertOne.mockResolvedValue({ insertedId: "x" });
    const { createCatalogApiKey, verifyCatalogApiKey } = await import(
      "@/lib/catalog-api-keys"
    );
    const { key, key_id } = await createCatalogApiKey("owner-a");
    const doc = mockInsertOne.mock.calls[0]![0] as { key_hash: string };
    mockFindOne.mockResolvedValue({
      key_id,
      key_hash: doc.key_hash,
      owner_user_id: "owner-a",
      scopes: ["catalog:write"],
      revoked_at: null,
    });

    await expect(verifyCatalogApiKey(key)).resolves.toBeNull();
    expect(mockUpdateOne).not.toHaveBeenCalled();
  });

  it("verifyCatalogApiKey rejects an expired key", async () => {
    mockInsertOne.mockResolvedValue({ insertedId: "x" });
    const { createCatalogApiKey, verifyCatalogApiKey } = await import(
      "@/lib/catalog-api-keys"
    );
    const { key, key_id } = await createCatalogApiKey("owner-a");
    const doc = mockInsertOne.mock.calls[0]![0] as { key_hash: string };
    mockFindOne.mockResolvedValue({
      key_id,
      key_hash: doc.key_hash,
      owner_user_id: "owner-a",
      scopes: ["catalog:read"],
      expires_at: Date.now() / 1000 - 1,
      revoked_at: null,
    });

    await expect(verifyCatalogApiKey(key)).resolves.toBeNull();
    expect(mockUpdateOne).not.toHaveBeenCalled();
  });

  it("revokeCatalogApiKey sets revoked_at", async () => {
    mockUpdateOne.mockResolvedValue({ modifiedCount: 1 });
    const { revokeCatalogApiKey } = await import("@/lib/catalog-api-keys");
    const ok = await revokeCatalogApiKey("sk_deadbeef12");
    expect(ok).toBe(true);
    expect(mockUpdateOne).toHaveBeenCalledWith(
      { key_id: "sk_deadbeef12" },
      expect.objectContaining({ $set: expect.objectContaining({ revoked_at: expect.any(Number) }) }),
    );
  });
});
