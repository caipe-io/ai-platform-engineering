import { createHash, randomUUID } from "crypto";
import { getServerConfig } from "@/lib/config";
import { ApiError } from "@/lib/api-error";
import { getCollection } from "@/lib/mongodb";
import {
  requireResourcePermission,
  filterResourcesByPermission,
  type ResourceAuthzSession,
} from "@/lib/rbac/resource-authz";
import {
  reconcileLlmModelRelationships,
  deleteAllLlmModelRelationshipTuples,
} from "@/lib/rbac/openfga-owned-resources-reconcile";
import { getCredentialFeatureConfig } from "@/lib/feature-flags/credentials";
import { getCredentialSecretService } from "@/lib/credentials/secret-service-factory";
import { getCredentialRetrievalService } from "@/lib/credentials/retrieval-service-factory";
import { assertCredentialServiceCaller } from "@/lib/credentials/internal-caller";
import {
  canonicalModelProvider,
  connectionProviderDefinition,
  validProviderModelId,
  type ConnectionDraft,
  type ModelConnection,
} from "@/lib/model-connections";
import { providerFieldAcceptsSecret } from "@/lib/llm-provider-credentials";
import type { LLMModelConfig } from "@/types/dynamic-agent";

export const CONNECTION_COLLECTION = "llm_model_connections";
export interface ConnectionActor {
  session: ResourceAuthzSession;
  email: string;
  name?: string;
}
const fieldNames = (provider: string) =>
  new Set(
    connectionProviderDefinition(provider)?.fields.map((field) => field.id),
  );

