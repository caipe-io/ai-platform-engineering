/**
 * Timeline Manager
 *
 * Manages the transformation of SSE events into an interleaved timeline.
 * Events are rendered in temporal order, with subagents having their own
 * nested timelines.
 *
 * Key features:
 * - Interleaved content/tools in stream order
 * - Subagent sections with nested timelines
 * - Final answer detection (content after last tool_end)
 */

import type { ToolStartEventData } from "@/lib/streaming/types";
import { SUBAGENT_TOOL_NAME } from "@/lib/streaming/types";
import type {
ContentSegment,
StatusSegment,
StatusType,
SubagentInfo,
TimelineData,
TimelineSegment,
TimelineStats,
ToolInfo,
ToolSegment,
} from "@/types/dynamic-agent-timeline";

// ═══════════════════════════════════════════════════════════════
// Internal Types
// ═══════════════════════════════════════════════════════════════

interface SubagentState {
  info: SubagentInfo;
  segments: TimelineSegment[];
  toolMap: Map<string, ToolInfo>;
  lastToolEndIndex: number;
}

// ═══════════════════════════════════════════════════════════════
// Manager Class
// ═══════════════════════════════════════════════════════════════

export class TimelineManager {
  // ─── Timeline Storage ───────────────────────────────────────
  private rootSegments: TimelineSegment[] = [];
  private rootToolMap: Map<string, ToolInfo> = new Map();
  private subagents: Map<string, SubagentState> = new Map();

  // ─── Content Buffering ──────────────────────────────────────
  // Buffer content and flush as segments to avoid too many tiny segments
  private rootContentBuffer: string = "";
  private rootContentId: number = 0;
  private subagentContentBuffers: Map<string, string> = new Map();
  private subagentContentIds: Map<string, number> = new Map();

  // ─── Tracking ───────────────────────────────────────────────
  private eventIndex: number = 0;
  private lastToolEndIndex: number = -1;
  private isFinalized: boolean = false;
  private warningCount: number = 0;
  private errorCount: number = 0;

  // ═══════════════════════════════════════════════════════════════
  // Content Buffering Helpers
  // ═══════════════════════════════════════════════════════════════

  private flushRootContent(): void {
    if (this.rootContentBuffer.trim()) {
      const segment: ContentSegment = {
        type: "content",
        id: `content-${this.rootContentId++}`,
        text: this.rootContentBuffer,
      };
      this.rootSegments.push(segment);
      this.rootContentBuffer = "";
    }
  }

  private flushSubagentContent(subagentId: string): void {
    const buffer = this.subagentContentBuffers.get(subagentId) || "";
    if (buffer.trim()) {
      const subagent = this.subagents.get(subagentId);
      if (subagent) {
        const contentId = this.subagentContentIds.get(subagentId) || 0;
        const segment: ContentSegment = {
          type: "content",
          id: `${subagentId}-content-${contentId}`,
          text: buffer,
        };
        subagent.segments.push(segment);
        this.subagentContentIds.set(subagentId, contentId + 1);
        this.subagentContentBuffers.set(subagentId, "");
      }
    }
  }

  /** Ensure resumed namespaced events always have a visible subagent owner. */
  private ensureSubagent(
    subagentId: string,
    args: Record<string, unknown> = {},
    startedAt: Date = new Date(),
  ): SubagentState {
    const existing = this.subagents.get(subagentId);
    if (existing) {
      const subagentType = args.subagent_type as string | undefined;
      const description = args.description as string | undefined;
      if (subagentType && (!existing.info.agentId || existing.info.name === "subagent")) {
        existing.info.name = subagentType;
        existing.info.agentId = subagentType;
      }
      if (description && !existing.info.purpose) {
        existing.info.purpose = description;
      }
      const existingTool = this.rootToolMap.get(subagentId);
      if (existingTool && Object.keys(args).length > 0) {
        existingTool.args = args;
      }
      return existing;
    }

    const subagentState: SubagentState = {
      info: {
        id: subagentId,
        name: (args.subagent_type as string) || "subagent",
        agentId: args.subagent_type as string,
        purpose: args.description as string,
        status: "running",
      },
      segments: [],
      toolMap: new Map(),
      lastToolEndIndex: -1,
    };
    this.subagents.set(subagentId, subagentState);
    this.subagentContentBuffers.set(subagentId, "");
    this.subagentContentIds.set(subagentId, 0);
    this.rootToolMap.set(subagentId, {
      id: subagentId,
      name: SUBAGENT_TOOL_NAME,
      args,
      status: "running",
      startedAt,
    });
    this.rootSegments.push({
      type: "subagent",
      id: subagentId,
      info: subagentState.info,
      segments: subagentState.segments,
    });
    return subagentState;
  }

