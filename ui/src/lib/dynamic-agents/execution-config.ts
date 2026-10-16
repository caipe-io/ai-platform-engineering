import { ApiError } from "@/lib/api-error";
import type { AgentExecution } from "@/types/dynamic-agent";

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

export function normalizeAgentExecution(value: unknown): AgentExecution {
  if (value === undefined) return { kind: "native" };
  if (!record(value) || Object.keys(value).some((key) => !["kind", "profile_id"].includes(key))) {
    throw new ApiError("Invalid agent execution configuration", 400, "INVALID_AGENT_EXECUTION");
  }
  if (value.kind === "native" && value.profile_id === undefined) return { kind: "native" };
  if (value.kind === "sandbox" && typeof value.profile_id === "string" && /^[a-z0-9][a-z0-9-]{0,62}$/.test(value.profile_id)) {
    return { kind: "sandbox", profile_id: value.profile_id };
  }
  throw new ApiError("Select an admitted runtime profile", 400, "INVALID_AGENT_EXECUTION");
}
