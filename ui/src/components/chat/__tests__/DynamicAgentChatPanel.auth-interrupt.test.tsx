import { interruptedAuthReason,interruptedTurnFallbackText,isAgentReadinessError } from "@/lib/chat-interrupt";
import { StreamError } from "@/lib/streaming";
import { APIClientError } from "@/lib/api-client";

describe("interruptedTurnFallbackText", () => {
  it.each(["not_signed_in", "session_expired", "bearer_invalid"])(
    "shows the sign-in hint for %s auth interruptions",
    (reason) => {
      expect(interruptedTurnFallbackText(reason)).toBe(
        "Session expired - signing you in again...",
      );
    },
  );

  it("keeps the generic interrupted copy when there is no error", () => {
    expect(interruptedTurnFallbackText(undefined)).toBe(
      "This response failed to complete. No content was generated.",
    );
  });

  it.each(["pdp_denied", "missing_role", "network_error"])(
    "preserves the existing error copy for %s",
    (reason) => {
      expect(interruptedTurnFallbackText(reason)).toBe(reason);
    },
  );
});

describe("interruptedAuthReason", () => {
  it.each(["not_signed_in", "session_expired", "bearer_invalid"] as const)(
    "persists the sign-in hint for a message-save failure with reason %s", reason => {
      expect(interruptedAuthReason(new APIClientError("Save failed", 401, undefined, reason, "sign_in"))).toBe(reason);
    },
  );

  it("does not turn a message-save access denial into a sign-in interruption", () => {
    expect(interruptedAuthReason(new APIClientError("Denied", 403, undefined, "missing_role", "contact_admin"))).toBeUndefined();
  });

  it.each(["not_signed_in", "session_expired", "bearer_invalid"] as const)(
    "persists structured sign-in auth reason %s",
    (reason) => {
      expect(
        interruptedAuthReason(new StreamError("auth failed", 401, undefined, reason, "sign_in")),
      ).toBe(reason);
    },
  );

  it("falls back to session_expired when older auth errors only carry sign_in action", () => {
    expect(
      interruptedAuthReason(new StreamError("auth failed", 401, undefined, undefined, "sign_in")),
    ).toBe("session_expired");
  });

  it("does not persist non sign-in authz reasons", () => {
    expect(
      interruptedAuthReason(new StreamError("denied", 403, undefined, "missing_role", "contact_admin")),
    ).toBeUndefined();
  });
});

it("distinguishes a blocked admission from auth/network interruptions", () => {
  expect(isAgentReadinessError(new StreamError("Not ready", 409, "HARNESS_AGENT_NOT_READY"))).toBe(true);
  expect(isAgentReadinessError(new StreamError("Unavailable", 503))).toBe(false);
  expect(isAgentReadinessError(new Error("HARNESS_AGENT_NOT_READY"))).toBe(false);
});
