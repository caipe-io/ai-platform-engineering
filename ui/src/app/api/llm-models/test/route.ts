import { NextRequest, NextResponse } from "next/server";
import {
  ApiError,
  successResponse,
  withErrorHandler,
} from "@/lib/api-middleware";
import {
  authenticateRequest,
  getDynamicAgentsConfig,
  proxyRequest,
} from "@/lib/da-proxy";
import { getCollection } from "@/lib/mongodb";
import { requireResourcePermission } from "@/lib/rbac/resource-authz";
import {
  authorizeDraft,
  parseConnectionDraft,
} from "@/lib/server/model-connections";
import {
  validProviderModelId,
  type ModelConnection,
} from "@/lib/model-connections";
import type { LLMModelConfig } from "@/types/dynamic-agent";

export const POST = withErrorHandler(async (request: NextRequest) => {
  const auth = await authenticateRequest(request);
  if (auth instanceof NextResponse) return auth;
  const input = await request.json();
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw new ApiError("Model test configuration is required", 400);
  const actor = { session: auth.authenticatedUser.session, email: auth.email };
  let payload: Record<string, unknown>;
  if (input.connection_id !== undefined) {
    if (typeof input.connection_id !== "string")
      throw new ApiError("Invalid connection ID", 400);
    const collection = await getCollection<ModelConnection>(
      "llm_model_connections",
    );
    const connection = await collection.findOne({
      _id: input.connection_id,
      state: "ready",
    });
    if (!connection || connection.owner_subject !== actor.session.sub)
      throw new ApiError(
        "Connection not available for model registration",
        403,
      );
    if (!validProviderModelId(input.upstream_model_id))
      throw new ApiError("Provider model ID is required", 400);
    const draft = {
      provider: connection.provider,
      auth_mode: connection.auth_mode,
      fields: connection.credential_refs,
    };
    await authorizeDraft(actor, draft);
    payload = { draft, upstream_model_id: input.upstream_model_id };
  } else if (input.draft !== undefined) {
    const draft = parseConnectionDraft(input.draft);
    await authorizeDraft(actor, draft);
    if (!validProviderModelId(input.upstream_model_id))
      throw new ApiError("Provider model ID is required", 400);
    payload = { draft, upstream_model_id: input.upstream_model_id };
  } else {
    if (typeof input.model_id !== "string" || !input.model_id)
      throw new ApiError("Model ID is required", 400);
    const models = await getCollection<LLMModelConfig>("llm_models");
    const model = await models.findOne({ _id: input.model_id });
    if (!model) throw new ApiError("Model not found", 404);
    await requireResourcePermission(actor.session, {
      type: "llm_model",
      id: model._id,
      action: "read",
    });
    payload = { model_id: model._id };
  }
  const config = getDynamicAgentsConfig();
  if (config instanceof NextResponse) return config;
  const response = await proxyRequest(
    new URL("/api/v1/llm-models/test", config.dynamicAgentsUrl).toString(),
    "POST",
    auth,
    "[llm-model-test]",
    JSON.stringify(payload),
  );
  if (response.status === 404)
    return successResponse({
      success: false,
      category: "configuration",
      elapsed_ms: 0,
      message:
        "The Dynamic Agents runtime must be upgraded before model connections can be tested.",
    });
  return response;
});
