const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { Readable } = require("node:stream");
const { test } = require("node:test");
const { runInNewContext } = require("node:vm");

const source = readFileSync(new URL("../../setup-caipe.sh", `file://${__filename}`), "utf8");
const script = source.split(/<<'CAIPE_WORKSPACE_MIGRATIONS_JS'[^\n]*\n/)[1]
  .split("\nCAIPE_WORKSPACE_MIGRATIONS_JS\n")[0]
  .replace(/main\(\)\.catch\([\s\S]*$/, "main()");

async function run(options = {}) {
  const calls = [], messages = [];
  const credential = (name, data) => ({ metadata: { name }, data: Object.fromEntries(
    Object.entries(data).map(([key, value]) => [key, Buffer.from(value).toString("base64")]),
  ) });
  const credentials = { items: [
    credential("caipe-keycloak-admin", { username: "example-admin", password: "master-password" }),
    credential("caipe-local-admin", { email: "admin@example.test", password: "local-password" }),
  ] };
  let client;
  const fetch = async (url, request = {}) => {
    const path = new URL(url).pathname;
    calls.push(`${request.method || "GET"} ${path}`);
    if (path.endsWith("/token")) {
      assert.equal(request.body.get("grant_type"), "password");
      if (path.includes("/master/")) {
        assert.equal(request.body.get("password"), "master-password");
        return Response.json({ access_token: "master-token" });
      }
      assert.equal(request.body.get("client_id"), client.clientId);
      assert.equal(request.body.get("client_secret"), client.secret);
      assert.equal(request.body.get("username"), "admin@example.test");
      assert.equal(request.body.get("password"), "local-password");
      if (options.authFailure) return new Response(null, { status: 401 });
      return Response.json({ access_token: "local-admin-token" });
    }
    if (path.includes("/admin/realms/")) {
      assert.equal(request.headers.Authorization, "Bearer master-token");
      if (request.method === "POST") {
        client = JSON.parse(request.body);
        assert.match(client.clientId, /^caipe-setup-[0-9a-f]{24}$/);
        assert.equal(client.publicClient, false);
        assert.equal(client.standardFlowEnabled, false);
        assert.equal(client.directAccessGrantsEnabled, true);
        assert.equal(client.protocolMappers[0].config["included.client.audience"], "example-ui");
        return new Response(null, { status: 201, headers: options.noLocation ? {} : {
          location: "http://identity.example.test/admin/realms/example/clients/example-uuid",
        } });
      }
      if (request.method === "DELETE") {
        return new Response(null, { status: options.cleanupFailure ? 500 : 204 });
      }
      assert.equal(new URL(url).searchParams.get("clientId"), client.clientId);
      return Response.json([{ clientId: client.clientId, id: "example-uuid" }]);
    }
    assert.equal(request.headers.Authorization, "Bearer local-admin-token");
    if (path.endsWith("/apply-all")) {
      assert.deepEqual(JSON.parse(request.body), { confirmation: "APPLY ALL PENDING MIGRATIONS" });
      return Response.json({ success: true, data: {
        applied_count: 2, failed_count: options.failedMigration ? 1 : 0, results: [],
      } });
    }
    return Response.json({ success: true, data: options.malformed ? {} : {
      migrations: options.pending ? [{ required: true, status: "pending" }] : [],
      schema_versions: options.unversioned ? [{ current_version: null, target_version: "1.0.0" }] : [],
    } });
  };
  let error;
  try {
    await runInNewContext(script, {
      require, Buffer, URLSearchParams, AbortSignal, fetch,
      process: { stdin: Readable.from([JSON.stringify(credentials)]), env: {
        KEYCLOAK_URL: "http://identity.example.test", KEYCLOAK_REALM: "example", OIDC_CLIENT_ID: "example-ui",
      } },
      console: { log: message => messages.push(message) },
    });
  } catch (caught) { error = caught; }
  const output = messages.join("\n");
  for (const secret of ["master-password", "local-password", "master-token", "local-admin-token"]) {
    assert.ok(!output.includes(secret));
    assert.ok(!String(error?.message).includes(secret));
  }
  assert.ok(calls.includes("DELETE /admin/realms/example/clients/example-uuid"), "temporary client is cleaned up");
  return { error, output, calls };
}

test("applies and verifies workspace updates using the local admin", async () => {
  const result = await run();
  assert.equal(result.error, undefined);
  assert.match(result.output, /2 applied/);
  assert.ok(result.calls.includes("GET /api/admin/rebac/migrations"));
});

for (const [name, options, message] of [
  ["HTTP 200 with failed migrations", { failedMigration: true }, /did not all succeed/],
  ["required updates remain", { pending: true }, /still requires attention/],
  ["schema versions are uninitialized", { unversioned: true }, /still requires attention/],
  ["invalid verification response", { malformed: true }, /Invalid workspace migration verification/],
  ["admin authentication fails", { authFailure: true }, /authentication failed/],
  ["temporary client cleanup fails", { cleanupFailure: true }, /cleanup failed/],
  ["client creation omits its location", { noLocation: true }, /no setup client ID/],
]) {
  test(`fails setup when ${name}`, async () => {
    const { error } = await run(options);
    assert.match(error?.message || "", message);
  });
}
