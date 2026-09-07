/**
 * API route for listing available LLM models.
 *
 * Models are read from the RBAC-filtered `llm_models` MongoDB collection
 * seeded at startup via instrumentation.ts from config.yaml, plus any added
 * via the admin LLM Models tab.
 */

import {
  getAuthFromBearerOrSession,
  successResponse,
  withErrorHandler,
} from "@/lib/api-middleware";
import { getCollection, isMongoDBConfigured } from "@/lib/mongodb";
import { filterResourcesByPermission } from "@/lib/rbac/resource-authz";
import { NextRequest } from "next/server";

interface ModelResponseEntry {
  model_id: string;
  name: string;
  provider: string;
  description: string;
}

/**
 * GET /api/dynamic-agents/models
 * List available LLM models for agent configuration.
 */
export const GET = withErrorHandler(async (request: NextRequest) => {
  const { session } = await getAuthFromBearerOrSession(request);

  let mongoModels: ModelResponseEntry[] = [];
  if (isMongoDBConfigured) {
    try {
      const collection = await getCollection("llm_models");
      const docs = await collection.find({}).sort({ name: 1 }).toArray();
      // Apply RBAC before mapping — the permission check keys off `_id`.
      const visibleDocs = await filterResourcesByPermission(session, docs, {
        type: "llm_model",
        action: "read",
        id: (model) => String(model._id),
      });
      mongoModels = visibleDocs.map((m) => ({
        model_id: m.model_id,
        name: m.name,
        provider: m.provider,
        description: m.description ?? "",
      }));
    } catch (err) {
      // Don't fail the whole request if Mongo is configured but unreachable.
      console.error(
        "[api/dynamic-agents/models] failed to read llm_models:",
        err,
      );
    }
  }

  return successResponse(mongoModels);
});
