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
      <h3 className="text-sm font-semibold">Claude (ACP)</h3>
      <Badge variant="outline">Experimental</Badge>
    </div>
    <p className="text-sm text-muted-foreground">Use Claude in this app with your organization&apos;s model access. Responses continue when you refresh or reconnect.</p>
    {profile?.description && <p className="text-sm">{profile.description}</p>}
    <dl className="grid gap-3 text-xs sm:grid-cols-3">
      <div><dt className="flex items-center gap-1.5 font-medium"><Radio className="h-3.5 w-3.5" aria-hidden="true" />Session</dt><dd className="mt-1 text-muted-foreground">Saved with this conversation</dd></div>
      <div><dt className="flex items-center gap-1.5 font-medium"><Folder className="h-3.5 w-3.5" aria-hidden="true" />Workspace</dt><dd className="mt-1 text-muted-foreground">Stored on the configured worker</dd></div>
      <div><dt className="flex items-center gap-1.5 font-medium"><ShieldCheck className="h-3.5 w-3.5" aria-hidden="true" />MCP tools</dt><dd className="mt-1 text-muted-foreground">{toolsAvailable ? "Choose individual tools in the Tools step" : "Not enabled for this worker"}</dd></div>
    </dl>
    <details className="text-xs text-muted-foreground">
      <summary className="cursor-pointer font-medium text-foreground">Access and authentication</summary>
      <p className="mt-2">Your app sign-in and the agent&apos;s sharing rules apply. Tool access is checked for every call. Your administrator configures model access and workspace tools.</p>
      <p className="mt-2">Refresh recovery does not recover an in-flight process after a worker failure. Continuing a session after replacement requires its saved workspace.</p>
    </details>
  </section>;
}