  // ═══════════════════════════════════════════════════════════════
  // Event Handlers
  // ═══════════════════════════════════════════════════════════════

  /**
   * Push content from a content event.
   */
  pushContent(text: string, namespace: string[]): void {
    this.eventIndex++;

    if (namespace.length === 0) {
      // Root content - buffer it
      this.rootContentBuffer += text;
    } else {
      // Subagent content - buffer it
      const subagentId = namespace[0];
      this.ensureSubagent(subagentId);
      const buffer = this.subagentContentBuffers.get(subagentId) || "";
      this.subagentContentBuffers.set(subagentId, buffer + text);
    }
  }

  /**
   * Push a tool start event.
   */
  pushToolStart(toolData: ToolStartEventData, namespace: string[]): void {
    const now = new Date();
    this.eventIndex++;

    // Check if this is a subagent invocation (task tool)
    if (toolData.tool_name === SUBAGENT_TOOL_NAME) {
      const subagentId = toolData.tool_call_id;
      const args = toolData.args || {};
      if (!this.subagents.has(subagentId)) {
        this.flushRootContent();
      }
      this.ensureSubagent(subagentId, args, now);
    } else if (namespace.length === 0) {
      // DEDUP GUARD: If we already have this tool, update its args if they
      // are now available (AG-UI streams args via TOOL_CALL_ARGS after start).
      if (this.rootToolMap.has(toolData.tool_call_id)) {
        const existing = this.rootToolMap.get(toolData.tool_call_id)!;
        if (toolData.args) {
          existing.args = toolData.args;
        }
        return;
      }

      // Root-level tool - flush content first
      this.flushRootContent();

      const tool: ToolInfo = {
        id: toolData.tool_call_id,
        name: toolData.tool_name,
        args: toolData.args,
        status: "running",
        startedAt: now,
      };
      this.rootToolMap.set(toolData.tool_call_id, tool);

      const segment: ToolSegment = {
        type: "tool",
        id: toolData.tool_call_id,
        data: tool,
      };
      this.rootSegments.push(segment);
    } else {
      // Subagent tool
      const subagentId = namespace[0];
      const subagent = this.ensureSubagent(subagentId);
      // DEDUP GUARD: If we already have this tool, update its args if they
      // are now available (AG-UI streams args via TOOL_CALL_ARGS after start).
      if (subagent.toolMap.has(toolData.tool_call_id)) {
        const existing = subagent.toolMap.get(toolData.tool_call_id)!;
        if (toolData.args) {
          existing.args = toolData.args;
        }
        return;
      }

      // Flush subagent content first
      this.flushSubagentContent(subagentId);

      const tool: ToolInfo = {
        id: toolData.tool_call_id,
        name: toolData.tool_name,
        args: toolData.args,
        status: "running",
        startedAt: now,
      };
      subagent.toolMap.set(toolData.tool_call_id, tool);

      const segment: ToolSegment = {
        type: "tool",
        id: toolData.tool_call_id,
        data: tool,
      };
      subagent.segments.push(segment);
    }
  }

  /**
   * Push a tool end event.
   */
  pushToolOutput(toolCallId: string, namespace: string[], result: string): void {
    const tools = namespace.length === 0 ? this.rootToolMap : this.subagents.get(namespace[0])?.toolMap;
    const tool = tools?.get(toolCallId);
    if (tool) tool.result = result;
  }

