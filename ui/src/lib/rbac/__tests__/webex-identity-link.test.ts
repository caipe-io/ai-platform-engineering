/** @jest-environment node */

import { MongoServerError } from "mongodb";

import { claimWebexIdentity, unlinkWebexIdentity } from "../webex-identity-link";

const mockRecords = new Map<string, Record<string, unknown>>();
const mockUsers = new Map<string, { enabled: boolean; attributes: Record<string, unknown> }>();
const mockMerge = jest.fn(async (id: string, attributes: Record<string, unknown>) => {
  const user = mockUsers.get(id)!;
  for (const [key, value] of Object.entries(attributes)) {
    if (value === undefined) delete user.attributes[key];
    else user.attributes[key] = value;
  }
});
const mockRoutes = jest.fn();
const mockGetUser = jest.fn(async (id: string) => mockUsers.get(id));

function mockCollection() {
  return {
    findOne: async (query: { _id: string }) => mockRecords.get(query._id) ?? null,
    insertOne: async (record: { _id: string }) => {
      if (mockRecords.has(record._id)) throw new MongoServerError({ code: 11000, message: "duplicate" });
      mockRecords.set(record._id, record);
    },
    deleteOne: async (query: { _id: string; nonce?: string; user_id?: string }) => {
      if ((!query.nonce || mockRecords.get(query._id)?.nonce === query.nonce)
        && (!query.user_id || mockRecords.get(query._id)?.user_id === query.user_id)) mockRecords.delete(query._id);
    },
    updateOne: async (query: { _id: string }, update: { $set: Record<string, unknown> }) => {
      mockRecords.set(query._id, { ...mockRecords.get(query._id), ...update.$set });
    },
  };
}
jest.mock("@/lib/rbac/mongo-collections", () => ({ getRbacCollection: async () => mockCollection() }));
jest.mock("@/lib/mongodb", () => ({ getCollection: async () => mockCollection() }));
jest.mock("@/lib/rbac/keycloak-admin", () => ({
  findRealmUserIdsByAttribute: async (_: string, personId: string) => [...mockUsers.entries()]
    .filter(([, user]) => (user.attributes.webex_user_id as string[] | undefined)?.includes(personId))
    .map(([id]) => id),
  getRealmUserById: (id: string) => mockGetUser(id),
  mergeUserAttributes: (...args: Parameters<typeof mockMerge>) => mockMerge(...args),
}));
jest.mock("@/lib/rbac/webex-direct-user-route-store", () => ({
  setWebexIdentityForUserRoutes: (...args: unknown[]) => mockRoutes(...args),
}));

beforeEach(() => {
  jest.clearAllMocks();
  mockRecords.clear();
  mockUsers.clear();
  mockUsers.set("user-1", { enabled: true, attributes: {} });
  mockUsers.set("user-2", { enabled: true, attributes: {} });
  process.env.KEYCLOAK_REALM = "example";
});

function claim(user = "user-1", person = "person1234"): Promise<void> {
  return claimWebexIdentity(person, user, { webex_user_id: [person] });
}

test("concurrent claims for one person cannot bind different users", async () => {
  const results = await Promise.allSettled([claim(), claim("user-2")]);
  expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
  expect([...mockUsers.values()].filter((user) => user.attributes.webex_user_id)).toHaveLength(1);
  expect(mockRecords.has("identity-write")).toBe(false);
});

test("concurrent claims cannot overwrite the user's different person binding", async () => {
  const results = await Promise.allSettled([claim(), claim("user-1", "person5678")]);
  expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
  expect(mockUsers.get("user-1")!.attributes.webex_user_id).toEqual(["person1234"]);
});

test("unlink records suppression for both person and account before removing the link", async () => {
  await claim();
  await unlinkWebexIdentity("user-1");
  expect(mockUsers.get("user-1")!.attributes.webex_user_id).toBeUndefined();
  expect(mockUsers.get("user-1")!.attributes.webex_auto_link_disabled).toEqual(["true"]);
  expect(mockRecords.has("blocked:example:person1234")).toBe(true);
  expect(mockRoutes).toHaveBeenLastCalledWith("user-1", null);
});

test("an explicit link clears suppression and records the SSO method", async () => {
  await claim();
  await unlinkWebexIdentity("user-1");
  await claim();
  expect(mockRecords.has("blocked:example:person1234")).toBe(false);
  expect(mockUsers.get("user-1")!.attributes.webex_auto_link_disabled).toBeUndefined();
  expect(mockUsers.get("user-1")!.attributes.webex_link_method).toEqual(["sso"]);
});

test("a disabled account cannot claim an identity", async () => {
  mockUsers.get("user-1")!.enabled = false;
  await expect(claim()).rejects.toMatchObject({ statusCode: 409 });
  expect(mockMerge).not.toHaveBeenCalled();
});

test("uncertain Keycloak writes retain the lock for operator reconciliation", async () => {
  mockMerge.mockRejectedValueOnce(new Error("write timed out"));
  await expect(claim()).rejects.toThrow("write timed out");
  expect(mockRecords.has("identity-write")).toBe(true);
});

test("durable claims prevent reassignment even if the directory no longer returns an owner", async () => {
  mockRecords.set("binding:example:person1234", { user_id: "user-2" });
  await expect(claim()).rejects.toMatchObject({ statusCode: 409 });
  expect(mockMerge).not.toHaveBeenCalled();
});

test("unlink releases reciprocal claims so the person can explicitly link a different account", async () => {
  await claim();
  await unlinkWebexIdentity("user-1");
  expect(mockRecords.has("binding:example:person1234")).toBe(false);
  expect(mockRecords.has("account:example:user-1")).toBe(false);
  await claim("user-2");
  expect(mockUsers.get("user-2")!.attributes.webex_user_id).toEqual(["person1234"]);
  expect(mockRecords.has("blocked:example:person1234")).toBe(false);
});


test("lookup failures release the mutex before the explicit fallback", async () => {
  mockGetUser.mockRejectedValueOnce(new Error("directory unavailable"));
  await expect(claim()).rejects.toMatchObject({ code: "WEBEX_LINK_LOOKUP_UNAVAILABLE" });
  expect(mockRecords.has("identity-write")).toBe(false);
  expect(mockMerge).not.toHaveBeenCalled();
});

test("a write that cannot be read back retains the mutex and does not sync routes", async () => {
  mockMerge.mockResolvedValueOnce(undefined);
  await expect(claim()).rejects.toThrow("write could not be verified");
  expect(mockRecords.has("identity-write")).toBe(true);
  expect(mockRoutes).not.toHaveBeenCalled();
});
