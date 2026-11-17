const mockRequireResourcePermission = jest.fn();
const mockCollection = {
  findOne: jest.fn(),
  insertOne: jest.fn(),
  findOneAndUpdate: jest.fn(),
  find: jest.fn(),
};
jest.mock("@/lib/mongodb", () => ({ getCollection: async () => mockCollection }));
jest.mock("@/lib/api-middleware", () => ({
  ApiError: class ApiError extends Error { constructor(message: string, public statusCode = 500) { super(message); } },
  getAuthFromBearerOrSession: async () => ({ user: { email: "test-user@example.test" }, session: { sub: "test-user", role: "admin" } }),
  successResponse: (data: unknown, status = 200) => ({ status, json: async () => ({ success: true, data }) }),
  withErrorHandler: (handler: unknown) => handler,
}));
jest.mock("@/lib/remote-agent-auth", () => ({
  normalizeRemoteAgentCredentialSource: () => ({ kind: "caller_token", target: "header", name: "Authorization" }),
}));

jest.mock("@/lib/rbac/resource-authz", () => ({ requireResourcePermission: (...args: unknown[]) => mockRequireResourcePermission(...args) }));
jest.mock("@/lib/da-proxy", () => ({ authenticateRequest: async () => ({}), buildBackendHeaders: () => ({}) }));

import { ApiError } from "@/lib/api-middleware";
import { GET, POST } from "../route";
import { PUT, DELETE } from "../[id]/route";
import { POST as PROBE } from "../probe/route";
import { GET as DISCOVERY_CONFIG, POST as DISCOVER } from "../discovery/route";

const request = (body: unknown) => ({ json: async () => body }) as never;

beforeEach(() => {
  jest.clearAllMocks();
  mockRequireResourcePermission.mockReset().mockResolvedValue(undefined);
  process.env.CAIPE_ORG_KEY = "example";
  mockCollection.findOne.mockResolvedValue(null);
  mockCollection.insertOne.mockResolvedValue({});
  mockCollection.findOneAndUpdate.mockResolvedValue({ _id: "remote-example", streaming: true });
});

it.each([true, false, undefined])("persists opt-in streaming %s with an off default", async streaming => {
  await POST(request({ name: "Example", endpoint: "https://agent.example.test/", streaming }));
  expect(mockCollection.insertOne).toHaveBeenCalledWith(expect.objectContaining({ streaming: streaming === true }));
});

it.each(["true", 1, null])("rejects a non-boolean streaming flag %s", async streaming => {
  await expect(POST(request({ name: "Example", endpoint: "https://agent.example.test/", streaming }))).rejects.toThrow("Streaming must be a boolean");
  await expect(PUT(request({ streaming }), { params: Promise.resolve({ id: "remote-example" }) })).rejects.toThrow("Streaming must be a boolean");
});

it("updates streaming without changing other settings", async () => {
  await PUT(request({ streaming: true }), { params: Promise.resolve({ id: "remote-example" }) });
  expect(mockCollection.findOneAndUpdate).toHaveBeenCalledWith(
    expect.objectContaining({ _id: "remote-example" }),
    { $set: expect.objectContaining({ streaming: true }) },
    { returnDocument: "after" },
  );
});


it("uses CAS organization manage for registration and updates", async () => {
  await POST(request({ name: "Example", endpoint: "https://agent.example.test" }));
  await PUT(request({ streaming: true }), { params: Promise.resolve({ id: "remote-example" }) });
  expect(mockRequireResourcePermission).toHaveBeenCalledTimes(2);
  expect(mockRequireResourcePermission).toHaveBeenCalledWith(
    expect.objectContaining({ sub: "test-user" }),
    { type: "organization", id: "example", action: "manage" },
  );
});

it.each([403, 503])("blocks all remote mutations and probes on CAS failure %s, even for an admin session", async status => {
  mockRequireResourcePermission.mockRejectedValue(new ApiError("CAS refused", status));
  const context = { params: Promise.resolve({ id: "remote-example" }) };
  await expect(POST(request({}))).rejects.toThrow("CAS refused");
  await expect(PUT(request({}), context)).rejects.toThrow("CAS refused");
  await expect(DELETE(request({}), context)).rejects.toThrow("CAS refused");
  await expect(PROBE(request({}))).rejects.toThrow("CAS refused");
  await expect(DISCOVERY_CONFIG(request({}))).rejects.toThrow("CAS refused");
  await expect(DISCOVER(request({}))).rejects.toThrow("CAS refused");
  expect(mockCollection.insertOne).not.toHaveBeenCalled();
  expect(mockCollection.findOneAndUpdate).not.toHaveBeenCalled();
  expect(mockRequireResourcePermission).toHaveBeenCalledTimes(6);
});


it("returns metadata only when CAS denies management", async () => {
  mockRequireResourcePermission.mockRejectedValue(new ApiError("CAS refused", 403));
  const query = { project: jest.fn().mockReturnThis(), sort: jest.fn().mockReturnThis(), toArray: jest.fn().mockResolvedValue([]) };
  mockCollection.find.mockReturnValue(query);
  const result = await GET(request({}));
  expect(query.project).toHaveBeenCalledWith(expect.not.objectContaining({ endpoint: 1 }));
  expect(query.project).toHaveBeenCalledWith(expect.not.objectContaining({ credential_source: 1 }));
  expect(await result.json()).toEqual({ success: true, data: { items: [], can_manage_registry: false } });
});

it("does not downgrade a CAS outage to a metadata listing", async () => {
  mockRequireResourcePermission.mockRejectedValue(new ApiError("CAS unavailable", 503));
  await expect(GET(request({}))).rejects.toThrow("CAS unavailable");
  expect(mockCollection.find).not.toHaveBeenCalled();
});

it.each(["claude_code", "claude_agent_sdk", "google_adk", "deepagents", "unspecified"])("stores explicit framework display metadata %s", async framework => {
  await POST(request({ name: "Example", endpoint: "https://agent.example.test", framework }));
  expect(mockCollection.insertOne).toHaveBeenCalledWith(expect.objectContaining({ framework }));
  await PUT(request({ framework }), { params: Promise.resolve({ id: "remote-example" }) });
  const update = mockCollection.findOneAndUpdate.mock.calls[0][1].$set;
  expect(update.framework).toBe(framework);
  expect(update).not.toHaveProperty("endpoint");
  expect(update).not.toHaveProperty("credential_source");
  expect(update).not.toHaveProperty("execution_harness_id");
});

it.each([null, true, "unknown", "constructor", "__proto__"])("rejects unsupported framework metadata %s", async framework => {
  await expect(POST(request({ name: "Example", endpoint: "https://agent.example.test", framework }))).rejects.toThrow("Unknown agent framework");
  await expect(PUT(request({ framework }), { params: Promise.resolve({ id: "remote-example" }) })).rejects.toThrow("Unknown agent framework");
  expect(mockCollection.insertOne).not.toHaveBeenCalled();
  expect(mockCollection.findOneAndUpdate).not.toHaveBeenCalled();
});

it("preserves existing framework metadata when omitted by older clients", async () => {
  await PUT(request({ streaming: true }), { params: Promise.resolve({ id: "remote-example" }) });
  expect(mockCollection.findOneAndUpdate.mock.calls[0][1].$set).not.toHaveProperty("framework");
});