  pushToolEnd(toolCallId: string, namespace: string[], args?: Record<string, unknown>, result?: string): void {
    const now = new Date();
    const currentIndex = this.eventIndex++;

    if (namespace.length === 0) {
      // Root-level tool completion
      const tool = this.rootToolMap.get(toolCallId);
      if (tool) {
        tool.status = "completed";
        tool.endedAt = now;
        if (args) tool.args = args;
        if (result) tool.result = result;
        this.lastToolEndIndex = currentIndex;
      }

      // Check if this is a subagent completion
      const subagent = this.subagents.get(toolCallId);
      if (subagent) {
        subagent.info.status = "completed";

        // AG-UI protocol: args arrive at TOOL_CALL_END, not TOOL_CALL_START.
        // Update subagent name/agentId/purpose from args if they were missing.
        if (args) {
          const subagentType = args.subagent_type as string | undefined;
          const description = args.description as string | undefined;
          if (subagentType && (!subagent.info.agentId || subagent.info.name === "subagent")) {
            subagent.info.name = subagentType;
            subagent.info.agentId = subagentType;
          }
          if (description && !subagent.info.purpose) {
            subagent.info.purpose = description;
          }
        }

        // Flush any remaining subagent content
        this.flushSubagentContent(toolCallId);
        
        // Add a "status" segment to the subagent's nested timeline
        const statusSegment: StatusSegment = {
          type: "status",
          id: `${toolCallId}-status`,
          status: "done",
          label: subagent.info.name,
        };
        subagent.segments.push(statusSegment);
      }
    } else {
      // Subagent tool completion
      const subagentId = namespace[0];
      const subagent = this.subagents.get(subagentId);
      if (subagent) {
        const tool = subagent.toolMap.get(toolCallId);
        if (tool) {
          tool.status = "completed";
          tool.endedAt = now;
          if (args) tool.args = args;
          if (result) tool.result = result;
          subagent.lastToolEndIndex = currentIndex;
        }
      }
    }
  }

  /**
   * Mark a tool as failed.
   */
  pushToolFailed(toolCallId: string, namespace: string[], error?: string): void {
    const now = new Date();
    const currentIndex = this.eventIndex++;

    if (namespace.length === 0) {
      const tool = this.rootToolMap.get(toolCallId);
      if (tool) {
        tool.status = "failed";
        tool.error = error;
        tool.endedAt = now;
        this.lastToolEndIndex = currentIndex;
      }

      const subagent = this.subagents.get(toolCallId);
      if (subagent) {
        subagent.info.status = "failed";
        this.flushSubagentContent(toolCallId);
      }
    } else {
      const subagentId = namespace[0];
      const subagent = this.subagents.get(subagentId);
      if (subagent) {
        const tool = subagent.toolMap.get(toolCallId);
        if (tool) {
          tool.status = "failed";
          tool.error = error;
          tool.endedAt = now;
        }
      }
    }
  }

  /**
   * Push a warning message.
   */
  pushWarning(message: string): void {
    this.eventIndex++;
    this.warningCount++;
    
    // Flush content first
    this.flushRootContent();
    
    this.rootSegments.push({
      type: "warning",
      id: `warning-${this.warningCount}`,
      message,
    });
  }

  /**
   * Push an error message.
   */
  pushError(message: string): void {
    this.eventIndex++;
    this.errorCount++;
    
    // Flush content first
    this.flushRootContent();
    
    this.rootSegments.push({
      type: "error",
      id: `error-${this.errorCount}`,
      message,
    });
  }

  // ═══════════════════════════════════════════════════════════════
  // Finalization
  // ═══════════════════════════════════════════════════════════════

  /**
   * Finalize the timeline (called when stream ends).
   * @param status - The status to show: "done", "interrupted", or "waiting_for_input"
   */
  finalize(status: StatusType = "done"): void {
    this.isFinalized = true;

    // Flush any remaining content
    this.flushRootContent();
    for (const subagentId of this.subagents.keys()) {
      this.flushSubagentContent(subagentId);
    }

    // Mark all running tools as completed (unless interrupted)
    const toolStatus = status === "interrupted" ? "failed" : "completed";
    for (const tool of this.rootToolMap.values()) {
      if (tool.status === "running") {
        tool.status = toolStatus;
        tool.endedAt = new Date();
      }
    }

    // Mark all running subagents and their tools as completed
    for (const subagent of this.subagents.values()) {
      if (subagent.info.status === "running") {
        subagent.info.status = toolStatus;
      }
      for (const tool of subagent.toolMap.values()) {
        if (tool.status === "running") {
          tool.status = toolStatus;
          tool.endedAt = new Date();
        }
      }
    }

    // Add a status segment for the parent agent
    const statusSegment: StatusSegment = {
      type: "status",
      id: "root-status",
      status,
    };
    this.rootSegments.push(statusSegment);
  }

  // ═══════════════════════════════════════════════════════════════
  // Output
  // ═══════════════════════════════════════════════════════════════

