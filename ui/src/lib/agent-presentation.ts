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
  claude_code_acp: {
    id: "claude_code_acp", label: "Claude Agent SDK (Advanced ACP)", shortLabel: "Claude SDK ACP",
    logoSrc: "/provider-logos/claude.svg",
    badgeClassName: "border-orange-500/30 bg-orange-500/10 text-orange-700 dark:text-orange-300",
    dotClassName: "bg-orange-500",
  },
  claude_code_cli_acp: {
    id: "claude_code_cli_acp", label: "Claude Code", shortLabel: "Claude Code",
    logoSrc: "/provider-logos/claude.svg",
    badgeClassName: "border-orange-500/30 bg-orange-500/10 text-orange-700 dark:text-orange-300",
    dotClassName: "bg-orange-500",
  },
  claude_agent_sdk_remote: {
    id: "claude_agent_sdk_remote",
    label: "Claude Agent SDK",
    shortLabel: "Claude SDK",
    logoSrc: "/provider-logos/claude.svg",
    badgeClassName: "border-violet-500/30 bg-violet-500/10 text-violet-700 dark:text-violet-300",
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
    HARNESS_PRESENTATIONS[normalized] ?? {
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
  remote?: { protocol?: "a2a" | "acp"; framework?: string },
): { label: string; logoSrc?: string; isApp: boolean; searchTerms: string[] } {
  if (presentation?.app) {
    const app = presentation.app;
    return {
      label: `App: ${app.name}${presentation.available ? "" : " (unavailable)"}`,
      isApp: true,
      searchTerms: [app.id, app.name, "app"],
    };
  }
  const frameworks: Record<string, string> = { claude_code: "claude_code_cli_acp", claude_agent_sdk: "claude_agent_sdk", deepagents: "dynamic_agents", agentcore: "agentcore" };
  const normalized = harnessId ? normalizeHarnessId(harnessId) : undefined;
  const known = normalized && Object.hasOwn(HARNESS_PRESENTATIONS, normalized) ? HARNESS_PRESENTATIONS[normalized] : undefined;
  const framework = remote?.framework && Object.hasOwn(frameworks, remote.framework) ? frameworks[remote.framework] : undefined;
  const harness = known ?? (framework ? getHarnessPresentation(framework) : null);
  if (!harness && remote?.framework === "google_adk") return { label: "Agent framework: Google ADK", logoSrc: "/provider-logos/adk.svg", isApp: false, searchTerms: ["Google ADK"] };
  if (!harness && remote?.protocol) return { label: `Remote agent: ${remote.protocol.toUpperCase()}`, logoSrc: remote.protocol === "a2a" ? "/provider-logos/a2a.svg" : undefined, isApp: false, searchTerms: [remote.protocol] };
  const identity = harness ?? getHarnessPresentation(harnessId);
  return {
    label: `Execution harness: ${identity.label}`,
    logoSrc: identity.logoSrc,
    isApp: false,
    searchTerms: [identity.id, identity.label, identity.shortLabel],
  };
}
