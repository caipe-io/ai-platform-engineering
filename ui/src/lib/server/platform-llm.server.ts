/**
 * Resolution of the LLM a server-side feature should call.
 *
 * `ai/review`, `ai/assist` and `skills/generate` all resolve through here, so
 * the Platform LLM chosen in Admin → Platform configuration is the single place
 * to set the model. AI Review may additionally pin a model per review target.
 */

import { getCollection } from "@/lib/mongodb";

/** A model the Python assistant can run: registry id plus its provider key. */
export interface LlmModelRef {
  id: string;
  provider: string;
}

/**
 * Last-resort model. Bedrock is the provider most deployments already have
 * credentials for, whereas OpenAI needs a key that is often absent in dev.
 *
 * `id` is the raw Bedrock modelId, not a LiteLLM-style `bedrock/...` value:
 * cnoe-agent-utils passes it straight to `client.converse(modelId=...)`, and
 * Bedrock rejects a prefixed id with `ValidationException`.
 */
export const GLOBAL_DEFAULT_MODEL: LlmModelRef = {
  id: "global.anthropic.claude-haiku-4-5-20251001-v1:0",
  provider: "aws-bedrock",
};

const PLATFORM_CONFIG_COLLECTION = "platform_config";
const PLATFORM_CONFIG_ID = "platform_settings";

/** A model reference, or null when either half is missing. */
export function toModelRef(value: unknown): LlmModelRef | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as { id?: unknown; provider?: unknown };
  const id = typeof candidate.id === "string" ? candidate.id.trim() : "";
  const provider = typeof candidate.provider === "string" ? candidate.provider.trim() : "";
  return id && provider ? { id, provider } : null;
}

/** The Platform LLM, or null when an admin has not chosen one. */
export async function readPlatformLlm(): Promise<LlmModelRef | null> {
  try {
    const collection = await getCollection<{ platform_llm?: unknown }>(
      PLATFORM_CONFIG_COLLECTION,
    );
    const doc = await collection.findOne({ _id: PLATFORM_CONFIG_ID } as never);
    return toModelRef(doc?.platform_llm);
  } catch {
    // Mongo unavailable: treat as unset so callers fall through their ladder.
    return null;
  }
}

/** The first registered model by name, used before the hardcoded default. */
async function readFirstRegisteredModel(): Promise<LlmModelRef | null> {
  try {
    const collection = await getCollection("llm_models");
    const first = await collection.findOne({}, { sort: { name: 1 } });
    return toModelRef({ id: first?.model_id, provider: first?.provider });
  } catch {
    return null;
  }
}

/**
 * Pick the model to call.
 *
 * Model choice belongs to the database, set through the UI. The only thing that
 * outranks the Platform LLM is a model pinned on the feature's own config, which
 * is itself a UI setting.
 */
export async function resolveLlmModel(
  /** A model pinned on the feature's own config, e.g. an AI Review target. */
  configModel?: { id?: string; provider?: string } | null,
): Promise<LlmModelRef> {
  return (
    toModelRef(configModel) ??
    (await readPlatformLlm()) ??
    (await readFirstRegisteredModel()) ??
    GLOBAL_DEFAULT_MODEL
  );
}
