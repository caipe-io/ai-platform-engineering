import { NextResponse } from "next/server";

import { authorize } from "@/lib/authz";
import { withAuthzSpan } from "./authz-tracing";

export interface AgentUsePermissionInput {
  subject?: string;
  agentId?: unknown;
  /** Display metadata only; never an alternate authorization principal. */
  email?: string;
  tenantId?: string;
  correlationId?: string;
  traceparent?: string;
  /** Caller classification supplied by authentication, never by the request body. */
  isServiceAccount?: boolean;
}

const OPENFGA_ID_PATTERN = /^[A-Za-z0-9._-]+$/;

function isValidOpenFgaId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && OPENFGA_ID_PATTERN.test(value);
}

function authzResponse(
  body: {
    error: string;
    code: string;
    reason: string;
    action: string;
  },
  status: number,
): NextResponse {
  return NextResponse.json({ success: false, ...body }, { status });
}

export async function requireAgentUsePermission({
  subject,
  agentId,
  tenantId = "default",
  correlationId,
  traceparent,
  isServiceAccount = false,
}: AgentUsePermissionInput): Promise<NextResponse | null> {
  if (!isValidOpenFgaId(subject)) {
    return authzResponse(
      {
        error: "You are not signed in. Please sign in to continue.",
        code: "NOT_SIGNED_IN",
        reason: "not_signed_in",
        action: "sign_in",
      },
      401,
    );
  }

  if (!isValidOpenFgaId(agentId)) {
    return authzResponse(
      {
        error: "Invalid agent identifier",
        code: "INVALID_AGENT_ID",
        reason: "invalid_request",
        action: "fix_request",
      },
      400,
    );
  }

  return withAuthzSpan(
    "authz.webui_backend.agent_use",
    {
      "authz.action": "can_use",
      "authz.resource": "dynamic_agent",
      "authz.agent_id": String(agentId),
      "authz.tenant_id": tenantId,
    },
    async (trace) => {
      try {
        const result = await authorize(
          {
            subject: { type: isServiceAccount ? "service_account" : "user", id: subject },
            resource: { type: "agent", id: agentId },
            action: "use",
          },
          { tenantId, correlationId, traceId: trace.traceId, spanId: trace.spanId },
        );
        if (result.decision === "ALLOW") return null;
        if (result.reason === "AUTHZ_UNAVAILABLE") return unavailableResponse();
      } catch (err) {
        // Unexpected CAS failures must not allow execution or look like a policy denial.
        console.error("[openfga-agent-authz] CAS agent-use check failed:", err);
        return unavailableResponse();
      }

      return authzResponse(
        {
          error: "Permission denied",
          code: "agent#use",
          reason: "pdp_denied",
          action: "contact_admin",
        },
        403,
      );
    },
    traceparent,
  );
}

function unavailableResponse(): NextResponse {
  return authzResponse(
    {
      error: "Authorization service is temporarily unavailable. Please try again in a moment.",
      code: "PDP_UNAVAILABLE",
      reason: "pdp_unavailable",
      action: "retry",
    },
    503,
  );
}
