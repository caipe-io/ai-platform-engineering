import { getHarnessPresentation } from "@/lib/agent-presentation";

/** Optional display metadata; selecting a framework never changes execution. */
export const AGENT_FRAMEWORKS = {
  unspecified: { label: "Not specified", logoSrc: undefined },
  claude_code: getHarnessPresentation("claude_code_cli_acp"),
  claude_agent_sdk: getHarnessPresentation("claude_agent_sdk"),
  google_adk: { label: "Google ADK", logoSrc: "/provider-logos/adk.svg" },
  deepagents: getHarnessPresentation("dynamic_agents"),
} as const;

export type AgentFramework = keyof typeof AGENT_FRAMEWORKS;

export function isAgentFramework(value: unknown): value is AgentFramework {
  return typeof value === "string" && Object.hasOwn(AGENT_FRAMEWORKS, value);
}

export function getAgentFramework(value?: string) {
  return isAgentFramework(value) ? AGENT_FRAMEWORKS[value] : AGENT_FRAMEWORKS.unspecified;
}
