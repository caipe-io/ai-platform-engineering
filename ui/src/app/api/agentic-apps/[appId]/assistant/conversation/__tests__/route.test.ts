/** @jest-environment node */
import { NextRequest, NextResponse } from "next/server";
import { MongoClient } from "mongodb";
import { randomUUID } from "node:crypto";

const mockAuth = jest.fn();
const mockApp = jest.fn();
const mockPermission = jest.fn();
const mockFind = jest.fn();
const mockCollection = jest.fn();
let mockEnabled = true;
let mockMongo = true;
jest.mock("@/lib/api-middleware", () => ({
  ApiError: jest.requireActual("@/lib/api-error").ApiError,
  getAuthFromBearerOrSession: (...args: unknown[]) => mockAuth(...args),
  withErrorHandler: (handler: (...args: unknown[]) => Promise<Response>) => async (...args: unknown[]) => {
    try { return await handler(...args); }
    catch (error) { return NextResponse.json({ error: (error as Error).message }, { status: (error as { statusCode?: number }).statusCode ?? 500 }); }
  },
}));
jest.mock("@/lib/agentic-apps/config", () => ({ isAgenticAppsEnabled: () => mockEnabled, getConfiguredAgenticApp: (...args: unknown[]) => mockApp(...args) }));
jest.mock("@/lib/mongodb", () => ({ get isMongoDBConfigured() { return mockMongo; }, getCollection: (...args: unknown[]) => mockCollection(...args) }));
jest.mock("@/lib/rbac/openfga-agent-authz", () => ({ requireAgentUsePermission: (...args: unknown[]) => mockPermission(...args) }));
jest.mock("@/lib/rbac/resource-authz", () => ({}));
import { GET } from "../route";

const binding = { conversation_surface: "agentic-app", agentic_app_id: "example", agentic_app_agent_id: "example-agent" };
const app = (includeLegacy = false) => ({
  installation: { installed: true, enabled: true },
  manifest: { access: { requiredRoles: ["user"] }, ui: { profiles: [{ id: "hosted" }],
    assistant: { agentId: "example-agent", hostOptions: { includeLegacyAgentHistory: includeLegacy } } } },
});
const get = (query = "") => GET(new NextRequest(`https://host.example.test/api/agentic-apps/example/assistant/conversation${query}`), {
  params: Promise.resolve({ appId: "example" }),
});
beforeEach(() => {
  jest.clearAllMocks(); mockEnabled = true; mockMongo = true;
  mockAuth.mockResolvedValue({ user: { email: "test-user@example.test", role: "user" },
    session: { sub: "test-user", role: "user", principalType: "oidc_user", isServiceAccount: false } });
  mockApp.mockReturnValue(app()); mockPermission.mockResolvedValue(null);
  mockFind.mockResolvedValue({ _id: "saved-chat", metadata: binding });
  mockCollection.mockResolvedValue({ findOne: mockFind });
});

it("finds one owned bound web chat without counting or paging, ignoring caller binding overrides", async () => {
  const response = await get("?agent_id=secondary&includeLegacyAgentHistory=true");
  expect(response.status).toBe(200);
  expect(response.headers.get("Cache-Control")).toBe("private, no-store");
  expect((await response.json()).data.conversation).toMatchObject({ _id: "saved-chat", access_level: "owner" });
  expect(mockFind).toHaveBeenCalledTimes(1);
  const [query, options] = mockFind.mock.calls[0];
  expect(query.$and).toEqual([
    { $or: [{ owner_subject: "test-user" }, { owner_id: "test-user@example.test" }] },
    { participants: { $elemMatch: { type: "agent", id: "example-agent" } } },
    { $or: [Object.fromEntries(Object.entries(binding).map(([k, v]) => [`metadata.${k}`, v]))] },
    { $or: [{ client_type: "webui" }, { client_type: { $exists: false } }] },
  ]);
  expect(query).toMatchObject({ deleted_at: null, is_archived: false, source: { $in: ["web", null] } });
  expect(query.$nor).toHaveLength(4);
  expect(options.sort).toEqual({ is_pinned: -1, updated_at: -1, _id: -1 });
  expect(mockPermission).toHaveBeenCalledWith({ subject: "test-user", agentId: "example-agent", email: "test-user@example.test" });
});

