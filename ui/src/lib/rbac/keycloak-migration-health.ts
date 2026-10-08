import { getCollection } from "@/lib/mongodb";
import {
getKeycloakRbacDiagnosticValues,
type KeycloakRbacDiagnosticValues,
} from "@/lib/rbac/keycloak-admin";
import type { BootstrapAdminReconciliationResult } from "@/lib/rbac/keycloak-bootstrap-admins";
import {
evaluateKeycloakInvariants,
summarizeKeycloakInvariants,
type KeycloakInvariant,
type KeycloakInvariantSummary,
} from "@/lib/rbac/keycloak-invariants";
import {
KEYCLOAK_RBAC_RECONCILIATION_MIGRATION_ID,
KEYCLOAK_RBAC_SCHEMA_AREA,
KEYCLOAK_RBAC_SCHEMA_VERSION,
} from "@/lib/rbac/keycloak-rbac-reconciliation";
import { getMigrationBlockingStatus,listReleaseMigrations } from "@/lib/rbac/migrations/registry";
import type { MigrationStatus } from "@/lib/rbac/migrations/types";

type KeycloakReachability = {
  configured: boolean;
  reachable: boolean;
  status:
    | "unconfigured"
    | "reachable"
    | "unreachable"
    | "admin_authorization_error"
    | "reconciliation_error";
  realm: string;
  last_probe_at: string;
  probe_error?: string;
};

interface SchemaMigrationRunDoc {
  _id: string;
  status?: MigrationStatus | "skipped";
  applied_counts?: Record<string, number>;
  planned_counts?: Record<string, number>;
  warnings?: string[];
  error?: string;
  bootstrap_admins?: BootstrapAdminReconciliationResult;
  completed_at?: string;
  updated_at?: string;
  updated_by?: string;
  locked_at?: string;
}

export interface KeycloakMigrationHealth {
  keycloak: KeycloakReachability;
  schema_area: {
    area: typeof KEYCLOAK_RBAC_SCHEMA_AREA;
    current_version: number | null;
    target_version: number;
    status: "current" | "behind" | "unknown";
    last_migration_id?: string;
  };
  migration: {
    id: typeof KEYCLOAK_RBAC_RECONCILIATION_MIGRATION_ID;
    manifest_status: MigrationStatus;
    last_run?: {
      status: MigrationStatus | "skipped";
      actor?: string;
      completed_at?: string;
      locked_at?: string;
      updated_at?: string;
      applied_counts: Record<string, number>;
      planned_counts: Record<string, number>;
      warnings: string[];
      error?: string;
    };
  };
  bootstrap_admins?: BootstrapAdminReconciliationResult;
  blocking: {
    is_blocking: boolean;
    blocking_required_count: number;
  };
  keycloak_values?: KeycloakRbacDiagnosticValues;
  keycloak_values_error?: string;
  /**
   * Evaluated invariants over the live Keycloak realm (e.g. "OBO
   * permissions use AFFIRMATIVE strategy", "each bot policy is a
   * strict client allow-list"). Always emitted when keycloak_values
   * is populated. Omitted when Keycloak is unreachable (keycloak.
   * reachable === false) or when the inspector errored — in those
   * cases the panel shows the existing "Keycloak unreachable"
   * indicator rather than a misleading all-unknown invariant list.
   */
  keycloak_invariants?: {
    summary: KeycloakInvariantSummary;
    items: KeycloakInvariant[];
  };
}

function keycloakRealm(): string {
  return process.env.KEYCLOAK_REALM?.trim() || "caipe";
}

function keycloakConfigured(): boolean {
  return Boolean(process.env.KEYCLOAK_URL?.trim());
}

// Mirrors the constants in keycloak-admin.ts so the invariant
// evaluator can name the bots/audience without re-reading process.env
// in tests. Tests inject these explicitly; runtime defers to env.
function slackBotClientId(): string {
  return process.env.KEYCLOAK_BOT_CLIENT_ID?.trim() || "caipe-slack-bot";
}
function webexBotClientId(): string {
  return process.env.KEYCLOAK_WEBEX_BOT_CLIENT_ID?.trim() || "caipe-webex-bot";
}
function oboAudienceClientId(): string {
  return process.env.CAIPE_PLATFORM_AUDIENCE?.trim() || "caipe-platform";
}

function isAdminAuthorizationError(message: string): boolean {
  return /\b(401|403)\b|forbidden|unauthorized/i.test(message);
}

function isNetworkReachabilityError(message: string): boolean {
  return /fetch failed|econnrefused|enotfound|etimedout|network|unavailable|connection refused|could not connect/i.test(
    message,
  );
}

