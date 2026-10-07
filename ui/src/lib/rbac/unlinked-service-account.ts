/**
 * Bootstrap and resolver for the platform-wide "unlinked" service account.
 *
 * The unlinked SA is a normal team-owned SA seeded into the `super-admins`
 * team on startup. It is used as the fallback identity for callers with no
 * linked user identity (unlinked Slack users, Slack bots). Platform admins
 * manage its scopes via the existing SA scope UI / a modal (a later workstream).
 *
 * Contract: spec anonymous-and-obo-routing C2 (TASKS.md).
 *
 * Design decisions:
 *  - NEVER THROWS: all errors are captured in `warnings`, matching the
 *    `ensureSuperAdminsTeam` never-throw contract.
 *  - Idempotent: guarded by `{ is_platform_unlinked: true, status: "active" }`.
 *  - Zero scopes at creation time — platform admins grant access later.
 *  - Mirrors the normal SA create path in `route.ts` (Keycloak → OpenFGA →
 *    Mongo) but uses a system actor and skips scope grants.
 *
 * assisted-by Claude:claude-sonnet-4-6
 */

import { getCollection, isMongoDBConfigured } from "@/lib/mongodb";
import { createServiceAccountClient, deleteServiceAccountClient } from "@/lib/rbac/keycloak-admin";
import { deleteExactOpenFgaTuples, writeOpenFgaTuples } from "@/lib/rbac/openfga";
import { createServiceAccountDoc } from "@/lib/service-accounts";
import { SUPER_ADMINS_TEAM_SLUG } from "@/lib/rbac/super-admins-team";
import type { ServiceAccount } from "@/types/mongodb";

// ── Public constants ────────────────────────────────────────────────────────

/** Reserved SA name within the super-admins team (case-insensitive). */
export const UNLINKED_SA_NAME = "unlinked";

/** Actor string used in the `created_by` field of the unlinked SA doc. */
const UNLINKED_SA_ACTOR = "unlinked-bootstrap";

// ── Result types (mirror super-admins-team.ts style) ───────────────────────

export type UnlinkedServiceAccountBootstrapStatus =
  | "created"
  | "noop"
  | "skipped";

export interface UnlinkedServiceAccountBootstrapResult {
  status: UnlinkedServiceAccountBootstrapStatus;
  sa_sub?: string;
  client_id?: string;
  warnings: string[];
}

// ── Shared platform-admin helper (QUAL-7) ───────────────────────────────────

/**
 * Re-export the shared platform-admin check from @/lib/rbac/platform-admin so
 * callers that already import `isPlatformAdmin` from this module continue to
 * work without change.  The authoritative implementation lives in platform-admin.ts.
 */
export { hasOrganizationAdmin as isPlatformAdmin } from "@/lib/rbac/platform-admin";

// ── Bootstrap ───────────────────────────────────────────────────────────────

/**
 * Idempotently ensure the platform unlinked service account exists.
 *
 * - If an active SA with `is_platform_unlinked: true` already exists → no-op.
 * - Otherwise: create the Keycloak client, write the OpenFGA ownership tuple,
 *   and insert the Mongo doc (with `is_platform_unlinked: true`).
 * - Never throws: errors are captured in `warnings`.
 *
 * @param input.actor  Who is triggering bootstrap (for the `created_by` field).
 * @param input.now    Override the creation timestamp (useful in tests).
 */
