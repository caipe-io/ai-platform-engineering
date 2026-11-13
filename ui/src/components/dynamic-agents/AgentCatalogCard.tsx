"use client";

import type { ReactNode } from "react";
import { getGradientStyle } from "@/lib/gradient-themes";
import { resolveAgentTheme, type AgentAvatarAgent } from "./AgentAvatar";

export function AgentCatalogCard({ name, ariaLabel, agent, identity, subtitle, children, footer }: {
  name: string; ariaLabel?: string; agent?: AgentAvatarAgent; identity: ReactNode; subtitle?: ReactNode; children: ReactNode; footer: ReactNode;
}) {
  const { theme, custom } = resolveAgentTheme(agent);
  return <article aria-label={ariaLabel || name} className="flex min-w-0 flex-col overflow-hidden rounded-xl border bg-card transition-colors hover:border-primary/40">
    <header className="relative isolate flex items-start gap-2.5 border-b p-3">
      <div aria-hidden="true" className="pointer-events-none absolute inset-0 -z-10 opacity-[0.08] dark:opacity-[0.12]" style={getGradientStyle(theme, custom)} />
      {identity}<div className="min-w-0 flex-1"><h2 className="text-sm font-semibold [overflow-wrap:anywhere]">{name}</h2>{subtitle && <div className="mt-1 text-xs text-muted-foreground">{subtitle}</div>}</div>
    </header>
    <div className="flex flex-1 flex-col min-w-0 gap-2 p-3 text-sm [overflow-wrap:anywhere]">{children}<div className="mt-auto flex flex-wrap items-center justify-between gap-2 pt-1">{footer}</div></div>
  </article>;
}
