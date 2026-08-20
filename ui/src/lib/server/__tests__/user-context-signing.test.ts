/** @jest-environment node */

import { createHmac } from "node:crypto";
import { NextRequest } from "next/server";

import { buildSignedUserContextHeaders } from "../user-context-signing";
import { buildWorkflowDaAuthHeaders } from "../workflow-da-auth";
import type { ResourceAuthzSession } from "@/lib/rbac/resource-authz";

describe("buildSignedUserContextHeaders", () => {
  afterEach(() => {
    delete process.env.DA_USER_CONTEXT_HMAC_SECRET;
  });

  it("signs workflow-engine calls and forwards the session bearer", () => {
    process.env.DA_USER_CONTEXT_HMAC_SECRET = "test-secret";
    const request = new NextRequest("https://example.com/api/workflow-runs", {
      method: "POST",
    });
    const headers = buildWorkflowDaAuthHeaders(
      request,
      { email: "user@example.com", name: "Example User" },
      { accessToken: "access-token" } as ResourceAuthzSession,
    );
    expect(headers.Authorization).toBe("Bearer access-token");
    expect(headers["X-User-Context-Signature"]).toMatch(/^v1=[a-f0-9]{64}$/);
  });

  it("uses the Dynamic Agents v1 HMAC wire format", () => {
    process.env.DA_USER_CONTEXT_HMAC_SECRET = "test-secret";
    const headers = buildSignedUserContextHeaders("encoded-context");
    const digest = createHmac("sha256", "test-secret")
      .update("encoded-context")
      .digest("hex");
    expect(headers).toEqual({
      "X-User-Context": "encoded-context",
      "X-User-Context-Signature": `v1=${digest}`,
    });
  });

  it("fails closed when the shared secret is missing", () => {
    expect(() => buildSignedUserContextHeaders("encoded-context")).toThrow(
      "DA_USER_CONTEXT_HMAC_SECRET is not configured",
    );
  });
});
