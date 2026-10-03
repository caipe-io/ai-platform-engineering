import {
  ApiError,
  requireRbacPermission,
  successResponse,
  withAuth,
  withErrorHandler,
} from "@/lib/api-middleware";
import { getServerConfig } from "@/lib/config";
import { getCollection } from "@/lib/mongodb";
import { requireResourcePermission } from "@/lib/rbac/resource-authz";
import {
  DEFAULT_SETUP_WIZARD_STATE,
  isFreshSetupInventory,
  normalizeSetupWizardState,
  SETUP_WIZARD_CONFIG_ID,
  SETUP_WIZARD_VERSION,
  type SetupWizardInventory,
  type SetupWizardSelection,
  type SetupWizardState,
} from "@/lib/setup-wizard";
import type { Document } from "mongodb";
import { NextRequest } from "next/server";

interface PlatformConfigDocument extends Document {
  _id: string;
  setup_wizard?: unknown;
}

interface CountDocument extends Document {
  _id: string;
  config_driven?: boolean;
  enabled?: boolean;
}

interface SetupWizardPatchBody {
  action?: unknown;
  current_step?: unknown;
  completed_steps?: unknown;
  skipped_steps?: unknown;
  selection?: unknown;
  created_agent_id?: unknown;
  smoke_test?: unknown;
  checklist_hidden?: unknown;
}

function stringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return [...new Set(value.filter((item): item is string =>
    typeof item === "string" && Boolean(item.trim()),
  ).map((item) => item.trim()))];
}

function stepArray(value: unknown, field: string): number[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((item) => !Number.isInteger(item) || item < 1 || item > 5)) {
    throw new ApiError(`${field} must contain setup steps from 1 through 5`, 400, "INVALID_SETUP_STEP");
  }
  return [...new Set(value as number[])].sort((a, b) => a - b);
}

function normalizeSelection(value: unknown): SetupWizardSelection | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ApiError("selection must be an object", 400, "INVALID_SETUP_SELECTION");
  }
  const source = value as Record<string, unknown>;
  const rawRecipe = source.recipe_id;
  const mcpServerIds = stringArray(source.mcp_server_ids);
  const recipe: SetupWizardSelection["recipe_id"] =
    rawRecipe === "sre" || rawRecipe === "hello-world" || rawRecipe === "blank"
      ? rawRecipe
      : undefined;
  if (rawRecipe !== undefined && recipe === undefined) {
    throw new ApiError("recipe_id must be sre, hello-world, or blank", 400, "INVALID_SETUP_RECIPE");
  }
  return {
    ...(typeof source.model_id === "string" ? { model_id: source.model_id.trim() } : {}),
    ...(typeof source.model_provider === "string" ? { model_provider: source.model_provider.trim() } : {}),
    ...(recipe ? { recipe_id: recipe } : {}),
    ...(mcpServerIds !== undefined
      ? { mcp_server_ids: mcpServerIds }
      : {}),
    ...(typeof source.enable_knowledge_base === "boolean"
      ? { enable_knowledge_base: source.enable_knowledge_base }
      : {}),
    ...(source.enabled_features && typeof source.enabled_features === "object" && !Array.isArray(source.enabled_features)
      ? {
          enabled_features: Object.fromEntries(
            ["workflows", "schedules", "autonomous_agents", "apps"].flatMap((key) =>
              typeof (source.enabled_features as Record<string, unknown>)[key] === "boolean"
                ? [[key, (source.enabled_features as Record<string, boolean>)[key]]]
                : [],
            ),
          ) as SetupWizardSelection["enabled_features"],
        }
      : {}),
  };
}

function normalizeCurrentStep(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isInteger(value) || Number(value) < 1 || Number(value) > 5) {
    throw new ApiError("current_step must be between 1 and 5", 400, "INVALID_SETUP_STEP");
  }
  return Number(value);
}

async function inventory(): Promise<SetupWizardInventory> {
  const [agents, conversations, providerConnections, oauthConnectors, knowledgeSources, mcpServers, models, users] = await Promise.all([
    getCollection<CountDocument>("dynamic_agents"),
    getCollection<CountDocument>("conversations"),
    getCollection<CountDocument>("provider_connections"),
    getCollection<CountDocument>("oauth_connectors"),
    getCollection<CountDocument>("rag_ingestion_sources"),
    getCollection<CountDocument>("mcp_servers"),
    getCollection<CountDocument>("llm_models"),
    getCollection<CountDocument>("users"),
  ]);
  const [agentCount, customAgentCount, conversationCount, connectedCredentialCount, availableOAuthConnectorCount, knowledgeSourceCount, mcpServerCount, modelCount, userCount] =
    await Promise.all([
      agents.countDocuments({}),
      agents.countDocuments({
        _id: { $ne: "hello-world" },
        config_driven: { $ne: true },
      }),
      conversations.countDocuments({}),
      providerConnections.countDocuments({ status: "connected" }),
      oauthConnectors.countDocuments({ enabled: { $ne: false } }),
      knowledgeSources.countDocuments({}),
      mcpServers.countDocuments({ enabled: { $ne: false } }),
      models.countDocuments({}),
      users.countDocuments({}),
    ]);
  return {
    agents: agentCount,
    custom_agents: customAgentCount,
    conversations: conversationCount,
    connected_credentials: connectedCredentialCount,
    available_oauth_connectors: availableOAuthConnectorCount,
    knowledge_sources: knowledgeSourceCount,
    mcp_servers: mcpServerCount,
    models: modelCount,
    users: userCount,
  };
}