export async function modelConnectionsRuntimeSupported(): Promise<boolean> {
  const url = getServerConfig().dynamicAgentsUrl;
  if (!url || typeof url !== "string") return false;
  try {
    const response = await fetch(new URL("/health", url), {
      cache: "no-store",
      signal: AbortSignal.timeout(4000),
      redirect: "error",
    });
    if (!response.ok) return false;
    const health = await response.json();
    return (
      health.saved_model_connections === 1 &&
      health.credential_api_configured === true
    );
  } catch {
    return false;
  }
}
export async function requireConnectionManager(
  actor: ConnectionActor,
): Promise<string> {
  if (typeof actor.session.sub !== "string" || !actor.session.sub)
    throw new ApiError("A stable user identity is required", 401);
  await requireResourcePermission(actor.session, {
    type: "system_config",
    id: "platform_settings",
    action: "manage",
  });
  return actor.session.sub;
}
export function parseConnectionDraft(value: unknown): ConnectionDraft {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new ApiError("Connection configuration is required", 400);
  const body = value as Record<string, unknown>;
  const provider =
    typeof body.provider === "string"
      ? canonicalModelProvider(body.provider)
      : "";
  if (!connectionProviderDefinition(provider))
    throw new ApiError("Unsupported model provider", 400);
  const mode = body.auth_mode;
  if (mode !== "secrets" && mode !== "deployment" && mode !== "none")
    throw new ApiError("Choose a credential source", 400);
  if (mode === "none" && !["openai", "openai-compatible"].includes(provider))
    throw new ApiError("This provider requires credentials", 400);
  const allowed = fieldNames(provider);
  const parseFields = (input: unknown): Record<string, string> => {
    if (input === undefined) return {};
    if (!input || typeof input !== "object" || Array.isArray(input))
      throw new ApiError("Invalid connection fields", 400);
    const result: Record<string, string> = {};
    for (const [key, field] of Object.entries(input)) {
      if (
        !allowed.has(key) ||
        typeof field !== "string" ||
        !field.trim() ||
        field.length > 65536
      )
        throw new ApiError("Invalid connection field", 400);
      result[key] = field.trim();
    }
    return result;
  };
  const fields = parseFields(body.fields);
  const values = parseFields(body.values);
  if (Object.keys(fields).some((key) => key in values))
    throw new ApiError("Choose one source for each connection field", 400);
  const present = new Set([...Object.keys(fields), ...Object.keys(values)]);
  if (
    mode === "deployment" &&
    [...present].some((key) => !["region"].includes(key))
  )
    throw new ApiError(
      "Deployment identity cannot include saved keys or endpoints",
      400,
    );
  if (mode !== "deployment") {
    if (provider === "openai-compatible" && !present.has("endpoint"))
      throw new ApiError(
        "Endpoint URL is required for an OpenAI-compatible provider",
        400,
      );
    const required =
      provider === "aws-bedrock"
        ? ["access_key_id", "secret_access_key", "region"]
        : provider === "azure-openai"
          ? ["endpoint", "api_version", "api_key"]
          : mode === "none"
            ? []
            : ["api_key"];
    for (const key of required)
      if (!present.has(key))
        throw new ApiError(`${key.replaceAll("_", " ")} is required`, 400);
    if (mode === "none" && present.has("api_key"))
      throw new ApiError(
        "No-key authentication cannot include an API key",
        400,
      );
  }
  if (values.endpoint) validateModelEndpoint(values.endpoint);
  return { provider, auth_mode: mode, fields, values };
}
export function validateModelEndpoint(value: string): string {
  let endpoint: URL;
  try {
    endpoint = new URL(value);
  } catch {
    throw new ApiError("Endpoint must be an absolute HTTP or HTTPS URL", 400);
  }
  if (
    !["https:", "http:"].includes(endpoint.protocol) ||
    endpoint.username ||
    endpoint.password ||
    endpoint.search ||
    endpoint.hash
  )
    throw new ApiError(
      "Endpoint must not contain credentials, query parameters, or fragments",
      400,
    );
  // SDKs append resource paths. Preserve a supplied /v1 base without adding it twice.
  return endpoint.toString().replace(/\/+$/, "");
}
export async function authorizeDraft(
  actor: ConnectionActor,
  draft: ConnectionDraft,
): Promise<void> {
  await requireConnectionManager(actor);
  if (!Object.keys(draft.fields).length) return;
  if (!getCredentialFeatureConfig().enabled)
    throw new ApiError(
      "Saved credentials are disabled for this deployment",
      404,
    );
  const service = await getCredentialSecretService();
  for (const [fieldId, id] of Object.entries(draft.fields)) {
    const field = connectionProviderDefinition(draft.provider)!.fields.find(
      (item) => item.id === fieldId,
    )!;
    const metadata = await service.getSecretMetadata({
      session: actor.session,
      secretId: id,
    });
    if (!providerFieldAcceptsSecret(field, metadata))
      throw new ApiError(`Incompatible saved secret for ${field.label}`, 400);
    // Publishing an endpoint/key pairing is configuration authority, not merely permission to use a shared key.
    await requireResourcePermission(actor.session, {
      type: "secret_ref",
      id,
      action: "manage",
    });
  }
}
export function modelRegistryId(
  connectionId: string,
  upstreamId: string,
): string {
  return `${connectionId}-${createHash("sha256").update(upstreamId).digest("hex").slice(0, 16)}`;
}
export async function createModelConnection(
  actor: ConnectionActor,
  input: Record<string, unknown>,
) {
  const subject = await requireConnectionManager(actor);
  const draft = parseConnectionDraft(input);
  await authorizeDraft(actor, draft);
  const name = typeof input.name === "string" ? input.name.trim() : "";
  if (!name || name.length > 160)
    throw new ApiError(
      "Connection name is required (160 characters maximum)",
      400,
    );
  if (
    !Array.isArray(input.models) ||
    input.models.length < 1 ||
    input.models.length > 50
  )
    throw new ApiError("Enter between 1 and 50 model IDs", 400);
  const upstreamIds = input.models.map((entry) =>
    typeof entry === "string" ? entry.trim() : "",
  );
  if (
    upstreamIds.some((id) => !validProviderModelId(id)) ||
    new Set(upstreamIds).size !== upstreamIds.length
  )
    throw new ApiError(
      "Model IDs must be valid and unique within the connection",
      400,
    );
  const id =
    typeof input.operation_id === "string" &&
    /^[0-9a-f-]{36}$/i.test(input.operation_id)
      ? input.operation_id
      : randomUUID();
  const connections = await getCollection<ModelConnection>(
    CONNECTION_COLLECTION,
  );
  const existing = await connections.findOne({ _id: id });
  if (existing) {
    if (existing.owner_subject !== subject || existing.state !== "ready")
      throw new ApiError(
        "Connection operation is already in progress; retry with a new operation",
        409,
      );
    const models = await getCollection<LLMModelConfig>("llm_models");
    return {
      connection: existing,
      models: await models.find({ connection_id: id }).toArray(),
    };
  }
  const now = new Date().toISOString();
  const connection: ModelConnection = {
    _id: id,
    name,
    provider: draft.provider,
    auth_mode: draft.auth_mode,
    credential_refs: { ...draft.fields },
    state: "pending",
    revision: randomUUID(),
    owner_subject: subject,
    owner_id: actor.email,
    created_at: now,
    updated_at: now,
  };
  try {
    await connections.insertOne(connection);
  } catch (error) {
    if (
      error &&
      typeof error === "object" &&
      "code" in error &&
      error.code === 11000
    )
      throw new ApiError("Connection operation is already in progress", 409);
    throw error;
  }
  const modelCollection = await getCollection<LLMModelConfig>("llm_models");
  if (
    Object.keys(draft.values ?? {}).length &&
    !getCredentialFeatureConfig().enabled
  ) {
    await connections.deleteOne({ _id: id, state: "pending" });
    throw new ApiError(
      "Saved credentials are disabled for this deployment",
      404,
    );
  }
  let secretService: Awaited<
    ReturnType<typeof getCredentialSecretService>
  > | null = null;
  const createdSecrets: string[] = [];
  const createdModels: string[] = [];
  try {
    if (Object.keys(draft.values ?? {}).length)
      secretService = await getCredentialSecretService();
    for (const [fieldId, value] of Object.entries(draft.values ?? {})) {
      const field = connectionProviderDefinition(draft.provider)!.fields.find(
        (item) => item.id === fieldId,
      )!;
      const secret = await secretService!.createSecret({
        session: actor.session,
        owner: {
          type: "user",
          id: subject,
          email: actor.email,
          ...(actor.name ? { name: actor.name } : {}),
        },
        name: `${name} — ${field.label}`,
        type: field.secretType,
        description: `Model connection ${id}: ${field.label}`,
        plaintext: value,
      });
      createdSecrets.push(secret.id);
      connection.credential_refs[fieldId] = secret.id;
    }
    const models: LLMModelConfig[] = [];
    for (const upstreamId of upstreamIds) {
      const registryId = modelRegistryId(id, upstreamId);
      createdModels.push(registryId);
      await reconcileLlmModelRelationships({
        modelId: registryId,
        ownerSubject: subject,
      });
      const model: LLMModelConfig = {
        _id: registryId,
        model_id: registryId,
        upstream_model_id: upstreamId,
        connection_id: id,
        connection_name: name,
        name: `${upstreamId} · ${name}`,
        provider: draft.provider,
        owner_subject: subject,
        owner_id: actor.email,
        config_driven: false,
        updated_at: now,
      };
      await modelCollection.insertOne(model);
      models.push(model);
    }
    // One publication switch makes the entire group usable, including on standalone MongoDB.
    const result = await connections.updateOne(
      { _id: id, state: "pending" },
      { $set: { credential_refs: connection.credential_refs, state: "ready" } },
    );
    if (result.matchedCount !== 1)
      throw new ApiError("Connection could not be published", 409);
    return { connection: { ...connection, state: "ready" as const }, models };
  } catch (error) {
    // Roll back only resources created by this operation; never rotate/delete reused credentials.
    const cleanup = await Promise.allSettled([
      modelCollection.deleteMany({ connection_id: id }),
      ...createdModels.map((modelId) =>
        deleteAllLlmModelRelationshipTuples(modelId),
      ),
      ...createdSecrets.map((secretId) =>
        secretService!.deleteSecret({ session: actor.session, secretId }),
      ),
    ]);
    if (cleanup.every((entry) => entry.status === "fulfilled"))
      await connections.deleteOne({ _id: id, state: "pending" });
    else {
      await connections.updateOne({ _id: id }, { $set: { state: "failed" } });
      console.error("Model connection rollback needs repair", {
        connection_id: id,
      });
    }
    // Provider values can be present in upstream errors; never return/log those errors to the browser.
    if (error instanceof ApiError) throw error;
    throw new ApiError(
      "The connection could not be created. Existing credentials were preserved; retry the operation.",
      500,
    );
  }
}
export async function publishedModels(
  models: LLMModelConfig[],
): Promise<LLMModelConfig[]> {
  const ids = [
    ...new Set(
      models.flatMap((model) =>
        model.connection_id ? [model.connection_id] : [],
      ),
    ),
  ];
  if (!ids.length) return models;
  const connections = await getCollection<ModelConnection>(
    CONNECTION_COLLECTION,
  );
  const ready = new Set(
    (
      await connections.find({ _id: { $in: ids }, state: "ready" }).toArray()
    ).map((connection) => connection._id),
  );
  return models.filter(
    (model) => !model.connection_id || ready.has(model.connection_id),
  );
}
export async function listModelConnections(actor: ConnectionActor) {
  const connections = await getCollection<ModelConnection>(
    CONNECTION_COLLECTION,
  );
  const records = await connections
    .find({ state: "ready" })
    .sort({ name: 1 })
    .toArray();
  const models = await getCollection<LLMModelConfig>("llm_models");
  const catalog = await models
    .find({ connection_id: { $in: records.map((record) => record._id) } })
    .toArray();
  const visible = await filterResourcesByPermission(actor.session, catalog, {
    type: "llm_model",
    action: "read",
    id: (model) => model._id,
  });
  const readable = new Set(visible.map((model) => model.connection_id));
  let canManage = false;
  try {
    await requireConnectionManager(actor);
    canManage = true;
  } catch (error) {
    if (!(error instanceof ApiError) || error.statusCode !== 403) throw error;
  }
  return {
    connections: records.filter(
      (connection) =>
        readable.has(connection._id) ||
        (canManage && connection.owner_subject === actor.session.sub),
    ),
    models: visible,
    can_manage: canManage,
  };
}

