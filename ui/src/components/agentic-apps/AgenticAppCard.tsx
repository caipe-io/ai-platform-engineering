"use client";

import { ArrowUpRight, Info } from "lucide-react";
import { AppIcon } from "@/components/shared/AppIcon";
import { NavigationProgressLink } from "@/components/layout/NavigationProgressLink";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import type { PublicAgenticApp } from "@/types/agentic-app";

/** Presentation consumes browser-safe catalog metadata, never runtime origins. */
export function AgenticAppCard({ app }: { app: PublicAgenticApp }): React.ReactElement {
  // Hosted URLs distinguish the host document from child-runtime traffic at
  // the gateway. Only native routes support ordinary Next.js client navigation.
  const LaunchLink = app.uiMode === "native-package" ? NavigationProgressLink : "a";
  return (
    <article className="group relative flex min-h-64 flex-col overflow-hidden rounded-2xl border border-border bg-card p-5 shadow-sm transition-colors hover:border-primary/40">
      <div aria-hidden className="pointer-events-none absolute -right-16 -top-24 h-48 w-48 rounded-full bg-primary/10 blur-3xl" />
      <div className="relative flex items-start justify-between gap-3">
        <span className="rounded-xl bg-primary/15 p-3 text-primary"><AppIcon appId={app.appId} icon={app.icon} className="h-5 w-5 object-contain" /></span>
        <TooltipProvider>
          <Tooltip>
            <TooltipTrigger asChild>
              <button type="button" aria-label={`Rendering details for ${app.displayName}`} className="relative z-10 rounded-full p-2 text-muted-foreground hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                <Info className="h-4 w-4" aria-hidden />
              </button>
            </TooltipTrigger>
            <TooltipContent side="left" className="max-w-[min(18rem,calc(100vw-2rem))] whitespace-normal break-words">
              {app.uiMode === "native-package"
                ? "Native package: renders in the CAIPE document using the host router."
                : "Hosted app: renders in a separate iframe document through the authenticated gateway."}
            </TooltipContent>
          </Tooltip>
        </TooltipProvider>
      </div>
      {app.categories[0] && <span className="mt-4 w-fit rounded-full bg-primary/15 px-2.5 py-1 text-[10px] font-semibold uppercase tracking-wider text-primary">{app.categories[0]}</span>}
      <h2 className="mt-3 text-lg font-semibold">
        {app.canLaunch ? (
          <LaunchLink href={app.href} className="after:absolute after:inset-0 after:rounded-2xl focus-visible:outline-none after:focus-visible:ring-2 after:focus-visible:ring-ring">
            {app.displayName}<ArrowUpRight className="ml-2 inline h-4 w-4" aria-hidden />
          </LaunchLink>
        ) : app.displayName}
      </h2>
      <p className="mt-2 line-clamp-3 flex-1 text-sm leading-6 text-muted-foreground">{app.description}</p>
      {!app.canLaunch && <p className="mt-3 rounded-lg border border-border bg-muted px-3 py-2 text-xs text-foreground">
        Access required{app.blockedReasons.length ? `: ${app.blockedReasons.join(", ").replaceAll("_", " ")}` : ""}
      </p>}
    </article>
  );
}
