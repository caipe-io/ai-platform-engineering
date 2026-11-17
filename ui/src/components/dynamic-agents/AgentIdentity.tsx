"use client";

import { AgentHarnessBadge } from "@/components/chat/AgentHarnessBadge";
import type { AgentPresentation } from "@/types/dynamic-agent";
import { AgentAvatar, type AgentAvatarAgent } from "./AgentAvatar";

/** The agent keeps its gradient; the badge identifies its harness, then protocol. */
export function AgentIdentity({ agent, harnessId, presentation, protocol, framework, decorative = false }: {
  agent?: AgentAvatarAgent; harnessId?: string | null; presentation?: AgentPresentation;
  protocol?: "a2a" | "acp"; framework?: string; decorative?: boolean;
}) {
  return <span className="relative inline-flex shrink-0 pb-1 pr-1" aria-hidden={decorative || undefined}>
    <AgentAvatar agent={agent} size="h-9 w-9" iconSize="h-4 w-4" rounded="rounded-lg" />
    <AgentHarnessBadge harnessId={harnessId} presentation={presentation} protocol={protocol} framework={framework} compact className="absolute -bottom-0.5 -right-0.5 rounded-sm bg-card ring-2 ring-card" />
  </span>;
}
