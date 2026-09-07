/**
 * GET /api/admin/service-accounts/unlinked
 *
 * Platform-admin-gated resolver: returns the unlinked service account's
 * id, sa_sub, name, and current scopes snapshot so the client can open the
 * Unlinked Access modal without knowing the SA's id ahead of time.
 *
 * Auth gate: `check(user:<caller>, can_manage, organization:<key>)` — i.e.
 * org-admin. Mirrors the guard used by admin-tab-gates/route.ts. Bootstrap-
 * admin email is also accepted (break-glass parity).
 *
 * Response shape: { success, data: { id, name, scopes } } where each scope is
 * tagged with a `source`: agent grants for an Everyone-shared (global) agent
 * are `"everyone"` (owned by the agent's visibility, not removable here);
 * everything else is `"explicit"` (added via this panel, removable). Agent
 * grants are read authoritatively from OpenFGA (`can_use`) so auto-grants from
 * global agents are visible; tools come from the Mongo snapshot.
 *
 * 403 for non-admins. 404 when the unlinked SA has not been bootstrapped yet.
 *
 * assisted-by Claude:claude-sonnet-4-6
 */

import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth-config";
import { getUnlinkedServiceAccount } from "@/lib/rbac/unlinked-service-account";
import { isPlatformAdmin } from "@/lib/rbac/platform-admin";
import { listOpenFgaObjects } from "@/lib/rbac/openfga";
import { findAgentVisibilities } from "@/lib/dynamic-agent-visibility";
import { refFromObject, type UnlinkedScope } from "@/lib/service-account-scopes";
import { listEveryoneKnowledgeScopes } from "@/lib/rbac/unlinked-knowledge-access";
import type { ServiceAccountScope } from "@/types/mongodb";

export async function GET() {
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

  // Platform-admin gate (org-admin + bootstrap-admin break-glass).
  const admin = await isPlatformAdmin(session);
  if (!admin) {
    return NextResponse.json(
      { success: false, error: "Forbidden: platform admin access required" },
      { status: 403 },
    );
  }

  try {
    const sa = await getUnlinkedServiceAccount();
    if (!sa) {
      return NextResponse.json(
        { success: false, error: "Unlinked service account not found or not yet bootstrapped" },
        { status: 404 },
      );
    }

    // Agent grants are authoritative in OpenFGA: this surfaces auto-grants
    // written when an agent is shared with Everyone, which never touch the
    // Mongo snapshot. Tool grants stay snapshot-driven.
    const [agentObjects, everyoneKnowledge] = await Promise.all([
      listOpenFgaObjects({
        user: `service_account:${sa.sa_sub}`,
        relation: "can_use",
        type: "agent",
      }),
      listEveryoneKnowledgeScopes(),
    ]);
    const agentIds = agentObjects.objects.map(refFromObject);
    const visibilityById = await findAgentVisibilities(agentIds);

    const agentScopes: UnlinkedScope[] = agentIds.map((ref) => ({
      type: "agent",
      ref,
      source: visibilityById.get(ref) === "global" ? "everyone" : "explicit",
    }));

    const toolScopes: UnlinkedScope[] = (sa.scopes_snapshot ?? [])
      .filter((s: ServiceAccountScope) => s.type === "tool")
      .map((s: ServiceAccountScope) => ({ type: "tool", ref: s.ref, source: "explicit" }));

    const explicitKnowledge = new Map(
      (sa.scopes_snapshot ?? [])
        .filter(
          (scope: ServiceAccountScope) =>
            scope.type === "datasource" || scope.type === "collection",
        )
        .map((scope: ServiceAccountScope) => [
          `${scope.type}:${scope.ref}`,
          scope,
        ]),
    );
    const knowledgeScopes = new Map<string, UnlinkedScope>();
    for (const ref of everyoneKnowledge.datasourceIds) {
      knowledgeScopes.set(`datasource:${ref}`, {
        type: "datasource",
        ref,
        source: "everyone",
      });
    }
    for (const ref of everyoneKnowledge.collectionIds) {
      knowledgeScopes.set(`collection:${ref}`, {
        type: "collection",
        ref,
        source: "everyone",
      });
    }
    for (const [key, scope] of explicitKnowledge) {
      if (knowledgeScopes.has(key)) continue;
      knowledgeScopes.set(key, {
        type: scope.type as "datasource" | "collection",
        ref: scope.ref,
        source: "explicit",
      });
    }

    const scopes: UnlinkedScope[] = [
      ...agentScopes,
      ...toolScopes,
      ...knowledgeScopes.values(),
    ];

    return NextResponse.json({
      success: true,
      data: {
        id: sa.sa_sub,
        name: sa.name,
        scopes,
      },
    });
  } catch (error) {
    console.error("[service-accounts/unlinked] failed:", error);
    return NextResponse.json(
      { success: false, error: "Failed to load unlinked service account" },
      { status: 503 },
    );
  }
}
