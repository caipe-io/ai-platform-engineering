import {
ApiError,
getAuthFromBearerOrSession,
requireRbacPermission,
successResponse,
withErrorHandler,
} from "@/lib/api-middleware";
import { getCollection,isMongoDBConfigured } from "@/lib/mongodb";
import { requireUserProfileRead } from "@/lib/rbac/require-openfga";
import {
deleteRealmUser,
getRealmUserById,
updateUser,
} from "@/lib/rbac/keycloak-admin";
import { getRbacCollection } from "@/lib/rbac/mongo-collections";
import {
deleteExactOpenFgaTuples,
readOpenFgaTuples,
type OpenFgaTupleKey,
} from "@/lib/rbac/openfga";
import type { TeamMembershipSource } from "@/types/identity-group-sync";
import type { UserMembershipSourceInfo } from "@/types/admin-user-identity";
import { type NextRequest } from "next/server";

function normalizeAttributes(raw: unknown): Record<string, string[]> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out: Record<string, string[]> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (Array.isArray(v)) out[k] = v.map(String);
    else if (v != null) out[k] = [String(v)];
  }
  return out;
}

function slackLinkStatus(attrs: Record<string, string[]>): "linked" | "unlinked" {
  const sid = attrs.slack_user_id?.[0];
  return sid && String(sid).trim() !== "" ? "linked" : "unlinked";
}

async function readSubjectTuples(subject: string): Promise<OpenFgaTupleKey[]> {
  // assisted-by Codex Codex-sonnet-4-6
  // OpenFGA read filters cannot be user-only, so delete cleanup scans pages.
  const tuples: OpenFgaTupleKey[] = [];
  let continuationToken: string | undefined;
  do {
    const page = await readOpenFgaTuples({
      continuationToken,
      pageSize: 100,
    });
    tuples.push(...page.tuples.map((entry) => entry.key).filter((key) => key.user === `user:${subject}`));
    continuationToken = page.continuationToken;
  } while (continuationToken);
  return tuples;
}

export const GET = withErrorHandler(
  async (
    request: NextRequest,
    context: { params: Promise<{ id: string }> }
  ) => {
    const { session } = await getAuthFromBearerOrSession(request);
    const params = await context.params;
    const id = params.id;
    await requireUserProfileRead(session, id);

    const kcUser = await getRealmUserById(id);

    const email = String(kcUser.email ?? "").trim().toLowerCase();
    const teams: Array<{ team_id: string; tenant_id: string }> = [];
    const membershipSources: UserMembershipSourceInfo[] = [];

    if (isMongoDBConfigured && email) {
      const sources = await getRbacCollection<TeamMembershipSource>("teamMembershipSources");
      const rows = await sources
        .find({ user_email: email, status: "active" })
        .project({
          team_slug: 1, team_id: 1, relationship: 1, source_type: 1,
          provider_id: 1, external_group_id: 1, user_subject: 1,
          last_seen_at: 1, last_applied_at: 1,
        })
        .toArray();
      // Deduplicate by team_slug — a user may have multiple source rows per team.
      const seen = new Set<string>();
      for (const row of rows) {
        const slug = row.team_slug;
        if (slug) {
          membershipSources.push({
            team: slug,
            relationship: row.relationship,
            source: row.source_type,
            provider: row.provider_id,
            externalGroup: row.external_group_id,
            subject: row.user_subject,
            lastSeenAt: row.last_seen_at,
            lastAppliedAt: row.last_applied_at,
          });
        }
        if (!slug || seen.has(slug)) continue;
        seen.add(slug);
        teams.push({ team_id: slug, tenant_id: row.team_id ?? "" });
      }
    }

    const attributes = normalizeAttributes(kcUser.attributes);

    const createdRaw = kcUser.createdTimestamp;
    const createdAt =
      typeof createdRaw === "number" && createdRaw > 0 ? createdRaw : null;

    return successResponse({
      user: {
        id: String(kcUser.id ?? id),
        principalType: kcUser.serviceAccountClientId ? "service_account" : "user",
        username: String(kcUser.username ?? ""),
        email: String(kcUser.email ?? ""),
        firstName:
          kcUser.firstName !== undefined && kcUser.firstName !== null
            ? String(kcUser.firstName)
            : "",
        lastName:
          kcUser.lastName !== undefined && kcUser.lastName !== null
            ? String(kcUser.lastName)
            : "",
        enabled: kcUser.enabled !== false,
        createdAt,
        attributes,
        membershipSources,
        membershipSourcesAvailable: Boolean(isMongoDBConfigured && email),
        slackLinkStatus: slackLinkStatus(attributes),
        teams: teams.map((t) => ({
          team_id: t.team_id,
          tenant_id: t.tenant_id,
        })),
      },
    });
  }
);

export const PUT = withErrorHandler(
  async (
    request: NextRequest,
    context: { params: Promise<{ id: string }> }
  ) => {
    const { session } = await getAuthFromBearerOrSession(request);
    await requireRbacPermission(session, "admin_ui", "admin");

    const params = await context.params;
    const id = params.id;

    let body: Record<string, unknown>;
    try {
      body = (await request.json()) as Record<string, unknown>;
    } catch {
      throw new ApiError("Invalid JSON body", 400);
    }

    const existing = await getRealmUserById(id);
    const merged: Record<string, unknown> = { ...existing, ...body, id: existing.id };
    await updateUser(id, merged);

    return successResponse({ ok: true });
  }
);

export const DELETE = withErrorHandler(
  async (
    request: NextRequest,
    context: { params: Promise<{ id: string }> }
  ) => {
    const { session } = await getAuthFromBearerOrSession(request);
    await requireRbacPermission(session, "admin_ui", "admin");

    const params = await context.params;
    const id = params.id?.trim();
    if (!id) {
      throw new ApiError("User id is required", 400);
    }
    if (session.sub === id) {
      throw new ApiError("Cannot delete the current session user", 400, "CURRENT_USER_DELETE_FORBIDDEN");
    }

    const existing = await getRealmUserById(id);
    const email = String(existing.email ?? existing.username ?? "").trim().toLowerCase();
    const deletedTuples = await readSubjectTuples(id);

    if (deletedTuples.length > 0) {
      await deleteExactOpenFgaTuples(deletedTuples);
    }

    let removedMembershipSources = 0;
    if (isMongoDBConfigured) {
      const now = new Date().toISOString();
      const sources = await getRbacCollection<TeamMembershipSource>("teamMembershipSources");
      const sourceResult = await sources.updateMany(
        {
          status: "active",
          $or: [
            { user_subject: id },
            ...(email ? [{ user_email: email }, { user_id: email }] : []),
          ],
        } as never,
        {
          $set: {
            status: "removed",
            removed_at: now,
            removed_by: session.user?.email ?? "admin-api",
            last_seen_at: now,
          },
        } as never,
      );
      removedMembershipSources = sourceResult.modifiedCount ?? 0;

      const users = await getCollection<Record<string, unknown>>("users");
      await users.updateMany(
        {
          $or: [
            { keycloak_sub: id },
            { id },
            { _id: id },
            ...(email ? [{ email }] : []),
          ],
        } as never,
        {
          $set: {
            status: "deleted",
            enabled: false,
            deleted_at: now,
            deleted_by: session.user?.email ?? "admin-api",
          },
        } as never,
      );
    }

    await deleteRealmUser(id);

    return successResponse({
      id,
      deleted: true,
      email,
      openfga_tuples_deleted: deletedTuples.length,
      membership_sources_removed: removedMembershipSources,
    });
  }
);
