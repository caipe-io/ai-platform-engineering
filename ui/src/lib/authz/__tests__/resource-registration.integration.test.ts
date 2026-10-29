/** @jest-environment node */
import { randomUUID } from "crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { request as httpRequest } from "node:http";
import { Collection, MongoClient, type Db } from "mongodb";
import { NextRequest } from "next/server";
import manifest from "../../../../examples/agentic-apps/service-only/manifest.json";
import model from "../../../../../charts/ai-platform-engineering/charts/openfga/authorization-model.json";
import { POST as register } from "@/app/api/access/resources/route";
import { GET as inspect, DELETE as retire } from "@/app/api/access/resources/[id]/route";
import { POST as transfer } from "@/app/api/access/resources/[id]/owner/route";
import { POST as check } from "@/app/api/access/check/route";
import { POST as query } from "@/app/api/access/query/route";
import { POST as grant, DELETE as revokeGrant } from "@/app/api/access/grants/route";
import { createDelegation, authorizeDelegated, revokeDelegation } from "../index";
import { readRegisteredResource, reserveResource } from "../resource-store";
import { permissionObject, resourceOwnerObject, RESOURCE_ID_PATTERN, type RegisteredResource } from "../resource-contract";
import { __resetAdapterStateForTests, describeFgaCheck } from "../engines/openfga";

let mockDb: Db;
const mockSession = jest.fn(); const mockJwt = jest.fn(); const mockAudit = jest.fn();
const mockUser = jest.fn();
const mockLegacyAuth = jest.fn(() => { throw new Error("Unexpected legacy authentication"); });
jest.mock("@/lib/mongodb", () => ({ isMongoDBConfigured: true, getCollection: (name: string) => mockDb.collection(name) }));
jest.mock("@/lib/api-middleware", () => ({ getAuthenticatedUser: (...args: unknown[]) => mockSession(...args),
  getAuthFromBearerOrSession: (...args: unknown[]) => mockLegacyAuth(...args) }));
