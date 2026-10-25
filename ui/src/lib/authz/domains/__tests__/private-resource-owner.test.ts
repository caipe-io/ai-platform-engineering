/** @jest-environment node */
const mockFindOne = jest.fn();
jest.mock("@/lib/mongodb", () => ({ getCollection: async () => ({ findOne: mockFindOne }) }));
jest.mock("@/lib/feature-flags/private-resources", () => ({ isPrivateResourcesEnabled: () => true }));
import { privateResourcePreCheck } from "../private-resource";

it.each(["agent", "mcp_server", "secret_ref"] as const)("rejects a non-owner before capability or admin bypass for %s", async (type) => {
  mockFindOne.mockResolvedValue({ visibility: "private", owner_subject: "owner-user", owner: { type: "user", id: "owner-user" } });
  const request = { subject: { type: "user" as const, id: "other-user" }, resource: { type, id: "example" }, action: "use" as const,
    trustedContext: { interaction: { source: "web" as const, conversationKind: "personal" as const, verified: true } } };
  expect(await privateResourcePreCheck(request)).toMatchObject({ decision: "DENY", reason: "NO_CAPABILITY" });
  expect(await privateResourcePreCheck({ ...request, subject: { type: "user", id: "owner-user" } })).toBeNull();
});
