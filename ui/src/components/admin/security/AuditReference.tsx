import { badgeVariants } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

const REFERENCES = {
  principal: { label: "Principal", colour: "border-violet-500/50 bg-violet-500/15 font-semibold" },
  resource: { label: "Resource", colour: "border-cyan-500/40 bg-cyan-500/10" },
  action: { label: "Action / relation", colour: "border-border bg-muted/50" },
  workload: { label: "Requesting workload", colour: "border-border bg-muted/30" },
};

export type AuditReferenceKind = keyof typeof REFERENCES;

/** Colour identifies the field's role, never its permission outcome or entity type. */
export function AuditReference({ kind, value }: { kind: AuditReferenceKind; value: string }) {
  const reference = REFERENCES[kind];
  return (
    <span aria-label={`${reference.label}: ${value}`} title={`${reference.label}: ${value}`}
      className={cn(badgeVariants({ variant: "outline" }), "max-w-full rounded px-1.5 font-mono font-normal break-all text-foreground", reference.colour)}>
      {value}
    </span>
  );
}
