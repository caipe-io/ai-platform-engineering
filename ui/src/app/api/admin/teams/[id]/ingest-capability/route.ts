import {
ApiError,
getAuthFromBearerOrSession,
requireRbacPermission,
successResponse,
withErrorHandler,
} from '@/lib/api-middleware';
import { getCollection,isMongoDBConfigured } from '@/lib/mongodb';
import {
readOpenFgaTuples,
writeOpenFgaTuples,
type OpenFgaTupleKey,
} from '@/lib/rbac/openfga';
import { organizationObjectId } from '@/lib/rbac/organization';
import { requireResourcePermission } from '@/lib/rbac/resource-authz';
import { ObjectId } from 'mongodb';
import { NextRequest,NextResponse } from 'next/server';

/**
 * Explicit "data source author" capability grant for a team (spec
 * 2026-06-03-explicit-ingest-capability).
 *
 * Writes/reads the single tuple:
 *   team:<slug>#member -> ingestor -> organization:<key>
 *
 * `team#member` already subsumes `team#admin` in the model, so a single
 * member-userset grant covers every member (including admins). Granting and
 * revoking is restricted to org admins (`admin_ui:admin`). This capability is
 * intentionally distinct from per-knowledge_base `ingestor` (which only means
 * "push into KB X"); it is what gates the create/ingest UI and the server-side
 * create endpoints.
 *
 * assisted-by Cursor claude-opus-4.8
 */

function requireMongoDB(): NextResponse | null {
  if (!isMongoDBConfigured) {
    return NextResponse.json(
      {
        success: false,
        error: 'MongoDB not configured - team ingest capability requires MongoDB',
        code: 'MONGODB_NOT_CONFIGURED',
      },
      { status: 503 }
    );
  }
  return null;
}

interface TeamDoc {
  _id: ObjectId;
  slug?: string;
}

function validateTeamId(id: string): void {
  if (!ObjectId.isValid(id)) {
    throw new ApiError('Invalid team ID format', 400);
  }
}

async function resolveTeamSlug(id: string): Promise<string> {
  const teams = await getCollection('teams');
  const team = (await teams.findOne({ _id: new ObjectId(id) })) as TeamDoc | null;
  if (!team) {
    throw new ApiError('Team not found', 404);
  }
  return (team.slug as string | undefined) || id;
}

function ingestCapabilityTuple(teamSlug: string): OpenFgaTupleKey {
  return {
    user: `team:${teamSlug}#member`,
    relation: 'ingestor',
    object: organizationObjectId(),
  };
}

async function teamHoldsCapability(teamSlug: string): Promise<boolean> {
  const tuple = ingestCapabilityTuple(teamSlug);
  const result = await readOpenFgaTuples({ tuple });
  return result.tuples.some(
    (t) =>
      t.key.user === tuple.user &&
      t.key.relation === tuple.relation &&
      t.key.object === tuple.object
  );
}

// GET /api/admin/teams/[id]/ingest-capability — report current grant state.
export const GET = withErrorHandler(
  async (
    request: NextRequest,
    context: { params: Promise<{ id: string }> }
  ) => {
    const mongoCheck = requireMongoDB();
    if (mongoCheck) return mongoCheck;

    const { session } = await getAuthFromBearerOrSession(request);
    const params = await context.params;
    validateTeamId(params.id);

    const teamSlug = await resolveTeamSlug(params.id);
    await requireResourcePermission(
      session,
      { type: 'team', id: teamSlug, action: 'read' },
      { bypassForOrgAdmin: true },
    );
    const enabled = await teamHoldsCapability(teamSlug);

    return successResponse({
      team_id: params.id,
      team_slug: teamSlug,
      can_author_data_sources: enabled,
    });
  }
);

// PUT /api/admin/teams/[id]/ingest-capability — grant the capability.
export const PUT = withErrorHandler(
  async (
    request: NextRequest,
    context: { params: Promise<{ id: string }> }
  ) => {
    const mongoCheck = requireMongoDB();
    if (mongoCheck) return mongoCheck;

    const { user, session } = await getAuthFromBearerOrSession(request);
    const params = await context.params;
    validateTeamId(params.id);

    // Explicit opt-in is an org-admin-only action.
    await requireRbacPermission(session, 'admin_ui', 'admin');

    const teamSlug = await resolveTeamSlug(params.id);
    const tuple = ingestCapabilityTuple(teamSlug);

    if (!(await teamHoldsCapability(teamSlug))) {
      const result = await writeOpenFgaTuples({ writes: [tuple], deletes: [] });
      if (!result.enabled) {
        throw new ApiError(
          'OpenFGA is not configured; ingest capability cannot be granted',
          503
        );
      }
    }

    console.log(
      `[Admin] Ingest capability GRANTED to team=${teamSlug} by ${user.email}`
    );

    return successResponse({
      team_id: params.id,
      team_slug: teamSlug,
      can_author_data_sources: true,
    });
  }
);

// DELETE /api/admin/teams/[id]/ingest-capability — revoke the capability.
export const DELETE = withErrorHandler(
  async (
    request: NextRequest,
    context: { params: Promise<{ id: string }> }
  ) => {
    const mongoCheck = requireMongoDB();
    if (mongoCheck) return mongoCheck;

    const { user, session } = await getAuthFromBearerOrSession(request);
    const params = await context.params;
    validateTeamId(params.id);

    await requireRbacPermission(session, 'admin_ui', 'admin');

    const teamSlug = await resolveTeamSlug(params.id);
    const tuple = ingestCapabilityTuple(teamSlug);

    if (await teamHoldsCapability(teamSlug)) {
      const result = await writeOpenFgaTuples({ writes: [], deletes: [tuple] });
      if (!result.enabled) {
        throw new ApiError(
          'OpenFGA is not configured; ingest capability cannot be revoked',
          503
        );
      }
    }

    console.log(
      `[Admin] Ingest capability REVOKED from team=${teamSlug} by ${user.email}`
    );

    return successResponse({
      team_id: params.id,
      team_slug: teamSlug,
      can_author_data_sources: false,
    });
  }
);
