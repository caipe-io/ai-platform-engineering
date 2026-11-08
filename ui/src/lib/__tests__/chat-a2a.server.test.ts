/** @jest-environment node */
import { NextResponse } from "next/server";
import { ApiError } from "@/lib/api-error";
import { availableChatA2AAgents, chatA2AAgent, prepareChatA2AExecution, requireChatA2AUse } from "../chat-a2a.server";

const mockUse = jest.fn();
const mockAdmin = jest.fn();
const mockReconcile = jest.fn();
const mockFind = jest.fn();
const mockFindOne = jest.fn();
const mockFilter = jest.fn();
const mockProxy = jest.fn();
jest.mock("@/lib/rbac/openfga-agent-authz", () => ({ requireAgentUsePermission: (...args: unknown[]) => mockUse(...args) }));
jest.mock("@/lib/rbac/openfga-agent-tools", () => ({ reconcileAgentRelationships: (...args: unknown[]) => mockReconcile(...args) }));
jest.mock("@/lib/rbac/resource-authz", () => ({ requireResourcePermission: (...args: unknown[]) => mockAdmin(...args), filterResourcesByPermission: (...args: unknown[]) => mockFilter(...args) }));
jest.mock("@/lib/rbac/organization", () => ({ caipeOrgKey: () => "example" }));
jest.mock("@/lib/mongodb", () => ({ getCollection: async () => ({ findOne: mockFindOne, find: mockFind }) }));
jest.mock("@/lib/harness-engine-proxy", () => ({ getHarnessEngineConfig: () => ({}), proxyHarnessEngine: (...args: unknown[]) => mockProxy(...args) }));
const auth = { subject: "owner", email: "owner@example.test" };
const entry = { _id: "remote-example", name: "Example remote", endpoint: "https://private.example.test", credential_source: { secret_ref: "private-reference" } };
const previous = process.env.HARNESS_ENGINE_DEEP_AGENTS_ENABLED;
beforeEach(() => {
  jest.resetAllMocks();
  process.env.HARNESS_ENGINE_DEEP_AGENTS_ENABLED = "true";
  mockFindOne.mockResolvedValue(entry);
  mockFind.mockReturnValue({ project: () => ({ sort: () => ({ toArray: async () => [entry] }) }) });
  mockUse.mockResolvedValue(null);
});
afterAll(() => { if (previous === undefined) delete process.env.HARNESS_ENGINE_DEEP_AGENTS_ENABLED; else process.env.HARNESS_ENGINE_DEEP_AGENTS_ENABLED = previous; });
it("returns safe catalog projections, never endpoints or credential references", async () => {
  const data = await availableChatA2AAgents(auth);
  expect(data[0]).toMatchObject({ _id: "a2a-remote-example", execution_harness_id: "a2a_remote" });
  expect(JSON.stringify(data)).not.toContain("private");
  expect(mockFind).toHaveBeenCalledWith({ enabled: { $ne: false } });
});
it("filters non-admin catalog entries using existing CAS agent Use permissions", async () => {
  mockAdmin.mockRejectedValue(new ApiError("Denied", 403));
  mockFilter.mockResolvedValue([]);
  expect(await availableChatA2AAgents(auth)).toEqual([]);
  expect(mockFilter).toHaveBeenCalledWith(expect.objectContaining({ sub: "owner" }), expect.any(Array), expect.objectContaining({ type: "agent", action: "use" }));
});
it("does not widen access for non-admins or authorization outages", async () => {
  mockUse.mockResolvedValue(NextResponse.json({}, { status: 403 }));
  mockAdmin.mockRejectedValue(new ApiError("Denied", 403));
  expect((await requireChatA2AUse(auth, "a2a-remote-example"))?.status).toBe(403);
  expect(mockReconcile).not.toHaveBeenCalled();
  mockUse.mockResolvedValue(NextResponse.json({}, { status: 503 }));
  expect((await requireChatA2AUse(auth, "a2a-remote-example"))?.status).toBe(503);
  expect(mockReconcile).not.toHaveBeenCalled();
});
it("bootstraps only organization-admin inheritance for an authorized registry admin", async () => {
  mockUse.mockResolvedValueOnce(NextResponse.json({}, { status: 403 })).mockResolvedValueOnce(null);
  expect(await requireChatA2AUse(auth, "a2a-remote-example")).toBeNull();
  expect(mockReconcile).toHaveBeenCalledWith({ agentId: "a2a-remote-example", nextAllowedTools: {}, organizationId: "example" });
});
it("uses a registry-only blueprint and leaves registry credentials out of Engine publications", async () => {
  mockProxy.mockResolvedValueOnce(new Response("{}", { status: 404 })).mockResolvedValueOnce(new Response("{}"));
  await prepareChatA2AExecution("a2a-remote-example", auth);
  const body = JSON.parse(mockProxy.mock.calls[1][3].body);
  expect(body.blueprint.harness.options).toEqual({ registry_id: "remote-example" });
  expect(JSON.stringify(body)).not.toContain("private");
});
it("rejects unavailable registry entries and conflicting pinned blueprints", async () => {
  mockFindOne.mockResolvedValueOnce(null);
  expect(await chatA2AAgent("a2a-remote-example")).toBeNull();
  expect(await chatA2AAgent("agent-primary")).toBeNull();
  mockProxy.mockResolvedValueOnce(Response.json({ data: { version: { blueprint: { harness: { id: "dynamic_agents" } } } } }));
  await expect(prepareChatA2AExecution("a2a-remote-example", auth)).rejects.toThrow("conflicting");
});
