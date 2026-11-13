"use client";

import { getConfig } from "@/lib/config";
import { cn } from "@/lib/utils";
import { Activity, Bot, CalendarClock, Cloud, Network, Route, ShieldCheck, Sparkles, Waypoints } from "lucide-react";
import { useState } from "react";
import { siKeycloak, siOpentelemetry, siMongodb, siPostgresql, siRedis, siMilvus, siMinio, siEtcd, type SimpleIcon } from "simple-icons";

const PLATFORM_COMPONENT_MARKS: Record<string, { icon: typeof Activity; className: string; logo?: SimpleIcon; logoUrl?: string }> = {
  "caipe-mongodb": { icon: Cloud, className: "text-emerald-500", logo: siMongodb },
  "keycloak-postgres": { icon: Cloud, className: "text-blue-400", logo: siPostgresql },
  "openfga-postgres": { icon: Cloud, className: "text-blue-400", logo: siPostgresql },
  "rag-redis": { icon: Cloud, className: "text-red-400", logo: siRedis },
  milvus: { icon: Cloud, className: "text-cyan-400", logo: siMilvus },
  "milvus-minio": { icon: Cloud, className: "text-red-400", logo: siMinio },
  etcd: { icon: Cloud, className: "text-blue-400", logo: siEtcd },
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

export function PlatformServiceLogo({ id, label, disabled = false }: { id: string; label: string; disabled?: boolean }) {
  const brandId = ({ "keycloak-bootstrap": "keycloak", "openfga-bootstrap": "openfga", "openfga-authz-bridge": "openfga", "agentgateway-config-bridge": "agentgateway" } as Record<string, string>)[id] ?? id;
  const mark = PLATFORM_COMPONENT_MARKS[brandId] ?? { icon: Cloud, className: "text-muted-foreground" };
  const Icon = mark.icon;
  const [logoFailed, setLogoFailed] = useState(false);
  const usesCaipeLogo = ["caipe-ui", "caipe-agent-harness", "scheduler", "autonomous-agents", "audit-service", "rag-server", "web-ingestor", "rebac-migrations"].includes(id);
  return (
    <span className={cn("grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-muted", mark.className, disabled && "grayscale opacity-60")} aria-hidden="true">
      {logoFailed ? <Icon className="h-6 w-6" /> : usesCaipeLogo ? (
        // The configured logo can be deployment-provided.
        // eslint-disable-next-line @next/next/no-img-element
        <img src={getConfig("logoUrl")} alt="" className="h-8 w-8 object-contain" onError={() => setLogoFailed(true)} />
      ) : mark.logo ? (
        <svg viewBox="0 0 24 24" className="h-6 w-6"><path d={mark.logo.path} fill="currentColor" /></svg>
      ) : mark.logoUrl ? (
        // Upstream service marks are optional presentation assets.
        // eslint-disable-next-line @next/next/no-img-element
        <img src={mark.logoUrl} alt={`${label} logo`} className="h-8 w-8 rounded object-contain" onError={() => setLogoFailed(true)} />
      ) : <Icon className="h-6 w-6" />}
    </span>
  );
}
