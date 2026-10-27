import { ApiError } from "@/lib/api-error";
import type { RemoteAgentCredentialSource } from "@/types/dynamic-agent";

const DEFAULT_CREDENTIAL_SOURCE: RemoteAgentCredentialSource = {
  kind: "caller_token",
  target: "header",
  name: "Authorization",
};
const HEADER_NAME_PATTERN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;

export function normalizeRemoteAgentCredentialSource(
  value: unknown,
): RemoteAgentCredentialSource {
  if (value === undefined || value === null) return DEFAULT_CREDENTIAL_SOURCE;
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new ApiError("A2A authentication source is invalid", 400, "INVALID_REMOTE_AGENT_AUTH");
  }
  const source = value as Record<string, unknown>;
  const kind = source.kind;
  const name = typeof source.name === "string" ? source.name.trim() : "Authorization";
  if (name.length > 256 || !HEADER_NAME_PATTERN.test(name) || (source.target !== undefined && source.target !== "header")) {
    throw new ApiError("A2A authentication header name is invalid", 400, "INVALID_REMOTE_AGENT_AUTH");
  }
  if (kind === "caller_token") return { kind, target: "header", name };
  if (kind === "secret_ref") {
    const secret_ref = typeof source.secret_ref === "string" ? source.secret_ref.trim() : "";
    if (!secret_ref) {
      throw new ApiError("Select a saved secret for A2A authentication", 400, "INVALID_REMOTE_AGENT_AUTH");
    }
    return { kind, target: "header", name, secret_ref };
  }
  if (kind === "provider_connection") {
    const provider = typeof source.provider === "string" ? source.provider.trim() : "";
    if (!provider) {
      throw new ApiError("Select a connected credential provider for A2A authentication", 400, "INVALID_REMOTE_AGENT_AUTH");
    }
    return { kind, target: "header", name, provider };
  }
  throw new ApiError("A2A authentication source is invalid", 400, "INVALID_REMOTE_AGENT_AUTH");
}
