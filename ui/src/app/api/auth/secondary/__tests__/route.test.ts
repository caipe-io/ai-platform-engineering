/** @jest-environment node */
import { NextRequest, NextResponse } from "next/server";
import { POST } from "../route";
const mockValidate = jest.fn();
let mockEnabled = true;
jest.mock("@/lib/auth/secondary-oidc", () => ({ isSecondaryOidcConfigured: () => mockEnabled, validateSecondaryOidcJWT: (...args: unknown[]) => mockValidate(...args) }));
jest.mock("@/lib/auth/secondary-identity-link", () => ({ SecondaryOidcIdentityLinkError: class extends Error {} }));
jest.mock("@/lib/api-middleware", () => ({
  ApiError: class extends Error { constructor(message: string, readonly status: number, readonly code: string) { super(message); } },
  successResponse: (data: unknown) => NextResponse.json({ success: true, data }),
  withErrorHandler: (fn: (r: NextRequest) => Promise<Response>) => async (r: NextRequest) => { try { return await fn(r); } catch (error) { const e = error as { status: number; code: string }; return NextResponse.json({ code: e.code }, { status: e.status || 500 }); } },
}));
const resource = "https://host.example.test/apps/example/api/mcp";
function request(body = JSON.stringify({ resource }), token = "Bearer example-token") {
  return new NextRequest("https://host.example.test/api/auth/secondary", { method: "POST", headers: token ? { authorization: token } : {}, body });
}
beforeEach(() => { mockEnabled = true; mockValidate.mockReset().mockResolvedValue({ sub: "canonical-user", email: "user@example.test", name: "Example", groups: ["admin"] }); });
it("returns only canonical identity and resource, without caching", async () => {
  const response = await POST(request());
  expect(await response.json()).toEqual({ success: true, data: { linked: true, resource, identity: { sub: "canonical-user", email: "user@example.test", name: "Example" } } });
  expect(response.headers.get("cache-control")).toBe("private, no-store");
});
it("is default-off and does not invoke validation", async () => {
  mockEnabled = false;
  expect((await POST(request())).status).toBe(404);
  expect(mockValidate).not.toHaveBeenCalled();
});
it("requires bearer authentication even if browser cookies are present", async () => {
  expect((await POST(request(undefined, ""))).status).toBe(401);
  expect(mockValidate).not.toHaveBeenCalled();
});
it.each(["not json", "null", "{}"])("rejects invalid input %s", async body => {
  expect((await POST(request(body))).status).toBe(400);
});
it("bounds the request body", async () => { expect((await POST(request(" ".repeat(4097)))).status).toBe(413); });
it("denies invalid tokens without exposing details", async () => {
  mockValidate.mockRejectedValue(new Error("private verifier detail"));
  const response = await POST(request());
  expect(response.status).toBe(401);
  expect(await response.text()).not.toContain("private verifier detail");
});
