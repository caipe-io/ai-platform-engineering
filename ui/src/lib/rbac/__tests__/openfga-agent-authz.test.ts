/** @jest-environment node */
import { authorize } from "@/lib/authz";
import { requireAgentUsePermission } from "../openfga-agent-authz";

jest.mock("@/lib/authz", () => ({ authorize: jest.fn() }));
const mockAuthorize = jest.mocked(authorize);

beforeEach(() => {
  jest.clearAllMocks();
  mockAuthorize.mockResolvedValue({ decision: "ALLOW", reason: "OK", retriable: false });
});

it.each([false, true])("asks CAS once with the authenticated namespace (service account: %s)", async (isServiceAccount) => {
  const response = await requireAgentUsePermission({
    subject: "test-user", agentId: "example", email: "test-user@example.com", isServiceAccount,
    tenantId: "primary", correlationId: "test-correlation",
    traceparent: "00-11111111111111111111111111111111-2222222222222222-01",
  });
  expect(response).toBeNull();
  expect(mockAuthorize).toHaveBeenCalledTimes(1);
  expect(mockAuthorize).toHaveBeenCalledWith(
    { subject: { type: isServiceAccount ? "service_account" : "user", id: "test-user" },
      resource: { type: "agent", id: "example" }, action: "use" },
    { tenantId: "primary", correlationId: "test-correlation",
      traceId: "11111111111111111111111111111111", spanId: expect.stringMatching(/^[a-f0-9]{16}$/) },
  );
});

it("returns the existing deny envelope without retrying with email or teams", async () => {
  mockAuthorize.mockResolvedValue({ decision: "DENY", reason: "NO_CAPABILITY", retriable: false });
  const response = await requireAgentUsePermission({
    subject: "test-user", agentId: "example", email: "test-user@example.com",
  });
  expect(response?.status).toBe(403);
  expect(await response?.json()).toEqual({
    success: false, error: "Permission denied", code: "agent#use",
    reason: "pdp_denied", action: "contact_admin",
  });
  expect(mockAuthorize).toHaveBeenCalledTimes(1);
});

it.each(["unavailable", "unexpected error"])("returns 503 on %s, without a fallback", async (failure) => {
  if (failure === "unavailable") {
    mockAuthorize.mockResolvedValue({ decision: "DENY", reason: "AUTHZ_UNAVAILABLE", retriable: true });
  } else {
    mockAuthorize.mockRejectedValue(new Error("unexpected CAS failure"));
  }
  const response = await requireAgentUsePermission({ subject: "test-user", agentId: "example" });
  expect(response?.status).toBe(503);
  expect(await response?.json()).toEqual({
    success: false, error: "Authorization service is temporarily unavailable. Please try again in a moment.",
    code: "PDP_UNAVAILABLE", reason: "pdp_unavailable", action: "retry",
  });
  expect(mockAuthorize).toHaveBeenCalledTimes(1);
});

it.each([undefined, "", "test-user@example.com", "user:test-user"])("rejects invalid subject %s before CAS", async (subject) => {
  const response = await requireAgentUsePermission({ subject, agentId: "example" });
  expect(response?.status).toBe(401);
  expect(await response?.json()).toMatchObject({ success: false, code: "NOT_SIGNED_IN", action: "sign_in" });
  expect(mockAuthorize).not.toHaveBeenCalled();
});

it.each([undefined, "", "../example", 123])("rejects invalid agent %s before CAS", async (agentId) => {
  const response = await requireAgentUsePermission({ subject: "test-user", agentId });
  expect(response?.status).toBe(400);
  expect(await response?.json()).toMatchObject({ success: false, code: "INVALID_AGENT_ID", action: "fix_request" });
  expect(mockAuthorize).not.toHaveBeenCalled();
});