export async function ensureUnlinkedServiceAccount(input: {
  actor: string;
  now?: Date;
}): Promise<UnlinkedServiceAccountBootstrapResult> {
  if (!isMongoDBConfigured) {
    return {
      status: "skipped",
      warnings: ["MongoDB not configured; unlinked SA bootstrap skipped"],
    };
  }

  const actor = (input.actor ?? "").trim() || UNLINKED_SA_ACTOR;
  const warnings: string[] = [];

  // ── Idempotency guard ─────────────────────────────────────────────────────
  // [unlinked-sa] Primary check: look up by is_platform_unlinked flag.
  // Fallback check: also match a partial/legacy doc (inserted before the flag
  // was stamped) by name+team+status so a half-written doc is not re-provisioned.
  try {
    const existing = await getUnlinkedServiceAccount();
    if (existing) {
      return {
        status: "noop",
        sa_sub: existing.sa_sub,
        client_id: existing.client_id,
        warnings: [],
      };
    }
    // [unlinked-sa] Fallback: detect a partial doc that lacks the flag.
    const collection = await getCollection<ServiceAccount>("service_accounts");
    const partial = await collection.findOne({
      owning_team_id: SUPER_ADMINS_TEAM_SLUG,
      name: UNLINKED_SA_NAME,
      status: "active",
    });
    if (partial) {
      return {
        status: "noop",
        sa_sub: partial.sa_sub,
        client_id: partial.client_id,
        warnings: ["unlinked SA partial doc detected (missing flag); treated as existing"],
      };
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    warnings.push(`unlinked SA idempotency check failed: ${message}`);
    // Continue — a failed check is not a reason to skip provisioning.
  }

  // ── Step 1: Keycloak — create the confidential client ────────────────────
  let client: Awaited<ReturnType<typeof createServiceAccountClient>>;
  try {
    client = await createServiceAccountClient(UNLINKED_SA_NAME);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    warnings.push(`unlinked SA Keycloak client creation failed: ${message}`);
    return { status: "skipped", warnings };
  }

  const saSubject = `service_account:${client.saSub}`;

  // ── Step 2: OpenFGA — ownership + gateway baseline ────────────────────────
  // Mirrors route.ts POST: write ownerTuple + gatewayBaselineTuple.
  // We intentionally write ZERO scope tuples (C2: zero scopes at creation).
  try {
    await writeOpenFgaTuples({
      writes: [
        {
          // Team owns this SA.
          user: `team:${SUPER_ADMINS_TEAM_SLUG}#member`,
          relation: "owner_team",
          object: saSubject,
        },
        {
          // Coarse AgentGateway ext_authz gate — required for any SA tool call.
          user: saSubject,
          relation: "caller",
          object: "mcp_gateway:list",
        },
      ],
      deletes: [],
    });
  } catch (error) {
    // Compensate: clean up the Keycloak client so there are no orphans.
    const message = error instanceof Error ? error.message : String(error);
    warnings.push(`unlinked SA OpenFGA tuple write failed: ${message}`);
    try {
      await deleteServiceAccountClient(client.clientUuid);
    } catch (deleteError) {
      const deleteMessage =
        deleteError instanceof Error ? deleteError.message : String(deleteError);
      warnings.push(`unlinked SA Keycloak client compensation failed: ${deleteMessage}`);
    }
    return { status: "skipped", warnings };
  }

  // ── Step 3: Mongo — insert the SA doc ─────────────────────────────────────
  // [unlinked-sa][TS-B2] Pass is_platform_unlinked: true so the flag is set
  // atomically in the same insertOne — no separate updateOne needed. This closes
  // the orphan window where a crash between insert and updateOne left a flagless doc.
  try {
    const doc = await createServiceAccountDoc({
      sa_sub: client.saSub,
      client_id: client.clientId,
      client_uuid: client.clientUuid,
      name: UNLINKED_SA_NAME,
      description:
        "Platform-managed unlinked identity. Used as the fallback for callers with no linked user identity. Scopes managed by platform admins.",
      owning_team_id: SUPER_ADMINS_TEAM_SLUG,
      created_by: actor,
      scopes_snapshot: [],
      is_platform_unlinked: true,
    });

    return {
      status: "created",
      sa_sub: doc.sa_sub,
      client_id: doc.client_id,
      warnings,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    // SEC-4: duplicate-key (11000) means a concurrent bootstrap already inserted
    // the doc — treat as idempotent noop and compensate: roll back the Keycloak
    // client and the two OpenFGA tuples we just wrote so we don't leave orphans.
    const isDupKey =
      (error instanceof Error && /duplicate key|E11000/i.test(error.message)) ||
      (typeof (error as { code?: unknown }).code === "number" &&
        (error as { code: number }).code === 11000);

    if (isDupKey) {
      // Compensate: delete OpenFGA tuples written in Step 2.
      try {
        await deleteExactOpenFgaTuples([
          {
            user: `team:${SUPER_ADMINS_TEAM_SLUG}#member`,
            relation: "owner_team",
            object: saSubject,
          },
          {
            user: saSubject,
            relation: "caller",
            object: "mcp_gateway:list",
          },
        ]);
      } catch (fgaErr) {
        const fgaMsg = fgaErr instanceof Error ? fgaErr.message : String(fgaErr);
        warnings.push(`unlinked SA dup-key OpenFGA compensation failed: ${fgaMsg}`);
      }
      // Compensate: delete the Keycloak client we created in Step 1.
      try {
        await deleteServiceAccountClient(client.clientUuid);
      } catch (kcErr) {
        const kcMsg = kcErr instanceof Error ? kcErr.message : String(kcErr);
        warnings.push(`unlinked SA dup-key Keycloak compensation failed: ${kcMsg}`);
      }
      return { status: "noop", warnings };
    }

    warnings.push(`unlinked SA Mongo insert failed: ${message}`);
    // Best-effort compensation: the OpenFGA tuples and Keycloak client exist
    // but the Mongo doc is missing. A subsequent startup will attempt re-create
    // via a new Keycloak client. Log but do not rethrow.
    return { status: "skipped", warnings };
  }
}

// ── Resolver ────────────────────────────────────────────────────────────────

/**
 * Look up the active platform unlinked service account.
 *
 * Returns the full Mongo doc (including `sa_sub`, `client_id`, etc.) or null
 * when the SA has not been bootstrapped yet or MongoDB is unavailable.
 *
 * B1/B2 runtime usage: call `getUnlinkedServiceAccount()` and use the returned
 * `sa_sub` to mint a token via `impersonate_service_account(sa_sub)`.
 */
export async function getUnlinkedServiceAccount(): Promise<ServiceAccount | null> {
  if (!isMongoDBConfigured) {
    return null;
  }
  const collection = await getCollection<ServiceAccount>("service_accounts");
  return collection.findOne({ is_platform_unlinked: true, status: "active" });
}

/**
 * Best-effort lookup of the unlinked SA's `sa_sub`, for callers (e.g. the
 * dynamic-agents routes) that grant it access to globally-shared agents.
 * Never throws — returns `null` when the SA isn't bootstrapped yet, MongoDB
 * is unavailable, or the lookup otherwise fails, so callers can fail open
 * (skip the grant) instead of blocking the caller's own request.
 */
export async function resolveUnlinkedServiceAccountSub(): Promise<string | null> {
  try {
    const sa = await getUnlinkedServiceAccount();
    return sa?.sa_sub ?? null;
  } catch (error) {
    console.warn("[unlinked-service-account] failed to resolve sa_sub:", error);
    return null;
  }
}

/**
 * The unlinked SA's `sa_sub` plus the set of agent ids an admin has EXPLICITLY
 * granted it via the Unlinked Access panel, read from `scopes_snapshot`.
 *
 * An explicit grant is durable: it must survive an agent's visibility leaving
 * `global` and survive the startup reconcile sweep. Only the panel's own DELETE
 * may remove it. Callers use `explicitAgentIds` to decide whether a visibility
 * demotion should delete the unlinked SA's `can_use` tuple — an explicit grant
 * is owned by the admin, not by the agent's visibility, so it is preserved.
 *
 * Never throws — on any failure returns `sub: null` and an empty set so callers
 * fall open (skip the grant/preserve nothing) instead of blocking the request.
 */
export async function resolveUnlinkedServiceAccountGrantState(): Promise<{
  sub: string | null;
  explicitAgentIds: Set<string>;
}> {
  try {
    const sa = await getUnlinkedServiceAccount();
    const explicitAgentIds = new Set(
      (sa?.scopes_snapshot ?? [])
        .filter((scope) => scope.type === "agent")
        .map((scope) => scope.ref),
    );
    return { sub: sa?.sa_sub ?? null, explicitAgentIds };
  } catch (error) {
    console.warn("[unlinked-service-account] failed to resolve grant state:", error);
    return { sub: null, explicitAgentIds: new Set() };
  }
}
