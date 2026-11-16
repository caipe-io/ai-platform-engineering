"use client";

import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { getAgentPresentation } from "@/lib/agent-presentation";
import { AppIcon } from "@/components/shared/AppIcon";
import type { AgentPresentation } from "@/types/dynamic-agent";
import { cn } from "@/lib/utils";
import { Cpu } from "lucide-react";
import Image from "next/image";

interface AgentHarnessBadgeProps {
  harnessId?: string | null;
  presentation?: AgentPresentation;
  compact?: boolean;
  className?: string;
}

export function AgentHarnessBadge({
  harnessId,
  presentation,
  compact = false,
  className,
}: AgentHarnessBadgeProps) {
  const identity = getAgentPresentation(harnessId, presentation);
  const { label } = identity;

  return (
    <Tooltip className={cn(
      "inline-flex shrink-0 align-middle",
      className,
      identity.logoSrc === "/provider-logos/agentcore.svg" && "rounded-full",
    )}>
      <TooltipTrigger asChild>
        <span
          role="img"
          aria-label={label}
          className={cn(
            "inline-flex shrink-0 items-center justify-center",
            compact ? "h-4 w-4" : "h-5 w-5",
          )}
        >
          {presentation?.app ? (
            <AppIcon
              appId={presentation.app.id}
              icon={presentation.app.icon}
              className="h-full w-full object-contain"
            />
          ) : identity.logoSrc ? (
            <Image
              src={identity.logoSrc}
              alt=""
              width={20}
              height={20}
              className="h-full w-full object-contain"
              aria-hidden="true"
            />
          ) : (
            <Cpu className="h-full w-full text-muted-foreground" aria-hidden="true" />
          )}
        </span>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}
