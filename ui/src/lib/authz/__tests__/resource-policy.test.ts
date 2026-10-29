/** @jest-environment node */
import { createOpenFgaAdmin, createOpenFgaEngine, checkDelegationPermission } from "../engines/openfga";
import { registeredResourceGate } from "../resource-policy";
import { HttpAuthzError } from "../errors";
const mockRead = jest.fn(); const mockDefinition = jest.fn();
jest.mock("../resource-types", () => ({ appResourceDefinition: (...args: unknown[]) => mockDefinition(...args), validateRegisteredAction: jest.fn() }));
jest.mock("../resource-store", () => ({ readRegisteredResource: (...args: unknown[]) => mockRead(...args) }));
const resource = { type: "app_resource" as const, id: "12345678-1234-4000-8000-123456789012" };
const request = { resource, subject: { type: "user" as const, id: "test-user" }, action: "execute" };
const originalEnv = { ...process.env };
beforeEach(() => { jest.clearAllMocks(); process.env.OIDC_ISSUER = "https://identity.example.test"; mockDefinition.mockReturnValue({}); });
afterAll(() => { process.env = originalEnv; });
it("does not add a metadata dependency to core resource types", async () => {
  expect(await registeredResourceGate({ type: "agent", id: "example" })).toBeNull();
  expect(mockRead).not.toHaveBeenCalled();
});
it.each(["pending", "invalid-state"])("blocks %s before check, query, delegation and grant paths reach OpenFGA", async (state) => {
  mockRead.mockResolvedValue({ state, issuer: process.env.OIDC_ISSUER, app_id: "example-service", resource_type: "agent-sandbox" });
  const engine = createOpenFgaEngine();
  expect(await engine.check(request)).toMatchObject({ decision: "DENY", via: "resource_pending" });
  expect((await engine.batchCheck(request.subject, "execute", "app_resource", [resource.id])).get(resource.id)).toMatchObject({ decision: "DENY" });
  expect(await checkDelegationPermission(request, AbortSignal.timeout(1000))).toMatchObject({ decision: "DENY" });
  await expect(createOpenFgaAdmin().grant({ resource, grantee: request.subject, capability: "execute" })).rejects.toMatchObject({ status: 503 });
});
it("fails closed on missing resources, disabled installations, issuer change and Mongo outage", async () => {
  mockRead.mockResolvedValue(null);
  expect(await registeredResourceGate(resource)).toMatchObject({ via: "resource_not_registered" });
  mockRead.mockResolvedValue({ state: "active", issuer: process.env.OIDC_ISSUER, app_id: "example-service" });
  mockDefinition.mockImplementationOnce(() => { throw new HttpAuthzError(403, "FORBIDDEN", "Disabled"); });
  expect(await registeredResourceGate(resource)).toMatchObject({ via: "installation_disabled" });
  mockRead.mockResolvedValue({ state: "active", issuer: "https://other.example.test" });
  expect(await registeredResourceGate(resource)).toMatchObject({ via: "resource_issuer_mismatch" });
  mockRead.mockRejectedValue(new Error("Mongo unavailable"));
  expect(await registeredResourceGate(resource)).toMatchObject({ reason: "AUTHZ_UNAVAILABLE" });
});
it("does not use graph-only reverse lookup to bypass registry availability", async () => {
  expect(await createOpenFgaEngine().listObjects(request.subject, "execute", "app_resource")).toEqual({ ids: new Set(), reason: "AUTHZ_UNAVAILABLE" });
});
it("rejects ownership and public wildcard writes through the generic grant API", async () => {
  await expect(createOpenFgaAdmin().grant({ resource, grantee: request.subject, capability: "owner" })).rejects.toMatchObject({ status: 400 });
  await expect(createOpenFgaAdmin().revoke({ resource, grantee: { type: "everyone" }, capability: "execute" })).rejects.toMatchObject({ status: 400 });
  expect(mockRead).not.toHaveBeenCalled();
});
