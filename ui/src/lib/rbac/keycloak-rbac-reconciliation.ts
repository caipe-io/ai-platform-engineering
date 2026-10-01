// assisted-by Codex Codex-sonnet-4-6
import { getCollection,isMongoDBConfigured } from "@/lib/mongodb";
import {
ensureBotServiceAccountImpersonationRoles,
ensureCaipePlatformTokenExchangeDecisionStrategy,
ensureSlackBotOboPermissions,
ensureWebexBotOboPermissions,
isValidTeamSlug,
} from "@/lib/rbac/keycloak-admin";
import type { BootstrapAdminReconciliationResult } from "@/lib/rbac/keycloak-bootstrap-admins";
import { reconcileBootstrapAdmins } from "@/lib/rbac/keycloak-bootstrap-admins";
import type { MigrationApplyResult,MigrationDefinition,MigrationPlanResult } from "@/lib/rbac/migrations/types";
import { ensureSuperAdminsTeam } from "@/lib/rbac/super-admins-team";
import { ensureUnlinkedServiceAccount } from "@/lib/rbac/unlinked-service-account";
import { reconcileSaConversationWriterGrants } from "@/lib/rbac/sa-conversation-reconcile";

export const KEYCLOAK_RBAC_RECONCILIATION_MIGRATION_ID = "keycloak_rbac_mapping_reconciliation_v1";
export const KEYCLOAK_RBAC_SCHEMA_AREA = "keycloak_rbac_mappings";
export const KEYCLOAK_RBAC_SCHEMA_VERSION = 1;
export const KEYCLOAK_RBAC_CONFIRMATION = "MIGRATE keycloak_rbac_mappings TO v1";

export const KEYCLOAK_RBAC_MIGRATION_DEFINITION: MigrationDefinition = {
  id: KEYCLOAK_RBAC_RECONCILIATION_MIGRATION_ID,
  release: "0.5.1",
  schema_area: KEYCLOAK_RBAC_SCHEMA_AREA,
  from_version: 0,
  to_version: KEYCLOAK_RBAC_SCHEMA_VERSION,
  kind: "implicit",
  title: "Keycloak RBAC mapping reconciliation",
  description:
    "Reconcile bot OBO permissions, service-account impersonation roles, the caipe-platform token-exchange decision strategy, and bootstrap-admin OpenFGA tuples. Per-team Keycloak client scopes are no longer touched (removed in Phase 3 of spec 2026-05-24-derive-team-from-channel; team identity is now derived from channel\u2192team mappings at request time).",
  confirmation: KEYCLOAK_RBAC_CONFIRMATION,
  required: true,
  blocking: true,
  implemented: true,
};

interface TeamRow {
  _id: unknown;
  name?: string;
  slug?: string;
}

interface StringIdRow {
  _id: string;
}

type StartupMigrationStatus = "skipped" | "completed" | "failed";

export interface KeycloakRbacStartupMigrationResult {
  migration_id: string;
  status: StartupMigrationStatus;
  counts: Record<string, number>;
  warnings: string[];
}

function nowIso(): string {
  return new Date().toISOString();
}

function deriveSlug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 63)
    .replace(/-+$/g, "");
}

async function seedManifest(now: string): Promise<void> {
  const manifest = await getCollection<StringIdRow>("migration_manifest");
  await manifest.updateOne(
    { _id: KEYCLOAK_RBAC_RECONCILIATION_MIGRATION_ID },
    {
      $set: {
        migration_id: KEYCLOAK_RBAC_RECONCILIATION_MIGRATION_ID,
        release: KEYCLOAK_RBAC_MIGRATION_DEFINITION.release,
        schema_area: KEYCLOAK_RBAC_SCHEMA_AREA,
        from_version: KEYCLOAK_RBAC_MIGRATION_DEFINITION.from_version,
        to_version: KEYCLOAK_RBAC_SCHEMA_VERSION,
        kind: KEYCLOAK_RBAC_MIGRATION_DEFINITION.kind,
        title: KEYCLOAK_RBAC_MIGRATION_DEFINITION.title,
        description: KEYCLOAK_RBAC_MIGRATION_DEFINITION.description,
        confirmation: KEYCLOAK_RBAC_CONFIRMATION,
        required: true,
        blocking: true,
        implemented: true,
        managed_by: "runtime",
        updated_at: now,
      },
      $setOnInsert: { created_at: now, registered_at: now },
    },
    { upsert: true }
  );
}

