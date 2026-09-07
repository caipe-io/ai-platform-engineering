import {
  ApiError,
  getAuthFromBearerOrSession,
  successResponse,
  withErrorHandler,
} from "@/lib/api-middleware";
import { getCollection } from "@/lib/mongodb";
import {
  enforceRagIngestorLimits,
  getRagIngestorLimits,
} from "@/lib/rag-ingestor-limits.server";
import { requireResourcePermission } from "@/lib/rbac/resource-authz";
import type { IngestionSourceConfig } from "@/types/ingestion-source";
import { NextRequest } from "next/server";
import { triggerIngestion } from "../../route";

const COLLECTION_NAME = "rag_ingestion_sources";

const RELOAD_PATH: Record<IngestionSourceConfig["source_type"], string> = {
  slack_channel: "/v1/ingest/slack/reload",
  confluence_space: "/v1/ingest/confluence/reload",
  jira_project: "/v1/ingest/jira/reload",
  web_url: "/v1/ingest/webloader/reload",
  webex_space: "/v1/ingest/webex/reload",
};

function getRagServerUrl(): string {
  return (
    process.env.RAG_SERVER_URL ||
    process.env.NEXT_PUBLIC_RAG_URL ||
    "http://localhost:9446"
  );
}

async function ragDatasourceExists(
  source: IngestionSourceConfig,
  accessToken: string | undefined,
): Promise<boolean> {
  if (!accessToken) {
    throw new ApiError(
      "A Keycloak access token is required to inspect this source",
      401,
    );
  }
  let response: Response;
  try {
    const target = new URL(
      `${getRagServerUrl()}/v1/datasource/${encodeURIComponent(source.source_id)}/exists`,
    );
    response = await fetch(
      target,
      { headers: { Authorization: `Bearer ${accessToken}` } },
    );
  } catch {
    throw new ApiError(
      "The datasource state could not be verified before retrying ingestion",
      503,
      "INGEST_STATE_UNAVAILABLE",
    );
  }
  if (!response.ok) {
    throw new ApiError(
      `The datasource state could not be verified before retrying ingestion (${response.status})`,
      response.status >= 400 && response.status < 500 ? response.status : 502,
      "INGEST_STATE_UNAVAILABLE",
    );
  }
  const body = (await response.json().catch(() => null)) as {
    exists?: unknown;
  } | null;
  if (!body || typeof body.exists !== "boolean") {
    throw new ApiError(
      "The RAG server returned an invalid datasource-state response",
      502,
      "INGEST_STATE_INVALID",
    );
  }
  return body.exists;
}

function resolveManagementOwnerTeam(
  source: IngestionSourceConfig,
): string | null {
  // This metadata describes who manages the source. Search-only teams are
  // reconciled independently and are never passed as datasource owners.
  return source.owner_team_slug?.trim() || null;
}

async function triggerReload(
  source: IngestionSourceConfig,
  accessToken: string | undefined,
): Promise<{ datasource_id: string; job_id: string }> {
  if (!accessToken) {
    throw new ApiError("A Keycloak access token is required to reload this source", 401);
  }
  const response = await fetch(`${getRagServerUrl()}${RELOAD_PATH[source.source_type]}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify({ datasource_id: source.source_id }),
  });
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new ApiError(
      `Ingestion could not be restarted (${response.status})${body ? `: ${body}` : ""}`,
      502,
      "INGEST_RELOAD_FAILED",
    );
  }
  const result = (await response.json().catch(() => ({}))) as {
    datasource_id?: string;
    job_id?: string;
  };
  if (result.datasource_id !== source.source_id) {
    throw new ApiError(
      "The RAG server returned a mismatched datasource id",
      502,
      "INGEST_DATASOURCE_ID_MISMATCH",
    );
  }
  if (typeof result.job_id !== "string" || !result.job_id.trim()) {
    throw new ApiError(
      "The RAG server accepted the reload without returning an ingestion job id",
      502,
      "INGEST_JOB_ID_MISSING",
    );
  }
  return { datasource_id: result.datasource_id, job_id: result.job_id };
}

export const POST = withErrorHandler(
  async (
    request: NextRequest,
    context: { params: Promise<{ sourceId: string }> },
  ) => {
    const { sourceId } = await context.params;
    const { session } = await getAuthFromBearerOrSession(request);
    const collection = await getCollection<IngestionSourceConfig>(COLLECTION_NAME);
    const source = await collection.findOne({ source_id: sourceId } as never);
    if (!source) {
      throw new ApiError("Source not found", 404, "SOURCE_NOT_FOUND");
    }
    if (source.config_driven) {
      throw new ApiError(
        "Config-driven sources are reloaded through their configured ingestor",
        403,
        "CONFIG_DRIVEN_IMMUTABLE",
      );
    }

    // Search is query-only. Starting or retrying the stored connector is a
    // source lifecycle action and therefore requires Owner authority.
    await requireResourcePermission(
      session,
      { type: "ingestion_source", id: sourceId, action: "manage" },
      { bypassForOrgAdmin: true },
    );

    const ingestorLimits = await getRagIngestorLimits();
    enforceRagIngestorLimits(
      source.source_type,
      source as unknown as Record<string, unknown>,
      ingestorLimits,
    );

    try {
      const datasourceExists = await ragDatasourceExists(
        source,
        session.accessToken,
      );
      // Existing/adopted sources must use the datasource-specific reload
      // command. Replaying their create request can overwrite connector
      // metadata (for example a multi-root Confluence config or web crawl
      // settings). A failed first create has no RAG datasource yet, so only
      // that recovery case replays the initial create payload.
      const trigger = datasourceExists
        ? await triggerReload(source, session.accessToken)
        : await triggerIngestion(
            source,
            session.accessToken,
            resolveManagementOwnerTeam(source),
          );
      const statusUpdate = {
        status: "ingesting" as const,
        ingestion_job_id: trigger.job_id,
        updated_at: new Date().toISOString(),
      };
      await collection.updateOne(
        { source_id: sourceId } as never,
        { $set: statusUpdate, $unset: { last_error: "" } } as never,
      );
      return successResponse({ ...source, ...statusUpdate });
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Failed to start ingestion";
      await collection.updateOne(
        { source_id: sourceId } as never,
        {
          $set: {
            status: "failed",
            last_error: message.slice(0, 2000),
            updated_at: new Date().toISOString(),
          },
        } as never,
      );
      throw error;
    }
  },
);
