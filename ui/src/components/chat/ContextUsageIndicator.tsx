"use client";

import { Tooltip,TooltipContent,TooltipProvider,TooltipTrigger } from "@/components/ui/tooltip";
import type { ContextUsageEventData } from "@/lib/streaming/types";
import { cn } from "@/lib/utils";
import { Gauge } from "lucide-react";

interface ContextUsageIndicatorProps {
  usage: ContextUsageEventData;
  className?: string;
}

const numberFormatter = new Intl.NumberFormat();

export function ContextUsageIndicator({
  usage,
  className,
}: ContextUsageIndicatorProps): React.ReactElement {
  const percent = Math.round(usage.remaining_percent);
  const tone = percent <= 15
    ? "text-destructive"
    : percent <= 35
      ? "text-amber-600 dark:text-amber-400"
      : "text-muted-foreground";

  return (
    <TooltipProvider delayDuration={150}>
      <Tooltip>
        <TooltipTrigger asChild>
          <div
            aria-label={`${percent}% context left before compaction`}
            className={cn(
              "inline-flex cursor-help items-center gap-1 rounded-full border border-border/60 bg-muted/40 px-2 py-1 text-[11px] font-medium tabular-nums",
              tone,
              className,
            )}
            data-testid="context-usage-indicator"
            role="status"
          >
            <Gauge aria-hidden="true" className="h-3 w-3" />
            <span>{percent}% context left</span>
          </div>
        </TooltipTrigger>
        <TooltipContent className="max-w-xs text-xs" side="top" sideOffset={6}>
          {numberFormatter.format(usage.used_tokens)} of{" "}
          {numberFormatter.format(usage.compaction_threshold)} tokens used. Older
          conversation history is compacted automatically at this threshold.
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
