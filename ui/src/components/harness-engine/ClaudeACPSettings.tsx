"use client";

import { Badge } from "@/components/ui/badge";
import { ShieldCheck, Folder, Radio } from "lucide-react";
import type { HarnessDescriptor } from "@/types/harness-engine";

export function ClaudeACPSettings({ descriptor, profileId }: { descriptor: HarnessDescriptor; profileId: string }) {
  const profile = descriptor.profiles.find(item => item.id === profileId);
  const broker = descriptor.capabilities["tools.broker"]?.level;
  const toolsAvailable = broker === "native" || broker === "emulated";
  return <section aria-label="Claude configuration" className="rounded-lg border border-orange-500/25 bg-orange-500/5 p-4 space-y-3">
    <div className="flex flex-wrap items-center gap-2">
      <h3 className="text-sm font-semibold">{descriptor.display_name}</h3>
      <Badge variant="outline">Experimental</Badge>
    </div>
    <p className="text-sm text-muted-foreground">Run Claude with your organization&apos;s model access. Refreshing or reconnecting won&apos;t stop a running response.</p>
    {profile?.description && <p className="text-sm">{profile.description}</p>}
    <dl className="grid gap-3 text-xs sm:grid-cols-3">
      <div><dt className="flex items-center gap-1.5 font-medium"><Radio className="h-3.5 w-3.5" aria-hidden="true" />Session</dt><dd className="mt-1 text-muted-foreground">Saved with this conversation</dd></div>
      <div><dt className="flex items-center gap-1.5 font-medium"><Folder className="h-3.5 w-3.5" aria-hidden="true" />Workspace</dt><dd className="mt-1 text-muted-foreground">Files stay on the server</dd></div>
      <div><dt className="flex items-center gap-1.5 font-medium"><ShieldCheck className="h-3.5 w-3.5" aria-hidden="true" />MCP tools</dt><dd className="mt-1 text-muted-foreground">{toolsAvailable ? "Choose tools in the Tools step" : "Not available with this profile"}</dd></div>
    </dl>
    <details className="text-xs text-muted-foreground">
      <summary className="cursor-pointer font-medium text-foreground">Access and recovery</summary>
      <p className="mt-2">Your sign-in and sharing permissions apply. Each tool call is checked against your access.</p>
      <p className="mt-2">If the worker stops, the current response is interrupted. Continuing the session requires its saved workspace.</p>
      <p className="mt-2">Profile changes apply to new chats. Existing chats keep their saved settings.</p>
    </details>
  </section>;
}
