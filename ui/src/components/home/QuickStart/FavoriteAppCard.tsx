"use client";

import { ArrowUpRight } from "lucide-react";
import { AppIcon } from "@/components/shared/AppIcon";
import { AgenticAppIcon } from "@/components/shared/AgenticAppIcon";
import { NavigationProgressLink } from "@/components/layout/NavigationProgressLink";
import { Button } from "@/components/ui/button";
import type { PublicAgenticApp } from "@/types/agentic-app";

export function FavoriteAppCard({ app }: { app: PublicAgenticApp }): React.ReactElement {
  const LaunchLink = app.uiMode === "native-package" ? NavigationProgressLink : "a";

  return (
    <article className="home-quick-start-card flex min-h-44 flex-col rounded-lg border border-border/50 bg-card/50 p-4 [@media(max-height:800px)]:min-h-40 [@media(max-height:800px)]:p-3">
      <div className="flex items-center gap-2.5">
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-gradient-to-br from-cyan-500 to-violet-500 text-white">
          {app.icon ? <AppIcon appId={app.appId} icon={app.icon} className="h-[18px] w-[18px] object-contain" /> : <AgenticAppIcon className="h-[18px] w-[18px]" aria-hidden />}
        </span>
        <h4 className="line-clamp-2 text-sm font-semibold text-foreground">{app.displayName}</h4>
      </div>
      <p className="mt-2.5 line-clamp-3 flex-1 text-xs leading-relaxed text-muted-foreground">{app.description}</p>
      <div className="mt-3 flex justify-end">
        <Button asChild size="sm" variant="outline">
          <LaunchLink href={app.href} aria-label={`Open ${app.displayName}`}>
            Open app <ArrowUpRight className="ml-1 h-3.5 w-3.5" aria-hidden />
          </LaunchLink>
        </Button>
      </div>
    </article>
  );
}
