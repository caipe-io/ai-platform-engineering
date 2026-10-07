"use client";

import { CircleHelp } from "lucide-react";

import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  EVERYONE_TEAM_SLUG,
  SUPER_ADMINS_TEAM_SLUG,
} from "@/lib/rbac/reserved-teams";
import { cn } from "@/lib/utils";

const BUILT_IN_TEAM_HELP: Record<string, string> = {
  [EVERYONE_TEAM_SLUG]: "Built-in team for organization-wide access.",
  [SUPER_ADMINS_TEAM_SLUG]: "Built-in team for platform administrators.",
};

export function builtInTeamHelpText(
  slug: string | null | undefined,
): string | null {
  return slug ? (BUILT_IN_TEAM_HELP[slug.trim().toLowerCase()] ?? null) : null;
}

export function BuiltInResourceHint({
  text,
  className,
  focusable = true,
}: {
  text: string;
  className?: string;
  focusable?: boolean;
}) {
  return (
    <TooltipProvider delayDuration={150}>
      <Tooltip>
        <TooltipTrigger asChild>
          <span
            role="img"
            aria-label={text}
            tabIndex={focusable ? 0 : undefined}
            className={cn(
              "inline-flex shrink-0 items-center rounded-sm text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring",
              className,
            )}
          >
            <CircleHelp className="h-3.5 w-3.5" aria-hidden="true" />
          </span>
        </TooltipTrigger>
        <TooltipContent className="max-w-64 overflow-hidden whitespace-normal break-words text-left">
          {text}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
