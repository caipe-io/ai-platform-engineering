import Image from "next/image";
import { Badge } from "@/components/ui/badge";
import { getHarnessPresentation } from "@/lib/agent-presentation";
import { getAgentFramework, AGENT_FRAMEWORKS, type AgentFramework } from "@/lib/agent-framework";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";

export function AgentTechnologyIcon({ protocol, harnessId, framework, decorative = false }: { protocol: "a2a" | "acp"; harnessId?: string; framework?: string; decorative?: boolean }) {
  const identity = harnessId ? getHarnessPresentation(harnessId) : getAgentFramework(framework);
  return <div aria-hidden={decorative || undefined} className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl border bg-muted/30">
    {identity.logoSrc ? <Image src={identity.logoSrc} alt={identity.label} width={32} height={32} className="h-8 w-8 object-contain" />
      : <ProtocolLogo protocol={protocol} large />}
  </div>;
}

function ProtocolLogo({ protocol, large = false }: { protocol: "a2a" | "acp"; large?: boolean }) {
  return protocol === "a2a" ? <Image src="/provider-logos/a2a.svg" alt="A2A" width={large ? 32 : 20} height={large ? 32 : 20} className={`${large ? "h-8 w-8" : "h-5 w-5"} shrink-0 object-contain`} /> : <span className="inline-flex h-4 w-8 shrink-0 items-center">
    <Image src="/provider-logos/acp-light.svg" alt="ACP" width={32} height={13} className="h-auto w-8 dark:hidden" />
    <Image src="/provider-logos/acp-dark.svg" alt="ACP" width={32} height={13} className="hidden h-auto w-8 dark:block" />
  </span>;
}

export function AgentProtocolBadge({ protocol, version }: { protocol: "a2a" | "acp"; version?: string }) {
  return <Badge variant="outline" className="gap-1.5 font-medium"><span aria-hidden="true"><ProtocolLogo protocol={protocol} /></span>{protocol.toUpperCase()}{version ? ` ${version}` : ""}</Badge>;
}

export function AgentFrameworkField({ id, value, onChange, disabled }: { id: string; value?: string; onChange: (value: AgentFramework) => void; disabled?: boolean }) {
  return <div className="space-y-1"><Label htmlFor={id}>Framework</Label><Select id={id} value={value || "unspecified"} disabled={disabled} onChange={event => onChange(event.target.value as AgentFramework)}>
    {Object.entries(AGENT_FRAMEWORKS).map(([key, identity]) => <option key={key} value={key}>{identity.label}</option>)}
  </Select><p className="text-xs text-muted-foreground">Display label only. Does not change the remote runtime.</p></div>;
}
