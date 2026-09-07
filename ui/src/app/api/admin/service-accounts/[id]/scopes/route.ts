// assisted-by Codex Codex-sonnet-4-6
import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth-config";
import { reconcileTupleDiff } from "@/lib/authz";
import { checkOpenFgaTuple, listOpenFgaObjects } from "@/lib/rbac/openfga";
import { logOpenFgaRebacAuditEvent } from "@/lib/rbac/audit";
import { getBySub, updateScopesSnapshot } from "@/lib/service-accounts";
import { findAgentVisibilities } from "@/lib/dynamic-agent-visibility";
import {
  listDirectServiceAccountKnowledgeScopes,
  parseScope,
  refFromObject,
  scopeCheckTuple,
  scopeWriteTuple,
  type ScopeRef,
} from "@/lib/service-account-scopes";
import {
  listEveryoneKnowledgeScopes,
  reconcileExistingUnlinkedKnowledgeAccess,
} from "@/lib/rbac/unlinked-knowledge-access";
import type { ServiceAccountScope } from "@/types/mongodb";
import { hasOrganizationAdmin as isPlatformAdmin } from "@/lib/rbac/platform-admin";
import { organizationObjectId } from "@/lib/rbac/organization";

/**
 * Scope management for a service account (US3).
 *
 * `[id]` is the SA's OpenFGA subject id (`sa_sub`). Both verbs require the
 * caller to be able to MANAGE the SA (owning-team membership) OR be an org
 * admin: check(user:<caller>, can_manage, service_account:<id>).
 *
 * POST  — add a scope (FR-015): non-admin editors must ALSO hold the scope
 *         being granted (check(user:<editor>, <rel>, <object>) → 403 if
 *         unheld). Platform admins can add any catalog scope to an SA they can
 *         manage, even if their org-admin authority is not materialized as a
 *         per-tool `can_call` tuple.
 * DELETE — remove a scope (FR-016): can_manage ONLY; the editor need NOT hold
 *         the scope.
 *
 * Neither verb touches the credential (FR-019) — only OpenFGA tuples + the
 * Mongo display snapshot change. Both audit (FR-026).
 */

interface RouteContext {
  params: Promise<{ id: string }>;
}

interface ResolvedActor {
  callerSub: string;
  email?: string;
}

/** 401 helper. */
function unauthorized() {
  return NextResponse.json(
    { success: false, error: "Unauthorized" },
    { status: 401 },
  );
}

/**
 * Common preamble: authenticate, parse the scope body, and enforce can_manage.
 * Returns either an early `response` (to return) or the validated context.
 */
async function authorizeScopeMutation(
  request: Request,
  id: string,
): Promise<
  | { response: NextResponse }
  | { actor: ResolvedActor; scope: ScopeRef; bypassHeldScopeCheck: boolean }
> {
  const session = (await getServerSession(authOptions)) as {
    sub?: string;
    user?: { email?: string | null };
  } | null;
  if (!session?.user?.email || !session.sub) {
    return { response: unauthorized() };
  }

  if (!id) {
    return {
      response: NextResponse.json(
        { success: false, error: "Missing service account id" },
        { status: 400 },
      ),
    };
  }

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return {
      response: NextResponse.json(
        { success: false, error: "Invalid JSON body" },
        { status: 400 },
      ),
    };
  }
  const { scope, error } = parseScope(raw);
  if (!scope) {
    return {
      response: NextResponse.json({ success: false, error }, { status: 400 }),
    };
  }

  // can_manage gate (owning-team membership) OR org admin. 404 to neither
  // (don't reveal existence — FR-022). Org admins get the same bypass here
  // that every other shareable resource type grants (see resource-authz.ts's
  // `bypassForOrgAdmin`); this also subsumes the narrower unlinked-SA-only
  // bypass this route used to have (platform admins could already manage the
  // unlinked SA's scopes — now that extends to every SA, consistent with the
  // detail/rotate/credentials routes).
  const canManage = await checkOpenFgaTuple({
    user: `user:${session.sub}`,
    relation: "can_manage",
    object: `service_account:${id}`,
  });
  const platformAdmin = await isPlatformAdmin(session);

  if (!canManage.allowed && !platformAdmin) {
    return {
      response: NextResponse.json(
        { success: false, error: "Service account not found" },
        { status: 404 },
      ),
    };
  }

  return {
    actor: { callerSub: session.sub, email: session.user.email ?? undefined },
    scope,
    bypassHeldScopeCheck: platformAdmin,
  };
}

