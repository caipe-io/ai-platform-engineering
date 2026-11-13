"use client";

import type { ReactNode } from "react";
import { getGradientStyle } from "@/lib/gradient-themes";
import { resolveAgentTheme, type AgentAvatarAgent } from "./AgentAvatar";

export function AgentCatalogCard({ name, ariaLabel, agent, identity, subtitle, children, footer, onActivate, activationDisabled = false }: {
  name: string; ariaLabel?: string; agent?: AgentAvatarAgent; identity: ReactNode; subtitle?: ReactNode; children: ReactNode; footer: ReactNode; onActivate?: (trigger: HTMLButtonElement) => void; activationDisabled?: boolean;
}) {
  const { theme, custom } = resolveAgentTheme(agent);
  return <article aria-label={ariaLabel || name} className="relative isolate flex min-w-0 flex-col overflow-hidden rounded-xl border bg-card transition-colors hover:border-primary/40">
    {onActivate && <button type="button" aria-label={`Open ${name}`} disabled={activationDisabled} onClick={event => onActivate(event.currentTarget)} className="absolute inset-0 z-10 cursor-pointer rounded-xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring disabled:cursor-wait" />}
    <header className="relative isolate flex items-start gap-2.5 border-b p-3">
      <div aria-hidden="true" className="pointer-events-none absolute inset-0 -z-10 opacity-[0.08] dark:opacity-[0.12]" style={getGradientStyle(theme, custom)} />
      {identity}<div className="min-w-0 flex-1"><h2 className="text-sm font-semibold [overflow-wrap:anywhere]">{name}</h2>{subtitle && <div className="mt-1 text-xs text-muted-foreground">{subtitle}</div>}</div>
    </header>
    <div className="flex flex-1 flex-col min-w-0 gap-2 p-3 text-sm [overflow-wrap:anywhere] [&_button]:relative [&_button]:z-20 [&_button:disabled]:pointer-events-auto [&_a]:relative [&_a]:z-20">{children}<div className="mt-auto flex flex-wrap items-center justify-between gap-2 pt-1">{footer}</div></div>
  </article>;
}
