"use client";

import { Folder, Loader2, Radio, ShieldCheck } from "lucide-react";
import { useId, useState } from "react";

import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";

export function ClaudeSessionPanel({ activity, readOnly }: {
  activity: "checking" | "running" | "saving" | "idle" | "stopping";
  readOnly: boolean;
}) {
  const [open, setOpen] = useState(false);
  const detailsId = useId();
  const label = { checking: "Reconnecting", running: "Working", saving: "Saving response", idle: "Ready", stopping: "Stopping" }[activity];
  return (
    <Popover open={open} onOpenChange={setOpen} className="shrink-0">
      <PopoverTrigger asChild>
        <Button type="button" variant="ghost" size="sm" className="h-8 gap-1.5 px-2 text-xs text-muted-foreground"
          aria-label={`Claude session: ${label}`} aria-expanded={open} aria-controls={detailsId} title="Claude session details">
          {activity === "idle"
            ? <Radio className="h-3.5 w-3.5" aria-hidden="true" />
            : <Loader2 className="h-3.5 w-3.5 animate-spin motion-reduce:animate-none" aria-hidden="true" />}
          <span>Claude</span>
          <span role="status" aria-live="polite" className={activity === "idle" ? "sr-only" : undefined}>{label}</span>
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80 max-w-[calc(100vw-1rem)] p-4">
        <div id={detailsId} className="space-y-3">
          <div>
            <p className="text-sm font-medium">Claude session</p>
            <p className="mt-1 text-xs text-muted-foreground">Claude (ACP) · {label}{readOnly ? " · Viewing shared session" : ""}</p>
          </div>
          <p className="flex gap-2 text-xs text-muted-foreground"><Folder className="h-4 w-4 shrink-0" aria-hidden="true" />This conversation keeps its Claude session. Refreshing or closing this page does not stop a response.</p>
          <p className="flex gap-2 text-xs text-muted-foreground"><ShieldCheck className="h-4 w-4 shrink-0" aria-hidden="true" />{readOnly ? "You can follow this response. Sending messages or stopping work requires additional access." : "Your agent and tool permissions apply to each request. Model access is managed by your administrator."}</p>
        </div>
      </PopoverContent>
    </Popover>
  );
}
