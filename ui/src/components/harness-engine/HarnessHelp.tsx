"use client";

import { Badge } from "@/components/ui/badge";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { harnessDisplayName, harnessStatusLabel } from "@/lib/harness-builder";
import { cn } from "@/lib/utils";
import type { HarnessDescriptor } from "@/types/harness-engine";
import { Info } from "lucide-react";
import React from "react";

const RUNTIME_GUIDES = [
  {
    id: "dynamic_agents",
    label: "LangChain Deep Agents",
    description: "The default runtime for agents with tools, knowledge, skills, and subagents.",
  },
  {
    id: "claude_agent_sdk",
    label: "Claude Agent SDK (Local)",
    description: "Runs the Claude Agent SDK directly inside the Harness Engine service, sharing its compute resources.",
  },
  {
    id: "claude_agent_sdk_remote",
    label: "Claude Agent SDK (Remote worker)",
    description: "Runs the SDK on a separate worker so execution uses the worker's compute resources.",
  },
  {
    id: "claude_code_acp",
    label: "Claude Agent SDK (ACP)",
    description: "Runs the SDK through an Agent Client Protocol (ACP) adapter process on a separate worker. Its saved workspace stays on that worker.",
  },
  {
    id: "claude_code_cli_acp",
    label: "Claude Code CLI (ACP)",
    description: "Runs the Claude Code command-line application through ACP on a separate worker, with a saved conversation and workspace.",
  },
  {
    id: "agentcore",
    label: "Amazon Bedrock AgentCore (Remote sessions)",
    description: "Runs on a configured AWS AgentCore deployment and keeps its remote session linked to the conversation.",
  },
];

export function HarnessHelp({ harnessId, descriptors }: { harnessId: string; descriptors: HarnessDescriptor[] }) {
  const [open, setOpen] = React.useState(false);
  const contentId = React.useId();
  const titleId = React.useId();
  const focusContent = React.useCallback((node: HTMLElement | null) => node?.focus(), []);

  return <Popover open={open} onOpenChange={setOpen}>
    <PopoverTrigger asChild>
      <button
        type="button"
        aria-label="About agent runtimes"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? contentId : undefined}
        className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <Info className="h-4 w-4" aria-hidden="true" />
      </button>
    </PopoverTrigger>
    <PopoverContent align="end" className="w-[min(34rem,calc(100vw-2rem))] p-4">
      <section id={contentId} role="dialog" aria-labelledby={titleId} tabIndex={-1} ref={focusContent} className="max-h-[65vh] space-y-3 overflow-y-auto outline-none">
        <h3 id={titleId} className="text-sm font-semibold">Choose how your agent runs</h3>
        <p className="text-xs leading-relaxed text-muted-foreground">
          Deep Agents is stable and selected by default. Other CAIPE integrations are experimental and enabled by default when configured.
        </p>
        <dl className="space-y-1">
          {RUNTIME_GUIDES.map(guide => {
            const descriptor = descriptors.find(item => item.id === guide.id);
            return <div key={guide.id} className={cn("rounded-md p-2", harnessId === guide.id && "bg-accent")}>
              <dt className="flex flex-wrap items-center gap-2 text-xs font-medium">
                {descriptor ? harnessDisplayName(descriptor) : guide.label}
                <Badge variant="outline" className="text-[10px] font-normal">{harnessStatusLabel(guide.id, descriptor?.certification)}</Badge>
                {harnessId === guide.id && <span className="text-[10px] text-muted-foreground">Selected</span>}
              </dt>
              <dd className="mt-1 text-xs leading-relaxed text-muted-foreground">{guide.description}</dd>
              {descriptor && descriptor.availability !== "available" && <dd className="mt-1 text-xs text-muted-foreground">Runtime setup is required before this option can be used.</dd>}
            </div>;
          })}
        </dl>
      </section>
    </PopoverContent>
  </Popover>;
}