async function loadTeamSlugs(now: string, warnings: string[]): Promise<string[]> {
  const teams = await getCollection<TeamRow>("teams");
  const rows = (await teams
    .find({}, { projection: { name: 1, slug: 1 } })
    .toArray()) as TeamRow[];
  const slugs = new Set<string>();

  for (const row of rows) {
    let slug = (row.slug || "").trim().toLowerCase();
    if (!slug) {
      slug = deriveSlug(row.name || "");
      if (!slug || !isValidTeamSlug(slug)) {
        warnings.push(`Skipping team ${String(row._id)} because no valid slug could be derived.`);
        continue;
      }
      await teams.updateOne(
        { _id: row._id as never },
        { $set: { slug, updated_at: new Date(now) } }
      );
    }
    if (!isValidTeamSlug(slug)) {
      warnings.push(`Skipping team ${String(row._id)} because slug "${slug}" is invalid.`);
      continue;
    }
    slugs.add(slug);
  }

  return [...slugs].sort();
}

// Pods that lose the race or find a completed migration return immediately.
// A lock older than LOCK_TTL_MS is treated as stale (crashed pod) and overwritten.
const LOCK_TTL_MS = 5 * 60 * 1000;

async function acquireMigrationLock(actor: string, now: string): Promise<boolean> {
  const staleThreshold = new Date(Date.now() - LOCK_TTL_MS).toISOString();
  const migrations = await getCollection<StringIdRow>("schema_migrations");
  try {
    const result = await migrations.findOneAndUpdate(
      {
        _id: KEYCLOAK_RBAC_RECONCILIATION_MIGRATION_ID,
        $or: [
          { status: { $nin: ["running", "completed"] } },
          { status: "running", locked_at: { $lt: staleThreshold } },
        ],
      },
      {
        $set: {
          release: KEYCLOAK_RBAC_MIGRATION_DEFINITION.release,
          schema_area: KEYCLOAK_RBAC_SCHEMA_AREA,
          from_version: 0,
          to_version: KEYCLOAK_RBAC_SCHEMA_VERSION,
          kind: "implicit",
          status: "running",
          locked_at: now,
          updated_at: now,
          updated_by: actor,
        },
        $setOnInsert: { created_at: now, created_by: actor },
      },
      { upsert: true, returnDocument: "after" }
    );
    return result !== null;
  } catch (e: unknown) {
    // E11000: document exists with status running/completed — another pod won the race.
    if ((e as { code?: number }).code === 11000) return false;
    throw e;
  }
}

async function recordCompleted(input: {
  actor: string;
  now: string;
  counts: Record<string, number>;
  warnings: string[];
  bootstrapAdmins?: BootstrapAdminReconciliationResult;
}): Promise<void> {
  const migrations = await getCollection<StringIdRow>("schema_migrations");
  const versions = await getCollection<StringIdRow>("data_schema_versions");
  await migrations.updateOne(
    { _id: KEYCLOAK_RBAC_RECONCILIATION_MIGRATION_ID },
    {
      $set: {
        release: KEYCLOAK_RBAC_MIGRATION_DEFINITION.release,
        schema_area: KEYCLOAK_RBAC_SCHEMA_AREA,
        from_version: 0,
        to_version: KEYCLOAK_RBAC_SCHEMA_VERSION,
        kind: "implicit",
        status: "completed",
        planned_counts: input.counts,
        applied_counts: input.counts,
        warnings: input.warnings,
        ...(input.bootstrapAdmins ? { bootstrap_admins: input.bootstrapAdmins } : {}),
        completed_at: input.now,
        updated_at: input.now,
        updated_by: input.actor,
      },
      $unset: { error: "" },
      $setOnInsert: { created_at: input.now, created_by: input.actor },
    },
    { upsert: true }
  );
  await versions.updateOne(
    { _id: KEYCLOAK_RBAC_SCHEMA_AREA },
    {
      $set: {
        version: KEYCLOAK_RBAC_SCHEMA_VERSION,
        updated_at: input.now,
        updated_by: input.actor,
        last_migration_id: KEYCLOAK_RBAC_RECONCILIATION_MIGRATION_ID,
      },
      $setOnInsert: { created_at: input.now },
    },
    { upsert: true }
  );
}

