"use client";

import { ArrowUpRight, CloudSun, DollarSign, Info, LayoutGrid, Sparkles } from "lucide-react";
import { NavigationProgressLink } from "@/components/layout/NavigationProgressLink";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import type { PublicAgenticApp } from "@/types/agentic-app";

const icons = { "layout-grid": LayoutGrid, "cloud-sun": CloudSun, "dollar-sign": DollarSign, sparkles: Sparkles };

/** Presentation consumes browser-safe catalog metadata, never runtime origins. */
export function AgenticAppCard({ app }: { app: PublicAgenticApp }): React.ReactElement {
  const Icon = icons[app.icon as keyof typeof icons] ?? LayoutGrid;
  return (
    <article className="group relative flex min-h-64 flex-col overflow-hidden rounded-2xl border border-border bg-card p-5 shadow-sm transition-colors hover:border-primary/40">
      <div aria-hidden className="pointer-events-none absolute -right-16 -top-24 h-48 w-48 rounded-full bg-primary/10 blur-3xl" />
      <div className="relative flex items-start justify-between gap-3">
        <span className="rounded-xl bg-primary/15 p-3 text-primary"><Icon className="h-5 w-5" aria-hidden /></span>
        <TooltipProvider>
          <Tooltip>
            <TooltipTrigger asChild>
              <button type="button" aria-label={`Rendering details for ${app.displayName}`} className="relative z-10 rounded-full p-2 text-muted-foreground hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                <Info className="h-4 w-4" aria-hidden />
              </button>
            </TooltipTrigger>
            <TooltipContent className="max-w-72">
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
          <NavigationProgressLink href={app.href} className="after:absolute after:inset-0 after:rounded-2xl focus-visible:outline-none after:focus-visible:ring-2 after:focus-visible:ring-ring">
            {app.displayName}<ArrowUpRight className="ml-2 inline h-4 w-4" aria-hidden />
          </NavigationProgressLink>
        ) : app.displayName}
      </h2>
      <p className="mt-2 line-clamp-3 flex-1 text-sm leading-6 text-muted-foreground">{app.description}</p>
      {!app.canLaunch && <p className="mt-3 rounded-lg border border-border bg-muted px-3 py-2 text-xs text-foreground">
        Access required{app.blockedReasons.length ? `: ${app.blockedReasons.join(", ").replaceAll("_", " ")}` : ""}
      </p>}
    </article>
  );
}
