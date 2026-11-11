/** @jest-environment node */

test("ownership lookup includes identities stored after another attribute value", async () => {
  jest.resetModules();
  const originalEnv = { ...process.env };
  const originalFetch = global.fetch;
  process.env.KEYCLOAK_URL = "http://directory.example.test";
  process.env.KEYCLOAK_REALM = "example";
  process.env.KEYCLOAK_ADMIN_CLIENT_ID = "example-client";
  process.env.KEYCLOAK_ADMIN_CLIENT_SECRET = "example-secret";
  const response = (body: unknown) => new Response(JSON.stringify(body), {
    headers: { "Content-Type": "application/json" },
  });
  global.fetch = jest.fn()
    .mockResolvedValueOnce(response({ access_token: "example-token", expires_in: 300 }))
    .mockResolvedValueOnce(response([
      { id: "primary", attributes: { webex_user_id: ["other-person", "person1234"] } },
      { id: "secondary", attributes: { webex_user_id: ["person1234"] } },
    ]));
  try {
    const { findRealmUserIdsByAttribute } = await import("../keycloak-admin");
    await expect(findRealmUserIdsByAttribute("webex_user_id", "person1234"))
      .resolves.toEqual(["primary", "secondary"]);
  } finally {
    process.env = originalEnv;
    global.fetch = originalFetch;
  }
});