async function recordFailed(input: {
  actor: string;
  now: string;
  error: string;
  counts: Record<string, number>;
  warnings: string[];
  bootstrapAdmins?: BootstrapAdminReconciliationResult;
}): Promise<void> {
  const migrations = await getCollection<StringIdRow>("schema_migrations");
  await migrations.updateOne(
    { _id: KEYCLOAK_RBAC_RECONCILIATION_MIGRATION_ID },
    {
      $set: {
        release: KEYCLOAK_RBAC_MIGRATION_DEFINITION.release,
        schema_area: KEYCLOAK_RBAC_SCHEMA_AREA,
        from_version: 0,
        to_version: KEYCLOAK_RBAC_SCHEMA_VERSION,
        kind: "implicit",
        status: "failed",
        planned_counts: input.counts,
        applied_counts: input.counts,
        warnings: input.warnings,
        error: input.error,
        ...(input.bootstrapAdmins ? { bootstrap_admins: input.bootstrapAdmins } : {}),
        updated_at: input.now,
        updated_by: input.actor,
      },
      $setOnInsert: { created_at: input.now, created_by: input.actor },
    },
    { upsert: true }
  );
}

export async function planKeycloakRbacReconciliationMigration(
  now = nowIso()
): Promise<MigrationPlanResult> {
  const warnings: string[] = [];
  if (!isMongoDBConfigured) {
    warnings.push("MongoDB is not configured; Keycloak RBAC mapping reconciliation cannot inspect teams.");
  }
  // Phase 3 (spec 2026-05-24-derive-team-from-channel) removed per-team Keycloak
  // client scopes. We still surface the Mongo team count for diagnostics so the
  // admin can verify the team data is healthy, but the migration only plans OBO
  // permission reconciliation now.
  const teamSlugs = isMongoDBConfigured ? await loadTeamSlugs(now, warnings) : [];

  return {
    migration_id: KEYCLOAK_RBAC_RECONCILIATION_MIGRATION_ID,
    release: KEYCLOAK_RBAC_MIGRATION_DEFINITION.release,
    schema_area: KEYCLOAK_RBAC_SCHEMA_AREA,
    kind: "implicit",
    from_version: 0,
    to_version: KEYCLOAK_RBAC_SCHEMA_VERSION,
    counts: {
      mongo_teams_seen: teamSlugs.length,
      obo_permission_sets_planned: 2,
    },
    warnings,
    sample_diffs: [],
    tuple_writes_planned: 0,
    confirmation: KEYCLOAK_RBAC_CONFIRMATION,
  };
}

