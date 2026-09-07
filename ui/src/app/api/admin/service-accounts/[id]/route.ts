import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth-config";
import {
  checkOpenFgaTuple,
  deleteExactOpenFgaTuples,
  listOpenFgaObjects,
} from "@/lib/rbac/openfga";
import type { OpenFgaTupleKey } from "@/lib/rbac/openfga";
import { deleteServiceAccountClient } from "@/lib/rbac/keycloak-admin";
import { logOpenFgaRebacAuditEvent } from "@/lib/rbac/audit";
import { getBySub, updateStatus } from "@/lib/service-accounts";
import { isProtectedServiceAccount } from "@/types/mongodb";
import { hasOrganizationAdmin } from "@/lib/rbac/platform-admin";
import { organizationObjectId } from "@/lib/rbac/organization";
import {
  listDirectServiceAccountKnowledgeScopes,
  scopeWriteTuple,
} from "@/lib/service-account-scopes";

/**
 * GET /api/admin/service-accounts/[id]
 *
 * Detail for a single service account. `[id]` is the SA's OpenFGA subject id
 * (`sa_sub`). Gated by `check(user:<caller>, can_manage, service_account:<id>)`
 * — i.e. the caller must belong to the owning team (FR-021/022) — OR be an
 * org admin (`hasOrganizationAdmin`), mirroring the bypass every other
 * shareable resource type grants org admins. Non-members get 404 (do not
 * reveal existence).
 *
 * Current scopes are read AUTHORITATIVELY from OpenFGA (not the Mongo display
 * snapshot, FR-014). NEVER returns credential material (FR-005).
 *
 * Response: { success, data: { id, name, description, owning_team_id,
 *   created_by, created_at, status, scopes: [{type,ref}] } }
 */

interface RouteContext {
  params: Promise<{ id: string }>;
}

/** Strip an OpenFGA `<type>:` prefix, returning the bare object id. */
function stripType(object: string, type: string): string {
  const prefix = `${type}:`;
  return object.startsWith(prefix) ? object.slice(prefix.length) : object;
}

export async function GET(_request: Request, context: RouteContext) {
  const session = (await getServerSession(authOptions)) as {
    sub?: string;
    user?: { email?: string | null };
  } | null;

  if (!session?.user?.email || !session.sub) {
    return NextResponse.json(
      { success: false, error: "Unauthorized" },
      { status: 401 },
    );
  }

  const { id } = await context.params;
  if (!id) {
    return NextResponse.json(
      { success: false, error: "Missing service account id" },
      { status: 400 },
    );
  }

  try {
    // Authorization: caller must be able to manage this SA (owning-team member).
    const decision = await checkOpenFgaTuple({
      user: `user:${session.sub}`,
      relation: "can_manage",
      object: `service_account:${id}`,
    });
    if (!decision.allowed && !(await hasOrganizationAdmin(session))) {
      // Do not reveal existence to non-members (FR-022).
      return NextResponse.json(
        { success: false, error: "Service account not found" },
        { status: 404 },
      );
    }

    const doc = await getBySub(id);
    if (!doc) {
      return NextResponse.json(
        { success: false, error: "Service account not found" },
        { status: 404 },
      );
    }

    // Authoritative scopes: read from OpenFGA, not the display snapshot.
    const [agentObjects, toolObjects, knowledgeScopes] = await Promise.all([
      listOpenFgaObjects({
        user: `service_account:${id}`,
        relation: "can_use",
        type: "agent",
      }),
      listOpenFgaObjects({
        user: `service_account:${id}`,
        relation: "can_call",
        type: "tool",
      }),
      listDirectServiceAccountKnowledgeScopes(`service_account:${id}`),
    ]);

    const scopes = [
      ...agentObjects.objects.map((object) => ({
        type: "agent" as const,
        ref: stripType(object, "agent"),
      })),
      ...toolObjects.objects.map((object) => ({
        type: "tool" as const,
        ref: stripType(object, "tool"),
      })),
      ...knowledgeScopes,
    ];

    return NextResponse.json({
      success: true,
      data: {
        id: doc.sa_sub,
        name: doc.name,
        description: doc.description,
        owning_team_id: doc.owning_team_id,
        created_by: doc.created_by,
        created_at: doc.created_at,
        status: doc.status,
        protected: isProtectedServiceAccount(doc),
        scopes,
      },
    });
  } catch (error) {
    console.error("[service-accounts:detail] failed:", error);
    return NextResponse.json(
      { success: false, error: "Failed to load service account" },
      { status: 503 },
    );
  }
}

/**
 * DELETE /api/admin/service-accounts/[id]
 *
 * Revoke a service account (US4; FR-018/018a) — terminal. Gated by can_manage
 * OR org admin.
 * Steps:
 *  1. Delete the Keycloak client (the credential stops authenticating).
 *  2. Delete ALL OpenFGA tuples for service_account:<id> — ownership
 *     (owner_team) + every scope grant (agent `user`, tool `caller`).
 *  3. Mark the Mongo doc status:revoked + revoked_at (retain for audit).
 *
 * The doc is retained but excluded from the active list, and its name becomes
 * reusable in the team (uniqueness is among `active` SAs only). Idempotent-ish:
 * a 404 from Keycloak is tolerated (already gone).
 *
 * Response 200: { success, data: { id, status: "revoked" } }
 */
