import { NextRequest } from "next/server";
import {
  ApiError,
  getAuthFromBearerOrSession,
  successResponse,
  withErrorHandler,
} from "@/lib/api-middleware";
import { getCollection } from "@/lib/mongodb";
import { getCredentialSecretService } from "@/lib/credentials/secret-service-factory";
import { getCredentialFeatureConfig } from "@/lib/feature-flags/credentials";
import { requireResourcePermission } from "@/lib/rbac/resource-authz";
import {
  LLM_PROVIDERS,
  providerFieldAcceptsSecret,
  normalizeProviderSecretBindings,
  type ProviderSecretBindings,
} from "@/lib/llm-provider-credentials";
import { DEFAULT_USER_SETTINGS, type UserSettings } from "@/types/mongodb";

async function caller(request: NextRequest) {
  if (!getCredentialFeatureConfig().enabled)
    throw new ApiError("Credential features are disabled", 404);
  const auth = await getAuthFromBearerOrSession(request);
  if (
    !auth.session.sub ||
    ["skills_api_key", "catalog_api_key"].includes(
      auth.session.principalType ?? "",
    )
  )
    throw new ApiError("A user identity is required", 403);
  return auth;
}

export const GET = withErrorHandler(async (request: NextRequest) => {
  const { user } = await caller(request);
  const collection = await getCollection<UserSettings>("user_settings");
  const doc = await collection.findOne({ user_id: user.email });
  const response = successResponse({
    bindings: normalizeProviderSecretBindings(
      doc?.preferences?.llm_provider_secrets,
    ),
  });
  response.headers.set("Cache-Control", "private, no-store");
  return response;
});

export const PATCH = withErrorHandler(async (request: NextRequest) => {
  const { user, session } = await caller(request);
  const body = (await request.json()) as Record<string, unknown>;
  if (!body || typeof body !== "object" || Array.isArray(body))
    throw new ApiError("A provider configuration object is required", 400);
  const provider = LLM_PROVIDERS.find((item) => item.id === body.provider);
  if (
    !provider ||
    !body.fields ||
    typeof body.fields !== "object" ||
    Array.isArray(body.fields)
  )
    throw new ApiError(
      "A supported provider and field references are required",
      400,
    );
  const fields: Record<string, string> = {};
  const secrets = await getCredentialSecretService();
  for (const [key, value] of Object.entries(body.fields)) {
    const field = provider.fields.find((item) => item.id === key);
    if (!field || typeof value !== "string" || !value.trim())
      throw new ApiError("Invalid provider field reference", 400);
    const metadata = await secrets.getSecretMetadata({
      session,
      secretId: value,
    });
    if (!providerFieldAcceptsSecret(field, metadata))
      throw new ApiError(
        `The saved secret is not compatible with ${field.label}`,
        400,
      );
    await requireResourcePermission(session, {
      type: "secret_ref",
      id: value,
      action: "use",
    });
    fields[key] = value;
  }
  for (const field of provider.fields) {
    if (field.required && !fields[field.id])
      throw new ApiError(`${field.label} is required`, 400);
  }
  if (
    provider.id === "aws-bedrock" &&
    (fields.access_key_id ||
      fields.secret_access_key ||
      fields.session_token) &&
    (!fields.access_key_id || !fields.secret_access_key || !fields.region)
  )
    throw new ApiError(
      "Bedrock access keys require Access Key ID, Secret Access Key, and Region",
      400,
    );
  const collection = await getCollection<UserSettings>("user_settings");
  // Initialize defaults separately to avoid conflicting writes to preferences and a nested path.
  await collection.updateOne(
    { user_id: user.email },
    { $setOnInsert: { user_id: user.email, ...DEFAULT_USER_SETTINGS } },
    { upsert: true },
  );
  await collection.updateOne(
    { user_id: user.email },
    {
      $set: {
        [`preferences.llm_provider_secrets.${provider.id}`]: fields,
        updated_at: new Date(),
      },
    },
  );
  return successResponse({ provider: provider.id, fields } satisfies {
    provider: string;
    fields: ProviderSecretBindings[string];
  });
});