export async function runKeycloakRbacStartupMigration(input: {
  actor?: string;
  now?: string;
} = {}): Promise<KeycloakRbacStartupMigrationResult> {
  const actor = input.actor ?? "webui-startup";
  const now = input.now ?? nowIso();
  const warnings: string[] = [];
  // Phase 3 (spec 2026-05-24-derive-team-from-channel) removed the per-team
  // and personal client scopes, orphan-scope cleanup, and audience-default
  // selection counters. The reconciler now only reports OBO permission /
  // service-account / decision-strategy / bootstrap-admin counts.
  const counts: Record<string, number> = {
    mongo_teams_seen: 0,
    obo_permission_sets_reconciled: 0,
    bot_service_accounts_reconciled: 0,
    token_exchange_permissions_reconciled: 0,
    bootstrap_admins_resolved: 0,
    bootstrap_admin_placeholders_created: 0,
    bootstrap_admin_tuples_written: 0,
    bootstrap_admin_failures: 0,
    sa_conversations_scanned: 0,
    sa_conversation_grants_backfilled: 0,
  };
  let bootstrapAdmins: BootstrapAdminReconciliationResult | undefined;

  if (!isMongoDBConfigured || !process.env.KEYCLOAK_URL) {
    return {
      migration_id: KEYCLOAK_RBAC_RECONCILIATION_MIGRATION_ID,
      status: "skipped",
      counts,
      warnings: ["MongoDB or KEYCLOAK_URL is not configured; skipped Keycloak RBAC migration."],
    };
  }

  const acquired = await acquireMigrationLock(actor, now);
  if (!acquired) {
    return {
      migration_id: KEYCLOAK_RBAC_RECONCILIATION_MIGRATION_ID,
      status: "skipped",
      counts,
      warnings: ["Migration already running or completed on another pod; skipped."],
    };
  }

  try {
    await seedManifest(now);
    const teamSlugs = await loadTeamSlugs(now, warnings);
    counts.mongo_teams_seen = teamSlugs.length;

    // Phase 3 (spec 2026-05-24-derive-team-from-channel) removed per-team
    // Keycloak client scopes, the `team-personal` marker scope, the orphan
    // cleanup step, and audience-default scope selection. Team identity is
    // now derived from the channel→team mapping at message time. The
    // reconciler still keeps the OBO permission wiring, service-account
    // impersonation roles, decision strategy, and bootstrap admin assignment
    // — those are independent of the legacy `active_team` claim.

    await ensureSlackBotOboPermissions();
    await ensureWebexBotOboPermissions();
    counts.obo_permission_sets_reconciled = 2;

    await ensureBotServiceAccountImpersonationRoles(["caipe-slack-bot", "caipe-webex-bot"]);
    counts.bot_service_accounts_reconciled = 2;

    await ensureCaipePlatformTokenExchangeDecisionStrategy("AFFIRMATIVE");
    // 1 shared audience + 2 per-bot (Slack, Webex) — ensureBotOboPermissions
    // now sets AFFIRMATIVE on the bot's own token-exchange permission as well.
    counts.token_exchange_permissions_reconciled = 3;

    bootstrapAdmins = await reconcileBootstrapAdmins({ actor });
    counts.bootstrap_admins_resolved = bootstrapAdmins.resolved_count;
    counts.bootstrap_admin_placeholders_created = bootstrapAdmins.created_count;
    counts.bootstrap_admin_tuples_written = bootstrapAdmins.tuple_write_count;
    counts.bootstrap_admin_failures = bootstrapAdmins.failed_count;
    warnings.push(...bootstrapAdmins.warnings);
    if (bootstrapAdmins.failed_count > 0) {
      throw new Error(`Bootstrap admin reconciliation failed for ${bootstrapAdmins.failed_count} email(s)`);
    }

    // Idempotently materialise the "Super Admins" team that backs the
    // platform default-team selector. We feed it the *resolved* user
    // subjects from the bootstrap-admin step so OpenFGA tuples are written
    // with the canonical Keycloak `sub`, not the email.
    try {
      const superAdmins = await ensureSuperAdminsTeam({
        actor,
        members: bootstrapAdmins.outcomes
          .filter((outcome) => outcome.status !== "failed" && outcome.user_id)
          .map((outcome) => ({ email: outcome.email, userSubject: outcome.user_id })),
      });
      counts.super_admins_team_status =
        superAdmins.status === "created"
          ? 2
          : superAdmins.status === "updated"
            ? 1
            : 0;
      counts.super_admins_members_added = superAdmins.members_added;
      counts.super_admins_members_already_present = superAdmins.members_already_present;
      counts.super_admins_members_unresolved = superAdmins.members_unresolved;
      warnings.push(...superAdmins.warnings);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      warnings.push(`super-admins team bootstrap failed: ${message}`);
    }

    // Idempotently ensure the platform-wide unlinked service account owned by
    // the super-admins team (C2 contract — anonymous-and-obo-routing TASKS.md).
    try {
      const unlinkedSa = await ensureUnlinkedServiceAccount({ actor });
      counts.unlinked_sa_status =
        unlinkedSa.status === "created" ? 2 : unlinkedSa.status === "noop" ? 1 : 0;
      warnings.push(...unlinkedSa.warnings);
      if (unlinkedSa.sa_sub) {
        const { reconcileExistingUnlinkedKnowledgeAccess } = await import(
          "@/lib/rbac/unlinked-knowledge-access"
        );
        await reconcileExistingUnlinkedKnowledgeAccess();
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      warnings.push(`unlinked SA bootstrap/access reconciliation failed: ${message}`);
    }

    // Backfill any missing `service_account:<sub> writer conversation:<id>` tuples
    // for conversations created by SAs (audit health-check / backstop for the
    // best-effort auto-grant in conversations/route.ts).
    try {
      const saConvReconcile = await reconcileSaConversationWriterGrants({ actor });
      counts.sa_conversations_scanned = saConvReconcile.scanned;
      counts.sa_conversation_grants_backfilled = saConvReconcile.backfilled;
      warnings.push(...saConvReconcile.warnings);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      warnings.push(`SA conversation writer grant reconcile failed: ${message}`);
    }

    await recordCompleted({ actor, now, counts, warnings, bootstrapAdmins });
    return {
      migration_id: KEYCLOAK_RBAC_RECONCILIATION_MIGRATION_ID,
      status: "completed",
      counts,
      warnings,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    warnings.push(message);
    await recordFailed({ actor, now, error: message, counts, warnings, bootstrapAdmins });
    return {
      migration_id: KEYCLOAK_RBAC_RECONCILIATION_MIGRATION_ID,
      status: "failed",
      counts,
      warnings,
    };
  }
}

export async function applyKeycloakRbacReconciliationMigration(input: {
  actor: string;
  now?: string;
}): Promise<MigrationApplyResult> {
  const now = input.now ?? nowIso();
  const result = await runKeycloakRbacStartupMigration({ actor: input.actor, now });
  const plan = await planKeycloakRbacReconciliationMigration(now);
  return {
    ...plan,
    applied_counts: result.counts,
    warnings: [...plan.warnings, ...result.warnings],
    applied_at: now,
    applied_by: input.actor,
  };
}
