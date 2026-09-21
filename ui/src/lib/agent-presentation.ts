export interface HarnessPresentation {
  label: string;
  shortLabel: string;
  badgeClassName: string;
}

const HARNESS_PRESENTATIONS: Record<string, HarnessPresentation> = {
  dynamic_agents: {
    label: "LangChain Deep Agents",
    shortLabel: "Deep Agents",
    badgeClassName:
      "border-teal-500/30 bg-teal-500/10 text-teal-700 dark:text-teal-300",
  },
  agentcore: {
    label: "Amazon Bedrock AgentCore",
    shortLabel: "AgentCore",
    badgeClassName:
      "border-orange-500/30 bg-orange-500/10 text-orange-700 dark:text-orange-300",
  },
  claude_agent_sdk: {
    label: "Claude Agent SDK",
    shortLabel: "Claude SDK",
    badgeClassName:
      "border-violet-500/30 bg-violet-500/10 text-violet-700 dark:text-violet-300",
  },
};

function normalizeHarnessId(harnessId?: string | null): string {
  const normalized = harnessId?.trim().toLowerCase();
  if (
    !normalized ||
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
      label: normalized,
      shortLabel: normalized,
      badgeClassName:
        "border-slate-500/30 bg-slate-500/10 text-slate-700 dark:text-slate-300",
    }
  );
}
