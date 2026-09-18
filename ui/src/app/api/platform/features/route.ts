import {
  successResponse,
  withAuth,
  withErrorHandler,
} from "@/lib/api-middleware";
import { getServerConfig } from "@/lib/config";
import { getCollection } from "@/lib/mongodb";
import {
  normalizeSetupWizardState,
  SETUP_WIZARD_CONFIG_ID,
  type SetupWizardFeatureFlags,
} from "@/lib/setup-wizard";
import type { Document } from "mongodb";
import { NextRequest } from "next/server";

export const PLATFORM_FEATURE_KEYS = [
  "workflows",
  "schedules",
  "autonomous_agents",
  "apps",
] as const;

export type PlatformFeatureKey = (typeof PLATFORM_FEATURE_KEYS)[number];

export interface PlatformFeatureState {
  deployed: boolean;
  enabled: boolean;
}

interface PlatformFeatureDocument extends Document {
  _id: string;
  setup_wizard?: unknown;
}

function deploymentFeatures(): Record<PlatformFeatureKey, boolean> {
  const config = getServerConfig();
  return {
    // The top-level Workflows surface requires the runner as well as its nav flag.
    workflows: config.workflowsEnabled && config.workflowRunnerEnabled,
    schedules: config.schedulerEnabled,
    autonomous_agents: config.autonomousAgentsEnabled,
    apps: config.agenticAppsEnabled,
  };
}

function normalizeFeatureSelection(value: SetupWizardFeatureFlags | undefined): Partial<Record<PlatformFeatureKey, boolean>> {
  return Object.fromEntries(
    PLATFORM_FEATURE_KEYS.flatMap((key) =>
      typeof value?.[key] === "boolean" ? [[key, value[key]]] : [],
    ),
  );
}

export const GET = withErrorHandler(async (request: NextRequest) => {
  return withAuth(request, async () => {
    const platformConfig = await getCollection<PlatformFeatureDocument>("platform_config");
    const document = await platformConfig.findOne({ _id: SETUP_WIZARD_CONFIG_ID });
    const deployed = deploymentFeatures();
    const selected = normalizeFeatureSelection(
      normalizeSetupWizardState(document?.setup_wizard).selection?.enabled_features,
    );

    return successResponse({
      features: Object.fromEntries(
        PLATFORM_FEATURE_KEYS.map((key) => [key, {
          deployed: deployed[key],
          // Deployment config remains the hard gate. The wizard can only hide a
          // surface that is already deployed and enabled by the operator.
          enabled: deployed[key] && selected[key] !== false,
        } satisfies PlatformFeatureState]),
      ) as Record<PlatformFeatureKey, PlatformFeatureState>,
    });
  });
});