async function requireSetupAdmin(
  session: Parameters<typeof requireRbacPermission>[0] & Parameters<typeof requireResourcePermission>[0],
  action: "read" | "admin",
): Promise<void> {
  await requireRbacPermission(session, "admin_ui", "admin");
  await requireResourcePermission(session, {
    type: "system_config",
    id: SETUP_WIZARD_CONFIG_ID,
    action,
  });
}

export const GET = withErrorHandler(async (request: NextRequest) => {
  return withAuth(request, async (_req, _user, session) => {
    await requireSetupAdmin(session, "read");
    const platformConfig = await getCollection<PlatformConfigDocument>("platform_config");
    const [doc, currentInventory] = await Promise.all([
      platformConfig.findOne({ _id: SETUP_WIZARD_CONFIG_ID }),
      inventory(),
    ]);
    const state = normalizeSetupWizardState(doc?.setup_wizard);
    const enabled = getServerConfig().setupWizardEnabled;
    const freshInstall = !doc?.setup_wizard && isFreshSetupInventory(currentInventory);

    return successResponse({
      auto_start: enabled && (
        (freshInstall && state.status === "not_started") || state.status === "in_progress"
      ),
      enabled,
      fresh_install: freshInstall,
      inventory: currentInventory,
      state,
    });
  });
});

export const PATCH = withErrorHandler(async (request: NextRequest) => {
  return withAuth(request, async (_req, user, session) => {
    await requireSetupAdmin(session, "admin");
    const body = await request.json() as SetupWizardPatchBody;
    const action = body.action;
    if (action !== "start" && action !== "progress" && action !== "dismiss" && action !== "complete" && action !== "reset" && action !== "hide_checklist") {
      throw new ApiError("action must be start, progress, dismiss, complete, reset, or hide_checklist", 400, "INVALID_SETUP_ACTION");
    }

    const collection = await getCollection<PlatformConfigDocument>("platform_config");
    const existing = await collection.findOne({ _id: SETUP_WIZARD_CONFIG_ID });
    const previous = normalizeSetupWizardState(existing?.setup_wizard);
    const now = new Date().toISOString();
    const currentStep = normalizeCurrentStep(body.current_step);
    const completedSteps = stepArray(body.completed_steps, "completed_steps");
    const skippedSteps = stepArray(body.skipped_steps, "skipped_steps");
    const selection = normalizeSelection(body.selection);
    const createdAgentId = typeof body.created_agent_id === "string" && body.created_agent_id.trim()
      ? body.created_agent_id.trim()
      : undefined;

    let next: SetupWizardState;
    if (action === "reset") {
      next = {
        ...DEFAULT_SETUP_WIZARD_STATE,
        status: "in_progress",
        started_at: now,
        updated_at: now,
        run_count: (previous.run_count ?? 0) + 1,
      };
    } else {
      next = {
        ...previous,
        version: SETUP_WIZARD_VERSION,
        status: action === "complete"
          ? "completed"
          : action === "dismiss"
            ? "dismissed"
            : action === "hide_checklist"
              ? previous.status
            : "in_progress",
        current_step: currentStep ?? previous.current_step,
        completed_steps: completedSteps ?? previous.completed_steps,
        skipped_steps: skippedSteps ?? previous.skipped_steps,
        selection: selection ?? previous.selection,
        created_agent_id: createdAgentId ?? previous.created_agent_id,
        started_at: previous.started_at ?? now,
        updated_at: now,
        ...(action === "complete" ? { completed_at: now, dismissed_at: undefined } : {}),
        ...(action === "dismiss" ? { dismissed_at: now } : {}),
        ...(action === "hide_checklist" ? { checklist_hidden: true } : {}),
        run_count: Math.max(1, previous.run_count ?? 0),
      };
    }

    if (body.smoke_test !== undefined) {
      const smoke = body.smoke_test;
      if (!smoke || typeof smoke !== "object" || Array.isArray(smoke)) {
        throw new ApiError("smoke_test must be an object", 400, "INVALID_SMOKE_TEST");
      }
      const smokeStatus = (smoke as { status?: unknown }).status;
      if (smokeStatus !== "passed" && smokeStatus !== "failed") {
        throw new ApiError("smoke_test.status must be passed or failed", 400, "INVALID_SMOKE_TEST");
      }
      next.last_smoke_test = {
        status: smokeStatus,
        ...(typeof (smoke as { detail?: unknown }).detail === "string"
          ? { detail: (smoke as { detail: string }).detail.slice(0, 500) }
          : {}),
        tested_at: now,
      };
    }

    await collection.updateOne(
      { _id: SETUP_WIZARD_CONFIG_ID },
      {
        $set: {
          setup_wizard: next,
          updated_at: new Date(now),
          updated_by: user.email,
        },
        $setOnInsert: { created_at: new Date(now) },
      },
      { upsert: true },
    );

    return successResponse({ state: next });
  });
});
