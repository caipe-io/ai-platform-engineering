"use client";

import { useId, useState, type ReactNode } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import { Button } from "@/components/ui/button";

export function AgentTeamActivity({ count, complete, grouped, children }: { count: number; complete: boolean; grouped: boolean; children: ReactNode }) {
  const id = useId();
  const [open, setOpen] = useState<boolean | null>(null);
  const expanded = open ?? !complete;
  return <section aria-label="Agent Team activity" className={grouped ? "mx-3 min-w-0 border-l-2 border-border pl-3" : "contents"}>
    {grouped && <Button type="button" variant="ghost" size="sm" className="mb-3 h-auto whitespace-normal px-0 text-xs text-muted-foreground"
      aria-expanded={expanded} aria-controls={id} onClick={() => setOpen(!expanded)}>
      {expanded ? <ChevronDown className="mr-1 h-3 w-3 shrink-0" /> : <ChevronRight className="mr-1 h-3 w-3 shrink-0" />}
      Agent Team activity · {count} agent{count === 1 ? "" : "s"}{complete ? " finished" : ""}
    </Button>}
    <div id={id} hidden={grouped && !expanded} className={grouped ? "space-y-6" : "contents"}>{children}</div>
  </section>;
}
