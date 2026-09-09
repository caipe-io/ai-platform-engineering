/**
 * Shared workflow run access helpers (list, poll, resume, cancel).
 */

import { getCollection } from "@/lib/mongodb";
import { ApiError } from "@/lib/api-error";
import type { ResourceAuthzSession } from "./resource-authz";
import {
  canViewWorkflowRunsForConfig,
  requireWorkflowConfigRunAccess,
  requireWorkflowConfigRunViewAccess,
  type WorkflowConfigRebacSnapshot,
} from "./workflow-config-rebac";
import type { WorkflowConfig } from "@/types/workflow-config";

export function workflowConfigAccessSnapshot(
  config: Pick<
    WorkflowConfig,
    | "_id"
    | "owner_id"
    | "owner_subject"
    | "visibility"
    | "shared_with_teams"
    | "config_driven"
    | "authz_revision"
    | "authz_sync_state"
    | "authz_last_synced_revision"
    | "authz_last_error_code"
    | "authz_sync_started_at"
  >,
): WorkflowConfigRebacSnapshot {
  return {
    _id: String(config._id),
    owner_id: config.owner_id,
    owner_subject: config.owner_subject,
    visibility: config.visibility,
    shared_with_teams: config.shared_with_teams,
    config_driven: config.config_driven,
    authz_revision: config.authz_revision,
    authz_sync_state: config.authz_sync_state,
    authz_last_synced_revision: config.authz_last_synced_revision,
    authz_last_error_code: config.authz_last_error_code,
    authz_sync_started_at: config.authz_sync_started_at,
  };
}

export async function loadWorkflowConfigForRunAccess(
  configId: string,
): Promise<WorkflowConfig | null> {
  const configCol = await getCollection<WorkflowConfig>("workflow_configs");
  return configCol.findOne({ _id: configId as WorkflowConfig["_id"] });
}

export async function assertCanViewWorkflowRunsForConfigId(
  session: ResourceAuthzSession,
  configId: string,
  userEmail: string,
  userTeamSlugs?: string[],
): Promise<WorkflowConfig> {
  const config = await loadWorkflowConfigForRunAccess(configId);
  if (!config) {
    throw new ApiError(`Workflow config ${configId} not found`, 404);
  }
  await requireWorkflowConfigRunViewAccess(
    session,
    workflowConfigAccessSnapshot(config),
    userEmail,
    userTeamSlugs,
  );
  return config;
}

export async function assertCanExecuteWorkflowRunsForConfigId(
  session: ResourceAuthzSession,
  configId: string,
  userEmail: string,
  userTeamSlugs?: string[],
): Promise<WorkflowConfig> {
  const config = await loadWorkflowConfigForRunAccess(configId);
  if (!config) {
    throw new ApiError(`Workflow config ${configId} not found`, 404);
  }
  await requireWorkflowConfigRunAccess(
    session,
    workflowConfigAccessSnapshot(config),
    userEmail,
    userTeamSlugs,
  );
  return config;
}

export async function canViewWorkflowRunsForConfigId(
  session: ResourceAuthzSession,
  configId: string,
  userEmail: string,
  userTeamSlugs?: string[],
): Promise<boolean> {
  const config = await loadWorkflowConfigForRunAccess(configId);
  if (!config) {
    return false;
  }
  return canViewWorkflowRunsForConfig(
    session,
    workflowConfigAccessSnapshot(config),
    userEmail,
    userTeamSlugs,
  );
}
