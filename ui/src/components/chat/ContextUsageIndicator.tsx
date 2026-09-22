"use client";

import type { ContextUsageEventData } from "@/lib/streaming/types";
import { cn } from "@/lib/utils";

interface ContextUsageIndicatorProps {
  usage: ContextUsageEventData;
  className?: string;
}

const numberFormatter = new Intl.NumberFormat();
const LOW_CONTEXT_THRESHOLD_PERCENT = 80;

export function ContextUsageIndicator({
  usage,
  className,
}: ContextUsageIndicatorProps): React.ReactElement | null {
  const percent = Math.round(usage.remaining_percent);

  if (percent >= LOW_CONTEXT_THRESHOLD_PERCENT) return null;

  return (
    <span
      aria-label={`${percent}% context remaining before compaction`}
      className={cn("whitespace-nowrap text-xs text-muted-foreground tabular-nums",className)}
      data-testid="context-usage-indicator"
      role="status"
    >
      {percent}% context remaining
    </span>
  );
}

export function ContextUsageDetails({
  usage,
  className,
}: ContextUsageIndicatorProps): React.ReactElement {
  const percent = Math.round(usage.remaining_percent);

  return (
    <div
      className={cn("rounded-lg border border-border/50 bg-muted/30 p-2.5",className)}
      data-testid="context-usage-details"
    >
      <div className="flex items-center justify-between gap-3 text-xs">
        <span className="text-muted-foreground">Context remaining</span>
        <span className="font-medium tabular-nums">{percent}%</span>
      </div>
      <p className="mt-1 text-[11px] text-foreground/80 tabular-nums">
        {numberFormatter.format(usage.used_tokens)} of{" "}
        {numberFormatter.format(usage.compaction_threshold)} tokens used
      </p>
      <p className="mt-1 text-[10px] leading-relaxed text-muted-foreground">
        Older conversation history is compacted automatically at this threshold.
      </p>
    </div>
  );
}
