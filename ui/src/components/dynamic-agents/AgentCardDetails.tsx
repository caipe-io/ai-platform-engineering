import { Badge } from "@/components/ui/badge";

export function agentCardSkills(card?: Record<string, unknown>): { name: string; description?: string }[] {
  if (!Array.isArray(card?.skills)) return [];
  return card.skills.flatMap(skill => {
    if (!skill || typeof skill !== "object" || typeof skill.name !== "string") return [];
    return [{ name: skill.name, description: typeof skill.description === "string" ? skill.description : undefined }];
  });
}

/** Agent Cards are untrusted metadata: render text, never HTML or executable links. */
export function AgentCardDetails({ card }: { card: Record<string, unknown> }) {
  const skills = agentCardSkills(card);
  const capabilities = card.capabilities && typeof card.capabilities === "object" ? card.capabilities : {};
  const advertised = Object.entries(capabilities).filter(([, value]) => value === true).map(([name]) => name.replace(/([A-Z])/g, " $1").replace(/_/g, " "));
  return <div className="min-w-0 space-y-4 [overflow-wrap:anywhere]">
    <section className="space-y-2"><h3 className="text-sm font-medium">Advertised capabilities</h3>
      {advertised.length ? <div className="flex flex-wrap gap-2">{advertised.map(name => <Badge className="max-w-full whitespace-normal [overflow-wrap:anywhere]" variant="secondary" key={name}>{name}</Badge>)}</div> : <p className="text-sm text-muted-foreground">No optional capabilities advertised.</p>}
    </section>
    <section className="space-y-2"><h3 className="text-sm font-medium">Agent skills</h3>
      {skills.length ? <ul className="space-y-2">{skills.map((skill, index) => <li key={index} className="rounded-lg bg-muted/40 p-3"><p className="text-sm font-medium">{skill.name}</p>{skill.description && <p className="mt-1 whitespace-pre-wrap break-words text-sm text-muted-foreground">{skill.description}</p>}</li>)}</ul> : <p className="text-sm text-muted-foreground">No skills advertised.</p>}
    </section>
    <details className="rounded-lg border p-3"><summary className="cursor-pointer text-sm font-medium">Agent Card</summary><pre className="mt-3 max-h-64 overflow-auto whitespace-pre-wrap break-all text-xs">{JSON.stringify(card, null, 2)}</pre></details>
  </div>;
}
