import { authorize } from "@/lib/authz";
import type { AuthorizeRequest, AuthorizeResult, DecisionContext } from "@/lib/authz";
import type { AgenticAppCasAction } from "@/types/agentic-app";

export type AgenticAppCasMode = "off" | "shadow" | "enforce";

export interface AgenticAppCasCompatibilityResult {
  mode: AgenticAppCasMode;
  casDecision: "ALLOW" | "DENY" | "NOT_EVALUATED";
  casReason?: AuthorizeResult["reason"];
  effectiveEffect: "allow" | "deny";
}

type CasAuthorizer = (
  request: AuthorizeRequest,
  context?: DecisionContext,
) => Promise<AuthorizeResult>;

export async function evaluateAgenticAppCasCompatibility(input: {
  appId: string;
  subjectId: string;
  localEffect: "allow" | "deny";
  correlationId: string;
  action?: AgenticAppCasAction;
  mode?: AgenticAppCasMode;
  authorizer?: CasAuthorizer;
}): Promise<AgenticAppCasCompatibilityResult> {
  const mode = input.mode ?? resolveAgenticAppCasMode();
  if (mode === "off") {
    return {
      mode,
      casDecision: "NOT_EVALUATED",
      effectiveEffect: input.localEffect,
    };
  }

  let result: AuthorizeResult;
  try {
    result = await (input.authorizer ?? authorize)(
      {
        subject: { type: "user", id: input.subjectId },
        resource: { type: "agentic_app", id: input.appId },
        action: input.action ?? "use",
      },
      { correlationId: input.correlationId },
    );
  } catch {
    result = { decision: "DENY", reason: "AUTHZ_UNAVAILABLE", retriable: true };
  }

  return {
    mode,
    casDecision: result.decision,
    casReason: result.reason,
    effectiveEffect:
      input.localEffect === "deny" || (mode === "enforce" && result.decision !== "ALLOW")
        ? "deny"
        : "allow",
  };
}

export function resolveAgenticAppCasMode(
  value = process.env.AGENTIC_APPS_CAS_MODE,
): AgenticAppCasMode {
  return value === "off" || value === "shadow" ? value : "enforce";
}