export async function DELETE(_request: Request, context: RouteContext) {
  const session = (await getServerSession(authOptions)) as {
    sub?: string;
    user?: { email?: string | null };
  } | null;

  if (!session?.user?.email || !session.sub) {
    return NextResponse.json(
      { success: false, error: "Unauthorized" },
      { status: 401 },
    );
  }

  const { id } = await context.params;
  if (!id) {
    return NextResponse.json(
      { success: false, error: "Missing service account id" },
      { status: 400 },
    );
  }

  try {
    const canManage = await checkOpenFgaTuple({
      user: `user:${session.sub}`,
      relation: "can_manage",
      object: `service_account:${id}`,
    });
    if (!canManage.allowed && !(await hasOrganizationAdmin(session))) {
      return NextResponse.json(
        { success: false, error: "Service account not found" },
        { status: 404 },
      );
    }

    const doc = await getBySub(id);
    if (!doc) {
      return NextResponse.json(
        { success: false, error: "Service account not found" },
        { status: 404 },
      );
    }
    // Protected service accounts (e.g. the platform unlinked SA) cannot be
    // revoked. The UI greys out the control; this is the defense-in-depth check.
    if (isProtectedServiceAccount(doc)) {
      return NextResponse.json(
        {
          success: false,
          error: "This service account is protected and cannot be revoked.",
        },
        { status: 403 },
      );
    }
    // Already revoked → idempotent success.
    if (doc.status === "revoked") {
      return NextResponse.json({
        success: true,
        data: { id, status: "revoked" },
      });
    }

    const saSubject = `service_account:${id}`;

    // Enumerate every scope tuple from OpenFGA so we delete them all (the
    // snapshot is not authoritative — read live grants).
    const [agentObjects, toolObjects, knowledgeScopes] = await Promise.all([
      listOpenFgaObjects({
        user: saSubject,
        relation: "can_use",
        type: "agent",
      }),
      listOpenFgaObjects({
        user: saSubject,
        relation: "can_call",
        type: "tool",
      }),
      listDirectServiceAccountKnowledgeScopes(saSubject),
    ]);
    const tuples: OpenFgaTupleKey[] = [
      {
        user: `team:${doc.owning_team_id}#member`,
        relation: "owner_team",
        object: saSubject,
      },
      // Coarse-gateway baseline written at create (research.md R-9) — remove it
      // on revoke so the dead SA can't pass the mcp_gateway:list gate.
      { user: saSubject, relation: "caller", object: "mcp_gateway:list" },
      { user: saSubject, relation: "searcher", object: organizationObjectId() },
      ...agentObjects.objects.map((object) => ({
        user: saSubject,
        relation: "user",
        object,
      })),
      ...toolObjects.objects.map((object) => ({
        user: saSubject,
        relation: "caller",
        object,
      })),
      ...knowledgeScopes.map((scope) => scopeWriteTuple(scope, saSubject)),
    ];

    // Ordering rationale (FR-018): kill the CREDENTIAL first. The primary
    // security guarantee of revoke is "the credential no longer authenticates",
    // so we delete the Keycloak client before anything else — once it's gone the
    // SA's tokens fail validation and any lingering OpenFGA tuples are unusable
    // (no live credential can present them). Each step is idempotent, so a crash
    // mid-sequence is fully repaired by re-running DELETE: deleteServiceAccountClient
    // tolerates 404, deleteExactOpenFgaTuples is a no-op on absent tuples, and
    // updateStatus is idempotent. We deliberately do NOT reorder to
    // tuples→Mongo→client: that would leave a window where Mongo reports
    // "revoked" while the credential still authenticates if the final step failed.
    // 1. Delete the Keycloak client (tolerates already-gone).
    await deleteServiceAccountClient(doc.client_uuid);
    // 2. Delete all OpenFGA tuples (ownership + coarse-gate baseline + scopes).
    await deleteExactOpenFgaTuples(tuples);
    // 3. Mark revoked in Mongo (retain doc; frees the name for reuse).
    await updateStatus(id, "revoked");

    logOpenFgaRebacAuditEvent({
      sub: session.sub,
      operation: "service_account.revoke",
      scope: "admin",
      resourceRef: `service_account:${id}`,
      email: session.user.email ?? undefined,
      correlationId: `service_account.revoke:${id}:${doc.owning_team_id}`,
    });

    return NextResponse.json({
      success: true,
      data: { id, status: "revoked" },
    });
  } catch (error) {
    console.error("[service-accounts:revoke] failed:", error);
    return NextResponse.json(
      { success: false, error: "Failed to revoke service account" },
      { status: 503 },
    );
  }
}
