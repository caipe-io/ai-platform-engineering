/** @jest-environment node */
import { NextRequest } from "next/server";
import { PolicyWritePendingError } from "../engine";
import { POST as grant, DELETE as revoke } from "@/app/api/access/grants/route";
import { POST as legacyGrant, DELETE as legacyRevoke } from "@/app/api/authz/v1/grants/route";

const mockChange = jest.fn();
jest.mock("@/lib/api-middleware", () => ({
  getAuthFromBearerOrSession: async () => ({ session: { sub: "test-user" } }),
}));
jest.mock("../index", () => ({
  PolicyWritePendingError: jest.requireActual("../engine").PolicyWritePendingError,
  authorize: async () => ({ decision: "ALLOW", reason: "OK" }),
  grant: (...args: unknown[]) => mockChange(...args),
  revoke: (...args: unknown[]) => mockChange(...args),
}));
jest.mock("../audit", () => ({ emitGrantAudit: jest.fn() }));

it.each([
  ["access", "POST", grant], ["access", "DELETE", revoke],
  ["authz/v1", "POST", legacyGrant], ["authz/v1", "DELETE", legacyRevoke],
])("RBAC-01.03 %s %s reports an unconfirmed change as pending without automatic retry", async (path, method, handler) => {
  mockChange.mockRejectedValueOnce(new PolicyWritePendingError());
  const request = new NextRequest(`https://example.test/api/${path}/grants`, {
    method,
    headers: { authorization: "Bearer example-token", "content-type": "application/json" },
    body: JSON.stringify({
      resource: { type: "system_config", id: "platform_settings" },
      capability: "manage", grantee: { type: "user", id: "secondary" },
    }),
  });
  const response = await handler(request);
  expect(response.status).toBe(503);
  expect(await response.json()).toEqual({
    code: "AUTHZ_WRITE_PENDING", retriable: false,
    error: expect.stringContaining("pending verification"),
  });
});