  /**
   * Get the interleaved timeline data for rendering.
   */
  getGroupedData(): TimelineData {
    // Flush any pending content
    const currentRootBuffer = this.rootContentBuffer;
    
    // Determine where to split for final answer
    // Final answer = content after the last tool_end (or all content if no tools)
    const hasTools = this.rootToolMap.size > 0;
    
    // Build segments for rendering (without final answer content)
    const segments: TimelineSegment[] = [];
    let finalAnswerParts: string[] = [];
    
    // Find the index of the last tool/subagent segment
    let lastToolSegmentIndex = -1;
    for (let i = this.rootSegments.length - 1; i >= 0; i--) {
      const seg = this.rootSegments[i];
      if (seg.type === "tool" || seg.type === "subagent") {
        lastToolSegmentIndex = i;
        break;
      }
    }
    
    // Process segments
    for (let i = 0; i < this.rootSegments.length; i++) {
      const seg = this.rootSegments[i];
      
      if (seg.type === "content" && hasTools && i > lastToolSegmentIndex) {
        // This content is after the last tool - it's part of final answer
        finalAnswerParts.push(seg.text);
      } else {
        if (seg.type === "subagent") {
          const liveBuffer = this.subagentContentBuffers.get(seg.id) || "";
          if (liveBuffer.trim()) {
            segments.push({
              ...seg,
              segments: [
                ...seg.segments,
                {
                  type: "content",
                  id: `${seg.id}-content-live`,
                  text: liveBuffer,
                },
              ],
            });
          } else {
            segments.push(seg);
          }
        } else {
          segments.push(seg);
        }
      }
    }
    
    // Add current buffer to final answer if we have tools and it's after last tool
    if (hasTools && currentRootBuffer.trim()) {
      finalAnswerParts.push(currentRootBuffer);
    } else if (!hasTools && currentRootBuffer.trim()) {
      // No tools - all content is final answer
      // But we still want to show it somewhere, so add as segment for now
      // Actually, if no tools, current buffer IS the final answer
      finalAnswerParts.push(currentRootBuffer);
    }
    
    // If no tools at all, all content segments become final answer
    // (plus any unflushed buffer content already added above)
    if (!hasTools) {
      const contentSegments = segments.filter(s => s.type === "content") as ContentSegment[];
      if (contentSegments.length > 0) {
        // Prepend flushed content segments before the buffer
        finalAnswerParts = [...contentSegments.map(s => s.text), ...finalAnswerParts];
      }
      // Remove content segments from segments (they go to finalAnswer)
      const nonContentSegments = segments.filter(s => s.type !== "content");
      segments.length = 0;
      segments.push(...nonContentSegments);
    }
    
    const finalAnswer = finalAnswerParts.length > 0 ? finalAnswerParts.join("") : null;

    return {
      segments,
      finalAnswer,
      isStreaming: !this.isFinalized,
      hasTools,
    };
  }

  /**
   * Get statistics for the summary bar.
   */
  getStats(): TimelineStats {
    // Count tools (excluding "task" which shows as subagent)
    let toolCount = 0;
    let completedToolCount = 0;
    
    for (const tool of this.rootToolMap.values()) {
      if (tool.name !== SUBAGENT_TOOL_NAME) {
        toolCount++;
        if (tool.status === "completed") completedToolCount++;
      }
    }

    return {
      toolCount,
      completedToolCount,
      subagentCount: this.subagents.size,
      completedSubagentCount: [...this.subagents.values()].filter(
        (s) => s.info.status === "completed"
      ).length,
      warningCount: this.warningCount,
      errorCount: this.errorCount,
    };
  }

  /**
   * Check if the timeline has any machinery.
   */
  hasMachinery(): boolean {
    return (
      this.rootToolMap.size > 0 ||
      this.subagents.size > 0 ||
      this.rootSegments.some(s => s.type === "content")
    );
  }

  /**
   * Check if there are any warnings or errors.
   */
  hasWarningsOrErrors(): boolean {
    return this.warningCount > 0 || this.errorCount > 0;
  }

  /**
   * Reset the manager for reuse.
   */
  reset(): void {
    this.rootSegments = [];
    this.rootToolMap.clear();
    this.subagents.clear();
    this.rootContentBuffer = "";
    this.rootContentId = 0;
    this.subagentContentBuffers.clear();
    this.subagentContentIds.clear();
    this.eventIndex = 0;
    this.lastToolEndIndex = -1;
    this.isFinalized = false;
    this.warningCount = 0;
    this.errorCount = 0;
  }
}

// ═══════════════════════════════════════════════════════════════
// Factory Function
// ═══════════════════════════════════════════════════════════════

/**
 * Create a new TimelineManager instance.
 */
export function createTimelineManager(): TimelineManager {
  return new TimelineManager();
}
