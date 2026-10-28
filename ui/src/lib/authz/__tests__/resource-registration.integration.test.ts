/** @jest-environment node */
import { randomUUID } from "crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { request as httpRequest } from "node:http";
import { MongoClient, type Db } from "mongodb";
import { NextRequest } from "next/server";
import manifest from "../../../../examples/agentic-apps/service-only/manifest.json";
import exampleType from "../../../../examples/agentic-apps/service-only/model.json";
import model from "../../../../../charts/ai-platform-engineering/charts/openfga/authorization-model.json";
import { POST as register } from "@/app/api/access/resources/route";
import { GET as inspect } from "@/app/api/access/resources/[id]/route";
import { POST as check } from "@/app/api/access/check/route";
import { POST as query } from "@/app/api/access/query/route";
import { POST as grant, DELETE as revokeGrant } from "@/app/api/access/grants/route";
import { createDelegation, authorizeDelegated, revokeDelegation } from "../index";
import { readRegisteredResource, registeredResourceId, reserveResource } from "../resource-store";
import { resolveOpenFgaModelId, resetOpenFgaStoreIdCacheForTests } from "../engines/openfga-client";
import { __resetAdapterStateForTests } from "../engines/openfga";

jest.mock("@/native-extensions/manifests.generated", () => {
  const primary = jest.requireActual("../../../../examples/agentic-apps/service-only/manifest.json");
  return { installedAgenticAppManifests: [primary, { ...primary, id: "secondary-service",
    authorization: { ...primary.authorization, module: "secondary-service" } }], installedLegacyNativeExtensionIds: [] };
});
jest.mock("@/native-extensions/authorization.generated", () => {
  const core = jest.requireActual("../../../../../charts/ai-platform-engineering/charts/openfga/authorization-model.json");
  const primary = jest.requireActual("../../../../examples/agentic-apps/service-only/model.json");
  return { bundledAuthorizationModel: { ...core, type_definitions: [...core.type_definitions, primary,
    { ...primary, type: "secondary_sandbox", metadata: { ...primary.metadata, module: "secondary-service" } }] },
    installedAuthorizationModules: [{ appId: "example-service", module: "example-service", packageName: "@example/service-policy", version: "1.0.0" },
      { appId: "secondary-service", module: "secondary-service", packageName: "@example/secondary-policy", version: "1.0.0" }] };
});
let mockDb: Db;
const mockSession = jest.fn(); const mockJwt = jest.fn(); const mockAudit = jest.fn();
const mockLegacyAuth = jest.fn((...args: unknown[]) => { throw new Error(`Unexpected legacy authentication (${args.length} arguments)`); });
jest.mock("@/lib/mongodb", () => ({ isMongoDBConfigured: true, getCollection: (name: string) => mockDb.collection(name) }));
jest.mock("@/lib/api-middleware", () => ({ getAuthenticatedUser: (...args: unknown[]) => mockSession(...args),
  getAuthFromBearerOrSession: (...args: unknown[]) => mockLegacyAuth(...args) }));
jest.mock("@/lib/jwt-validation", () => ({ validatePlatformBearerJWT: (...args: unknown[]) => mockJwt(...args) }));
jest.mock("@/lib/audit", () => ({ getAuditClient: () => ({ append: (...args: unknown[]) => mockAudit(...args) }) }));

const mongoUri = process.env.CAS_RESOURCE_TEST_MONGODB_URI;
const fgaUrl = process.env.CAS_RESOURCE_TEST_OPENFGA_URL;
const describeIntegration = mongoUri && fgaUrl ? describe : describe.skip;
const originalEnv = { ...process.env };
const originalFetch = global.fetch;
// The global Jest setup replaces fetch with a stub. Use real HTTP for this
// integration suite rather than accidentally proving a mocked graph decision.
const realFetch: typeof fetch = async (input, options = {}) => new Promise((resolve, reject) => {
  const pending = httpRequest(String(input), { method: options.method, headers: options.headers as Record<string, string>,
    signal: options.signal ?? undefined }, (response) => {
    const chunks: Buffer[] = [];
    response.on("data", (chunk: Buffer) => chunks.push(chunk));
    response.on("end", () => resolve(new Response(response.statusCode === 204 ? null : Buffer.concat(chunks), { status: response.statusCode })));
    response.on("error", reject);
  });
  pending.on("error", reject);
  pending.end(typeof options.body === "string" ? options.body : undefined);
});
const issuer = "https://identity.example.test";
const user = { issuer, subject: { type: "user" as const, id: "test-user" }, clientId: "browser", expiresAt: 10 ** 10 };
const service = { issuer, subject: { type: "service_account" as const, id: "service-subject" }, clientId: "example-client", expiresAt: 10 ** 10 };
const ctx = { caller: user.subject, tenantId: "primary", correlationId: "example-trace" };
const nativeType = "example_agent_sandbox";
const registration = { resource: { type: nativeType, id: "example-record" } };

