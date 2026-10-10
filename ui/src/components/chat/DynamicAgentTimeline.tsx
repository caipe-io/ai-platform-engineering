"use client";

import { AgentAvatar } from "@/components/dynamic-agents/AgentAvatar";
import { FileTree } from "@/components/dynamic-agents/FileTree";
import type { TaskItem } from "@/components/shared/timeline";
import {
CollapsibleSection,
MarkdownRenderer,
TaskList,
} from "@/components/shared/timeline";
import { isFileToolName,isTodoToolName,isWorkflowToolName } from "@/lib/streaming/types";
import { cn } from "@/lib/utils";
import type {
ContentSegment,
ErrorSegment,
StatusSegment,
SubagentSegment,
TimelineData,
TimelineSegment,
ToolGroupSegment,
ToolInfo,
ToolSegment,
WarningSegment,
} from "@/types/dynamic-agent-timeline";
import { extractToolThought,groupConsecutiveTools } from "@/types/dynamic-agent-timeline";
import {
AlertTriangle,
CheckCircle,
ChevronDown,
Loader2,
Wrench,
XCircle,
} from "lucide-react";
import { createContext,useContext,useEffect,useRef,useState } from "react";
import { WorkflowRunCard } from "./WorkflowRunCard";

// ═══════════════════════════════════════════════════════════════
// Helper: Detect file-related tools in segments
// ═══════════════════════════════════════════════════════════════

/**
 * Check if any file-related tools were called in the segments (including nested subagents).
 */
function hasFileToolsInSegments(segments: TimelineSegment[]): boolean {
  for (const segment of segments) {
    if (segment.type === "tool" && isFileToolName(segment.data.name)) {
      return true;
    }
    if (segment.type === "tool-group") {
      if (segment.tools.some(t => isFileToolName(t.name))) {
        return true;
      }
    }
    if (segment.type === "subagent" && hasFileToolsInSegments(segment.segments)) {
      return true;
    }
  }
  return false;
}

/**
 * Check if any todo-related tools were called in the segments (including nested subagents).
 */
function hasTodoToolsInSegments(segments: TimelineSegment[]): boolean {
  for (const segment of segments) {
    if (segment.type === "tool" && isTodoToolName(segment.data.name)) {
      return true;
    }
    if (segment.type === "tool-group") {
      if (segment.tools.some(t => isTodoToolName(t.name))) {
        return true;
      }
    }
    if (segment.type === "subagent" && hasTodoToolsInSegments(segment.segments)) {
      return true;
    }
  }
  return false;
}

/**
 * Extract workflow run IDs from tool segments that called workflow tools.
 * Looks at tool result (for start_workflow_run → {run_id}) and args (for get_workflow_run_status → {run_id}).
 */
function extractWorkflowRunIds(segments: TimelineSegment[]): { runId: string; workflowConfigId?: string }[] {
  const seen = new Set<string>();
  const runs: { runId: string; workflowConfigId?: string }[] = [];

  function extract(tools: ToolInfo[]) {
    for (const tool of tools) {
      if (!isWorkflowToolName(tool.name)) continue;
      let runId: string | undefined;
      let configId: string | undefined;

      // Try to get run_id from result (start_workflow_run returns it)
      if (tool.result) {
        try {
          const parsed = JSON.parse(tool.result);
          if (parsed.run_id) runId = parsed.run_id;
          if (parsed.workflow_config_id) configId = parsed.workflow_config_id;
        } catch { /* not JSON */ }
      }
      // Also check args (get_workflow_run_status passes run_id as arg)
      if (!runId && tool.args) {
        if (typeof tool.args.run_id === "string") runId = tool.args.run_id;
        if (typeof tool.args.workflow_config_id === "string") configId = tool.args.workflow_config_id;
      }

      if (runId && !seen.has(runId)) {
        seen.add(runId);
        runs.push({ runId, workflowConfigId: configId });
      }
    }
  }

  for (const segment of segments) {
    if (segment.type === "tool") extract([segment.data]);
    if (segment.type === "tool-group") extract(segment.tools);
    if (segment.type === "subagent") {
      const nested = extractWorkflowRunIds(segment.segments);
      for (const r of nested) {
        if (!seen.has(r.runId)) { seen.add(r.runId); runs.push(r); }
      }
    }
  }
  return runs;
}

// ═══════════════════════════════════════════════════════════════
// Subagent Lookup Context
// ═══════════════════════════════════════════════════════════════

export interface SubagentLookupInfo {
  name: string;
  gradientTheme?: string;
  customThemeConfig?: import("@/types/dynamic-agent").CustomThemeConfig | null;
}

type SubagentLookupFn = (subagentName: string) => SubagentLookupInfo | undefined;

const SubagentLookupContext = createContext<SubagentLookupFn | undefined>(undefined);

// ═══════════════════════════════════════════════════════════════
// Props
// ═══════════════════════════════════════════════════════════════

interface AgentTimelineProps {
  /** Interleaved timeline data from TimelineManager */
  data: TimelineData;
  /** Duration in seconds (for summary bar) */
  durationSec?: number;

  // ─── Files & Tasks (passed from parent, not from segments) ───
  /** Files created by the agent */
  files: string[];
  /** Tasks/todos from the agent */
  tasks: TaskItem[];

  // ─── Controls ────────────────────────────────────────────────
  /** Whether this is the latest message (enables file download) */
  isLatestMessage: boolean;

  // ─── Subagent lookup (optional) ──────────────────────────────
  /** Function to look up subagent info by name (for avatar gradient) */
  getSubagentInfo?: SubagentLookupFn;