export interface ResolvedModelPlan {
  model_id: string;
  provider: string;
  parameters: Record<string, string>;
  revision: string;
  connection_id?: string;
}
export async function resolveModelPlan(
  actor: ConnectionActor,
  headers: Headers,
  body: Record<string, unknown>,
): Promise<ResolvedModelPlan> {
  assertCredentialServiceCaller({
    headers,
    expectedAudience:
      process.env.CREDENTIAL_SERVICE_AUDIENCE || "caipe-credential-service",
  });
  let draft: ConnectionDraft;
  let revision: string;
  let modelId: string;
  let connectionId: string | undefined;
  if (body.draft !== undefined) {
    draft = parseConnectionDraft(body.draft);
    await authorizeDraft(actor, draft);
    if (!validProviderModelId(body.upstream_model_id))
      throw new ApiError("A valid provider model ID is required", 400);
    modelId = body.upstream_model_id;
    revision = "draft";
  } else {
    if (typeof body.model_id !== "string" || !body.model_id)
      throw new ApiError("Model ID is required", 400);
    const models = await getCollection<LLMModelConfig>("llm_models");
    const model = await models.findOne({ _id: body.model_id });
    if (!model) throw new ApiError("Model not found", 404);
    await requireResourcePermission(actor.session, {
      type: "llm_model",
      id: model._id,
      action: "read",
    });
    modelId = model.upstream_model_id ?? model.model_id;
    if (!model.connection_id)
      return {
        model_id: modelId,
        provider: canonicalModelProvider(model.provider),
        parameters: {},
        revision: `deployment:${model.updated_at}`,
      };
    const connections = await getCollection<ModelConnection>(
      CONNECTION_COLLECTION,
    );
    const connection = await connections.findOne({
      _id: model.connection_id,
      state: "ready",
    });
    if (!connection)
      throw new ApiError(
        "This model connection is unavailable; ask its administrator to repair it",
        409,
      );
    draft = {
      provider: connection.provider,
      auth_mode: connection.auth_mode,
      fields: connection.credential_refs,
    };
    revision = `${model.updated_at}:${connection.revision}`;
    connectionId = connection._id;
  }
  const parameters: Record<string, string> = {};
  const hasRefs = Object.keys(draft.fields).length > 0;
  const metadata = hasRefs ? await getCredentialSecretService() : null;
  const retrieval =
    hasRefs && body.metadata_only !== true
      ? await getCredentialRetrievalService()
      : null;
  const fields: Record<string, string> = { ...draft.values };
  for (const [field, id] of Object.entries(draft.fields)) {
    revision += `:${id}:${await metadata!.getSecretRevisionForUse({ session: actor.session, secretId: id })}`;
    if (body.metadata_only !== true)
      fields[field] = (
        await retrieval!.retrieve({
          headers,
          session: actor.session,
          body: { secret_ref: id, intended_use: "llm_model" },
        })
      ).credential;
  }
  if (body.metadata_only !== true) {
    const map: Record<string, Record<string, string>> = {
      openai: { endpoint: "base_url", api_key: "api_key" },
      "openai-compatible": { endpoint: "base_url", api_key: "api_key" },
      "azure-openai": {
        endpoint: "azure_endpoint",
        api_version: "api_version",
        api_key: "api_key",
      },
      "anthropic-claude": { api_key: "anthropic_api_key" },
      "aws-bedrock": {
        access_key_id: "aws_access_key_id",
        secret_access_key: "aws_secret_access_key",
        session_token: "aws_session_token",
        region: "region_name",
      },
      "google-gemini": { api_key: "google_api_key" },
      groq: { api_key: "groq_api_key" },
      "gcp-vertexai": {},
    };
    for (const [field, value] of Object.entries(fields)) {
      const target = map[draft.provider]?.[field];
      if (target)
        parameters[target] =
          field === "endpoint" ? validateModelEndpoint(value) : value;
    }
    if (draft.provider === "openai" && draft.auth_mode !== "deployment")
      parameters.base_url ??= "https://api.openai.com/v1";
    if (
      ["openai", "openai-compatible"].includes(draft.provider) &&
      draft.auth_mode === "none"
    )
      parameters.api_key = "not-needed";
  }
  return {
    provider: draft.provider,
    model_id: modelId,
    parameters,
    revision,
    ...(connectionId ? { connection_id: connectionId } : {}),
  };
}
