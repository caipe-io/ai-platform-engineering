"use client";

import type { CSSProperties } from "react";
import { NavigationProgressLink } from "@/components/layout/NavigationProgressLink";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { QuickStartCard as QuickStartCardData } from "./quickStartCards";

interface QuickStartCardProps {
  card: QuickStartCardData;
}

export function QuickStartCard({ card }: QuickStartCardProps) {
  const Icon = card.icon;

  return (
    <div
      data-testid={`quick-start-card-${card.id}`}
      className="home-quick-start-card flex min-h-44 flex-col rounded-lg border border-border/50 bg-card/50 p-4 [@media(max-height:800px)]:min-h-40 [@media(max-height:800px)]:p-3"
      style={{ "--quick-start-accent": card.accentColor } as CSSProperties}
    >
      <div className="flex items-center gap-2.5 [@media(max-height:800px)]:gap-2">
        <div
          data-testid={`quick-start-icon-${card.id}`}
          className={cn(
            "flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-gradient-to-br text-white shadow-sm [@media(max-height:800px)]:h-8 [@media(max-height:800px)]:w-8",
            card.iconClassName,
          )}
        >
          <Icon className="h-[18px] w-[18px]" />
        </div>
        <h3 className="text-sm font-semibold text-foreground">{card.title}</h3>
      </div>
      <p className="mt-2.5 flex-1 text-xs leading-relaxed text-muted-foreground [@media(max-height:800px)]:mt-2">
        {card.description}
      </p>
      <div className="mt-3 flex justify-end [@media(max-height:800px)]:mt-2">
        <Button asChild size="sm" variant="outline">
          <NavigationProgressLink href={card.href} data-testid={`quick-start-cta-${card.id}`}>
            {card.ctaLabel}
          </NavigationProgressLink>
        </Button>
      </div>
    </div>
  );
}
