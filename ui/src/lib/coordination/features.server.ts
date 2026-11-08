import { getCollection } from "@/lib/mongodb";
import { PLATFORM_CONFIG_ID } from "@/lib/platform-default-agent";

export interface CoordinationFeatures {
  enabled: boolean;
  team: boolean;
}

interface FeatureDocument {
  _id: string;
  agent_coordination?: Partial<CoordinationFeatures>;
}

/** Deployment settings are ceilings: runtime settings cannot override a disabled feature. */
export function coordinationDeploymentLimits(): CoordinationFeatures {
  const enabled = process.env.AGENT_COORDINATION_ENABLED !== "false";
  return { enabled, team: enabled && process.env.AGENT_TEAM_HANDOFFS_ENABLED !== "false" };
}

export function resolveCoordinationFeatures(settings?: Partial<CoordinationFeatures>): CoordinationFeatures {
  const limits = coordinationDeploymentLimits();
  const enabled = limits.enabled && settings?.enabled !== false;
  return { enabled, team: enabled && limits.team && settings?.team !== false };
}

/** No process cache: each admission and queue delivery observes the current admin switches. */
export async function getCoordinationFeatures(): Promise<CoordinationFeatures> {
  const limits = coordinationDeploymentLimits();
  if (!limits.enabled) return limits;
  const document = await (await getCollection<FeatureDocument>("platform_config"))
    .findOne({ _id: PLATFORM_CONFIG_ID }, { projection: { agent_coordination: 1 } });
  return resolveCoordinationFeatures(document?.agent_coordination);
}
