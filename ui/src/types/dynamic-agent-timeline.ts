/**
 * Agent Timeline Types
 *
 * These types are used by the AgentTimeline component to render
 * an interleaved timeline view where content and tools appear in stream order.
 *
 * Files and Tasks are fixed (fetched via API), while streamed content,
 * tools, and subagents appear in temporal order.
 */

// ═══════════════════════════════════════════════════════════════
// Tool Types
// ═══════════════════════════════════════════════════════════════

export interface ToolInfo {
  /** Tool call ID (unique identifier) */
  id: string;
  /** Tool name (e.g., "read_file", "search_code") */
  name: string;
  /** Tool arguments (used for thought extraction) */
  args?: Record<string, unknown>;
  /** Current status */
  status: "running" | "completed" | "failed";
  /** Error message when status is "failed" */
  error?: string;
  /** Truncated tool result (for display in collapsible) */
  result?: string;
  /** Timestamp when tool started */
  startedAt: Date;
  /** Timestamp when tool ended (if completed) */
  endedAt?: Date;
}

// ═══════════════════════════════════════════════════════════════
// Subagent Types
// ═══════════════════════════════════════════════════════════════

export interface SubagentInfo {
  /** Tool call ID (namespace correlates to this) */
  id: string;
  /** Agent name (from args.subagent_type) */
  name: string;
  /** MongoDB agent_id */
  agentId?: string;
  /** Purpose description (from args.description) */
  purpose?: string;
  /** Current status */
  status: "running" | "completed" | "failed";
}

// ═══════════════════════════════════════════════════════════════
// Timeline Segment Types (Interleaved)
// ═══════════════════════════════════════════════════════════════

/** A segment of content text */
export interface ContentSegment {
  type: "content";
  id: string;
  text: string;
  /** Explicit reasoning stays in the thinking timeline even after the final tool. */
  reasoning?: boolean;
}

/** A tool call segment */
export interface ToolSegment {
  type: "tool";
  id: string;
  data: ToolInfo;
}

/** A group of consecutive tool calls (for compact rendering) */
export interface ToolGroupSegment {
  type: "tool-group";
  id: string;
  tools: ToolInfo[];
}

/** A subagent section with its own nested timeline */
export interface SubagentSegment {
  type: "subagent";
  id: string;
  info: SubagentInfo;
  /** Nested timeline segments for this subagent */
  segments: TimelineSegment[];
}

/** A warning message */
export interface WarningSegment {
  type: "warning";
  id: string;
  message: string;
}

/** An error message */
export interface ErrorSegment {
  type: "error";
  id: string;
  message: string;
}

/** Status segment types */
export type StatusType = "done" | "interrupted" | "waiting_for_input";

/** A status marker (completion, interruption, or waiting for input) */
export interface StatusSegment {
  type: "status";
  id: string;
  /** Status type: done, interrupted, or waiting_for_input */
  status: StatusType;
  /** Optional label (e.g., subagent name that completed) */
  label?: string;
}

/**
 * @deprecated Use StatusSegment instead. Stored timeline data may still
 * contain this older segment shape.
 */
export interface DoneSegment {
  type: "done";
  id: string;
  /** Optional label (e.g., subagent name that completed) */
  label?: string;
}

/** Union of all segment types */
export type TimelineSegment =
  | ContentSegment
  | ToolSegment
  | ToolGroupSegment
  | SubagentSegment
  | WarningSegment
  | ErrorSegment
  | StatusSegment
  | DoneSegment;

// ═══════════════════════════════════════════════════════════════
// Timeline Data (Interleaved Structure)
// ═══════════════════════════════════════════════════════════════

/**
 * Interleaved timeline data for rendering.
 * Segments appear in stream order; finalAnswer is content after last tool.
 */
export interface TimelineData {
  /** Interleaved segments in temporal order */
  segments: TimelineSegment[];
  /** Content after last tool_end (null if none yet) */
  finalAnswer: string | null;
  /** Whether stream is still active */
  isStreaming: boolean;
  /** Whether any tools have been called (determines timeline vs simple message mode) */
  hasTools: boolean;
}

// ═══════════════════════════════════════════════════════════════
// Timeline Stats (for summary bar)
// ═══════════════════════════════════════════════════════════════

export interface TimelineStats {
  toolCount: number;
  completedToolCount: number;
  subagentCount: number;
  completedSubagentCount: number;
  warningCount: number;
  errorCount: number;
}

// ═══════════════════════════════════════════════════════════════
// Helper: Extract thought/reason from tool args
// ═══════════════════════════════════════════════════════════════

const THOUGHT_KEYS = [
  "thought",
  "thoughts",
  "reason",
  "thinking",
  "rationale",
  "explanation",
  "description",
  "purpose",
  "intent",
  "goal",
] as const;

/**
 * Extract a preview string from tool arguments.
 * Looks for common "thought" fields that agents use to explain their reasoning.
 */
export function extractToolThought(
  args?: Record<string, unknown>,
  maxLength = 60
): string | null {
  if (!args) return null;

  for (const key of THOUGHT_KEYS) {
    const value = args[key];
    if (typeof value === "string" && value.trim()) {
      const trimmed = value.trim();
      return trimmed.length > maxLength
        ? trimmed.slice(0, maxLength) + "..."
        : trimmed;
    }
  }

  return null;
}

// ═══════════════════════════════════════════════════════════════
// Helper: Group consecutive tool segments
// ═══════════════════════════════════════════════════════════════

/**
 * Groups consecutive tool segments into ToolGroupSegment.
 * Other segment types remain unchanged.
 * This creates a consistent view for all tools (single or multiple).
 */
export function groupConsecutiveTools(
  segments: TimelineSegment[]
): TimelineSegment[] {
  const result: TimelineSegment[] = [];
  let currentToolGroup: ToolInfo[] = [];

  const flushToolGroup = () => {
    if (currentToolGroup.length === 0) return;
    
    // Always create a group for consistency
    result.push({
      type: "tool-group",
      id: `tool-group-${currentToolGroup[0].id}`,
      tools: [...currentToolGroup],
    });
    currentToolGroup = [];
  };

  for (const segment of segments) {
    if (segment.type === "tool") {
      currentToolGroup.push(segment.data);
    } else {
      flushToolGroup();
      result.push(segment);
    }
  }

  // Don't forget trailing tools
  flushToolGroup();

  return result;
}