/**
 * Read the SA's current scopes from OpenFGA (authoritative) and rebuild the
 * Mongo display snapshot after a mutation. `mutated` carries the just-changed
 * scope's added_by/added_at so the snapshot reflects who added it.
 */
async function refreshSnapshot(
  saSub: string,
  addedByForNew: { sub: string; at: Date },
  explicitlyAddedScope?: ScopeRef,
): Promise<void> {
  const subject = `service_account:${saSub}`;
  const serviceAccount = await getBySub(saSub);
  const prior = serviceAccount?.scopes_snapshot ?? [];
  const priorByKey = new Map(prior.map((s) => [`${s.type}:${s.ref}`, s]));
  const everyoneKnowledge = serviceAccount?.is_platform_unlinked
    ? await listEveryoneKnowledgeScopes()
    : null;
  const [agentObjects, toolObjects, knowledgeScopes] = await Promise.all([
    listOpenFgaObjects({ user: subject, relation: "can_use", type: "agent" }),
    listOpenFgaObjects({ user: subject, relation: "can_call", type: "tool" }),
    listDirectServiceAccountKnowledgeScopes(subject),
  ]);

  const agentIds = agentObjects.objects.map(refFromObject);
  const toolIds = toolObjects.objects.map(refFromObject);
  // Automatic Everyone collection grants are direct reader tuples too. Keep
  // them out of the snapshot unless an admin also explicitly selected the
  // same scope; the snapshot records explicit intent and protects it from an
  // eventual Everyone removal.
  const explicitKnowledgeScopes = knowledgeScopes.filter((scope) => {
    if (!everyoneKnowledge) return true;
    const key = `${scope.type}:${scope.ref}`;
    const automatic =
      scope.type === "datasource"
        ? everyoneKnowledge.datasourceIds.has(scope.ref)
        : everyoneKnowledge.collectionIds.has(scope.ref);
    return (
      !automatic ||
      priorByKey.has(key) ||
      (explicitlyAddedScope?.type === scope.type &&
        explicitlyAddedScope.ref === scope.ref)
    );
  });
  const datasourceIds = explicitKnowledgeScopes
    .filter((scope) => scope.type === "datasource")
    .map((scope) => scope.ref);
  const collectionIds = explicitKnowledgeScopes
    .filter((scope) => scope.type === "collection")
    .map((scope) => scope.ref);

  // Global (Everyone-shared) agents grant the unlinked SA `can_use` via the
  // agent's visibility, not via an explicit panel scope. Keep those out of the
  // display snapshot so the snapshot only ever tracks explicit grants — the
  // panel surfaces global agents separately as read-only "via Everyone" chips.
  const visibilityById = await findAgentVisibilities(agentIds);
  const explicitAgentIds = agentIds.filter(
    (ref) => visibilityById.get(ref) !== "global",
  );

  // Preserve prior added_by/added_at where we have them; default new entries to
  // the current editor/time.
  const build = (
    type: ServiceAccountScope["type"],
    refs: string[],
  ): ServiceAccountScope[] =>
    refs.map(
      (ref) =>
        priorByKey.get(`${type}:${ref}`) ?? {
          type,
          ref,
          added_by: addedByForNew.sub,
          added_at: addedByForNew.at,
        },
    );

  const snapshot = [
    ...build("agent", explicitAgentIds),
    ...build("tool", toolIds),
    ...build("datasource", datasourceIds),
    ...build("collection", collectionIds),
  ];
  await updateScopesSnapshot(saSub, snapshot);
}