jest.mock("@/lib/jwt-validation", () => ({ validatePlatformBearerJWT: (...args: unknown[]) => mockJwt(...args) }));
jest.mock("@/lib/audit", () => ({ getAuditClient: () => ({ append: (...args: unknown[]) => mockAudit(...args) }) }));
jest.mock("@/lib/rbac/keycloak-admin", () => ({ getRealmUserByIdOrNull: (...args: unknown[]) => mockUser(...args) }));
const mongoUri = process.env.CAS_RESOURCE_TEST_MONGODB_URI;
const fgaUrl = process.env.CAS_RESOURCE_TEST_OPENFGA_URL;
const describeIntegration = mongoUri && fgaUrl ? describe : describe.skip;
const originalEnv = { ...process.env };
const originalFetch = global.fetch;
// Jest replaces fetch globally; use real HTTP so graph assertions exercise OpenFGA.
const realFetch: typeof fetch = async (input, options = {}) => new Promise((resolve, reject) => {
  const pending = httpRequest(String(input), { method: options.method, headers: options.headers as Record<string, string>,
    signal: options.signal ?? undefined }, (response) => {
    const chunks: Buffer[] = [];
    response.on("data", (chunk: Buffer) => chunks.push(chunk));
    response.on("end", () => resolve(new Response(response.statusCode === 204 ? null : Buffer.concat(chunks), { status: response.statusCode })));
    response.on("error", reject);
  });
  pending.on("error", reject); pending.end(typeof options.body === "string" ? options.body : undefined);
});
const issuer = "https://identity.example.test";
const user = { issuer, subject: { type: "user" as const, id: "test-user" }, clientId: "browser", expiresAt: 10 ** 10 };
const service = { issuer, subject: { type: "service_account" as const, id: "service-subject" }, clientId: "example-client", expiresAt: 10 ** 10 };
const ctx = { caller: user.subject, tenantId: "primary", correlationId: "example-trace" };
const businessKey = { app_id: manifest.id, resource_type: "agent-sandbox", local_id: "sandbox-123" };
function request(path: string, body: unknown, bearer = false, method = "POST") {
  return new NextRequest(`https://example.test/api/access/${path}`, { method,
    headers: { origin: "https://example.test", "content-type": "application/json", ...(bearer ? { authorization: "Bearer service-token" } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}
function apps(enabled = true) {
  // Both manifests are installed at runtime. Neither comes from compiled host packages.
  const primary = { ...manifest, resourceTypes: [...manifest.resourceTypes, { name: "workspace", actions: ["read"] }], ui: { profiles: [{ id: "hosted", mode: "iframe" }], routes: [] },
    runtime: { kind: "proxied-next-zone", mountPath: "/apps/example-service" },
    access: { ...manifest.access, policyActions: [{ action: "proxy:GET", defaultEffect: "allow" }] } };
  const secondary = { ...primary, id: "secondary-service", runtime: { ...primary.runtime, mountPath: "/apps/secondary-service" } };
  return { agentic_apps: { packages: [{ package_id: primary.id, manifest: primary }, { package_id: secondary.id, manifest: secondary }],
    installations: [{ app_id: primary.id, enabled, visible: false, bindings: { serviceAccountClientId: service.clientId, runtimeOrigin: "https://primary.example.test" } },
      { app_id: secondary.id, enabled: true, visible: false, bindings: { serviceAccountClientId: "secondary-client", runtimeOrigin: "https://secondary.example.test" } }] } };
}

describeIntegration("runtime iframe app resources with real MongoDB and OpenFGA", () => {
  let client: MongoClient; let peer: MongoClient; let storeId: string; let directory: string; let configFile: string;
  async function fga(path: string, body?: unknown, method = "POST") {
    const response = await realFetch(`${fgaUrl}${path}`, { method, headers: { "content-type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) });
    if (!response.ok) throw new Error(`OpenFGA setup: ${response.status} ${await response.text()}`);
    return response.status === 204 ? {} : response.json();
  }
  function session(id = user.subject.id) {
    mockSession.mockResolvedValue({ session: { principalType: "oidc_user", sub: id, role: "user", org: "primary", expiresAt: user.expiresAt } });
  }
  async function create(localId: string, extra = {}) {
    const response = await register(request("resources", { ...businessKey, local_id: localId, ...extra }));
    expect(response.status).toBe(201); return response.json();
  }
  beforeAll(async () => {
    directory = mkdtempSync(join(tmpdir(), "cas-generic-resources-")); configFile = join(directory, "apps.json");
    client = await new MongoClient(mongoUri!).connect(); peer = await new MongoClient(mongoUri!).connect();
    mockDb = client.db(`cas_resources_test_${randomUUID().replaceAll("-", "")}`);
    storeId = (await fga("/stores", { name: "cas-resource-test" })).id;
    await fga(`/stores/${storeId}/authorization-models`, model);
    Object.assign(process.env, { OIDC_ISSUER: issuer, OIDC_CLIENT_ID: "browser", NEXTAUTH_URL: "https://example.test",
      OPENFGA_HTTP: fgaUrl, OPENFGA_STORE_ID: storeId, OPENFGA_RECONCILE_ENABLED: "true",
      AGENTIC_APPS_INSTALL_ENABLED: "true", AGENTIC_APPS_CONFIG_PATH: configFile, AUDIT_FULL_FIDELITY_ALLOWS: "true" });
  });
  beforeEach(() => {
    jest.clearAllMocks(); global.fetch = realFetch; __resetAdapterStateForTests(); session();
    writeFileSync(configFile, JSON.stringify(apps())); mockJwt.mockResolvedValue(service);
    mockUser.mockImplementation(async (id: string) => ({ id, enabled: true }));
  });
  afterAll(async () => {
    global.fetch = originalFetch;
    try { if (storeId) await fga(`/stores/${storeId}`, undefined, "DELETE"); }
    finally { if (mockDb) await mockDb.dropDatabase(); await client?.close(); await peer?.close();
      if (directory) rmSync(directory, { recursive: true, force: true }); process.env = originalEnv; __resetAdapterStateForTests(); }
  });

  it("maps a runtime app business key to a stable generic handle with user ownership", async () => {
    const saved = await create(businessKey.local_id);
    expect(saved.resource.type).toBe("app_resource"); expect(saved.resource.id).toMatch(RESOURCE_ID_PATTERN);
    expect(saved).toMatchObject({ ...businessKey, owner: user.subject, state: "active" });
    expect(await (await register(request("resources", businessKey))).json()).toEqual(saved);
    expect(await peer.db(mockDb.databaseName).collection("access_resources").findOne({ _id: saved.resource.id })).toMatchObject({ ...businessKey, creator: user.subject });
    const permission = { resource: saved.resource, action: "execute" };
    expect(await (await check(request("check", permission))).json()).toMatchObject({ decision: "ALLOW" });
    expect(await (await check(request("check", permission, true))).json()).toMatchObject({ decision: "DENY" });
    expect(mockLegacyAuth).not.toHaveBeenCalled();
    expect(mockAudit.mock.calls.some(([event]) => event.type === "cas_grant" && event.registration?.local_id === businessKey.local_id && event.registration.owner.id === user.subject.id)).toBe(true);
    const second = await create(businessKey.local_id, { app_id: "secondary-service" });
    expect(second.resource.id).not.toBe(saved.resource.id);
    const otherKind = await create(businessKey.local_id, { resource_type: "workspace" });
    expect(otherKind.resource.id).not.toBe(saved.resource.id);
    expect(await (await check(request("check", { resource: otherKind.resource, action: "read" }))).json()).toMatchObject({ decision: "ALLOW" });
    expect((await register(request("resources", { ...businessKey, owner_team: "unrelated-team" }))).status).toBe(403);
  });

  it("reserves one handle under concurrent registration and rejects a competing owner", async () => {
    const responses = await Promise.all(Array.from({ length: 6 }, () => register(request("resources", { ...businessKey, local_id: "concurrent" }))));
    expect(responses.every((response) => [201, 503].includes(response.status))).toBe(true);
    const saved = await create("concurrent");
    expect(await peer.db(mockDb.databaseName).collection("access_resources").countDocuments({ app_id: manifest.id, local_id: "concurrent" })).toBe(1);
    session("other-user");
    expect((await register(request("resources", { ...businessKey, local_id: "concurrent" }))).status).toBe(409);
    expect(await readRegisteredResource(saved.resource.id)).toMatchObject({ owner: user.subject });
  });

  it("keeps an ambiguous owner projection pending across every access path and retries safely", async () => {
    global.fetch = async (url, options) => String(url).endsWith("/write") ? new Response("unavailable", { status: 503 }) : realFetch(url, options);
    const response = await register(request("resources", { ...businessKey, local_id: "pending" }));
    expect(response.status).toBe(503); const saved = await response.json();
    expect(saved.state).toBe("pending");
    expect((await inspect(request("resources", undefined, false, "GET"), { params: Promise.resolve({ id: saved.resource.id }) })).status).toBe(200);
    expect((await check(request("check", { resource: saved.resource, action: "execute" }))).status).toBe(503);
    expect((await query(request("query", { resource_type: "app_resource", action: "execute", ids: [saved.resource.id] }))).status).toBe(503);
    expect((await grant(request("grants", { resource: saved.resource, capability: "execute", grantee: service.subject }))).status).toBe(503);
    global.fetch = realFetch;
    expect((await create("pending")).resource).toEqual(saved.resource);
  });

  it("keeps action use and action grant authority independent without arbitrary policy", async () => {
    const { resource } = await create("independent-actions");
    const grantor = { type: "user", id: "execution-grantor" };
    expect((await grant(request("grants", { resource, capability: "execute", authority: "grant", grantee: grantor }))).status).toBe(200);
    session(grantor.id);
    expect(await (await check(request("check", { resource, action: "grant:execute" }))).json()).toMatchObject({ decision: "ALLOW" });
    expect(await (await check(request("check", { resource, action: "grant:terminate" }))).json()).toMatchObject({ decision: "DENY" });
    const intent = { resource, capability: "execute", grantee: service.subject };
    expect((await grant(request("grants", intent))).status).toBe(200);
    expect((await grant(request("grants", { ...intent, capability: "terminate" }))).status).toBe(403);
    expect((await grant(request("grants", { ...intent, authority: "grant" }))).status).toBe(403);
    expect(await (await check(request("check", { resource, action: "execute" }, true))).json()).toMatchObject({ decision: "ALLOW" });
    expect(await (await check(request("check", { resource, action: "terminate" }, true))).json()).toMatchObject({ decision: "DENY" });
    expect((await revokeGrant(request("grants", intent, false, "DELETE"))).status).toBe(200);
    expect(await (await check(request("check", { resource, action: "execute" }, true))).json()).toMatchObject({ decision: "DENY" });
    const debug = await describeFgaCheck({ resource, subject: service.subject, action: "execute" });
    expect(debug).toMatchObject({ relation: "can_use", object: permissionObject(resource.id, "execute"),
      contextual_tuples: [{ user: `app_resource:${resource.id}`, relation: "resource", object: permissionObject(resource.id, "execute") }] });
    expect((await fga(`/stores/${storeId}/read`, { tuple_key: { object: permissionObject(resource.id, "execute"), relation: "resource" } })).tuples).toEqual([]);
  });

  it("preserves team-owned delegated work after logout and rechecks both current permissions", async () => {
    const tuple = { user: `user:${user.subject.id}`, relation: "member", object: "team:example-team" };
    await fga(`/stores/${storeId}/write`, { writes: { tuple_keys: [tuple] } });
    const saved = await create("team-owned", { owner_team: "example-team" });
    expect(saved.owner).toEqual({ type: "team", id: "example-team" });
    expect((await grant(request("grants", { resource: saved.resource, capability: "execute", grantee: service.subject }))).status).toBe(200);
    const approval = await createDelegation(user, { service: { id: service.subject.id, client_id: service.clientId }, job_id: "example-job",
      expires_at: new Date(Date.now() + 3600000).toISOString(), scope: [{ resource: saved.resource, action: "execute" }] }, ctx, randomUUID());
    const work = { resource: saved.resource, action: "execute", job_id: "example-job" };
    mockSession.mockRejectedValue(new Error("Browser logged out"));
    expect(await authorizeDelegated(approval._id, service, work, {})).toMatchObject({ decision: "ALLOW" });
    expect(await authorizeDelegated(approval._id, service, { ...work, action: "terminate" }, {})).toMatchObject({ reason: "DELEGATION_SCOPE_MISMATCH" });
    expect(await authorizeDelegated(approval._id, { ...service, clientId: "other-client" }, work, {})).toMatchObject({ decision: "DENY" });
    writeFileSync(configFile, JSON.stringify(apps(false)));
    expect(await authorizeDelegated(approval._id, service, work, {})).toMatchObject({ decision: "DENY" });
    writeFileSync(configFile, JSON.stringify(apps()));
    await fga(`/stores/${storeId}/write`, { deletes: { tuple_keys: [{ user: `service_account:${service.subject.id}`, relation: "grantee", object: permissionObject(saved.resource.id, "execute") }] } });
    expect(await authorizeDelegated(approval._id, service, work, {})).toMatchObject({ reason: "SERVICE_NOT_ALLOWED" });
    await fga(`/stores/${storeId}/write`, { writes: { tuple_keys: [{ user: `service_account:${service.subject.id}`, relation: "grantee", object: permissionObject(saved.resource.id, "execute") }] }, deletes: { tuple_keys: [tuple] } });
    expect(await authorizeDelegated(approval._id, service, work, {})).toMatchObject({ reason: "USER_NOT_ALLOWED" });
    await revokeDelegation(approval._id, user, ctx);
    expect(await authorizeDelegated(approval._id, service, work, {})).toMatchObject({ reason: "DELEGATION_REVOKED" });
    expect(mockAudit.mock.calls.some(([event]) => event.delegation_id === approval._id && event.actor_ref === `service_account:${service.subject.id}`)).toBe(true);
  });

  it("uses the same mapped checks for candidate queries and immediately rejects configuration changes", async () => {
    const { resource } = await create("query-record");
    const intent = { resource, capability: "execute", grantee: service.subject };
    expect((await grant(request("grants", intent))).status).toBe(200);
    expect(await (await query(request("query", { resource_type: "app_resource", action: "execute", ids: [resource.id, resource.id] }, true))).json()).toEqual({ ids: [resource.id] });
    const config = apps(); config.agentic_apps.packages[0].manifest.resourceTypes = [{ name: "agent-sandbox", actions: ["terminate"] }];
    writeFileSync(configFile, JSON.stringify(config));
    expect((await check(request("check", { resource, action: "execute" }, true))).status).toBe(400);
    writeFileSync(configFile, JSON.stringify(apps(false)));
    expect(await (await check(request("check", { resource, action: "execute" }))).json()).toMatchObject({ decision: "DENY", via: "installation_disabled" });
  });

  it("rejects forged ownership, raw graph identities, undefined types/actions and native policy contracts", async () => {
    for (const field of ["owner", "subject", "namespace", "resource", "model_id"]) {
      expect((await register(request("resources", { ...businessKey, [field]: "forged" }))).status).toBe(400);
    }
    expect((await register(request("resources", businessKey, true))).status).toBe(403);
    expect((await register(request("resources", { ...businessKey, app_id: "uninstalled" }))).status).toBe(403);
    expect((await register(request("resources", { ...businessKey, resource_type: "undefined-kind" }))).status).toBe(400);
    const { resource } = await create("validation");
    for (const capability of ["owner", "undefined-action", "grant:execute"]) {
      expect((await grant(request("grants", { resource, capability, grantee: service.subject }))).status).toBe(400);
    }
    expect((await grant(request("grants", { resource, relationship: "executor", grantee: service.subject }))).status).toBe(400);
    expect((await check(request("check", { resource: { type: "app_permission", id: resource.id }, action: "can_use" }))).status).toBe(400);
    expect((await check(request("check", { resource, action: "execute", contextual_tuples: { tuple_keys: [] } }))).status).toBe(400);
    session("unrelated-user");
    await fga(`/stores/${storeId}/write`, { writes: { tuple_keys: [{ user: "user:unrelated-user", relation: "admin", object: "organization:primary" }] } });
    expect((await inspect(request("resources", undefined, false, "GET"), { params: Promise.resolve({ id: resource.id }) })).status).toBe(403);
    expect((await grant(request("grants", { resource, capability: "execute", grantee: service.subject }))).status).toBe(403);
  });

  it("fails writes closed while disabled and leaves a durable pending reservation for retry", async () => {
    process.env.OPENFGA_RECONCILE_ENABLED = "false";
    try {
      const failed = await register(request("resources", { ...businessKey, local_id: "disabled-writes" }));
      expect(failed.status).toBe(503);
      const { resource } = await failed.json();
      expect(await readRegisteredResource(resource.id)).toMatchObject({ state: "pending" });
    } finally { process.env.OPENFGA_RECONCILE_ENABLED = "true"; }
    const { resource } = await create("disabled-writes");
    process.env.OPENFGA_RECONCILE_ENABLED = "false";
    try { expect((await grant(request("grants", { resource, capability: "execute", grantee: service.subject }))).status).toBe(503); }
    finally { process.env.OPENFGA_RECONCILE_ENABLED = "true"; }
  });

  it("does not adopt orphaned owner grants from a restored or imported mapping", async () => {
    const record: RegisteredResource = { _id: randomUUID(), issuer, ...businessKey, local_id: "orphaned", creator: user.subject,
      owner: user.subject, state: "pending", prepared: false, created_at: new Date().toISOString() };
    await reserveResource(record);
    await fga(`/stores/${storeId}/write`, { writes: { tuple_keys: [{ user: "user:prior-user", relation: "owner", object: `app_resource:${record._id}` }] } });
    expect((await register(request("resources", { ...businessKey, local_id: record.local_id }))).status).toBe(409);
  });

  function params(id: string) { return { params: Promise.resolve({ id }) }; }
  const nextOwner = { type: "user", id: "next-owner" };
  async function move(saved: { resource: { id: string }; owner_version: string }, owner = nextOwner) {
    return transfer(request("resources/owner", { owner, expected_owner_version: saved.owner_version }), params(saved.resource.id));
  }

  it("transfers only ownership, preserves action grants/grantors, and rechecks approved jobs", async () => {
    const saved = await create("owner-transfer");
    const { resource } = saved;
    for (const [grantee, authority] of [[service.subject, "use"], [user.subject, "use"], [{ type: "user", id: "action-grantor" }, "grant"]]) {
      expect((await grant(request("grants", { resource, capability: "execute", grantee, authority }))).status).toBe(200);
    }
    const approval = await createDelegation(user, { service: { id: service.subject.id, client_id: service.clientId }, job_id: "transfer-job",
      expires_at: new Date(Date.now() + 3600000).toISOString(), scope: [{ resource, action: "execute" }] }, ctx, randomUUID());
    const moved = await move(saved); expect(moved.status).toBe(200);
    const next = await moved.json(); expect(next.resource).toEqual(resource); expect(next.owner).toEqual(nextOwner);
    expect(next.owner_version).not.toBe(saved.owner_version);
    expect(await peer.db(mockDb.databaseName).collection("access_resources").findOne({ _id: resource.id })).toMatchObject({ owner: nextOwner, owner_version: next.owner_version });
    expect(await (await check(request("check", { resource, action: "owner" }))).json()).toMatchObject({ decision: "DENY" });
    const work = { resource, action: "execute", job_id: "transfer-job" };
    expect(await authorizeDelegated(approval._id, service, work, {})).toMatchObject({ decision: "ALLOW" });
    session("action-grantor");
    expect(await (await check(request("check", { resource, action: "grant:execute" }))).json()).toMatchObject({ decision: "ALLOW" });
    expect((await move(next)).status).toBe(403);
    session(nextOwner.id);
    expect(await (await check(request("check", { resource, action: "terminate" }))).json()).toMatchObject({ decision: "ALLOW" });
    expect((await move(saved)).status).toBe(409);
    expect((await revokeGrant(request("grants", { resource, capability: "execute", grantee: user.subject }, false, "DELETE"))).status).toBe(200);
    expect(await authorizeDelegated(approval._id, service, work, {})).toMatchObject({ reason: "USER_NOT_ALLOWED" });
    const record = (await readRegisteredResource(resource.id))!;
    expect(await describeFgaCheck({ resource, subject: service.subject, action: "execute" })).toMatchObject({
      object: permissionObject(resource.id, "execute"), contextual_tuples: [{ user: resourceOwnerObject(record), relation: "resource", object: permissionObject(resource.id, "execute") }],
    });
    // Old ownership nodes remain inert, even if a delayed old write lands again.
    expect((await fga(`/stores/${storeId}/check`, { tuple_key: { user: `user:${user.subject.id}`, relation: "owner", object: `app_resource:${resource.id}` } })).allowed).toBe(true);
    expect(mockAudit.mock.calls.some(([event]) => event.lifecycle?.operation === "transfer" && event.lifecycle.previous_owner.id === user.subject.id && event.grantee_ref === `user:${nextOwner.id}`)).toBe(true);
  });

  it("requires membership in the receiving team and rejects invalid human owners", async () => {
    const saved = await create("transfer-team");
    expect((await move(saved, { type: "team", id: "receiving-team" })).status).toBe(403);
    for (const owner of [null, { id: nextOwner.id, enabled: false }, { id: nextOwner.id, enabled: true, serviceAccountClientId: "example-client" }, { id: nextOwner.id }]) {
      mockUser.mockResolvedValueOnce(owner); expect((await move(saved)).status).toBe(400);
    }
    await fga(`/stores/${storeId}/write`, { writes: { tuple_keys: [{ user: `user:${user.subject.id}`, relation: "member", object: "team:receiving-team" }] } });
    const moved = await move(saved, { type: "team", id: "receiving-team" });
    expect(moved.status).toBe(200); expect((await moved.json()).owner).toEqual({ type: "team", id: "receiving-team" });
    expect(await (await check(request("check", { resource: saved.resource, action: "owner" }))).json()).toMatchObject({ decision: "ALLOW" });
  });

  it("leaves live ownership unchanged when preparing OpenFGA fails or is disabled", async () => {
    const saved = await create("transfer-prepare-failure");
    global.fetch = async (url, options) => String(url).endsWith("/write") ? new Response("unavailable", { status: 503 }) : realFetch(url, options);
    expect((await move(saved)).status).toBe(503);
    global.fetch = realFetch;
    expect(await readRegisteredResource(saved.resource.id)).toMatchObject({ owner: user.subject, state: "active" });
    expect(await (await check(request("check", { resource: saved.resource, action: "owner" }))).json()).toMatchObject({ decision: "ALLOW" });
    process.env.OPENFGA_RECONCILE_ENABLED = "false";
    try { expect((await move(saved)).status).toBe(503); }
    finally { process.env.OPENFGA_RECONCILE_ENABLED = "true"; }
  });

  it("does not publish a prepared owner after an ambiguous graph write or failed Mongo publication", async () => {
    const saved = await create("unpublished-owner");
    global.fetch = async (url, options) => {
      const response = await realFetch(url, options);
      if (String(url).endsWith("/write")) throw new Error("Ownership write acknowledgement lost");
      return response;
    };
    expect((await move(saved)).status).toBe(503);
    global.fetch = realFetch;
    const publication = jest.spyOn(Collection.prototype, "findOneAndUpdate").mockRejectedValueOnce(new Error("Mongo publication failed"));
    try { expect((await move(saved)).status).toBe(503); }
    finally { publication.mockRestore(); }
    expect(await readRegisteredResource(saved.resource.id)).toMatchObject({ owner: user.subject, state: "active" });
    session(nextOwner.id);
    expect(await (await check(request("check", { resource: saved.resource, action: "owner" }))).json()).toMatchObject({ decision: "DENY" });
    session(); expect((await move(saved)).status).toBe(200);
  });

  it("cannot publish a transfer over a retirement committed by another replica", async () => {
    const saved = await create("transfer-retirement-race");
    let retired = false;
    global.fetch = async (url, options) => {
      const response = await realFetch(url, options);
      if (!retired && String(url).endsWith("/write")) {
        retired = true;
        await peer.db(mockDb.databaseName).collection("access_resources").updateOne({ _id: saved.resource.id }, { $set: { state: "retired" } });
      }
      return response;
    };
    expect((await move(saved)).status).toBe(409);
    expect(await readRegisteredResource(saved.resource.id)).toMatchObject({ owner: user.subject, state: "retired" });
    expect(await (await check(request("check", { resource: saved.resource, action: "execute" }))).json()).toMatchObject({ via: "resource_retired" });
  });

  it("publishes one winner across replicas and rejects a check begun against the old owner", async () => {
    const saved = await create("transfer-concurrent");
    const responses = await Promise.all([move(saved), move(saved)]);
    expect(responses.filter(response => response.status === 200)).toHaveLength(1);
    expect(responses.every(response => [200, 403, 409, 503].includes(response.status))).toBe(true);
    session(nextOwner.id);
    const current = await (await inspect(request("resources", undefined, false, "GET"), params(saved.resource.id))).json();
    let changed = false;
    global.fetch = async (url, options) => {
      const response = await realFetch(url, options);
      if (!changed && String(url).endsWith("/check")) {
        changed = true;
        // Simulate another replica publishing its already-prepared ownership node.
        await peer.db(mockDb.databaseName).collection("access_resources").updateOne({ _id: saved.resource.id }, { $set: { owner_version: randomUUID() } });
      }
      return response;
    };
    const stale = await check(request("check", { resource: saved.resource, action: "owner" }));
    expect(stale.status).toBe(503);
    expect(await stale.json()).toMatchObject({ code: "AUTHZ_UNAVAILABLE", retriable: true });
    expect(mockAudit.mock.calls.some(([event]) => event.decision_via === "resource_ownership_changed")).toBe(true);
    expect(current.owner_version).not.toBe(saved.owner_version);
  });

  it("permanently retires the handle across checks, queries, grants and approved jobs", async () => {
    const saved = await create("retirement"); const { resource } = saved;
    expect((await grant(request("grants", { resource, capability: "execute", grantee: service.subject }))).status).toBe(200);
    const approval = await createDelegation(user, { service: { id: service.subject.id, client_id: service.clientId }, job_id: "retirement-job",
      expires_at: new Date(Date.now() + 3600000).toISOString(), scope: [{ resource, action: "execute" }] }, ctx, randomUUID());
    const retirement = () => retire(request("resources", { expected_owner_version: saved.owner_version }, false, "DELETE"), params(resource.id));
    const response = await retirement(); expect(response.status).toBe(200);
    const receipt = await response.json(); expect(receipt).toMatchObject({ state: "retired", retired_by: user.subject, retired_at: expect.any(String) });
    expect(await (await retirement()).json()).toEqual(receipt);
    expect(await (await inspect(request("resources", undefined, false, "GET"), params(resource.id))).json()).toEqual(receipt);
    for (const action of ["execute", "owner", "grant:execute"]) {
      expect(await (await check(request("check", { resource, action }))).json()).toMatchObject({ decision: "DENY", via: "resource_retired", retriable: false });
    }
    expect(await (await query(request("query", { resource_type: "app_resource", action: "execute", ids: [resource.id] }, true))).json()).toEqual({ ids: [] });
    expect((await grant(request("grants", { resource, capability: "execute", grantee: service.subject }))).status).toBe(403);
    expect(await authorizeDelegated(approval._id, service, { resource, action: "execute", job_id: "retirement-job" }, {})).toMatchObject({ decision: "DENY" });
    expect((await register(request("resources", { ...businessKey, local_id: "retirement" }))).status).toBe(409);
    expect((await move(saved)).status).toBe(409);
    session("unrelated-user"); expect((await retirement()).status).toBe(403);
    expect((await inspect(request("resources", undefined, false, "GET"), params(resource.id))).status).toBe(403);
    expect(mockAudit.mock.calls.some(([event]) => event.lifecycle?.operation === "retire" && event.registration?.state === "retired")).toBe(true);
  });

  it("does not publish a graph allow if another replica retires the resource in flight", async () => {
    const saved = await create("retirement-in-flight");
    let retired = false;
    global.fetch = async (url, options) => {
      const response = await realFetch(url, options);
      if (!retired && String(url).endsWith("/check")) {
        retired = true;
        await peer.db(mockDb.databaseName).collection("access_resources").updateOne({ _id: saved.resource.id }, { $set: { state: "retired" } });
      }
      return response;
    };
    expect(await (await check(request("check", { resource: saved.resource, action: "execute" }))).json()).toMatchObject({ decision: "DENY", via: "resource_retired" });
  });

  it("requires an interactive same-origin owner and strictly validates lifecycle input", async () => {
    const saved = await create("lifecycle-validation");
    for (const body of [{}, { expected_owner_version: "invalid", owner: nextOwner },
      { expected_owner_version: saved.owner_version, owner: service.subject },
      { expected_owner_version: saved.owner_version, owner: { ...nextOwner, extra: true } },
      { expected_owner_version: saved.owner_version, owner: nextOwner, contextual_tuples: [] }]) {
      expect((await transfer(request("resources/owner", body), params(saved.resource.id))).status).toBe(400);
    }
    const body = { expected_owner_version: saved.owner_version, owner: nextOwner };
    expect((await transfer(request("resources/owner", body, true), params(saved.resource.id))).status).toBe(403);
    expect((await transfer(new NextRequest("https://example.test/api/access/resources/owner", { method: "POST", headers: { origin: "https://other.example.test", "content-type": "application/json" }, body: JSON.stringify(body) }), params(saved.resource.id))).status).toBe(403);
    session("unrelated-user"); expect((await move(saved)).status).toBe(403);
    expect((await retire(request("resources", { expected_owner_version: saved.owner_version }, false, "DELETE"), params(saved.resource.id))).status).toBe(403);
  });
});