  // ─── File operations ─────────────────────────────────────────
  onFileDownload?: (path: string) => void;
  getFileContent?: (path: string) => Promise<string | null>;
  onFileDelete?: (path: string) => void;
  isDownloadingFile?: boolean;
  downloadingFilePath?: string;
  isDeletingFile?: boolean;
  deletingFilePath?: string;

  /** When true, keep timeline expanded (e.g. waiting for HITL input) */
  pendingHitl?: boolean;
}

// ═══════════════════════════════════════════════════════════════
// Main Component
// ═══════════════════════════════════════════════════════════════

export function AgentTimeline({
  data,
  durationSec,
  files,
  tasks,
  isLatestMessage,
  getSubagentInfo,
  onFileDownload,
  getFileContent,
  onFileDelete,
  isDownloadingFile,
  downloadingFilePath,
  isDeletingFile,
  deletingFilePath,
  pendingHitl = false,
}: AgentTimelineProps) {
  const { segments, finalAnswer, isStreaming, hasTools } = data;

  // Determine if turn has ended (not streaming and has final answer)
  const turnEnded = !isStreaming && finalAnswer !== null;
  const hasWarningsOrErrors = segments.some(s => s.type === "warning" || s.type === "error");

  // assisted-by Codex Codex-sonnet-4-6
  // Collapse completed machinery, but keep warning/error details visible until the user collapses them.
  const [machineryExpanded, setMachineryExpanded] = useState(!turnEnded || hasWarningsOrErrors);
  const prevStreamingRef = useRef(isStreaming);
  const prevFinalAnswerRef = useRef(finalAnswer);
  const prevHadWarningsOrErrorsRef = useRef(hasWarningsOrErrors);
  // Track whether this turn transitioned from streaming → final.
  // When true, skip the reveal animation since content was already visible.
  // State (not ref) so the JSX can read it without a react-hooks/refs violation.
  const [wasStreaming, setWasStreaming] = useState(false);
  
  // For ref to timeline container (kept for potential future use)
  const timelineRef = useRef<HTMLDivElement>(null);

  const prevPendingHitlRef = useRef(pendingHitl);

  useEffect(() => {
    // Don't collapse while waiting for HITL input
    if (pendingHitl) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- intentional: expand machinery when HITL input is pending
      setMachineryExpanded(true);
      prevPendingHitlRef.current = pendingHitl;
      return;
    }
    if (hasWarningsOrErrors && !prevHadWarningsOrErrorsRef.current) {

      setMachineryExpanded(true);
    }
    // Collapse when HITL input is resolved (pendingHitl went true → false)
    if (prevPendingHitlRef.current && !hasWarningsOrErrors) {

      setMachineryExpanded(false);
    }
    // Collapse when streaming ends
    if (prevStreamingRef.current && !isStreaming) {

      setMachineryExpanded(hasWarningsOrErrors);
      setWasStreaming(true);
    }
    // Also collapse when final answer first appears AND streaming has stopped
    if (!prevFinalAnswerRef.current && finalAnswer && !isStreaming && !hasWarningsOrErrors) {
      setMachineryExpanded(false);
    }
    prevStreamingRef.current = isStreaming;
    prevFinalAnswerRef.current = finalAnswer;
    prevHadWarningsOrErrorsRef.current = hasWarningsOrErrors;
    prevPendingHitlRef.current = pendingHitl;
  }, [isStreaming, finalAnswer, pendingHitl, hasWarningsOrErrors]);

  // Group consecutive tools for compact rendering
  const groupedSegments = groupConsecutiveTools(segments);

  // Count stats for summary bar
  const toolCount = segments.filter(s => s.type === "tool").length;
  const subagentCount = segments.filter(s => s.type === "subagent").length;
  const warningCount = segments.filter(s => s.type === "warning").length;
  const errorCount = segments.filter(s => s.type === "error").length;

  // Determine if tasks/files sections will actually be shown
  const showTasksSection = tasks.length > 0 && hasTodoToolsInSegments(segments) && (isStreaming || tasks.some(t => t.status !== "completed"));
  const showFilesSection = files.length > 0 && hasFileToolsInSegments(segments);
  const workflowRuns = extractWorkflowRunIds(segments);
  const showWorkflowSection = workflowRuns.length > 0;

  // Check if we have meaningful timeline segments (tools, subagents, content, warnings, errors)
  // "done" and "status" segments don't count - they're just markers
  const hasMeaningfulSegments = segments.some(s => s.type !== "done" && s.type !== "status");
  
  // Should show timeline content (always show when streaming to include final answer as thinking)
  const showTimeline = isStreaming || machineryExpanded;
  
  // Streaming content display logic:
  // - If streaming with NO tools yet: show content as streaming text (like normal message)
  // - If streaming WITH tools: show final answer as "thinking" in timeline
  // - After streaming: show final answer as completed message
  const showStreamingContent = isStreaming && !hasTools && finalAnswer;
  const showFinalAnswerInTimeline = isStreaming && hasTools && finalAnswer;
  const showFinalAnswerOutside = !isStreaming && finalAnswer;

  // If there's nothing to show at all, render nothing
  const hasAnythingToShow = hasMeaningfulSegments || showStreamingContent || showFinalAnswerInTimeline || showFinalAnswerOutside || showTasksSection || showFilesSection || showWorkflowSection;

  // If streaming but nothing to show yet, show thinking indicator
  if (isStreaming && !hasAnythingToShow) {
    return (
      <div className="inline-flex items-center gap-2 px-4 py-3 rounded-xl bg-card/50 border border-border/50">
        <span className="relative flex h-2 w-2">
          <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-primary/60 opacity-75" />
          <span className="relative inline-flex rounded-full h-2 w-2 bg-primary/80" />
        </span>
        <span className="text-xs text-muted-foreground">Thinking...</span>
      </div>
    );
  }

  if (!hasAnythingToShow) {
    return null;
  }

  // When streaming without tools, render as simple streaming message (no timeline chrome)
  if (showStreamingContent) {
    return (
      <div className="animate-reveal-ltr bg-muted/30 border border-border/30 rounded-lg px-4 py-3">
        <MarkdownRenderer
          content={finalAnswer}
          isStreaming={true}
        />
      </div>
    );
  }

  return (
    <SubagentLookupContext.Provider value={getSubagentInfo}>
      <div className="space-y-3">
        {/* Summary bar - only shown when NOT streaming and has meaningful timeline segments */}
        {!isStreaming && hasMeaningfulSegments && (
          <TimelineSummary
            expanded={machineryExpanded}
            onToggle={() => setMachineryExpanded(!machineryExpanded)}
            toolCount={toolCount}
            subagentCount={subagentCount}
            taskCount={showTasksSection ? tasks.length : 0}
            fileCount={showFilesSection ? files.length : 0}
            durationSec={durationSec}
          />
        )}

        {/* Timeline sections - grid-based animation for smooth expand/collapse */}
        {(hasMeaningfulSegments || showFinalAnswerInTimeline) && (
          <div
            className={cn(
              "grid transition-[grid-template-rows] duration-150 ease-out",
              showTimeline ? "grid-rows-[1fr]" : "grid-rows-[0fr]"
            )}
          >
            <div className="overflow-hidden">
              <div ref={timelineRef} className="relative pl-6">
                {/* Vertical timeline line */}
                <div className="absolute left-[7px] top-2 bottom-2 w-px bg-border/60" />

                {/* Render interleaved segments in stream order */}
                {groupedSegments.map((segment) => (
                  <SegmentRenderer
                    key={segment.id}
                    segment={segment}
                    isStreaming={isStreaming}
                  />
                ))}

                {/* Streaming final answer - shown as "thinking" content attached to timeline */}
                {showFinalAnswerInTimeline && (
                  <div className="relative pb-3">
                    <TimelineDot color="primary" />
                    <MarkdownRenderer
                      content={finalAnswer}
                      isStreaming={true}
                    />
                  </div>
                )}
              </div>
            </div>
          </div>
        )}

        {/* Tasks section */}
        {showTasksSection && (
          <TaskSection tasks={tasks} readonly={!isLatestMessage} turnEnded={turnEnded} isStreaming={isStreaming} />
        )}

        {/* Files section */}
        {showFilesSection && (
          <FileSection
            files={files}
            readonly={!isLatestMessage}
            turnEnded={turnEnded}
            isStreaming={isStreaming}
            onFileDownload={onFileDownload}
            getFileContent={getFileContent}
            onFileDelete={onFileDelete}
            isDownloading={isDownloadingFile}
            downloadingPath={downloadingFilePath}
            isDeleting={isDeletingFile}
            deletingPath={deletingFilePath}
          />
        )}

        {/* Workflow runs section */}
        {showWorkflowSection && (
          <WorkflowRunCard runs={workflowRuns} />
        )}

        {/* Final answer - only shown after streaming completes */}
        {showFinalAnswerOutside && (
          <div className={cn(
            "bg-muted/30 border border-border/30 rounded-lg px-4 py-3",
            !wasStreaming && "animate-reveal-ltr"
          )}>
            <MarkdownRenderer
              content={finalAnswer}
            />
          </div>
        )}

        {/* Warnings & Errors summary (only when collapsed) */}
        {!machineryExpanded && hasWarningsOrErrors && (
          <WarningsSummary warningCount={warningCount} errorCount={errorCount} />
        )}
      </div>
    </SubagentLookupContext.Provider>
  );
}

