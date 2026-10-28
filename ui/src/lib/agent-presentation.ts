import type { AgentPresentation } from "@/types/dynamic-agent";

export { getDeterministicAgentThemeId } from "@/lib/agent-theme";

export interface HarnessPresentation {
  id: string;
  label: string;
  shortLabel: string;
  logoSrc?: string;
  badgeClassName: string;
  dotClassName: string;
}

const HARNESS_PRESENTATIONS: Record<string, HarnessPresentation> = {
  dynamic_agents: {
    id: "dynamic_agents",
    label: "LangChain Deep Agents",
    shortLabel: "Deep Agents",
    logoSrc: "/provider-logos/deepagents.svg",
    badgeClassName:
      "border-teal-500/30 bg-teal-500/10 text-teal-700 dark:text-teal-300",
    dotClassName: "bg-teal-500",
  },
  agentcore: {
    id: "agentcore",
    label: "Amazon Bedrock AgentCore",
    shortLabel: "AgentCore",
    logoSrc: "/provider-logos/agentcore.svg",
    badgeClassName:
      "border-orange-500/30 bg-orange-500/10 text-orange-700 dark:text-orange-300",
    dotClassName: "bg-orange-500",
  },
  claude_agent_sdk: {
    id: "claude_agent_sdk",
    label: "Claude Agent SDK",
    shortLabel: "Claude SDK",
    logoSrc: "/provider-logos/claude.svg",
    badgeClassName:
      "border-violet-500/30 bg-violet-500/10 text-violet-700 dark:text-violet-300",
    dotClassName: "bg-violet-500",
  },
};

const FALLBACK_HARNESS: HarnessPresentation = {
  id: "unknown",
  label: "Custom harness",
  shortLabel: "Custom",
  badgeClassName:
    "border-slate-500/30 bg-slate-500/10 text-slate-700 dark:text-slate-300",
  dotClassName: "bg-slate-500",
};

export function normalizeHarnessId(harnessId?: string | null): string {
  const normalized = harnessId?.trim().toLowerCase();
  if (
    !normalized ||
    normalized === "dynamic_agents" ||
    normalized === "langchain-deepagents" ||
    normalized === "langchain_deepagents"
  ) {
    return "dynamic_agents";
  }
  return normalized;
}

export function getHarnessPresentation(
  harnessId?: string | null,
): HarnessPresentation {
  const normalized = normalizeHarnessId(harnessId);
  return (
    (Object.hasOwn(HARNESS_PRESENTATIONS, normalized) ? HARNESS_PRESENTATIONS[normalized] : undefined) ?? {
      ...FALLBACK_HARNESS,
      id: normalized,
      label: normalized,
    }
  );
}

/** App provenance takes precedence; an app stream does not identify its internal SDK. */
export function getAgentPresentation(
  harnessId?: string | null,
  presentation?: AgentPresentation,
): { label: string; logoSrc?: string; isApp: boolean; searchTerms: string[] } {
  if (presentation?.app) {
    const app = presentation.app;
    return {
      label: `App: ${app.name}${presentation.available ? "" : " (unavailable)"}`,
      isApp: true,
      searchTerms: [app.id, app.name, "app"],
    };
  }
  const harness = getHarnessPresentation(harnessId);
  return {
    label: `Execution harness: ${harness.label}`,
    logoSrc: harness.logoSrc,
    isApp: false,
    searchTerms: [harness.id, harness.label, harness.shortLabel],
  };
}