function request(path: string, body: unknown, bearer = false, method = "POST") {
  return new NextRequest(`https://example.test/api/access/${path}`, { method,
    headers: { origin: "https://example.test", "content-type": "application/json", ...(bearer ? { authorization: "Bearer service-token" } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}
function apps(enabled = true) {
  return { agentic_apps: { packages: [],
  installations: [{ app_id: manifest.id, enabled, visible: false, bindings: { serviceAccountClientId: service.clientId } },
    { app_id: "secondary-service", enabled: true, visible: false, bindings: { serviceAccountClientId: "secondary-client" } }] } };
}

describeIntegration("registered resources with real MongoDB and OpenFGA", () => {
  let client: MongoClient; let peer: MongoClient; let storeId: string; let directory: string; let configFile: string; let publishedModelId: string;
  async function fga(path: string, body?: unknown, method = "POST") {
    if (method === "POST" && /\/(write|check|batch-check)$/.test(path)) {
      body = { ...(body as object), authorization_model_id: publishedModelId };
    }
    const response = await realFetch(`${fgaUrl}${path}`, { method, headers: { "content-type": "application/json" },
      ...(body ? { body: JSON.stringify(body) } : {}) });
    if (!response.ok) throw new Error(`OpenFGA test setup: ${response.status} ${await response.text()}`);
    return response.status === 204 ? {} : response.json();
  }
  beforeAll(async () => {
    directory = mkdtempSync(join(tmpdir(), "cas-resource-integration-")); configFile = join(directory, "apps.json");
    client = await new MongoClient(mongoUri!).connect(); peer = await new MongoClient(mongoUri!).connect();
    mockDb = client.db(`cas_resources_test_${randomUUID().replaceAll("-", "")}`);
    storeId = (await fga("/stores", { name: "cas-resource-test" })).id;
    const published = await fga(`/stores/${storeId}/authorization-models`, { ...model,
      type_definitions: [...model.type_definitions, exampleType, { ...exampleType, type: "secondary_sandbox",
        metadata: { ...exampleType.metadata, module: "secondary-service" } }] });
    publishedModelId = published.authorization_model_id;
    process.env.OPENFGA_AUTHORIZATION_MODEL_ID = publishedModelId;
    Object.assign(process.env, { OIDC_ISSUER: issuer, OIDC_CLIENT_ID: "browser", NEXTAUTH_URL: "https://example.test",
      OPENFGA_HTTP: fgaUrl, OPENFGA_STORE_ID: storeId, OPENFGA_RECONCILE_ENABLED: "true",
      AGENTIC_APPS_INSTALL_ENABLED: "true", AGENTIC_APPS_CONFIG_PATH: configFile, AUDIT_FULL_FIDELITY_ALLOWS: "true" });
  });
  beforeEach(() => {
    jest.clearAllMocks(); global.fetch = realFetch; __resetAdapterStateForTests();
    process.env.OPENFGA_AUTHORIZATION_MODEL_ID = publishedModelId; resetOpenFgaStoreIdCacheForTests();
    writeFileSync(configFile, JSON.stringify(apps()));
    mockSession.mockResolvedValue({ session: { principalType: "oidc_user", sub: user.subject.id, role: "user", org: "primary", expiresAt: user.expiresAt } });
    mockJwt.mockResolvedValue(service);
  });
  afterAll(async () => {
    global.fetch = originalFetch;
    try { if (storeId) await fga(`/stores/${storeId}`, undefined, "DELETE"); }
    finally {
      if (mockDb) await mockDb.dropDatabase(); await client?.close(); await peer?.close();
      if (directory) rmSync(directory, { recursive: true, force: true });
      process.env = originalEnv; __resetAdapterStateForTests();
    }
  });

  it("resolves the build artifact even when a different model was published later", async () => {
    await fga(`/stores/${storeId}/authorization-models`, model);
    delete process.env.OPENFGA_AUTHORIZATION_MODEL_ID;
    await expect(resolveOpenFgaModelId()).resolves.toBe(publishedModelId);
    const response = await register(request("resources", { resource: { type: nativeType, id: "auto-selected" } }));
    expect(response.status).toBe(201);
    expect(await readRegisteredResource(`${nativeType}:auto-selected`)).toMatchObject({ model_id: publishedModelId });
  });

  it("registers a personal resource, reserves namespace identity and never implicitly grants the service", async () => {
    const response = await register(request("resources", registration));
    expect(response.status).toBe(201);
    const saved = await response.json();
    expect(saved).toMatchObject({ app_id: manifest.id, owner: user.subject, state: "active" });
    expect(saved.resource).toEqual(registration.resource);
    expect(await peer.db(mockDb.databaseName).collection("access_resources").findOne({ _id: `${nativeType}:${saved.resource.id}` }))
      .toMatchObject({ state: "active", creator: user.subject });
    expect(await (await check(request("check", { resource: saved.resource, action: "can_exec" }))).json()).toMatchObject({ decision: "ALLOW" });
    expect(await (await check(request("check", { resource: saved.resource, action: "can_exec" }, true))).json()).toMatchObject({ decision: "DENY" });
    expect(mockLegacyAuth).not.toHaveBeenCalled();
    expect(mockAudit.mock.calls.some(([event]) => event.type === "cas_grant" && event.registration?.app_id === manifest.id &&
      event.registration.owner.id === user.subject.id && event.registration.state === "active")).toBe(true);
    expect(await (await register(request("resources", registration))).json()).toEqual(saved);
    const secondary = await (await register(request("resources", { resource: { type: "secondary_sandbox", id: registration.resource.id } }))).json();
    expect(secondary.resource.type).not.toBe(saved.resource.type);
    expect((await register(request("resources", { ...registration, owner_team: "unrelated-team" }))).status).toBe(403);
  });

  it("atomically rejects competing owners across connections without replacing the winner", async () => {
    const id = registeredResourceId(nativeType, "concurrent");
    const pending = { _id: id, issuer, app_id: manifest.id, resource: { type: nativeType, id: "concurrent" }, model_id: process.env.OPENFGA_AUTHORIZATION_MODEL_ID!, prepared: false,
      creator: user.subject, owner: user.subject, state: "pending" as const, created_at: new Date().toISOString() };
    await Promise.all(Array.from({ length: 8 }, () => reserveResource(pending)));
    expect(await peer.db(mockDb.databaseName).collection("access_resources").countDocuments({ _id: id })).toBe(1);
    await expect(reserveResource({ ...pending, creator: { type: "user", id: "other-user" }, owner: { type: "user", id: "other-user" } }))
      .rejects.toMatchObject({ status: 409 });
    expect(await readRegisteredResource(id)).toMatchObject({ owner: user.subject });
  });

  it("keeps an ambiguous projection pending, blocks all access paths, then recovers on the same registration", async () => {
    const input = { resource: { type: nativeType, id: "pending-record" } };
    global.fetch = async (url, options) => String(url).endsWith("/write") ? new Response("unavailable", { status: 503 }) : realFetch(url, options);
    const interrupted = await register(request("resources", input));
    expect(interrupted.status).toBe(503);
    const pending = await interrupted.json();
    expect(pending).toMatchObject({ state: "pending", resource: { type: nativeType }, retriable: true });
    global.fetch = realFetch;
    const id = registeredResourceId(input.resource.type, input.resource.id);
    expect(`${pending.resource.type}:${pending.resource.id}`).toBe(id);
    const resource = input.resource;
    expect(await readRegisteredResource(id)).toMatchObject({ state: "pending" });
    expect((await inspect(request(`resources/${id}`, undefined, false, "GET"), { params: Promise.resolve({ id }) })).status).toBe(200);
    expect((await check(request("check", { resource, action: "can_exec" }))).status).toBe(503);
    expect((await query(request("query", { resource_type: nativeType, action: "can_exec", ids: [resource.id] }))).status).toBe(503);
    expect((await grant(request("grants", { resource, relationship: "executor", grantee: service.subject }))).status).toBe(503);
    expect(await (await register(request("resources", input))).json()).toMatchObject({ resource, state: "active" });
  });

  it("never activates a storage-only registration while permission updates are disabled", async () => {
    const input = { resource: { type: nativeType, id: "writes-disabled" } };
    process.env.OPENFGA_RECONCILE_ENABLED = "false";
    try {
      expect((await register(request("resources", input))).status).toBe(503);
      expect(await readRegisteredResource(registeredResourceId(input.resource.type, input.resource.id)))
        .toMatchObject({ state: "pending" });
    } finally { process.env.OPENFGA_RECONCILE_ENABLED = "true"; }
    expect((await register(request("resources", input))).status).toBe(201);
  });

  it("rechecks team ownership and preserves bounded delegation after logout, revocation and app disablement", async () => {
    const team = "example-team";
    const tuple = { user: `user:${user.subject.id}`, relation: "member", object: `team:${team}` };
    await fga(`/stores/${storeId}/write`, { writes: { tuple_keys: [tuple] } });
    const saved = await (await register(request("resources", { resource: { type: nativeType, id: "team-record" }, owner_team: team }))).json();
    expect(saved.owner).toEqual({ type: "team", id: team });
    const intent = { resource: saved.resource, grantee: service.subject, relationship: "executor" };
    expect((await grant(request("grants", intent))).status).toBe(200);
    const approval = await createDelegation(user, { service: { id: service.subject.id, client_id: service.clientId },
      job_id: "example-job", expires_at: new Date(Date.now() + 3600000).toISOString(),
      scope: [{ resource: saved.resource, action: "can_exec" }] }, ctx, randomUUID());
    const work = { resource: saved.resource, action: "can_exec" as const, job_id: "example-job" };
    mockSession.mockRejectedValue(new Error("Browser logged out"));
    expect(await authorizeDelegated(approval._id, service, work, {})).toMatchObject({ decision: "ALLOW" });
    expect(await authorizeDelegated(approval._id, { ...service, clientId: "unbound-client" }, work, {})).toMatchObject({ decision: "DENY" });
    writeFileSync(configFile, JSON.stringify(apps(false)));
    expect(await authorizeDelegated(approval._id, service, work, {})).toMatchObject({ decision: "DENY" });
    writeFileSync(configFile, JSON.stringify(apps()));
    await fga(`/stores/${storeId}/write`, { deletes: { tuple_keys: [tuple] } });
    expect(await authorizeDelegated(approval._id, service, work, {})).toMatchObject({ reason: "USER_NOT_ALLOWED" });
    await revokeDelegation(approval._id, user, ctx);
    expect(await authorizeDelegated(approval._id, service, work, {})).toMatchObject({ reason: "DELEGATION_REVOKED" });
  });

  it("does not reuse a cached allow after grant revocation or installation disablement", async () => {
    const saved = await (await register(request("resources", { resource: { type: nativeType, id: "fresh-record" } }))).json();
    const permission = { resource: saved.resource, action: "can_exec" };
    const intent = { resource: saved.resource, grantee: service.subject, relationship: "executor" };
    expect((await grant(request("grants", intent))).status).toBe(200);
    expect(await (await check(request("check", permission, true))).json()).toMatchObject({ decision: "ALLOW" });
    expect((await revokeGrant(request("grants", intent, false, "DELETE"))).status).toBe(200);
    expect(await (await check(request("check", permission, true))).json()).toMatchObject({ decision: "DENY" });
    writeFileSync(configFile, JSON.stringify(apps(false)));
    expect(await (await check(request("check", permission))).json()).toMatchObject({ decision: "DENY", via: "installation_disabled" });
    expect((await grant(request("grants", intent))).status).toBe(403);
  });

  it("rejects forged owners/namespaces, bearer registration and undeployed integrations", async () => {
    for (const field of ["owner", "subject", "namespace", "resource_type", "app_id", "kind", "local_id"]) {
      expect((await register(request("resources", { ...registration, [field]: "forged" }))).status).toBe(400);
    }
    expect((await register(request("resources", { resource: { type: "unknown_sandbox", id: "unknown" } }))).status).toBe(400);
    expect((await register(request("resources", { ...registration, kind: "agent" }))).status).toBe(400);
    expect((await register(request("resources", registration, true))).status).toBe(403);
    expect((await register(new NextRequest("https://example.test/api/access/resources", { method: "POST",
      headers: { origin: "https://other.example.test", "content-type": "application/json" }, body: JSON.stringify(registration) }))).status).toBe(403);
    expect((await register(request("resources", { resource: { type: nativeType, id: "x".repeat(20000) } }))).status).toBe(400);
  });
  it("keeps simultaneous retries under the same native identity and owner", async () => {
    const input = { resource: { type: nativeType, id: "concurrent-registration" } };
    const responses = await Promise.all(Array.from({ length: 6 }, () => register(request("resources", input))));
    expect(responses.every((response) => [201, 503].includes(response.status))).toBe(true);
    expect(responses.some((response) => response.status === 201)).toBe(true);
    // A racing duplicate write may be unconfirmed; the same registration recovers.
    expect((await register(request("resources", input))).status).toBe(201);
    expect(await mockDb.collection("access_resources").countDocuments({ _id: `${nativeType}:${input.resource.id}` })).toBe(1);
    expect((await readRegisteredResource(`${nativeType}:${input.resource.id}`))?.owner).toEqual(user.subject);
  });

  it("fails native relationship writes closed when permission updates are disabled", async () => {
    const resource = { type: nativeType, id: "grant-disabled" };
    expect((await register(request("resources", { resource }))).status).toBe(201);
    process.env.OPENFGA_RECONCILE_ENABLED = "false";
    try {
      expect((await grant(request("grants", { resource, relationship: "executor", grantee: service.subject }))).status).toBe(503);
      expect(await (await check(request("check", { resource, action: "can_exec" }, true))).json()).toMatchObject({ decision: "DENY" });
    } finally { process.env.OPENFGA_RECONCILE_ENABLED = "true"; }
  });

  it("separates execution grants from termination grants even for an organization administrator", async () => {
    const resource = { type: nativeType, id: "separate-authority" };
    expect((await register(request("resources", { resource }))).status).toBe(201);
    await fga(`/stores/${storeId}/write`, { writes: { tuple_keys: [
      { user: "user:limited-user", relation: "execution_grantor", object: `${nativeType}:${resource.id}` },
      { user: "user:limited-user", relation: "admin", object: "organization:caipe" },
    ] } });
    mockSession.mockResolvedValue({ session: { principalType: "oidc_user", sub: "limited-user", role: "admin", expiresAt: user.expiresAt } });
    expect((await grant(request("grants", { resource, relationship: "executor", grantee: service.subject }))).status).toBe(200);
    expect((await grant(request("grants", { resource, relationship: "terminator", grantee: service.subject }))).status).toBe(403);
    expect(await (await check(request("check", { resource, action: "can_exec" }, true))).json()).toMatchObject({ decision: "ALLOW" });
    expect(await (await check(request("check", { resource, action: "can_terminate" }, true))).json()).toMatchObject({ decision: "DENY" });
    for (const relationship of ["owner", "can_grant_executor", "execution_grantor"]) {
      expect((await grant(request("grants", { resource, relationship, grantee: service.subject }))).status).toBe(400);
    }
    expect(mockAudit.mock.calls.some(([event]) => event.authorization_model_id === process.env.OPENFGA_AUTHORIZATION_MODEL_ID &&
      event.action === "can_grant_terminator" && event.outcome === "deny")).toBe(true);
  });

  it("does not adopt pre-existing graph relationships and preserves literal native IDs", async () => {
    const resource = { type: nativeType, id: "b64_example" };
    await fga(`/stores/${storeId}/write`, { writes: { tuple_keys: [
      { user: "user:prior-user", relation: "executor", object: `${nativeType}:${resource.id}` },
    ] } });
    expect((await register(request("resources", { resource }))).status).toBe(409);
    expect(await readRegisteredResource(`${nativeType}:${resource.id}`)).toMatchObject({ state: "pending", prepared: false });
    expect((await check(request("check", { resource, action: "can_exec" }))).status).toBe(503);
  });

  it("keeps decisions on the selected model when another model is published", async () => {
    const resource = { type: nativeType, id: "model-pin" };
    expect((await register(request("resources", { resource }))).status).toBe(201);
    const latest = { ...exampleType, relations: { ...exampleType.relations, can_exec: { this: {} } },
      metadata: { ...exampleType.metadata, relations: { ...exampleType.metadata.relations,
        can_exec: { directly_related_user_types: [{ type: "user" }] } } } };
    await fga(`/stores/${storeId}/authorization-models`, { ...model, type_definitions: [...model.type_definitions, latest] });
    expect(await (await check(request("check", { resource, action: "can_exec" }))).json()).toMatchObject({ decision: "ALLOW" });
  });

});