// ═══════════════════════════════════════════════════════════════
// Timeline Dot Component
// ═══════════════════════════════════════════════════════════════

function TimelineDot({ color, size = "md" }: { color: "amber" | "sky" | "muted" | "primary" | "red" | "emerald"; size?: "sm" | "md" }) {
  return (
    <div
      className={cn(
        "absolute rounded-full border-2 bg-background",
        size === "sm" ? "left-[-21px] top-1 w-2 h-2" : "left-[-20px] top-1.5 w-2.5 h-2.5",
        color === "amber" && "border-amber-500",
        color === "sky" && "border-sky-400",
        color === "muted" && "border-muted-foreground/40",
        color === "primary" && "border-primary/60",
        color === "red" && "border-red-500",
        color === "emerald" && "border-emerald-500"
      )}
    />
  );
}

// ═══════════════════════════════════════════════════════════════
// Segment Renderer (dispatches to appropriate component)
// ═══════════════════════════════════════════════════════════════

function SegmentRenderer({
  segment,
  isStreaming,
  isNested = false,
}: {
  segment: TimelineSegment;
  isStreaming: boolean;
  /** Whether this segment is inside a subagent (affects sizing) */
  isNested?: boolean;
}) {
  const getDotColor = (): "amber" | "sky" | "muted" | "primary" | "red" | "emerald" => {
    switch (segment.type) {
      case "content":
        return "muted";
      case "tool":
        return segment.data.status === "running" ? "amber" : 
               segment.data.status === "failed" ? "red" : "emerald";
      case "tool-group": {
        // Show amber if any tool is running, red if any failed, otherwise emerald
        const hasRunning = segment.tools.some(t => t.status === "running");
        const hasFailed = segment.tools.some(t => t.status === "failed");
        return hasRunning ? "amber" : hasFailed ? "red" : "emerald";
      }
      case "subagent":
        return segment.info.status === "running" ? "sky" : "emerald";
      case "warning":
        return "amber";
      case "error":
        return "red";
      case "status":
        return segment.status === "done" ? "emerald" : "amber";
      case "done":
        return "emerald";
      default:
        return "muted";
    }
  };

  return (
    <div className={cn(
      "relative last:pb-0 animate-in fade-in slide-in-from-top-1 duration-150",
      isNested ? "pb-1.5" : "pb-3"
    )}>
      <TimelineDot color={getDotColor()} size={isNested ? "sm" : "md"} />
      {segment.type === "content" && (
        <ContentSegmentView segment={segment} isNested={isNested} />
      )}
      {segment.type === "tool" && (
        <ToolSegmentView segment={segment} isNested={isNested} />
      )}
      {segment.type === "tool-group" && (
        <ToolGroupSegmentView segment={segment} isNested={isNested} />
      )}
      {segment.type === "subagent" && (
        <SubagentSegmentView segment={segment} isStreaming={isStreaming} />
      )}
      {segment.type === "warning" && (
        <WarningSegmentView segment={segment} isNested={isNested} />
      )}
      {segment.type === "error" && (
        <ErrorSegmentView segment={segment} isNested={isNested} />
      )}
      {segment.type === "status" && (
        <StatusSegmentView segment={segment} isNested={isNested} />
      )}
      {segment.type === "done" && (
        <DoneSegmentView isNested={isNested} />
      )}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════
// Content Segment
// ═══════════════════════════════════════════════════════════════

function ContentSegmentView({
  segment,
  isNested = false,
}: {
  segment: ContentSegment;
  isNested?: boolean;
}) {
  // For nested subagent content, use smaller text with no special styling
  // For root content, use the thinking variant
  if (isNested) {
    return (
      <div className="text-[11px] leading-relaxed text-muted-foreground/70 whitespace-pre-wrap">
        {segment.text.trim()}
      </div>
    );
  }

  return (
    <MarkdownRenderer
      content={segment.text}
    />
  );
}

// ═══════════════════════════════════════════════════════════════
// Tool Segment
// ═══════════════════════════════════════════════════════════════

function ToolSegmentView({ segment, isNested = false }: { segment: ToolSegment; isNested?: boolean }) {
  const { data: tool } = segment;
  const thought = extractToolThought(tool.args);
  const isRunning = tool.status === "running";
  const isFailed = tool.status === "failed";
  const errorDisplay = isFailed && tool.error ? formatToolError(tool.error) : null;
  const hasParams = tool.args && Object.keys(tool.args).length > 0;
  const hasDetails = hasParams || (!isFailed && tool.result);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const detailsVisible = detailsOpen || (isRunning && !!tool.result);

  return (
    <div
      className={cn(
        "rounded-md",
        isNested ? "text-[10px] px-2 py-1" : "text-xs px-3 py-1.5",
        isRunning && "bg-amber-500/10 border border-amber-500/25",
        !isRunning && !isFailed && "bg-emerald-500/8 border border-emerald-500/20",
        isFailed && "bg-red-500/10 border border-red-500/25"
      )}
    >
      {/* Header row with tool name, thought, and status — clickable to toggle details */}
      <div
        className={cn("flex items-center gap-1.5 rounded-sm transition-colors", hasDetails && "hover:bg-foreground/5 cursor-pointer")}
        onClick={hasDetails ? () => setDetailsOpen(!detailsOpen) : undefined}
      >
        {isRunning ? (
          <Loader2 className={cn("animate-spin text-amber-500 shrink-0", isNested ? "h-2.5 w-2.5" : "h-3 w-3")} />
        ) : isFailed ? (
          <XCircle className={cn("text-red-500 shrink-0", isNested ? "h-2.5 w-2.5" : "h-3 w-3")} />
        ) : (
          <CheckCircle className={cn("text-emerald-500 shrink-0", isNested ? "h-2.5 w-2.5" : "h-3 w-3")} />
        )}
        <span className="font-medium text-foreground/80">{tool.name}</span>
        {thought && (
          <span className={cn(
            "text-muted-foreground/60 truncate flex-1 italic",
            isNested ? "text-[9px]" : "text-[10px]"
          )}>
            — {thought}
          </span>
        )}
        {hasDetails && (
          <ChevronDown className={cn(
            "text-muted-foreground/50 transition-transform duration-150 shrink-0",
            detailsVisible && "rotate-180",
            isNested ? "h-2.5 w-2.5" : "h-3 w-3"
          )} />
        )}
        <span
          className={cn(
            "ml-auto shrink-0",
            isNested ? "text-[9px]" : "text-[10px]",
            isRunning && "text-amber-500",
            !isRunning && !isFailed && "text-emerald-500/70",
            isFailed && "text-red-500"
          )}
        >
          {isRunning ? "running" : isFailed ? "failed" : "done"}
        </span>
      </div>
      {/* Error message for failed tools */}
      {errorDisplay && (
        <p className={cn(
          "text-red-400/80 mt-0.5 font-mono leading-snug",
          isNested ? "text-[8px]" : "text-[10px]"
        )}>
          {errorDisplay}
        </p>
      )}
      {/* Expandable details: params + output */}
      {hasDetails && (
        <div className={cn(
          "grid transition-all duration-150 ease-out",
          detailsVisible ? "grid-rows-[1fr] mt-1.5" : "grid-rows-[0fr]"
        )}>
          <div className="overflow-hidden">
            <div>
              <span className={cn(
                "text-muted-foreground/50 font-medium",
                isNested ? "text-[8px]" : "text-[10px]"
              )}>params:</span>
              {hasParams ? (
                <ToolParamsView args={tool.args!} isNested={isNested} />
              ) : (
                <span className={cn(
                  "text-muted-foreground/40 italic ml-1",
                  isNested ? "text-[8px]" : "text-[10px]"
                )}>none provided for this tool call</span>
              )}
            </div>
            {!isFailed && tool.result && (
              <hr className={cn("border-foreground/10 my-1.5")} />
            )}
            {!isFailed && tool.result && (
              <div>
                <span className={cn(
                  "text-muted-foreground/50 font-medium",
                  isNested ? "text-[8px]" : "text-[10px]"
                )}>{isRunning ? "Streaming output:" : "output:"}</span>
                <p className={cn(
                  "text-muted-foreground/70 font-mono leading-snug whitespace-pre-wrap break-all mt-0.5",
                  isRunning ? "max-h-48 overflow-y-auto" : "line-clamp-6",
                  isNested ? "text-[8px]" : "text-[10px]"
                )}>
                  {tool.result}
                </p>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}


// ═══════════════════════════════════════════════════════════════
// Helper: Format tool error message for display
// ═══════════════════════════════════════════════════════════════
/**
 * Return the raw error string as-is for full transparency.
 */
function formatToolError(raw: string): string {
  return raw;
}

// ═══════════════════════════════════════════════════════════════
// Helper: Format tool arguments for display
// ═══════════════════════════════════════════════════════════════

// ═══════════════════════════════════════════════════════════════
// Tool Parameters (expandable view)
// ═══════════════════════════════════════════════════════════════

const THOUGHT_KEYS = new Set([
  "thought", "thoughts", "reason", "thinking", "rationale",
  "explanation", "description", "purpose", "intent", "goal",
]);

function ToolParamsView({ args, isNested = false }: { args: Record<string, unknown>; isNested?: boolean }) {
  const entries = Object.entries(args).filter(([k]) => !THOUGHT_KEYS.has(k.toLowerCase()));
  if (entries.length === 0) return null;

  return (
    <div className={cn(
      "font-mono pt-0.5 space-y-1",
      isNested ? "text-[8px]" : "text-[10px]"
    )}>
      {entries.map(([key, value]) => (
        <div key={key} className="flex gap-1.5">
          <span className="text-muted-foreground/70 shrink-0">{key}:</span>
          <span className="text-muted-foreground/50 break-all whitespace-pre-wrap">
            {typeof value === "string" ? value : JSON.stringify(value, null, 2)}
          </span>
        </div>
      ))}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════
// Tool Group Segment (multiple consecutive tools)
// ═══════════════════════════════════════════════════════════════

function ToolGroupSegmentView({ segment, isNested = false }: { segment: ToolGroupSegment; isNested?: boolean }) {
  const [expanded, setExpanded] = useState(false);
  const { tools } = segment;
  const completedCount = tools.filter(t => t.status === "completed").length;
  const hasRunning = tools.some(t => t.status === "running");
  const groupExpanded = expanded || tools.some(t => t.status === "running" && !!t.result);

  return (
    <div className="rounded-lg border border-border/50 bg-card/50 overflow-hidden">
      {/* Collapsible header */}
      <button
        onClick={() => setExpanded(!expanded)}
        className={cn(
          "w-full flex items-center gap-2 text-left",
          "hover:bg-muted/30 transition-colors duration-150",
          isNested ? "px-2 py-1.5 text-[10px]" : "px-3 py-2 text-xs"
        )}
      >
        <span 
          className={cn(
            "shrink-0 transition-transform duration-150 ease-out",
            groupExpanded && "rotate-180"
          )}
        >
          <ChevronDown className={cn("text-muted-foreground", isNested ? "h-2.5 w-2.5" : "h-3 w-3")} />
        </span>
        {hasRunning ? (
          <Loader2 className={cn("animate-spin text-amber-500 shrink-0", isNested ? "h-3 w-3" : "h-3.5 w-3.5")} />
        ) : (
          <Wrench className={cn("text-muted-foreground shrink-0", isNested ? "h-3 w-3" : "h-3.5 w-3.5")} />
        )}
        <span className="text-muted-foreground">
          {tools.length} tool{tools.length !== 1 ? "s" : ""}
        </span>
        <span className={cn("text-muted-foreground/60 ml-auto", isNested ? "text-[9px]" : "text-[10px]")}>
          {completedCount}/{tools.length}
        </span>
      </button>
      {/* Grid-based animation for smooth auto-height transitions */}
      <div
        className={cn(
          "grid transition-[grid-template-rows] duration-150 ease-out",
          groupExpanded ? "grid-rows-[1fr]" : "grid-rows-[0fr]"
        )}
      >
        <div className="overflow-hidden">
          <div className={cn("space-y-1", isNested ? "px-1.5 pb-1.5" : "px-2 pb-2")}>
            {tools.map((tool) => (
              <ToolItemView key={tool.id} tool={tool} isNested={isNested} />
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

/** Single tool item within a group - with individual status background */
function ToolItemView({ tool, isNested = false }: { tool: ToolInfo; isNested?: boolean }) {
  const thought = extractToolThought(tool.args);
  const isRunning = tool.status === "running";
  const isFailed = tool.status === "failed";
  const errorDisplay = isFailed && tool.error ? formatToolError(tool.error) : null;
  const hasParams = tool.args && Object.keys(tool.args).length > 0;
  const hasDetails = hasParams || (!isFailed && tool.result);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const detailsVisible = detailsOpen || (isRunning && !!tool.result);

  return (
    <div
      className={cn(
        "rounded-md",
        isNested ? "px-2 py-1 text-[10px]" : "px-2 py-1.5 text-xs",
        isRunning && "bg-amber-500/10 border border-amber-500/25",
        !isRunning && !isFailed && "bg-emerald-500/8 border border-emerald-500/20",
        isFailed && "bg-red-500/10 border border-red-500/25"
      )}
    >
      {/* Header row with tool name, thought, and status — clickable to toggle details */}
      <div
        className={cn("flex items-center gap-2 rounded-sm transition-colors", hasDetails && "hover:bg-foreground/5 cursor-pointer")}
        onClick={hasDetails ? () => setDetailsOpen(!detailsOpen) : undefined}
      >
        {isRunning ? (
          <Loader2 className={cn("animate-spin text-amber-500 shrink-0", isNested ? "h-2.5 w-2.5" : "h-3 w-3")} />
        ) : isFailed ? (
          <XCircle className={cn("text-red-500 shrink-0", isNested ? "h-2.5 w-2.5" : "h-3 w-3")} />
        ) : (
          <CheckCircle className={cn("text-emerald-500 shrink-0", isNested ? "h-2.5 w-2.5" : "h-3 w-3")} />
        )}
        <span className="font-medium text-foreground/80">{tool.name}</span>
        {thought && (
          <span className={cn(
            "text-muted-foreground/60 truncate flex-1 italic",
            isNested ? "text-[9px]" : "text-[10px]"
          )}>
            — {thought}
          </span>
        )}
        {hasDetails && (
          <ChevronDown className={cn(
            "text-muted-foreground/50 transition-transform duration-150 shrink-0",
            detailsVisible && "rotate-180",
            isNested ? "h-2.5 w-2.5" : "h-3 w-3"
          )} />
        )}
        <span
          className={cn(
            "ml-auto shrink-0",
            isNested ? "text-[8px]" : "text-[10px]",
            isRunning && "text-amber-500",
            !isRunning && !isFailed && "text-emerald-500/70",
            isFailed && "text-red-500"
          )}
        >
          {isRunning ? "running" : isFailed ? "failed" : "done"}
        </span>
      </div>
      {/* Error message for failed tools */}
      {errorDisplay && (
        <p className={cn(
          "text-red-400/80 mt-0.5 font-mono leading-snug",
          isNested ? "text-[8px]" : "text-[10px]"
        )}>
          {errorDisplay}
        </p>
      )}
      {/* Expandable details: params + output */}
      {hasDetails && (
        <div className={cn(
          "grid transition-all duration-150 ease-out",
          detailsVisible ? "grid-rows-[1fr] mt-1.5" : "grid-rows-[0fr]"
        )}>
          <div className="overflow-hidden">
            <div>
              <span className={cn(
                "text-muted-foreground/50 font-medium",
                isNested ? "text-[8px]" : "text-[10px]"
              )}>params:</span>
              {hasParams ? (
                <ToolParamsView args={tool.args!} isNested={isNested} />
              ) : (
                <span className={cn(
                  "text-muted-foreground/40 italic ml-1",
                  isNested ? "text-[8px]" : "text-[10px]"
                )}>none provided for this tool call</span>
              )}
            </div>
            {!isFailed && tool.result && (
              <hr className={cn("border-foreground/10 my-1.5")} />
            )}
            {!isFailed && tool.result && (
              <div>
                <span className={cn(
                  "text-muted-foreground/50 font-medium",
                  isNested ? "text-[8px]" : "text-[10px]"
                )}>{isRunning ? "Streaming output:" : "output:"}</span>
                <p className={cn(
                  "text-muted-foreground/70 font-mono leading-snug whitespace-pre-wrap break-all mt-0.5",
                  isRunning ? "max-h-48 overflow-y-auto" : "line-clamp-6",
                  isNested ? "text-[8px]" : "text-[10px]"
                )}>
                  {tool.result}
                </p>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════
// Subagent Segment (with nested timeline)
// ═══════════════════════════════════════════════════════════════

function SubagentSegmentView({
  segment,
  isStreaming,
}: {
  segment: SubagentSegment;
  isStreaming: boolean;
}) {
  const { info, segments: nestedSegments } = segment;
  const isRunning = info.status === "running";
  
  // Group consecutive tools in nested segments (same as parent)
  const groupedNestedSegments = groupConsecutiveTools(nestedSegments);
  
  // Look up subagent info for gradient
  const getSubagentInfo = useContext(SubagentLookupContext);
  const subagentLookup = getSubagentInfo?.(info.name);
  // Custom icon with gradient avatar
  const subagentIcon = (
    <AgentAvatar
      agent={subagentLookup ? { gradient_theme: subagentLookup.gradientTheme, custom_theme_config: subagentLookup.customThemeConfig } : undefined}
      rounded="rounded-full"
      size="w-5 h-5"
      iconSize="h-3 w-3"
    />
  );
  
  // Build a description string for collapsed mode
  const purposeIsLong = info.purpose && info.purpose.length > 80;
  const [purposeExpanded, setPurposeExpanded] = useState(false);

  return (
    <CollapsibleSection
      title={
        <span className="flex flex-col gap-0.5 flex-1 min-w-0">
          <span className="font-medium text-foreground/80">{subagentLookup?.name || info.name}</span>
          {info.purpose && (
            <span className="text-muted-foreground/60 text-[11px]">
              {purposeIsLong && !purposeExpanded ? (
                <span>
                  {info.purpose.slice(0, 80)}...{" "}
                  <span
                    className="text-blue-400 hover:text-blue-300 underline cursor-pointer"
                    onClick={(e) => { e.stopPropagation(); setPurposeExpanded(true); }}
                  >
                    show more
                  </span>
                </span>
              ) : (
                <span className="whitespace-pre-wrap break-words">
                  {info.purpose}
                  {purposeIsLong && (
                    <>
                      {" "}
                      <span
                        className="text-blue-400 hover:text-blue-300 underline cursor-pointer"
                        onClick={(e) => { e.stopPropagation(); setPurposeExpanded(false); }}
                      >
                        show less
                      </span>
                    </>
                  )}
                </span>
              )}
            </span>
          )}
        </span>
      }
      icon={subagentIcon}
      badge={
        isRunning ? (
          <div className="flex items-center gap-1">
            <Loader2 className="h-3 w-3 text-sky-400 animate-spin" />
            <span className="text-[10px] text-sky-400">running</span>
          </div>
        ) : (
          <CheckCircle className="h-3 w-3 text-emerald-500" />
        )
      }
      defaultExpanded={false}
      contentClassName="relative pl-8 pr-3 pt-2 pb-2"
      headerClassName="py-2.5 px-3 text-xs"
      className={cn(
        isRunning && "bg-sky-500/5 border-sky-500/30"
      )}
    >
      {/* Nested vertical timeline line */}
      <div className="absolute left-3 top-1 bottom-1 w-px bg-border/30" />

      {/* Nested segments (interleaved content + tools, grouped) */}
      {groupedNestedSegments.map((nestedSeg) => (
        <SegmentRenderer
          key={nestedSeg.id}
          segment={nestedSeg}
          isStreaming={isStreaming && isRunning}
          isNested={false}
        />
      ))}

      {/* Show loading if running but no segments yet */}
      {isRunning && nestedSegments.length === 0 && (
        <div className="relative pb-0">
          <TimelineDot color="primary" size="md" />
          <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <Loader2 className="h-3 w-3 animate-spin" />
            <span>Working...</span>
          </div>
        </div>
      )}
    </CollapsibleSection>
  );
}

// ═══════════════════════════════════════════════════════════════
// Warning Segment
// ═══════════════════════════════════════════════════════════════

function WarningSegmentView({ segment, isNested = false }: { segment: WarningSegment; isNested?: boolean }) {
  return (
    <div className={cn(
      "flex items-start gap-1.5 text-amber-500 rounded-md bg-amber-500/10 border border-amber-500/25",
      isNested ? "text-[10px] px-2 py-1" : "text-xs px-3 py-2"
    )}>
      <AlertTriangle className={cn("shrink-0 mt-0.5", isNested ? "h-2.5 w-2.5" : "h-3.5 w-3.5")} />
      <div
        className={cn(
          "min-w-0 [&_.streaming-markdown]:text-inherit [&_.md-link]:font-semibold",
          "[&_.md-link]:text-cyan-300 [&_.md-link]:underline [&_.md-link:hover]:text-cyan-200",
        )}
      >
        <MarkdownRenderer content={segment.message} variant="user" />
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════
// Error Segment
// ═══════════════════════════════════════════════════════════════

function ErrorSegmentView({ segment, isNested = false }: { segment: ErrorSegment; isNested?: boolean }) {
  return (
    <div className={cn(
      "flex items-start gap-1.5 text-red-500 rounded-md bg-red-500/10 border border-red-500/25",
      isNested ? "text-[10px] px-2 py-1" : "text-xs px-3 py-2"
    )}>
      <XCircle className={cn("shrink-0 mt-0.5", isNested ? "h-2.5 w-2.5" : "h-3.5 w-3.5")} />
      <span>{segment.message}</span>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════
// Status Segment (done, interrupted, waiting_for_input)
// ═══════════════════════════════════════════════════════════════

function StatusSegmentView({ segment, isNested = false }: { segment: StatusSegment; isNested?: boolean }) {
  const { status, label } = segment;
  
  // Determine styling based on status
  const isDone = status === "done";
  const isInterrupted = status === "interrupted";
  const isWaiting = status === "waiting_for_input";
  
  // Status labels
  const statusLabel = isDone ? "Done" : isInterrupted ? "Interrupted" : "Waiting for user response";
  
  return (
    <div className={cn(
      "flex items-center gap-1.5",
      isNested ? "text-[10px]" : "text-xs",
      isDone && "text-emerald-500",
      (isInterrupted || isWaiting) && "text-amber-500"
    )}>
      {isDone ? (
        <CheckCircle className={cn("shrink-0", isNested ? "h-2.5 w-2.5" : "h-3 w-3")} />
      ) : (
        <span className="relative flex shrink-0">
          <span className={cn(
            "relative inline-flex rounded-full bg-amber-500",
            isNested ? "h-2 w-2" : "h-2.5 w-2.5"
          )} />
        </span>
      )}
      <span className="font-medium">{statusLabel}</span>
      {label && (
        <span className="text-muted-foreground/60">— {label}</span>
      )}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════
// Done Segment (completion marker)
// ═══════════════════════════════════════════════════════════════

function DoneSegmentView({ isNested = false }: { isNested?: boolean }) {
  return (
    <div className={cn(
      "flex items-center gap-1.5 text-emerald-500",
      isNested ? "text-[10px]" : "text-xs"
    )}>
      <CheckCircle className={cn("shrink-0", isNested ? "h-2.5 w-2.5" : "h-3 w-3")} />
      <span className="font-medium">Done</span>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════
// Summary Bar
// ═══════════════════════════════════════════════════════════════

function TimelineSummary({
  expanded,
  onToggle,
  toolCount,
  subagentCount,
  taskCount,
  fileCount,
  durationSec,
}: {
  expanded: boolean;
  onToggle: () => void;
  toolCount: number;
  subagentCount: number;
  taskCount: number;
  fileCount: number;
  durationSec?: number;
}) {
  const parts: string[] = [];
  if (toolCount > 0) parts.push(`${toolCount} tool${toolCount !== 1 ? "s" : ""}`);
  if (subagentCount > 0) parts.push(`${subagentCount} subagent${subagentCount !== 1 ? "s" : ""}`);
  if (taskCount > 0) parts.push(`${taskCount} task${taskCount !== 1 ? "s" : ""}`);
  if (fileCount > 0) parts.push(`${fileCount} file${fileCount !== 1 ? "s" : ""}`);
  if (durationSec != null && durationSec > 0) {
    parts.push(`${Math.round(durationSec)}s`);
  }

  return (
    <button
      type="button"
      aria-expanded={expanded}
      onClick={onToggle}
      className={cn(
        "w-full flex items-center gap-2 px-3 py-2 rounded-lg text-xs",
        "bg-muted/40 hover:bg-muted/60 border border-border/40 hover:border-border/60",
        "transition-all duration-200 cursor-pointer text-left"
      )}
    >
      <span 
        className={cn(
          "shrink-0 transition-transform duration-200 ease-out",
          expanded && "rotate-180"
        )}
      >
        <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />
      </span>
      <Wrench className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
      <span className="text-muted-foreground">
        {parts.length > 0 ? parts.join(" \u00b7 ") : "View execution details"}
      </span>
    </button>
  );
}

// ═══════════════════════════════════════════════════════════════
// Warnings Summary (shown when machinery is collapsed)
// ═══════════════════════════════════════════════════════════════

function WarningsSummary({
  warningCount,
  errorCount,
}: {
  warningCount: number;
  errorCount: number;
}) {
  return (
    <div className="flex items-center gap-3 text-xs">
      {warningCount > 0 && (
        <span className="flex items-center gap-1 text-amber-500">
          <AlertTriangle className="h-3 w-3" />
          {warningCount} warning{warningCount !== 1 ? "s" : ""}
        </span>
      )}
      {errorCount > 0 && (
        <span className="flex items-center gap-1 text-red-500">
          <XCircle className="h-3 w-3" />
          {errorCount} error{errorCount !== 1 ? "s" : ""}
        </span>
      )}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════
// Task Section
// ═══════════════════════════════════════════════════════════════

function TaskSection({
  tasks,
  readonly,
  turnEnded = false,
  isStreaming = false,
}: {
  tasks: TaskItem[];
  readonly: boolean;
  turnEnded?: boolean;
  isStreaming?: boolean;
}) {
  const completedCount = tasks.filter((t) => t.status === "completed").length;
  const allCompleted = completedCount === tasks.length;

  return (
    <CollapsibleSection
      title="Tasks"
      icon={allCompleted 
        ? <CheckCircle className="h-3.5 w-3.5 text-emerald-500" />
        : <Loader2 className="h-3.5 w-3.5 text-sky-400" />
      }
      badge={
        <span className={cn(
          "text-[10px]",
          allCompleted ? "text-emerald-500" : "text-muted-foreground"
        )}>
          {completedCount}/{tasks.length}
        </span>
      }
      defaultExpanded={!turnEnded}
      autoCollapseOnStreamEnd
      isStreaming={isStreaming}
      contentClassName="px-3 pb-3"
    >
      <TaskList tasks={tasks} readonly={readonly} />
    </CollapsibleSection>
  );
}

// ═══════════════════════════════════════════════════════════════
// File Section
// ═══════════════════════════════════════════════════════════════

function FileSection({
  files,
  readonly,
  turnEnded = false,
  isStreaming = false,
  onFileDownload,
  getFileContent,
  onFileDelete,
  isDownloading,
  downloadingPath,
  isDeleting,
  deletingPath,
}: {
  files: string[];
  readonly: boolean;
  turnEnded?: boolean;
  isStreaming?: boolean;
  onFileDownload?: (path: string) => void;
  getFileContent?: (path: string) => Promise<string | null>;
  onFileDelete?: (path: string) => void;
  isDownloading?: boolean;
  downloadingPath?: string;
  isDeleting?: boolean;
  deletingPath?: string;
}) {
  return (
    <CollapsibleSection
      title={`${files.length} file${files.length !== 1 ? "s" : ""}`}
      defaultExpanded={!turnEnded && files.length <= 10}
      autoCollapseOnStreamEnd
      isStreaming={isStreaming}
      contentClassName="px-3 pb-3"
    >
      <FileTree
        files={files}
        getFileContent={getFileContent}
        onFileClick={onFileDownload}
        onFileDelete={readonly ? undefined : onFileDelete}
        isDownloading={isDownloading}
        downloadingPath={downloadingPath}
        isDeleting={isDeleting}
        deletingPath={deletingPath}
      />
    </CollapsibleSection>
  );
}
