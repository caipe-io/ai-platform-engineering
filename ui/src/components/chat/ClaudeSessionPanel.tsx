"use client";

import { Folder, Radio, ShieldCheck } from "lucide-react";

export function ClaudeSessionPanel({ activity, readOnly }: {
  activity: "checking" | "running" | "saving" | "idle" | "stopping";
  readOnly: boolean;
}) {
  const label = { checking: "Reconnecting", running: "Working", saving: "Saving response", idle: "Ready", stopping: "Stopping" }[activity];
  return <details className="mx-3 my-2 shrink-0 rounded-lg border border-orange-500/20 bg-orange-500/5 px-3 py-2 text-xs" aria-label="Claude session">
    <summary className="flex cursor-pointer flex-wrap items-center gap-2">
      <Radio className="h-3.5 w-3.5 text-orange-500" aria-hidden="true" />
      <span className="font-medium">Claude (ACP)</span>
      <span role="status" aria-live="polite" className="text-muted-foreground">{label}</span>
      {readOnly && <span className="text-muted-foreground">Viewing shared session</span>}
      <span className="ml-auto text-muted-foreground">Session details</span>
    </summary>
    <div className="mt-3 grid gap-3 text-muted-foreground sm:grid-cols-2">
      <p className="flex gap-2"><Folder className="h-4 w-4 shrink-0" aria-hidden="true" />This conversation keeps its Claude session. Refreshing or closing this page does not stop a response.</p>
      <p className="flex gap-2"><ShieldCheck className="h-4 w-4 shrink-0" aria-hidden="true" />{readOnly ? "You can follow this response. Sending messages or stopping work requires additional access." : "Your agent and tool permissions apply to each request. Model access is managed by your administrator."}</p>
    </div>
  </details>;
}
