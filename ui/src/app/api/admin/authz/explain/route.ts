// assisted-by Codex Codex-sonnet-4-6
//
// POST /api/admin/authz/explain — admin permission debugger.
//
// "Why can/can't subject S do action A on resource R?" Returns the CAS
// decision plus the OpenFGA debug block (the relation actually checked).
// Admin-gated (admin_ui / audit.view); no subject-binding because this is a
// privileged forensic tool, not a self-service decision call.
//
// Single action  → { decision, reason, retriable, debug }            (back-compat)
// `actions: [..]` (or neither field) → { results: [ {action, decision, reason, retriable, debug} ] }
//   — the permission-matrix view: every action for one subject+resource at once.

import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";

import { authOptions } from "@/lib/auth-config";
import { requireRbacPermission, withErrorHandler, ApiError } from "@/lib/api-middleware";
import { authorize, describeFgaCheck, type Action, type Resource, type Subject } from "@/lib/authz";
import { HttpAuthzError, parseAction, parseSubject } from "@/lib/authz/http";
import { readOpenFgaTuples, type OpenFgaTupleKey } from "@/lib/rbac/openfga";
import { isSupportedResourceAction, listResourceTypeDefinitions } from "@/lib/rbac/resource-model";
import { openFgaResourceObject } from "@/lib/rbac/openfga-resource-ids";
import { parseAccessAction, parseAccessResource } from "@/lib/authz/access-validation";
import { isAppResource } from "@/lib/authz/resource-contract";
import { readRegisteredResource } from "@/lib/authz/resource-store";
import { declaredResourceActions } from "@/lib/authz/resource-types";
import { openFgaRelation } from "@/lib/rbac/tuple-builders";

const ALL_ACTIONS = Array.from(
  new Set(listResourceTypeDefinitions().flatMap((definition) => definition.actions)),
) as Action[];

function directGrantTuple(subject: Subject, resource: Resource, action: Action): OpenFgaTupleKey {
  return {
    user: `${subject.type}:${subject.id}`,
    relation: openFgaRelation(action),
    object: openFgaResourceObject(resource.type, resource.id),
  };
}

function tupleLabel(tuple: OpenFgaTupleKey): string {
  return `${tuple.user} ${tuple.relation} ${tuple.object}`;
}

function tupleMatches(a: OpenFgaTupleKey, b: OpenFgaTupleKey): boolean {
  return a.user === b.user && a.relation === b.relation && a.object === b.object;
}

async function explainDirectGrant(subject: Subject, resource: Resource, action: Action) {
  const tuple = directGrantTuple(subject, resource, action);
  try {
    const page = await readOpenFgaTuples({ tuple, pageSize: 1 });
    const present = page.tuples.some((entry) => tupleMatches(entry.key, tuple));
    return {
      tuple: tupleLabel(tuple),
      present,
      revocable: present,
    };
  } catch {
    return {
      tuple: tupleLabel(tuple),
      present: false,
      revocable: false,
      lookup_error: "DIRECT_GRANT_LOOKUP_FAILED",
    };
  }
}

function explainOne(subject: Subject, resource: Resource, action: Action, tenantId?: string) {
  return (async () => {
    const req = { subject, resource, action };
    const fga = await describeFgaCheck(req);
    if (!isAppResource(resource.type) && !isSupportedResourceAction(resource.type, action)) {
      return {
        action,
        supported: false,
        decision: "DENY" as const,
        reason: "INVALID_REQUEST" as const,
        unsupportedReason: "capability is not supported for this resource type",
        retriable: false,
        via: null,
        debug: {
          engine: fga.engine,
          relation: fga.relation,
          checked: [`${fga.user} ${fga.relation} ${fga.object}`],
          store: fga.store,
        contextual_tuples: fga.contextual_tuples,

        },
      };
    }
    const result = await authorize(req, { tenantId });
    const directGrant =
      !isAppResource(resource.type) && result.decision === "ALLOW" && result.via === "tuple"
        ? await explainDirectGrant(subject, resource, action)
        : undefined;
    return {
      action,
      decision: result.decision,
      supported: true,
      reason: result.reason,
      retriable: result.retriable,
      via: result.via ?? null,
      ...(directGrant ? { directGrant } : {}),
      debug: {
        engine: fga.engine,
        relation: fga.relation,
        checked: [`${fga.user} ${fga.relation} ${fga.object}`],
        store: fga.store,
        contextual_tuples: fga.contextual_tuples,

      },
    };
  })();
}

export const POST = withErrorHandler(async (request: NextRequest): Promise<NextResponse> => {
  const session = (await getServerSession(authOptions)) as {
    accessToken?: string;
    sub?: string;
    org?: string;
    user?: { email?: string | null };
  } | null;

  if (!session?.user?.email) {
    throw new ApiError("Unauthorized", 401);
  }

  await requireRbacPermission(
    {
      accessToken: session.accessToken,
      sub: session.sub,
      org: session.org,
      user: { email: session.user.email ?? undefined },
    },
    "admin_ui",
    "audit.view",
  );

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    throw new ApiError("Request body must be valid JSON", 400, "VALIDATION_ERROR");
  }
  if (!body || typeof body !== "object") {
    throw new ApiError("Request body must be an object", 400, "VALIDATION_ERROR");
  }
  const b = body as Record<string, unknown>;

  let subject: Subject;
  let resource: Resource;
  let singleAction: Action | null = null;
  let actions: Action[];
  try {
    subject = parseSubject(b.subject);
    resource = await parseAccessResource(b.resource);
    const record = isAppResource(resource.type) ? await readRegisteredResource(resource.id) : null;
    if (isAppResource(resource.type) && !record) throw new HttpAuthzError(404, "INVALID_REQUEST", "Resource is not registered");
    const available = record ? declaredResourceActions(record) : ALL_ACTIONS;
    if (Array.isArray(b.actions)) {
      // Matrix mode: validate each requested action (empty → all).
      actions = await Promise.all((b.actions.length > 0 ? b.actions : available).map((action) =>
        isAppResource(resource.type) ? parseAccessAction(resource, action) : parseAction(action)));
    } else if (b.action != null) {
      singleAction = isAppResource(resource.type) ? await parseAccessAction(resource, b.action) : parseAction(b.action);
      actions = [singleAction];
    } else {
      // Neither field → evaluate the full matrix.
      actions = available;
    }
  } catch (err) {
    if (err instanceof HttpAuthzError) {
      throw new ApiError(err.message, err.status, err.code);
    }
    throw err;
  }

  const results = await Promise.all(actions.map((a) => explainOne(subject, resource, a, session.org)));

  // Back-compat: a single `action` returns the flat shape; everything else
  // (matrix) returns { results: [...] }.
  const payload = singleAction !== null ? results[0] : { results };

  return NextResponse.json(payload, { headers: { "Cache-Control": "no-store" } });
});
