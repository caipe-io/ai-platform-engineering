/** @jest-environment node */
import { NextRequest } from "next/server";
import { ApiError } from "@/lib/api-error";
import { POST, DELETE } from "../route";

const mockAuth = jest.fn();
const mockAuthorize = jest.fn();
const mockGrant = jest.fn();
const mockRevoke = jest.fn();
jest.mock("@/lib/api-middleware", () => ({ getAuthFromBearerOrSession: (...args: unknown[]) => mockAuth(...args) }));
jest.mock("@/lib/authz", () => ({
  authorize: (...args: unknown[]) => mockAuthorize(...args),
  grant: (...args: unknown[]) => mockGrant(...args),
  revoke: (...args: unknown[]) => mockRevoke(...args),
}));
jest.mock("@/lib/authz/audit", () => ({ emitGrantAudit: jest.fn() }));

function request(method = "POST"): NextRequest {
  return new NextRequest("https://example.test/api/authz/v1/grants", {
    method, headers: { "content-type": "application/json" },
    body: JSON.stringify({ resource: { type: "conversation", id: "conversation-primary" },
      grantee: { type: "user", id: "subject-secondary" }, capability: "read" }),
  });
}
beforeEach(() => {
  jest.resetAllMocks();
  mockAuth.mockResolvedValue({ session: { sub: "subject-primary" } });
  mockAuthorize.mockResolvedValue({ decision: "ALLOW", reason: "OK", retriable: false });
});

it("returns a non-retriable privacy denial after management authorization", async () => {
  mockGrant.mockRejectedValue(new ApiError("Private evidence cannot be shared", 409, "PERSONAL_CONTEXT_PRIVATE"));
  const response = await POST(request());
  expect(response.status).toBe(409);
  expect(await response.json()).toMatchObject({ code: "PERSONAL_CONTEXT_PRIVATE", retriable: false });
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(mockAuthorize.mock.invocationCallOrder[0]).toBeLessThan(mockGrant.mock.invocationCallOrder[0]);
  expect(mockGrant).toHaveBeenCalledTimes(1);
});

it("does not attempt a grant before management permission is established", async () => {
  mockAuthorize.mockResolvedValue({ decision: "DENY", reason: "NO_CAPABILITY", retriable: false });
  expect((await POST(request())).status).toBe(403);
  expect(mockGrant).not.toHaveBeenCalled();
});

it("keeps private-history grant revocation available", async () => {
  expect((await DELETE(request("DELETE"))).status).toBe(200);
  expect(mockRevoke).toHaveBeenCalledTimes(1);
  expect(mockGrant).not.toHaveBeenCalled();
});
