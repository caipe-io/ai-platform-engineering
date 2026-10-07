import { NextRequest } from "next/server";

import {
  getAuthFromBearerOrSession,
  successResponse,
  withErrorHandler,
} from "@/lib/api-middleware";
import {
  listPublicationRequestsPageForActor,
  publicationActorFromSession,
} from "@/lib/publication-approval.server";
import type {
  PublicationRequestStatus,
  PublicationResourceKind,
} from "@/types/publication-approval";

const STATUSES = new Set<PublicationRequestStatus>([
  "pending",
  "applying",
  "approved",
  "rejected",
  "cancelled",
  "superseded",
]);
const KINDS = new Set<PublicationResourceKind>([
  "rag_datasource",
  "rag_collection",
  "slack_channel",
  "webex_space",
]);

function commaList<T extends string>(
  value: string | null,
  allowed: Set<T>,
): T[] | undefined {
  if (!value) return undefined;
  const parsed = value
    .split(",")
    .map((item) => item.trim())
    .filter((item): item is T => allowed.has(item as T));
  return parsed.length > 0 ? Array.from(new Set(parsed)) : undefined;
}

export const GET = withErrorHandler(async (request: NextRequest) => {
  const { session } = await getAuthFromBearerOrSession(request);
  const actor = publicationActorFromSession(session);
  const params = request.nextUrl.searchParams;
  const page = Number.parseInt(params.get("page") ?? "1", 10);
  const pageSize = Number.parseInt(
    params.get("page_size") ?? params.get("limit") ?? "20",
    10,
  );
  const result = await listPublicationRequestsPageForActor(actor, {
    statuses: commaList(params.get("status"), STATUSES),
    kinds: commaList(params.get("kind"), KINDS),
    resourceIds: params.getAll("resource_id").map((id) => id.trim()).filter(Boolean),
    requestIds: params.getAll("request_id").map((id) => id.trim()).filter(Boolean),
    mine: params.get("mine") === "true",
    page: Number.isFinite(page) ? page : 1,
    pageSize: Number.isFinite(pageSize) ? pageSize : 20,
  });
  return successResponse(result);
});
