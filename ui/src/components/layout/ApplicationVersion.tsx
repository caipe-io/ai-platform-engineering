"use client";

import { GitCommitHorizontal } from "lucide-react";

import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { useVersion } from "@/hooks/use-version";
import { formatBuildIdentifier } from "@/lib/build-identifier";
import { cn } from "@/lib/utils";

export function ApplicationVersion({
  collapsed = false,
}: {
  collapsed?: boolean;
}): React.ReactElement {
  const { versionInfo,isLoading } = useVersion();
  const version = formatBuildIdentifier({
    version: versionInfo?.version,
    packageVersion: versionInfo?.packageVersion,
    gitCommit: versionInfo?.gitCommit,
  });

  return <BuildIdentifier collapsed={collapsed} isLoading={isLoading} version={version} />;
}

function BuildIdentifier({
  collapsed,
  isLoading,
  version,
}: {
  collapsed: boolean;
  isLoading: boolean;
  version: string | null;
}): React.ReactElement {
  const versionLabel = version ? `Version: ${version}` : "Version: Development";
  const label = isLoading ? "Version: Loading" : versionLabel;
  const content = (
    <div
      aria-label={label}
      className={cn(
        "flex min-w-0 items-center gap-2 rounded-md text-xs text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        collapsed ? "h-8 w-8 justify-center" : "px-1 py-1.5",
      )}
      data-testid="application-version"
      tabIndex={collapsed ? 0 : undefined}
    >
      <GitCommitHorizontal aria-hidden="true" className="h-3.5 w-3.5 shrink-0" />
      {!collapsed ? (
        <span className="truncate font-medium">{label}</span>
      ) : null}
    </div>
  );

  if (!collapsed) return content;

  return (
    <TooltipProvider delayDuration={500}>
      <Tooltip>
        <TooltipTrigger asChild>{content}</TooltipTrigger>
        <TooltipContent side="right" sideOffset={8}>{label}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