export async function POST(request: Request, context: RouteContext) {
  const { id } = await context.params;
  const pre = await authorizeScopeMutation(request, id);
  if ("response" in pre) return pre.response;
  const { actor, scope, bypassHeldScopeCheck } = pre;

  try {
    // FR-015: normal non-admin editors must hold the scope they're granting.
    // Platform admins are different: org-admin authority is administrative and
    // often is not materialized as per-tool can_call tuples, but the picker now
    // exposes the full platform MCP catalog for them.
    if (!bypassHeldScopeCheck) {
      const held = await checkOpenFgaTuple(
        scopeCheckTuple(scope, `user:${actor.callerSub}`),
      );
      if (!held.allowed) {
        return NextResponse.json(
          {
            success: false,
            error: "You cannot grant a scope you do not hold",
            data: { rejected_scope: scope },
          },
          { status: 403 },
        );
      }
    }

    const saSubject = `service_account:${id}`;
    await reconcileTupleDiff(
      {
        writes: [
          scopeWriteTuple(scope, saSubject),
          ...(scope.type === "datasource" || scope.type === "collection"
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
        source: "service_account_scope_add",
      },
    );
    await refreshSnapshot(
      id,
      { sub: actor.callerSub, at: new Date() },
      scope,
    );

    logOpenFgaRebacAuditEvent({
      sub: actor.callerSub,
      operation: "service_account.scope_add",
      scope: "admin",
      resourceRef: `service_account:${id}`,
      email: actor.email,
      correlationId: `service_account.scope_add:${id}:${scope.type}:${scope.ref}`,
    });

    return NextResponse.json({ success: true, data: { added: scope } });
  } catch (error) {
    console.error("[service-accounts:scope_add] failed:", error);
    return NextResponse.json(
      { success: false, error: "Failed to add scope" },
      { status: 503 },
    );
  }
}

export async function DELETE(request: Request, context: RouteContext) {
  const { id } = await context.params;
  const pre = await authorizeScopeMutation(request, id);
  if ("response" in pre) return pre.response;
  const { actor, scope } = pre;
  const serviceAccount = await getBySub(id);

  if (
    serviceAccount?.is_platform_unlinked &&
    (scope.type === "datasource" || scope.type === "collection") &&
    !(serviceAccount.scopes_snapshot ?? []).some(
      (candidate) =>
        candidate.type === scope.type && candidate.ref === scope.ref,
    )
  ) {
    return NextResponse.json(
      {
        success: false,
        error:
          "This knowledge access comes from sharing with Everyone. Change the datasource or collection Search access to revoke it.",
      },
      { status: 409 },
    );
  }

  // An agent shared with Everyone (global) grants the unlinked SA `can_use`
  // through the agent's visibility, not through this explicit scope. Removing
  // it here would delete a tuple the visibility reconcile re-adds on the next
  // edit/seed — a silent no-op. Refuse it and point the admin at the agent.
  if (scope.type === "agent") {
    const visibilityById = await findAgentVisibilities([scope.ref]);
    if (visibilityById.get(scope.ref) === "global") {
      return NextResponse.json(
        {
          success: false,
          error:
            "This agent is shared with Everyone; unlinked access is managed by the agent's visibility. Change the agent's visibility to revoke it.",
        },
        { status: 409 },
      );
    }
  }

  // FR-016: removal requires can_manage ONLY (already checked) — the editor
  // need NOT hold the scope. No scope-holding check here, by design.
  try {
    const saSubject = `service_account:${id}`;
    const deletes = [scopeWriteTuple(scope, saSubject)];
    if (scope.type === "datasource" || scope.type === "collection") {
      const currentKnowledge =
        await listDirectServiceAccountKnowledgeScopes(saSubject);
      const remaining = currentKnowledge.filter(
        (current) => current.type !== scope.type || current.ref !== scope.ref,
      );
      if (remaining.length === 0) {
        deletes.push({
          user: saSubject,
          relation: "searcher",
          object: organizationObjectId(),
        });
      }
    }
    await reconcileTupleDiff(
      { writes: [], deletes },
      {
        caller: { type: "user", id: actor.callerSub },
        source: "service_account_scope_remove",
      },
    );
    await refreshSnapshot(id, { sub: actor.callerSub, at: new Date() });
    if (
      serviceAccount?.is_platform_unlinked &&
      (scope.type === "datasource" || scope.type === "collection")
    ) {
      await reconcileExistingUnlinkedKnowledgeAccess();
    }

    logOpenFgaRebacAuditEvent({
      sub: actor.callerSub,
      operation: "service_account.scope_remove",
      scope: "admin",
      resourceRef: `service_account:${id}`,
      email: actor.email,
      correlationId: `service_account.scope_remove:${id}:${scope.type}:${scope.ref}`,
    });

    return NextResponse.json({ success: true, data: { removed: scope } });
  } catch (error) {
    console.error("[service-accounts:scope_remove] failed:", error);
    return NextResponse.json(
      { success: false, error: "Failed to remove scope" },
      { status: 503 },
    );
  }
}
