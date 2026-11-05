/** @jest-environment node */
import { resolveUserIdentitiesByEmail } from "../user-identity-directory";
const mockRows = jest.fn();
jest.mock("@/lib/mongodb", () => ({ getCollection: async () => ({ find: () => ({ project: () => ({ toArray: () => mockRows() }) }) }) }));
it("rejects conflicting canonical subjects for first-link email resolution", async () => {
  mockRows.mockResolvedValue([
    { email: "user@example.test", keycloak_sub: "first-user" },
    { email: "user@example.test", keycloak_sub: "second-user" },
  ]);
  expect((await resolveUserIdentitiesByEmail(["user@example.test"], { requireUnique: true })).size).toBe(0);
});
it("allows duplicate records only when they name the same canonical subject", async () => {
  mockRows.mockResolvedValue([
    { email: "user@example.test", keycloak_sub: "same-user" },
    { email: "user@example.test", metadata: { keycloak_sub: "same-user" } },
  ]);
  expect((await resolveUserIdentitiesByEmail(["user@example.test"], { requireUnique: true })).get("user@example.test")?.subject).toBe("same-user");
});
it("preserves existing directory lookup behavior unless uniqueness is requested", async () => {
  mockRows.mockResolvedValue([{ email: "user@example.test", keycloak_sub: "first-user" }, { email: "user@example.test", keycloak_sub: "second-user" }]);
  expect((await resolveUserIdentitiesByEmail(["user@example.test"])).get("user@example.test")?.subject).toBe("second-user");
});