function inferReachability(
  configured: boolean,
  details: Array<string | undefined>,
): Pick<KeycloakReachability, "reachable" | "status" | "probe_error"> {
  if (!configured) {
    return {
      reachable: false,
      status: "unconfigured",
      probe_error: "KEYCLOAK_URL is not configured",
    };
  }

  const detail = details.find((item) => item && item.trim())?.trim();
  if (!detail) {
    return { reachable: true, status: "reachable" };
  }
  if (isAdminAuthorizationError(detail)) {
    return { reachable: true, status: "admin_authorization_error", probe_error: detail };
  }
  if (isNetworkReachabilityError(detail)) {
    return { reachable: false, status: "unreachable", probe_error: detail };
  }
  return { reachable: true, status: "reconciliation_error", probe_error: detail };
}

export async function getKeycloakMigrationHealth(input: {
  actor: string;
  now?: string;
}): Promise<KeycloakMigrationHealth> {
  const now = input.now ?? new Date().toISOString();
  const [releaseState, blockingStatus] = await Promise.all([
    listReleaseMigrations({ includeCompleted: true }),
    getMigrationBlockingStatus({ actor: input.actor, now }),
  ]);
  const migrations = await getCollection<SchemaMigrationRunDoc>("schema_migrations");
  const run = await migrations.findOne({ _id: KEYCLOAK_RBAC_RECONCILIATION_MIGRATION_ID });
  const schemaStatus = releaseState.schema_versions.find(
    (schema) => schema.schema_area === KEYCLOAK_RBAC_SCHEMA_AREA,
  );
  const migration =
    releaseState.migrations.find((item) => item.id === KEYCLOAK_RBAC_RECONCILIATION_MIGRATION_ID) ??
    releaseState.completed_migrations.find((item) => item.id === KEYCLOAK_RBAC_RECONCILIATION_MIGRATION_ID);
  const configured = keycloakConfigured();
  const keycloakValuesResult = configured
    ? await getKeycloakRbacDiagnosticValues()
        .then((values) => ({ values }))
        .catch((err) => ({
          error: err instanceof Error ? err.message : "Failed to inspect Keycloak values",
        }))
    : undefined;
  const failedRunDetail =
    run?.status === "failed"
      ? run.error || run.warnings?.join("; ") || "Last Keycloak migration failed"
      : undefined;
  const keycloakValuesError =
    keycloakValuesResult && "error" in keycloakValuesResult
      ? keycloakValuesResult.error
      : undefined;
  const reachability = inferReachability(configured, [keycloakValuesError, failedRunDetail]);

  const invariants =
    keycloakValuesResult && "values" in keycloakValuesResult
      ? (() => {
          const items = evaluateKeycloakInvariants({
            values: keycloakValuesResult.values,
            slackBotClientId: slackBotClientId(),
            webexBotClientId: webexBotClientId(),
            oboAudienceClientId: oboAudienceClientId(),
          });
          return { summary: summarizeKeycloakInvariants(items), items };
        })()
      : undefined;

  return {
    keycloak: {
      configured,
      reachable: reachability.reachable,
      status: reachability.status,
      realm: keycloakRealm(),
      last_probe_at: now,
      probe_error: reachability.probe_error,
    },
    schema_area: {
      area: KEYCLOAK_RBAC_SCHEMA_AREA,
      current_version: schemaStatus?.current_version ?? null,
      target_version: schemaStatus?.target_version ?? KEYCLOAK_RBAC_SCHEMA_VERSION,
      status: schemaStatus?.status ?? "unknown",
      last_migration_id: schemaStatus?.last_migration_id,
    },
    migration: {
      id: KEYCLOAK_RBAC_RECONCILIATION_MIGRATION_ID,
      manifest_status: migration?.status ?? "not_started",
      last_run: run
        ? {
            status: run.status ?? "not_started",
            actor: run.updated_by,
            completed_at: run.completed_at,
            locked_at: run.locked_at,
            updated_at: run.updated_at,
            applied_counts: run.applied_counts ?? {},
            planned_counts: run.planned_counts ?? {},
            warnings: run.warnings ?? [],
            error: run.error,
          }
        : undefined,
    },
    blocking: {
      is_blocking: blockingStatus.is_blocking,
      blocking_required_count: blockingStatus.blocking_required_count,
    },
    ...(run?.bootstrap_admins ? { bootstrap_admins: run.bootstrap_admins } : {}),
    ...(keycloakValuesResult && "values" in keycloakValuesResult
      ? { keycloak_values: keycloakValuesResult.values }
      : {}),
    ...(keycloakValuesResult && "error" in keycloakValuesResult
      ? { keycloak_values_error: keycloakValuesResult.error }
      : {}),
    ...(invariants ? { keycloak_invariants: invariants } : {}),
  };
}