it("returns no conversation for a new reader", async () => {
  mockFind.mockResolvedValue(null);
  expect((await (await get()).json()).data).toEqual({ conversation: null });
});
it("takes the legacy opt-in only from the installed app", async () => {
  mockApp.mockReturnValue(app(true)); await get();
  expect(mockFind.mock.calls[0][0].$and[2].$or[1]).toEqual({
    "metadata.agentic_app_id": { $exists: false }, "metadata.agentic_app_agent_id": { $exists: false },
    "metadata.conversation_surface": { $ne: "agentic-app" },
  });
});
it.each([403, 503])("does not expose history when agent use fails with %s", async status => {
  mockPermission.mockResolvedValue(NextResponse.json({ error: "Agent unavailable" }, { status }));
  expect((await get()).status).toBe(status); expect(mockFind).not.toHaveBeenCalled();
});
it("rejects app roles before accessing history", async () => {
  mockAuth.mockResolvedValue({ user: { email: "test-user@example.test", role: "viewer" }, session: { sub: "test-user", role: "viewer", principalType: "oidc_user" } });
  expect((await get()).status).toBe(403); expect(mockCollection).not.toHaveBeenCalled();
});
it.each([null, { ...app(), installation: { installed: true, enabled: false } },
  { ...app(), manifest: { ...app().manifest, ui: { profiles: [] } } }])("rejects unavailable assistant installations: %j", async value => {
  mockApp.mockReturnValue(value); expect((await get()).status).toBe(404); expect(mockCollection).not.toHaveBeenCalled();
});
it.each([{ sub: "service", principalType: "service_account", isServiceAccount: true }, { principalType: "oidc_user" }])("requires an interactive stable identity: %j", async session => {
  mockAuth.mockResolvedValue({ user: { email: "test-user@example.test" }, session });
  expect((await get()).status).toBe(403); expect(mockFind).not.toHaveBeenCalled();
});
it("reports unavailable storage as an error rather than missing history", async () => {
  mockMongo = false; expect((await get()).status).toBe(503); expect(mockCollection).not.toHaveBeenCalled();
});

// Reuse CI's disposable Mongo service, never the deployment database URI.
const mongoUri = process.env.APP_ASSISTANT_TEST_MONGODB_URI ?? process.env.AUTH_SESSION_TEST_MONGODB_URI;
const mongoTest = mongoUri ? it : it.skip;
mongoTest("restores the matching chat beyond 12,000 unrelated chats and excludes inaccessible or non-web records", async () => {
  const client = await new MongoClient(mongoUri!).connect();
  const db = client.db(`assistant_startup_test_${randomUUID().replaceAll("-", "")}`);
  try {
    const collection = db.collection("conversations");
    mockCollection.mockResolvedValue(collection);
    const own = { owner_id: "test-user@example.test", owner_subject: "test-user", is_archived: false, is_pinned: false,
      client_type: "webui", source: "web", participants: [{ type: "agent", id: "example-agent" }], metadata: binding };
    const decoys = [
      { owner_id: "secondary@example.test", owner_subject: "secondary", sharing: { shared_with: ["test-user@example.test"] } },
      { metadata: { ...binding, agentic_app_id: "secondary" } }, { is_archived: true }, { deleted_at: new Date() },
      { client_type: "webex" }, { client_type: "api" }, { source: "autonomous" },
      { metadata: { ...binding, source: "autonomous" } }, { metadata: { ...binding, schedule_id: "schedule" } },
      { title: "[Autonomous] example" }, { participants: [{ type: "agent", id: "secondary-agent" }] },
      { participants: [{ type: "agent", id: "secondary-agent" }, { type: "agent", id: "example-agent" }] },
    ];
    await collection.insertMany([
      { ...own, _id: "saved-chat", updated_at: new Date("2026-01-01") },
      ...decoys.map((value, i) => ({ ...own, _id: `excluded-${i}`, updated_at: new Date("2026-02-01"), ...value })),
      ...Array.from({ length: 12_000 }, (_, i) => ({ ...own, _id: `unrelated-${i}`, updated_at: new Date("2026-03-01"),
        ...(i % 2 ? { participants: [{ type: "agent", id: "secondary-agent" }] }
          : { metadata: { ...binding, agentic_app_id: "secondary" } }) })),
    ] as never[]);
    await collection.createIndex({ owner_id: 1, "participants.id": 1, "metadata.agentic_app_id": 1, is_pinned: -1, updated_at: -1, _id: -1 });
    await collection.createIndex({ owner_subject: 1, "participants.id": 1, "metadata.agentic_app_id": 1, is_pinned: -1, updated_at: -1, _id: -1 });
    const lookup = jest.spyOn(collection, "findOne");
    expect((await (await get()).json()).data.conversation._id).toBe("saved-chat");
    expect(lookup).toHaveBeenCalledTimes(1);
    const [query, options] = lookup.mock.calls[0];
    const explained = await collection.find(query!).sort(options!.sort!).limit(1).explain("executionStats");
    expect(explained.executionStats.nReturned).toBe(1);
    expect(explained.executionStats.totalDocsExamined).toBeLessThan(50);
    console.info("Shared assistant synthetic history lookup", {
      unrelatedChats: 12_000, lookupCalls: lookup.mock.calls.length,
      docsExamined: explained.executionStats.totalDocsExamined,
    });
    await collection.insertOne({ ...own, _id: "empty-chat", updated_at: new Date("2026-04-01"), metadata: { ...binding, total_messages: 0 } } as never);
    expect((await (await get()).json()).data.conversation._id).toBe("empty-chat");
    await collection.insertOne({ ...own, _id: "legacy-chat", updated_at: new Date("2026-05-01"), metadata: {} } as never);
    expect((await (await get()).json()).data.conversation._id).toBe("empty-chat");
    mockApp.mockReturnValue(app(true));
    expect((await (await get()).json()).data.conversation._id).toBe("legacy-chat");
  } finally { await db.dropDatabase(); await client.close(); }
}, 30_000);
