/** @jest-environment node */
import { createOpenFgaAdmin, createOpenFgaEngine, checkDelegationPermission } from "../engines/openfga";
import { registeredResourceGate } from "../resource-policy";
const mockRead = jest.fn(); const mockApp = jest.fn();
jest.mock("../resource-store", () => ({ readRegisteredResource: (...args: unknown[]) => mockRead(...args) }));
jest.mock("@/lib/agentic-apps/service-binding", () => ({ resourceApp: (...args: unknown[]) => mockApp(...args) }));
jest.mock("../audit", () => ({ emitDelegationAudit: jest.fn() }));
const resource = { type: "app_resource" as const, id: "example" };
const request = { resource, subject: { type: "user" as const, id: "test-user" }, action: "read" as const };
beforeEach(() => { jest.clearAllMocks(); process.env.OIDC_ISSUER = "https://identity.example.test"; mockApp.mockReturnValue({}); });
it("does not add a metadata dependency to existing resource types", async () => {
  expect(await registeredResourceGate({ type: "agent", id: "example" })).toBeNull();
  expect(mockRead).not.toHaveBeenCalled();
});
it.each(["pending", "invalid-state"])("blocks %s before ordinary, batch, delegated and grant paths reach OpenFGA", async (state) => {
  mockRead.mockResolvedValue({ state, issuer: process.env.OIDC_ISSUER, app_id: "example-service" });
  const engine = createOpenFgaEngine();
  expect(await engine.check(request)).toMatchObject({ decision: "DENY", via: "resource_pending" });
  expect((await engine.batchCheck(request.subject, "read", "app_resource", [resource.id])).get(resource.id))
    .toMatchObject({ decision: "DENY" });
  expect(await checkDelegationPermission(request, AbortSignal.timeout(1000))).toMatchObject({ decision: "DENY" });
  await expect(createOpenFgaAdmin().grant({ resource, grantee: request.subject, capability: "read" }))
    .rejects.toMatchObject({ status: 503 });
});
it("fails closed on a missing resource, disabled app, issuer change or unavailable metadata", async () => {
  mockRead.mockResolvedValue(null);
  expect(await registeredResourceGate(resource)).toMatchObject({ via: "resource_not_registered" });
  mockRead.mockResolvedValue({ state: "active", issuer: process.env.OIDC_ISSUER, app_id: "example-service" });
  mockApp.mockReturnValue(null);
  expect(await registeredResourceGate(resource)).toMatchObject({ via: "installation_disabled" });
  mockApp.mockReturnValue({});
  mockRead.mockResolvedValue({ state: "active", issuer: "https://other.example.test" });
  expect(await registeredResourceGate(resource)).toMatchObject({ decision: "DENY" });
  mockRead.mockRejectedValue(new Error("Mongo unavailable"));
  expect(await registeredResourceGate(resource)).toMatchObject({ reason: "AUTHZ_UNAVAILABLE" });
});
it("refuses graph-only reverse lookup for registered resources", async () => {
  expect(await createOpenFgaEngine().listObjects(request.subject, "read", "app_resource"))
    .toEqual({ ids: new Set(), reason: "AUTHZ_UNAVAILABLE" });
});
it("does not let in-process grants or revokes change ownership behind the registry", async () => {
  const intent = { resource, grantee: request.subject, capability: "create" as const };
  await expect(createOpenFgaAdmin().grant(intent)).rejects.toMatchObject({ status: 400 });
  await expect(createOpenFgaAdmin().revoke(intent)).rejects.toMatchObject({ status: 400 });
  expect(mockRead).not.toHaveBeenCalled();
});
