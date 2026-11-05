"use client";

import { ArrowUpRight, CloudSun, DollarSign, Info, ShieldCheck, Star } from "lucide-react";
import { AppIcon } from "@/components/shared/AppIcon";
import { AgenticAppIcon } from "@/components/shared/AgenticAppIcon";
import { NavigationProgressLink } from "@/components/layout/NavigationProgressLink";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { catalogPresentation } from "@/lib/agentic-apps/catalog-presentation";
import type { PublicAgenticApp } from "@/types/agentic-app";

interface Props {
  app: PublicAgenticApp;
  isFavorite?: boolean;
  favoritePending?: boolean;
  onToggleFavorite?: () => void;
}

/** The card uses public metadata only; launch and preference controls remain separate. */
export function AgenticAppCard({ app, isFavorite = false, favoritePending = false, onToggleFavorite }: Props): React.ReactElement {
  const presentation = catalogPresentation(app.categories[0]);
  const LaunchLink = app.uiMode === "native-package" ? NavigationProgressLink : "a";
  const FallbackIcon = presentation.icon === "weather" ? CloudSun
    : presentation.icon === "finance" ? DollarSign : AgenticAppIcon;

  return (
    <article className="group relative flex min-h-64 flex-col overflow-hidden rounded-[1.35rem] border border-border bg-card p-4 shadow-md transition duration-200 hover:-translate-y-1 hover:border-primary/30 hover:bg-accent/40">
      <div aria-hidden className={`pointer-events-none absolute -right-20 -top-24 h-48 w-48 rounded-full bg-gradient-to-br ${presentation.glow} opacity-80 blur-3xl transition group-hover:opacity-100`} />
      <div className="relative flex items-start justify-between gap-3">
        <span aria-label={`${app.displayName} app icon`} className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl border border-border/60 bg-gradient-to-br ${presentation.tile} text-white shadow-md`}>
          {app.icon ? <AppIcon appId={app.appId} icon={app.icon} className="h-5 w-5 object-contain" /> : <FallbackIcon className="h-5 w-5" aria-hidden />}
        </span>
        <div className="relative z-10 flex items-center gap-1.5">
          {onToggleFavorite ? (
            <button type="button" aria-label={`${isFavorite ? "Remove" : "Add"} ${app.displayName} ${isFavorite ? "from" : "to"} favorites`}
              aria-pressed={isFavorite} disabled={favoritePending} onClick={onToggleFavorite}
              className={`inline-flex h-8 w-8 items-center justify-center rounded-full border transition disabled:opacity-50 ${isFavorite
                ? "border-amber-500 bg-amber-400 text-amber-950"
                : "border-border bg-muted/40 text-muted-foreground hover:border-amber-400/40 hover:bg-amber-400/10 hover:text-amber-500"}`}>
              <Star className="h-3.5 w-3.5" fill={isFavorite ? "currentColor" : "none"} aria-hidden />
            </button>
          ) : null}
          <TooltipProvider>
            <Tooltip>
              <TooltipTrigger asChild>
                <button type="button" aria-label={`Rendering details for ${app.displayName}`} className="inline-flex h-8 w-8 items-center justify-center rounded-full border border-border bg-muted/40 text-muted-foreground hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
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
          {app.canLaunch ? (
            <span aria-hidden className="inline-flex h-8 w-8 items-center justify-center rounded-full border border-border bg-muted/40 text-primary"><ArrowUpRight className="h-3.5 w-3.5" /></span>
          ) : (
            <span aria-label={`${app.displayName} launch blocked`} className="inline-flex h-8 w-8 items-center justify-center rounded-full border border-amber-500/40 bg-amber-400/20 text-amber-600"><ShieldCheck className="h-3.5 w-3.5" aria-hidden /></span>
          )}
        </div>
      </div>

      {app.categories[0] ? <span className={`relative mt-4 w-fit rounded-full px-2.5 py-1 text-[10px] font-semibold uppercase tracking-[0.18em] ${presentation.badge}`}>{app.categories[0]}</span> : null}
      <h2 className="mt-3 line-clamp-1 text-lg font-semibold text-foreground">
        {app.canLaunch ? (
          <LaunchLink href={app.href} className="after:absolute after:inset-0 after:z-[5] after:rounded-[1.35rem] focus-visible:outline-none after:focus-visible:ring-2 after:focus-visible:ring-primary/60">
            {app.displayName}
          </LaunchLink>
        ) : app.displayName}
      </h2>
      <p className="relative mt-2 line-clamp-3 flex-1 text-xs leading-5 text-muted-foreground">{app.description}</p>
      {!app.canLaunch ? <p className="relative mt-3 rounded-xl border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-600">
        Access required{app.blockedReasons.length ? `: ${app.blockedReasons.join(", ").replaceAll("_", " ")}` : ""}
      </p> : null}
    </article>
  );
}
