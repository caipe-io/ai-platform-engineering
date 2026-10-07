// assisted-by Claude:claude-opus-5
import { NextResponse } from "next/server";
import { batchCheckOpenFgaTuples } from "@/lib/rbac/openfga";
import { reconcileTupleDiff } from "@/lib/authz";
import { logOpenFgaRebacAuditEvent } from "@/lib/rbac/audit";
import { organizationObjectId } from "@/lib/rbac/organization";
import {
  parseScope,
  scopeCheckTuple,
  scopeWriteTuple,
  type ScopeRef,
} from "@/lib/service-account-scopes";
import {
  refreshSnapshot,
  requireManageServiceAccountAccess,
} from "../route";

/**
 * POST /api/admin/service-accounts/[id]/scopes/bulk — add many scopes in one
 * request (FR-015, bulk variant).
 *
 * The single-scope POST at `../route.ts` re-derives the SA's ENTIRE scope set
 * from OpenFGA (`refreshSnapshot`, several paginated reads — for the unlinked
 * SA specifically, also a full `listEveryoneKnowledgeScopes()` sweep) after
 * every individual write. Looping that from the client for a large batch (a
 * "bulk-add datasources from a collection" pick can easily queue hundreds of
 * datasources) turns into hundreds of sequential HTTP round trips, each
 * paying the full-rescan cost — tens of seconds for a few hundred scopes.
 *
 * This route batches the SAME underlying primitives instead of looping them:
 *  - `batchCheckOpenFgaTuples` for the "does the editor hold this scope"
 *    check (FR-015), replacing N individual `checkOpenFgaTuple` calls.
 *  - ONE `reconcileTupleDiff` call carrying every scope's write tuple (this
 *    is exactly how `unlinked-knowledge-access.ts`'s Everyone reconciler
 *    already applies hundreds of tuples at once) — internally chunked to
 *    OpenFGA's per-transaction tuple limit, with all-or-nothing compensation
 *    on a partial chunk failure.
 *  - ONE `refreshSnapshot` call at the end instead of one per scope.
 *
 * Permission semantics are intentionally atomic, not per-item: if the editor
 * doesn't hold ANY requested scope (and isn't a platform admin), the WHOLE
 * request is rejected before anything is written — no partial application.
 * In practice this should never trigger from the UI, since every picker only
 * offers scopes drawn from the caller's own grantable set; it's a
 * defense-in-depth check, not an expected-to-sometimes-fail path.
 */

interface RouteContext {
  params: Promise<{ id: string }>;
}

// Headroom above any real bulk-add-by-collection scenario today (an admin
// bulk-adding every datasource in a large collection) without being
// unbounded.
const MAX_BULK_SCOPES = 1000;

function parseBulkBody(
  raw: unknown,
): { scopes?: ScopeRef[]; error?: string } {
  if (typeof raw !== "object" || raw === null) {
    return { error: "Request body must be an object" };
  }
  const obj = raw as Record<string, unknown>;
  if (!Array.isArray(obj.scopes)) {
    return { error: "scopes must be an array" };
  }
  if (obj.scopes.length === 0) {
    return { error: "scopes must contain at least one entry" };
  }
  if (obj.scopes.length > MAX_BULK_SCOPES) {
    return { error: `scopes may not exceed ${MAX_BULK_SCOPES} entries` };
  }
  const scopes: ScopeRef[] = [];
  for (const item of obj.scopes) {
    const { scope, error } = parseScope(item);
    if (!scope) return { error };
    scopes.push(scope);
  }
  return { scopes };
}

export async function POST(request: Request, context: RouteContext) {
  const { id } = await context.params;
  const gate = await requireManageServiceAccountAccess(id);
  if ("response" in gate) return gate.response;
  const { actor, bypassHeldScopeCheck } = gate;

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return NextResponse.json(
      { success: false, error: "Invalid JSON body" },
      { status: 400 },
    );
  }
  const { scopes, error } = parseBulkBody(raw);
  if (!scopes) {
    return NextResponse.json({ success: false, error }, { status: 400 });
  }

  try {
    // FR-015 (batch): reject the whole request if the editor doesn't hold
    // ANY requested scope — atomic, no partial writes. Platform admins
    // bypass this the same way the single-scope route does.
    if (!bypassHeldScopeCheck) {
      const held = await batchCheckOpenFgaTuples(
        scopes.map((scope) => scopeCheckTuple(scope, `user:${actor.callerSub}`)),
      );
      const rejected = scopes.filter((_, i) => !held[i]);
      if (rejected.length > 0) {
        return NextResponse.json(
          {
            success: false,
            error: "You cannot grant a scope you do not hold",
            data: { rejected_scopes: rejected },
          },
          { status: 403 },
        );
      }
    }

    const saSubject = `service_account:${id}`;
    const hasKnowledgeScope = scopes.some(
      (scope) => scope.type === "datasource" || scope.type === "collection",
    );
    await reconcileTupleDiff(
      {
        writes: [
          ...scopes.map((scope) => scopeWriteTuple(scope, saSubject)),
          ...(hasKnowledgeScope
            ? [
                {
                  user: saSubject,
                  relation: "searcher",
                  object: organizationObjectId(),
                },
              ]
            : []),
        ],
        deletes: [],
      },
      {
        caller: { type: "user", id: actor.callerSub },
        source: "service_account_scope_bulk_add",
      },
    );
    await refreshSnapshot(id, { sub: actor.callerSub, at: new Date() }, scopes);

    logOpenFgaRebacAuditEvent({
      sub: actor.callerSub,
      operation: "service_account.scope_bulk_add",
      scope: "admin",
      resourceRef: `service_account:${id}`,
      email: actor.email,
      correlationId: `service_account.scope_bulk_add:${id}:${scopes.length}:${Date.now()}`,
    });

    return NextResponse.json({
      success: true,
      data: { added: scopes, added_count: scopes.length },
    });
  } catch (err) {
    console.error("[service-accounts:scope_bulk_add] failed:", err);
    return NextResponse.json(
      { success: false, error: "Failed to add scopes" },
      { status: 503 },
    );
  }
}
