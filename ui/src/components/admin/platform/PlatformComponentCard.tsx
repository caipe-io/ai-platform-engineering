"use client";

import { getConfig } from "@/lib/config";
import { cn } from "@/lib/utils";
import type { PlatformHealthComponent } from "@/hooks/use-platform-health-probes";
import { Activity, Bot, CalendarClock, Cloud, ExternalLink, Network, Route, ShieldCheck, Sparkles, Waypoints } from "lucide-react";
import { useState } from "react";
import { siKeycloak, siOpentelemetry, type SimpleIcon } from "simple-icons";

const PLATFORM_COMPONENT_MARKS: Record<string, { icon: typeof Activity; className: string; logo?: SimpleIcon; logoUrl?: string }> = {
  "caipe-ui": { icon: Sparkles, className: "from-cyan-500/30 to-violet-500/30 text-cyan-300" },
  keycloak: { icon: ShieldCheck, className: "from-blue-500/30 to-indigo-500/30 text-blue-300", logo: siKeycloak },
  openfga: { icon: Network, className: "from-amber-500/30 to-orange-500/30 text-amber-300", logoUrl: "https://raw.githubusercontent.com/openfga/openfga/main/openfga-logo.png" },
  "caipe-agent-harness": { icon: Bot, className: "from-emerald-500/30 to-teal-500/30 text-emerald-300" },
  scheduler: { icon: CalendarClock, className: "from-cyan-500/30 to-blue-500/30 text-cyan-300" },
  "autonomous-agents": { icon: Bot, className: "from-emerald-500/30 to-lime-500/30 text-emerald-300" },
  agentgateway: { icon: Route, className: "from-fuchsia-500/30 to-pink-500/30 text-fuchsia-300", logoUrl: "https://raw.githubusercontent.com/agentgateway/agentgateway/main/ui/public/agw-mark-color.svg" },
  "otel-tracing": { icon: Activity, className: "from-sky-500/30 to-cyan-500/30 text-sky-300", logo: siOpentelemetry },
  litellm: { icon: Waypoints, className: "from-violet-500/30 to-purple-500/30 text-violet-300", logoUrl: "https://raw.githubusercontent.com/BerriAI/litellm/main/litellm/proxy/_experimental/out/assets/logos/litellm_logo.jpg" },
};

export function PlatformComponentCard({
  component,
  delay = 0,
}: {
  component: PlatformHealthComponent;
  delay?: number;
}) {
  const mark = PLATFORM_COMPONENT_MARKS[component.id] ?? { icon: Cloud, className: "from-slate-500/30 to-slate-700/30 text-slate-300" };
  const Icon = mark.icon;
  const [logoFailed, setLogoFailed] = useState(false);
  const healthy = component.status === "healthy";
  const disabled = component.status === "disabled";
  const usesCaipeLogo = ["caipe-ui", "caipe-agent-harness", "scheduler", "autonomous-agents"].includes(component.id);
  const enableGuide = component.id === "scheduler"
    ? "https://caipe.io/docs/architecture/scheduler/#enable-the-scheduler"
    : component.id === "autonomous-agents"
      ? "https://caipe.io/docs/architecture/autonomous-agents/"
      : "https://caipe.io/docs/";
  return (
    <div className={cn("flex items-center gap-3 rounded-xl border bg-card/60 p-4", disabled && "opacity-60 grayscale")} style={{ animationDelay: `${delay}ms` }}>
      <span className={cn("relative grid h-12 w-12 shrink-0 place-items-center rounded-xl bg-muted", mark.className)} aria-hidden="true">
        {logoFailed ? <Icon className="h-6 w-6" /> : usesCaipeLogo ? (
          // The configured logo may be deployment-provided and is intentionally not optimized.
          // eslint-disable-next-line @next/next/no-img-element
          <img src={getConfig("logoUrl")} alt="" className="h-10 w-10 object-contain" onError={() => setLogoFailed(true)} />
        ) : mark.logo ? (
          <svg viewBox="0 0 24 24" className="h-7 w-7" role="img" aria-label={`${component.label} logo`}>
            <path d={mark.logo.path} fill="currentColor" />
          </svg>
        ) : mark.logoUrl ? (
          // These upstream service marks are optional presentation assets.
          // eslint-disable-next-line @next/next/no-img-element
          <img src={mark.logoUrl} alt={`${component.label} logo`} className="h-9 w-9 rounded object-contain" onError={() => setLogoFailed(true)} />
        ) : (
          <Icon className="h-5 w-5" />
        )}
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex items-center justify-between gap-2">
          <span className="break-words text-sm font-medium">{component.label}</span>
          <span className={cn("h-2 w-2 shrink-0 rounded-full", healthy ? "bg-emerald-500" : disabled ? "bg-slate-500" : component.status === "down" ? "bg-red-500" : "bg-amber-500")} aria-label={disabled ? "Not enabled" : component.status} role="img" />
        </span>
        <span className="mt-1 block break-words text-xs text-muted-foreground" title={component.detail}>{component.detail}</span>
        {disabled && <details className="mt-1 text-[11px]"><summary className="cursor-pointer">How to enable</summary><p className="mt-1 leading-relaxed">{component.detail}</p><a className="mt-1 inline-flex items-center gap-1 underline" href={enableGuide} target="_blank" rel="noreferrer">Deployment guide<ExternalLink className="h-3 w-3" /></a></details>}
      </span>
    </div>
  );
}
