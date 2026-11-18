/** @jest-environment node */
let user: Record<string, unknown> | null;
let writes: Record<string, unknown>[];
const originalFetch = global.fetch;
const originalEnv = { ...process.env };

beforeEach(() => {
  jest.resetModules();
  process.env = { ...originalEnv, KEYCLOAK_URL: "https://identity.example.test", KEYCLOAK_REALM: "example", KEYCLOAK_ADMIN_CLIENT_ID: "example-client", KEYCLOAK_ADMIN_CLIENT_SECRET: "test-secret" };
  user = { id: "test-subject", email: "test-user@example.test", firstName: "", lastName: "" };
  writes = [];
  global.fetch = jest.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith("/protocol/openid-connect/token")) return Response.json({ access_token: "test-token", expires_in: 300 });
    expect(url).toBe("https://identity.example.test/admin/realms/example/users/test-subject");
    if (init?.method === "PUT") { writes.push(JSON.parse(String(init.body))); return new Response(null, { status: 204 }); }
    return user ? Response.json(user) : new Response(null, { status: 404 });
  }) as typeof fetch;
});
afterAll(() => { global.fetch = originalFetch; process.env = originalEnv; });

it.each([
  { given_name: "Test", family_name: "Person" },
  { firstname: "Test", lastname: "Person" },
  { caipe_idp_given_name: "Test", caipe_idp_family_name: "Person" },
  { caipe_idp_firstname: "Test", caipe_idp_lastname: "Person" },
])("repairs an email-only existing account from structured claims %j", async (claims) => {
  const { backfillMissingUserNamesFromClaims } = await import("../keycloak-admin");
  expect(await backfillMissingUserNamesFromClaims("test-subject", claims)).toBe("Test Person");
  expect(writes).toEqual([{ firstName: "Test", lastName: "Person" }]);
});

it("preserves an existing name and fills only the missing part", async () => {
  user = { ...user, firstName: "Preferred", lastName: "  " };
  const { backfillMissingUserNamesFromClaims } = await import("../keycloak-admin");
  expect(await backfillMissingUserNamesFromClaims("test-subject", { given_name: "Other", family_name: "Person" })).toBe("Preferred Person");
  expect(writes).toEqual([{ lastName: "Person" }]);
});

it("does not overwrite a complete profile", async () => {
  user = { ...user, firstName: "Preferred", lastName: "Person" };
  const { backfillMissingUserNamesFromClaims } = await import("../keycloak-admin");
  expect(await backfillMissingUserNamesFromClaims("test-subject", { given_name: "Other", family_name: "Name" })).toBeUndefined();
  expect(writes).toEqual([]);
});

it.each([
  { name: "Test Person", email: "test-user@example.test", preferred_username: "test-user" },
  { given_name: ["Test"], family_name: { value: "Person" } },
  { given_name: "test-user@example.test", family_name: "<>&" },
  { given_name: "a".repeat(256), family_name: " " },
])("does not infer names or use malformed claims %j", async (claims) => {
  const { backfillMissingUserNamesFromClaims } = await import("../keycloak-admin");
  await backfillMissingUserNamesFromClaims("test-subject", claims);
  expect(global.fetch).not.toHaveBeenCalled();
});

it("sanitizes valid structured names and falls back from empty upstream claims", async () => {
  const { backfillMissingUserNamesFromClaims } = await import("../keycloak-admin");
  await backfillMissingUserNamesFromClaims("test-subject", { caipe_idp_given_name: " ", given_name: "Test (Example)", family_name: "  Person  " });
  expect(writes).toEqual([{ firstName: "Test Example", lastName: "Person" }]);
});

it("never recreates a deleted subject or resolves a replacement by email", async () => {
  user = null;
  const { backfillMissingUserNamesFromClaims } = await import("../keycloak-admin");
  expect(await backfillMissingUserNamesFromClaims("test-subject", { given_name: "Test" })).toBeUndefined();
  expect(writes).toEqual([]);
});

it("requires a subject and surfaces a write failure to its caller", async () => {
  const { backfillMissingUserNamesFromClaims } = await import("../keycloak-admin");
  await backfillMissingUserNamesFromClaims(" ", { given_name: "Test" });
  expect(global.fetch).not.toHaveBeenCalled();
  (global.fetch as jest.Mock).mockImplementation(async (_input: unknown, init?: RequestInit) => {
    if (init?.method === "POST") return Response.json({ access_token: "test-token", expires_in: 300 });
    if (init?.method === "PUT") return new Response("unavailable", { status: 503 });
    return Response.json(user);
  });
  await expect(backfillMissingUserNamesFromClaims("test-subject", { given_name: "Test" })).rejects.toThrow();
});
