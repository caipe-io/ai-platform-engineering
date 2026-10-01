export const AGENT_SETUP_STEP_IDS = [
  "basic",
  "instructions",
  "tools",
  "knowledge",
  "skills",
  "advanced",
] as const;

export type AgentSetupStep = (typeof AGENT_SETUP_STEP_IDS)[number];

export function isAgentSetupStep(
  value: string | null,
): value is AgentSetupStep {
  return AGENT_SETUP_STEP_IDS.some((step) => step === value);
}
