"use client";

import { AgentAvatar,type AgentAvatarAgent } from "@/components/dynamic-agents/AgentAvatar";
import { isLightColorTheme } from "@/lib/color-theme";
import { cn } from "@/lib/utils";
import { Handle,Position,type NodeProps } from "@xyflow/react";
import { Plus } from "lucide-react";
import { useTheme } from "@/components/theme-provider";
import { memo } from "react";

export interface WorkflowStepNodeData {
  stepIndex: number;
  display_text: string;
  agent_id: string;
  prompt: string;
  on_error: "abort" | "skip" | "retry";
  /** Agent info for avatar theming — looked up from agents list */
  agent?: (AgentAvatarAgent & { name?: string }) | null;
  [key: string]: unknown;
}

function WorkflowStepNodeComponent({ data, selected }: NodeProps) {
  const nodeData = data as unknown as WorkflowStepNodeData;
  const { resolvedTheme } = useTheme();
  const isDark = !isLightColorTheme(resolvedTheme);

  const agentName = nodeData.agent?.name || nodeData.agent_id || "No agent";

  return (
    <div
      className={cn(
        "rounded-lg border px-3 py-2.5 w-[220px] shadow-lg transition-all cursor-pointer",
        isDark ? "bg-slate-900 border-slate-600" : "bg-white border-slate-200",
        selected && "border-primary ring-2 ring-primary/40",
      )}
    >
      <Handle
        type="target"
        position={Position.Top}
        className="!bg-primary !w-2.5 !h-2.5 !border-2 !border-background"
      />

      <div className="flex items-center gap-2">
        <AgentAvatar
          agent={nodeData.agent}
          size="w-7 h-7"
          iconSize="h-3.5 w-3.5"
          rounded="rounded-lg"
        />

        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1.5 mb-0.5">
            <span className={cn(
              "text-[10px] font-bold uppercase tracking-wide truncate",
              isDark ? "text-gray-400" : "text-slate-500",
            )}>
              {agentName}
            </span>
            <span className={cn(
              "text-[10px] font-mono ml-auto shrink-0",
              isDark ? "text-gray-500" : "text-slate-400",
            )}>
              #{nodeData.stepIndex + 1}
            </span>
          </div>
          <p className={cn(
            "text-xs font-semibold leading-snug truncate",
            isDark ? "text-gray-100" : "text-slate-800",
          )}>
            {nodeData.display_text || (nodeData.prompt ? nodeData.prompt.slice(0, 20) + (nodeData.prompt.length > 20 ? "..." : "") : "Untitled step")}
          </p>
        </div>
      </div>

      {/* On-error badge */}
      {nodeData.on_error && nodeData.on_error !== "abort" && (
        <div className="mt-1.5">
          <span className={cn(
            "text-[9px] font-mono px-1.5 py-0.5 rounded",
            nodeData.on_error === "skip"
              ? "bg-yellow-500/10 text-yellow-600 dark:text-yellow-400"
              : "bg-blue-500/10 text-blue-500",
          )}>
            {nodeData.on_error === "skip" ? "Skip on error" : "Retry on error"}
          </span>
        </div>
      )}

      <Handle
        type="source"
        position={Position.Bottom}
        className="!bg-primary !w-2.5 !h-2.5 !border-2 !border-background"
      />
    </div>
  );
}

export const WorkflowStepNode = memo(WorkflowStepNodeComponent);

// ---------------------------------------------------------------------------
// "Add Step" button node — rendered between steps and at the end
// ---------------------------------------------------------------------------

export interface AddButtonNodeData {
  /** Index at which to insert the new step */
  insertIndex: number;
  /** "insert" = between steps (small), "append" = after last step or initial (full size) */
  variant: "insert" | "append";
  /** Placeholder — actual click handling is done via onNodeClick at canvas level */
  onAdd: (insertIndex: number) => void;
  [key: string]: unknown;
}

function AddButtonNodeComponent({ data }: NodeProps) {
  const nodeData = data as unknown as AddButtonNodeData;
  const isInsert = nodeData.variant === "insert";

  return (
    <div
      className={cn(
        "rounded-full flex items-center justify-center transition-colors cursor-pointer border-dashed",
        isInsert
          ? "w-5 h-5 border border-primary/30 text-primary/40 hover:text-primary hover:border-primary hover:bg-primary/10 bg-background"
          : "w-7 h-7 border-2 border-muted-foreground/30 text-muted-foreground/50 hover:text-primary hover:border-primary bg-background shadow-sm",
      )}
      title="Add step"
    >
      <Handle type="target" position={Position.Top} className="!opacity-0 !w-0 !h-0" />
      <Plus className={isInsert ? "h-2.5 w-2.5" : "h-3.5 w-3.5"} strokeWidth={2.5} />
    </div>
  );
}

export const AddButtonNode = memo(AddButtonNodeComponent);
