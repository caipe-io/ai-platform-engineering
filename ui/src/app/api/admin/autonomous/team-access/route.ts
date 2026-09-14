import { ObjectId, type Document } from "mongodb";
import { NextRequest, NextResponse } from "next/server";

import {
  ApiError,
  getAuthFromBearerOrSession,
  requireRbacPermission,
  successResponse,
  withErrorHandler,
} from "@/lib/api-middleware";
import { getCollection, isMongoDBConfigured } from "@/lib/mongodb";
import {
  batchCheckOpenFgaTuples,
  type OpenFgaTupleKey,
  writeOpenFgaTuples,
} from "@/lib/rbac/openfga";
import { organizationObjectId } from "@/lib/rbac/organization";

export const dynamic = "force-dynamic";

const DEFAULT_PAGE_SIZE = 25;
const MAX_PAGE_SIZE = 100;

interface TeamDocument extends Document {
  _id: ObjectId;
  name?: string;
  slug?: string;
  status?: string;
}

interface UpdateTeamAccessBody {
  all?: boolean;
  enabled?: boolean;
  team_ids?: string[];
}

function requireMongoDB(): NextResponse | null {
  if (isMongoDBConfigured) return null;
  return NextResponse.json(
    { success: false, error: "MongoDB not configured", code: "MONGODB_NOT_CONFIGURED" },
    { status: 503 },
  );
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function teamSlug(team: TeamDocument): string {
  return typeof team.slug === "string" && team.slug ? team.slug : String(team._id);
}

function eligibilityTuple(team: TeamDocument): OpenFgaTupleKey {
  return {
    user: `team:${teamSlug(team)}#member`,
    relation: "automation_eligible",
    object: organizationObjectId(),
  };
}

export const GET = withErrorHandler(async (request: NextRequest) => {
  const mongoCheck = requireMongoDB();
  if (mongoCheck) return mongoCheck;

  const { session } = await getAuthFromBearerOrSession(request);
  await requireRbacPermission(session, "admin_ui", "view");
  const canManage = await requireRbacPermission(session, "admin_ui", "admin").then(
    () => true,
    () => false,
  );

  const page = Math.max(1, Number.parseInt(request.nextUrl.searchParams.get("page") ?? "1", 10) || 1);
  const pageSize = Math.min(
    MAX_PAGE_SIZE,
    Math.max(
      1,
      Number.parseInt(
        request.nextUrl.searchParams.get("page_size") ?? String(DEFAULT_PAGE_SIZE),
        10,
      ) || DEFAULT_PAGE_SIZE,
    ),
  );
  const search = (request.nextUrl.searchParams.get("search") ?? "").trim();
  const query: Record<string, unknown> = { status: { $ne: "archived" } };
  if (search) {
    const pattern = escapeRegExp(search);
    query.$or = [
      { name: { $regex: pattern, $options: "i" } },
      { slug: { $regex: pattern, $options: "i" } },
    ];
  }

  const teams = await getCollection<TeamDocument>("teams");
  const [documents, total] = await Promise.all([
    teams
      .find(query)
      .project<TeamDocument>({ name: 1, slug: 1 })
      .sort({ name: 1, slug: 1 })
      .skip((page - 1) * pageSize)
      .limit(pageSize)
      .toArray(),
    teams.countDocuments(query),
  ]);
  const checks = await batchCheckOpenFgaTuples(documents.map(eligibilityTuple));

  const response = successResponse({
    teams: documents.map((team, index) => ({
      id: String(team._id),
      name: typeof team.name === "string" && team.name ? team.name : teamSlug(team),
      slug: teamSlug(team),
      enabled: Boolean(checks[index]),
    })),
    total,
    page,
    page_size: pageSize,
    has_more: page * pageSize < total,
    can_manage: canManage,
  });
  response.headers.set("Cache-Control", "no-store, max-age=0");
  return response;
});

export const PUT = withErrorHandler(async (request: NextRequest) => {
  const mongoCheck = requireMongoDB();
  if (mongoCheck) return mongoCheck;

  const { session, user } = await getAuthFromBearerOrSession(request);
  await requireRbacPermission(session, "admin_ui", "admin");

  const body = (await request.json()) as UpdateTeamAccessBody;
  if (typeof body.enabled !== "boolean") {
    throw new ApiError("enabled must be a boolean", 400);
  }
  const updateAll = body.all === true;
  const ids = Array.isArray(body.team_ids) ? [...new Set(body.team_ids)] : [];
  if (!updateAll && ids.length === 0) {
    throw new ApiError("Select at least one team", 400);
  }
  if (!updateAll && ids.some((id) => !ObjectId.isValid(id))) {
    throw new ApiError("Invalid team ID format", 400);
  }

  const teams = await getCollection<TeamDocument>("teams");
  const query = updateAll
    ? { status: { $ne: "archived" } }
    : { _id: { $in: ids.map((id) => new ObjectId(id)) }, status: { $ne: "archived" } };
  const documents = await teams
    .find(query)
    .project<TeamDocument>({ name: 1, slug: 1 })
    .toArray();
  if (!updateAll && documents.length !== ids.length) {
    throw new ApiError("One or more teams were not found", 404);
  }

  const tuples = documents.map(eligibilityTuple);
  const result = await writeOpenFgaTuples({
    writes: body.enabled ? tuples : [],
    deletes: body.enabled ? [] : tuples,
  });
  if (!result.enabled) {
    throw new ApiError("OpenFGA is not configured; team access cannot be updated", 503);
  }

  console.log(
    `[Admin] Autonomous access ${body.enabled ? "GRANTED" : "REVOKED"} for ${documents.length} team(s) by ${user.email}`,
  );
  return successResponse({ enabled: body.enabled, updated: documents.length });
});
