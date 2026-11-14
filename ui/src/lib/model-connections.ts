import { LLM_PROVIDERS } from "@/lib/llm-provider-credentials";

export type ModelConnectionAuth = "secrets" | "deployment" | "none";
export interface ModelConnection {
  _id: string;
  name: string;
  provider: string;
  auth_mode: ModelConnectionAuth;
  credential_refs: Record<string, string>;
  revision: string;
  state: "pending" | "ready" | "failed";
  owner_subject: string;
  owner_id: string;
  created_at: string;
  updated_at: string;
}
export interface ConnectionDraft {
  provider: string;
  auth_mode: ModelConnectionAuth;
  fields: Record<string, string>;
  /** New values are accepted only on create/test requests, never in stored records. */
  values?: Record<string, string>;
}
export interface ModelTestResult {
  success: boolean;
  category:
    | "success"
    | "authentication"
    | "authorization"
    | "connection"
    | "tls"
    | "timeout"
    | "not_found"
    | "rate_limit"
    | "invalid_response"
    | "configuration"
    | "provider_error";
  message: string;
  elapsed_ms: number;
  provider?: string;
  model_id?: string;
  status_code?: number;
}
export function canonicalModelProvider(value: string): string {
  const normalized = value.trim().toLowerCase().replaceAll("_", "-");
  const aliases: Record<string, string> = {
    "google-genai": "google-gemini",
    "google-gemini": "google-gemini",
    bedrock: "aws-bedrock",
    anthropic: "anthropic-claude",
    "google-vertexai": "gcp-vertexai",
  };
  return aliases[normalized] ?? normalized;
}
export function connectionProviderDefinition(provider: string) {
  const canonical = canonicalModelProvider(provider);
  return LLM_PROVIDERS.find(
    (item) =>
      item.id === (canonical === "openai-compatible" ? "openai" : canonical),
  );
}
export function validProviderModelId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length <= 512 &&
    /^[a-zA-Z0-9][a-zA-Z0-9._/:@-]*$/.test(value)
  );
}
