export const SETUP_WIZARD_VERSION = 1;
export const SETUP_WIZARD_CONFIG_ID = "platform_settings";

export type SetupWizardStatus =
  | "not_started"
  | "in_progress"
  | "completed"
  | "dismissed";

export interface SetupWizardFeatureFlags {
  workflows?: boolean;
  schedules?: boolean;
  autonomous_agents?: boolean;
  apps?: boolean;
}

export interface SetupWizardSelection {
  model_id?: string;
  model_provider?: string;
  recipe_id?: "sre" | "hello-world" | "blank";
  mcp_server_ids?: string[];
  enable_knowledge_base?: boolean;
  enabled_features?: SetupWizardFeatureFlags;
}

export interface SetupWizardState {
  version: number;
  status: SetupWizardStatus;
  current_step: number;
  completed_steps: number[];
  skipped_steps: number[];
  selection?: SetupWizardSelection;
  created_agent_id?: string;
  started_at?: string;
  updated_at?: string;
  completed_at?: string;
  dismissed_at?: string;
  last_smoke_test?: {
    status: "passed" | "failed";
    detail?: string;
    tested_at: string;
  };
  run_count?: number;
}

export interface SetupWizardInventory {
  agents: number;
  custom_agents: number;
  conversations: number;
  knowledge_sources: number;
  mcp_servers: number;
  models: number;
  users: number;
}

export interface SetupWizardPayload {
  auto_start: boolean;
  enabled: boolean;
  fresh_install: boolean;
  inventory: SetupWizardInventory;
  state: SetupWizardState;
}

export const DEFAULT_SETUP_WIZARD_STATE: SetupWizardState = {
  version: SETUP_WIZARD_VERSION,
  status: "not_started",
  current_step: 1,
  completed_steps: [],
  skipped_steps: [],
  run_count: 0,
};

function stringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return [...new Set(value.filter((item): item is string =>
    typeof item === "string" && Boolean(item.trim()),
  ).map((item) => item.trim()))];
}

function stepArray(value: unknown): number[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((item): item is number =>
    Number.isInteger(item) && item >= 1 && item <= 5,
  ))].sort((a, b) => a - b);
}

function timestamp(value: unknown): string | undefined {
  return typeof value === "string" && !Number.isNaN(Date.parse(value))
    ? value
    : undefined;
}

export function normalizeSetupWizardState(value: unknown): SetupWizardState {
  const source = value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
  const rawStatus = source.status;
  const status: SetupWizardStatus =
    rawStatus === "in_progress" || rawStatus === "completed" || rawStatus === "dismissed"
      ? rawStatus
      : "not_started";
  const rawStep = Number(source.current_step);
  const currentStep = Number.isInteger(rawStep)
    ? Math.min(5, Math.max(1, rawStep))
    : 1;
  const rawSelection = source.selection;
  const selectionSource = rawSelection && typeof rawSelection === "object" && !Array.isArray(rawSelection)
    ? rawSelection as Record<string, unknown>
    : {};
  const recipe = selectionSource.recipe_id;
  const mcpServerIds = stringArray(selectionSource.mcp_server_ids);
  const startedAt = timestamp(source.started_at);
  const updatedAt = timestamp(source.updated_at);
  const completedAt = timestamp(source.completed_at);
  const dismissedAt = timestamp(source.dismissed_at);

  return {
    version: SETUP_WIZARD_VERSION,
    status,
    current_step: currentStep,
    completed_steps: stepArray(source.completed_steps),
    skipped_steps: stepArray(source.skipped_steps),
    selection: {
      ...(typeof selectionSource.model_id === "string" && selectionSource.model_id.trim()
        ? { model_id: selectionSource.model_id.trim() }
        : {}),
      ...(typeof selectionSource.model_provider === "string" && selectionSource.model_provider.trim()
        ? { model_provider: selectionSource.model_provider.trim() }
        : {}),
      ...(recipe === "sre" || recipe === "hello-world" || recipe === "blank"
        ? { recipe_id: recipe }
        : {}),
      ...(mcpServerIds !== undefined
        ? { mcp_server_ids: mcpServerIds }
        : {}),
      ...(typeof selectionSource.enable_knowledge_base === "boolean"
        ? { enable_knowledge_base: selectionSource.enable_knowledge_base }
        : {}),
      ...(selectionSource.enabled_features && typeof selectionSource.enabled_features === "object" && !Array.isArray(selectionSource.enabled_features)
        ? {
            enabled_features: Object.fromEntries(
              ["workflows", "schedules", "autonomous_agents", "apps"].flatMap((key) =>
                typeof (selectionSource.enabled_features as Record<string, unknown>)[key] === "boolean"
                  ? [[key, (selectionSource.enabled_features as Record<string, boolean>)[key]]]
                  : [],
              ),
            ) as SetupWizardSelection["enabled_features"],
          }
        : {}),
    },
    ...(typeof source.created_agent_id === "string" && source.created_agent_id.trim()
      ? { created_agent_id: source.created_agent_id.trim() }
      : {}),
    ...(startedAt ? { started_at: startedAt } : {}),
    ...(updatedAt ? { updated_at: updatedAt } : {}),
    ...(completedAt ? { completed_at: completedAt } : {}),
    ...(dismissedAt ? { dismissed_at: dismissedAt } : {}),
    run_count: Number.isInteger(source.run_count) && Number(source.run_count) >= 0
      ? Number(source.run_count)
      : 0,
    ...(source.last_smoke_test && typeof source.last_smoke_test === "object"
      ? {
          last_smoke_test: {
            status: (source.last_smoke_test as { status?: unknown }).status === "passed"
              ? "passed"
              : "failed",
            ...(typeof (source.last_smoke_test as { detail?: unknown }).detail === "string"
              ? { detail: (source.last_smoke_test as { detail: string }).detail }
              : {}),
            tested_at: timestamp((source.last_smoke_test as { tested_at?: unknown }).tested_at)
              ?? new Date(0).toISOString(),
          },
        }
      : {}),
  };
}

export function isFreshSetupInventory(inventory: SetupWizardInventory): boolean {
  return inventory.conversations === 0 && inventory.custom_agents === 0 && inventory.users <= 1;
}
