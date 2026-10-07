import {
  Bot,
  CalendarClock,
  Cpu,
  Database,
  KeyRound,
  Link2,
  MessageSquare,
  Server,
  Workflow,
  Zap,
  type LucideIcon,
} from "lucide-react";

export interface QuickStartCard {
  id: string;
  title: string;
  description: string;
  icon: LucideIcon;
  iconClassName: string;
  accentColor: string;
  ctaLabel: string;
  href: string;
}

export type QuickStartTabId = "build" | "automate" | "connect" | "explore";

export interface QuickStartTab {
  id: QuickStartTabId;
  label: string;
  cards: QuickStartCard[];
}

export const QUICK_START_TABS: QuickStartTab[] = [
  {
    id: "build",
    label: "Build",
    cards: [
      {
        id: "build-agent",
        title: "Build an agent",
        description: "Build agents and choose the instructions, tools, skills, and model they use.",
        icon: Bot,
        iconClassName: "from-violet-500 to-fuchsia-500",
        accentColor: "#8b5cf6",
        ctaLabel: "Build an agent",
        href: "/dynamic-agents",
      },
      {
        id: "add-mcp-server",
        title: "Add an MCP server",
        description: "Configure MCP server connections so agents can reach approved tools.",
        icon: Server,
        iconClassName: "from-sky-500 to-cyan-500",
        accentColor: "#06b6d4",
        ctaLabel: "Add an MCP server",
        href: "/dynamic-agents?tab=mcp-servers",
      },
      {
        id: "create-skills",
        title: "Create a skill",
        description: "Build reusable skills and templates for common tasks.",
        icon: Zap,
        iconClassName: "from-amber-400 to-orange-500",
        accentColor: "#f59e0b",
        ctaLabel: "Create a skill",
        href: "/skills/workspace/new",
      },
      {
        id: "add-knowledge-base",
        title: "Add a knowledge base",
        description: "Ingest and manage the sources your agents can search.",
        icon: Database,
        iconClassName: "from-emerald-500 to-teal-500",
        accentColor: "#10b981",
        ctaLabel: "Add a knowledge base",
        href: "/knowledge-bases/ingest",
      },
      {
        id: "add-model",
        title: "Add a model",
        description: "Register the LLM models available for agents to use.",
        icon: Cpu,
        iconClassName: "from-rose-500 to-pink-500",
        accentColor: "#ec4899",
        ctaLabel: "Add a model",
        href: "/dynamic-agents?tab=llm-models",
      },
    ],
  },
  {
    id: "automate",
    label: "Automate",
    cards: [
      {
        id: "build-workflow",
        title: "Build a workflow",
        description: "Chain multiple agents together into automated, multi-step workflows.",
        icon: Workflow,
        iconClassName: "from-indigo-500 to-violet-500",
        accentColor: "#6366f1",
        ctaLabel: "Build a workflow",
        href: "/workflows",
      },
      {
        id: "create-schedules",
        title: "Create a schedule",
        description: "Set up recurring agent jobs for your account.",
        icon: CalendarClock,
        iconClassName: "from-orange-500 to-red-500",
        accentColor: "#f97316",
        ctaLabel: "Create a schedule",
        href: "/schedules",
      },
    ],
  },
  {
    id: "connect",
    label: "Connect",
    cards: [
      {
        id: "connect-apps",
        title: "Connect an app",
        description: "Connect apps like Atlassian so agents can use approved account access.",
        icon: Link2,
        iconClassName: "from-blue-500 to-indigo-500",
        accentColor: "#3b82f6",
        ctaLabel: "Connect an app",
        href: "/credentials/connections",
      },
      {
        id: "secrets",
        title: "Add a secret",
        description: "Store secrets that agents and services can use without showing the value again.",
        icon: KeyRound,
        iconClassName: "from-red-500 to-rose-500",
        accentColor: "#f43f5e",
        ctaLabel: "Add a secret",
        href: "/credentials/secrets",
      },
    ],
  },
  {
    id: "explore",
    label: "Explore",
    cards: [
      {
        id: "chat-assistants",
        title: "Chat with an agent",
        description: "Chat with platform and dynamic agents.",
        icon: MessageSquare,
        iconClassName: "from-teal-500 to-cyan-500",
        accentColor: "#14b8a6",
        ctaLabel: "Chat with an agent",
        href: "/chat",
      },
    ],
  },
];
