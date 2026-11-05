"use client";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { sandboxPortalUrl } from "@/lib/harness-sandbox";
import { ExternalLink, ShieldCheck, Folder, Radio } from "lucide-react";
import { useState } from "react";
import type { HarnessDescriptor } from "@/types/harness-engine";

export function ClaudeSandboxSetup({ portalUrl, onRefresh }: {
  portalUrl?: unknown;
  onRefresh?: () => Promise<number>;
}) {
  const url = sandboxPortalUrl(portalUrl);
  const [refreshing, setRefreshing] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  async function refresh() {
    setRefreshing(true);
    setNotice(null);
    try {
      const count = await onRefresh?.();
      setNotice(count ? "Connections refreshed. Select your registered sandbox profile under Claude (ACP)." : "No sandbox connection is registered for your account yet. Ask your platform administrator to register the reference shown in the sandbox application.");
    } catch {
      setNotice("Connections could not be refreshed. Try again or contact your platform administrator.");
    } finally {
      setRefreshing(false);
    }
  }
  return <div className="space-y-3 text-xs text-muted-foreground">
    <ol className="list-decimal space-y-2 pl-5">
      <li>{url ? <a href={url} target="_blank" rel="noopener noreferrer" className="text-primary underline">Open the sandbox application</a> : "Open your organization's sandbox application"} and create a sandbox from an approved Claude Code profile. Open its <strong>CAIPE connection</strong> details to get the reference.</li>
      <li>In this PoC, your platform administrator completes the approved model setup and registers that reference for your CAIPE account. Creating the sandbox alone does not connect it. Wait until the sandbox is running before using it.</li>
      <li>Refresh connections here, choose <strong>Claude (ACP)</strong> and your sandbox profile, then add the agent&apos;s instructions and selected MCP tools. Save and start a new conversation.</li>
    </ol>
    <p>One sandbox is reserved for one owner and conversation. Use the sandbox application to view its profile and policies, inspect files, suspend, resume or delete it. Platform administrators manage the approved filesystem/network controls. A policy or placement change needs an approved connection revision; it does not silently move an existing conversation.</p>
    {onRefresh && <Button type="button" variant="outline" size="sm" disabled={refreshing} onClick={() => void refresh()}>{refreshing ? "Refreshing connections…" : "Refresh sandbox connections"}</Button>}
    {notice && <p role="status">{notice}</p>}
  </div>;
}

export function ClaudeACPSettings({ descriptor, profileId, onRefresh }: {
  descriptor: HarnessDescriptor;
  profileId: string;
  onRefresh?: () => Promise<number>;
}) {
  const profile = descriptor.profiles.find(item => item.id === profileId);
  const sandbox = profile?.sandbox;
  const manageUrl = sandboxPortalUrl(sandbox?.portal_url);
  const broker = descriptor.capabilities["tools.broker"]?.level;
  const toolsAvailable = broker === "native" || broker === "emulated";
  return <section aria-label="Claude configuration" className="rounded-lg border border-orange-500/25 bg-orange-500/5 p-4 space-y-3">
    <div className="flex flex-wrap items-center gap-2">
      <h3 className="text-sm font-semibold">{descriptor.display_name}</h3>
      <Badge variant="outline">Experimental</Badge>
    </div>
    <p className="text-sm text-muted-foreground">Use Claude in this app with your organization&apos;s model access. Responses continue when you refresh or reconnect.</p>
    <p className="text-xs text-muted-foreground">{descriptor.id === "claude_code_cli_acp" ? "Runs the Claude Code CLI directly over ACP." : "Runs the Claude Agent SDK through its ACP adapter."} Existing conversations keep their saved runtime.</p>
    {profile?.description && <p className="text-sm">{profile.description}</p>}
    {sandbox && <section className="space-y-2 rounded-md border bg-background/60 p-3" aria-label="Sandbox connection">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm font-medium break-words">{sandbox.display_name}</p>
        <Badge variant="outline">Configured</Badge>
      </div>
      <p className="text-xs text-muted-foreground">Your private sandbox connection is checked when execution starts. It belongs to your account and one conversation; sharing the agent or chat does not share its shell.</p>
      <p className="text-xs break-words">{sandbox.policy_summary}</p>
      <p className="text-xs text-muted-foreground break-all">Profile revision: {sandbox.policy_revision}</p>
      {manageUrl && <Button asChild variant="outline" size="sm"><a href={manageUrl} target="_blank" rel="noopener noreferrer">Manage sandbox <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" /></a></Button>}
    </section>}
    <dl className="grid gap-3 text-xs sm:grid-cols-3">
      <div><dt className="flex items-center gap-1.5 font-medium"><Radio className="h-3.5 w-3.5" aria-hidden="true" />Session</dt><dd className="mt-1 text-muted-foreground">Saved with this conversation</dd></div>
      <div><dt className="flex items-center gap-1.5 font-medium"><Folder className="h-3.5 w-3.5" aria-hidden="true" />Workspace</dt><dd className="mt-1 text-muted-foreground">{sandbox ? "Private persistent sandbox files" : "Stored on the configured worker"}</dd></div>
      <div><dt className="flex items-center gap-1.5 font-medium"><ShieldCheck className="h-3.5 w-3.5" aria-hidden="true" />MCP tools</dt><dd className="mt-1 text-muted-foreground">{toolsAvailable ? "Choose individual tools in the Tools step" : "Not enabled for this worker"}</dd></div>
    </dl>
    <details className="text-xs" open={!profile || undefined}>
      <summary className="cursor-pointer font-medium">Set up a sandboxed Claude agent</summary>
      <div className="mt-3"><ClaudeSandboxSetup portalUrl={descriptor.ui_schema.sandbox_portal_url ?? sandbox?.portal_url} onRefresh={onRefresh} /></div>
    </details>
    <details className="text-xs text-muted-foreground">
      <summary className="cursor-pointer font-medium text-foreground">Access and authentication</summary>
      <p className="mt-2">Your app sign-in and the agent&apos;s sharing rules apply. Tool access is checked for every call. Your administrator configures model access and workspace tools.</p>
      <p className="mt-2">Refresh recovery does not recover an in-flight process after a worker failure. Continuing a session after replacement requires its saved workspace.</p>
      {sandbox && <p className="mt-2">The profile controls permitted shell tools and the environment&apos;s filesystem/network policy. Agent instructions and MCP permissions cannot expand those controls. Deleting this chat does not delete the sandbox or its files.</p>}
    </details>
  </section>;
}
