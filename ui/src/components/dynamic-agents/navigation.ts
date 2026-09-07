import {
  type WorkspaceNavigationGroup,
  type WorkspaceNavigationItem,
} from "@/components/layout/WorkspaceNavigation";
import { Bot,Cpu,KeyRound,MessageSquare,Server } from "lucide-react";

export const BASE_DYNAMIC_AGENT_TABS = [
  "agents",
  "mcp-servers",
  "model-providers",
  "llm-models",
] as const;

export type DynamicAgentNavigationTab =
  | (typeof BASE_DYNAMIC_AGENT_TABS)[number]
  | "conversations";

type DynamicAgentNavigationDestination = Pick<
  WorkspaceNavigationItem,
  "href" | "onSelect"
>;

export function buildDynamicAgentNavigationGroups({
  destinationForTab,
  showConversations,
}: {
  destinationForTab: (
    tab: DynamicAgentNavigationTab,
  ) => DynamicAgentNavigationDestination;
  showConversations: boolean;
}): WorkspaceNavigationGroup[] {
  return [{
    id: "agent-sections",
    items: [
      {
        id: "agents",
        label: "Agents",
        icon: Bot,
        description: "Create and configure agents",
        ...destinationForTab("agents"),
      },
      {
        id: "mcp-servers",
        label: "MCP Servers",
        icon: Server,
        description: "Connect tools and services",
        ...destinationForTab("mcp-servers"),
      },
      {
        id: "model-settings",
        label: "Models",
        icon: Cpu,
        description: "Configure providers and models",
        children: [
          {
            id: "model-providers",
            label: "Model Providers",
            icon: KeyRound,
            description: "Connect model providers",
            ...destinationForTab("model-providers"),
          },
          {
            id: "llm-models",
            label: "LLM Models",
            icon: Cpu,
            description: "Register available models",
            ...destinationForTab("llm-models"),
          },
        ],
      },
      ...(showConversations ? [{
        id: "conversations",
        label: "Conversations",
        icon: MessageSquare,
        description: "Review agent conversations",
        ...destinationForTab("conversations"),
      }] : []),
    ],
  }];
}
