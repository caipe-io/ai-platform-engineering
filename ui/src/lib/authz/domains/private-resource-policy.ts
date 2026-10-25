import type { AuthorizeRequest, AuthorizeResult } from "../contract";

export type ResourceVisibility = "private" | "team" | "global" | null;

export const PRIVATE_DATA_ACTIONS = new Set(["use", "invoke", "call"]);

export function evaluatePrivateResourceContext(
  req: AuthorizeRequest,
  visibility: ResourceVisibility,
): AuthorizeResult | null {
  if (visibility !== "private" || !PRIVATE_DATA_ACTIONS.has(req.action)) return null;

  const interaction = req.trustedContext?.interaction;
  const allowed = req.subject.type === "user"
    && (
      (interaction?.source === "web" && interaction.conversationKind === "personal")
      || (
        interaction?.verified === true
        && interaction.conversationKind === "direct"
        && (interaction.source === "slack" || interaction.source === "webex")
      )
    );

  return allowed
    ? null
    : {
        decision: "DENY",
        reason: "PRIVATE_RESOURCE_CONTEXT_DENIED",
        retriable: false,
        via: "private_resource_context",
      };
}
