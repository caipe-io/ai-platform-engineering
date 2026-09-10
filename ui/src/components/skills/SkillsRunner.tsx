"use client";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { CAIPESpinner } from "@/components/ui/caipe-spinner";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Select } from "@/components/ui/select";
import { apiClient } from "@/lib/api-client";
import { resolveUsableChatAgent } from "@/lib/chat-agent-selection";
import { getConfig } from "@/lib/config";
import { pushWithNavigationProgress } from "@/lib/navigation-progress";
import { getMarkdownComponents } from "@/lib/markdown-components";
import { createStreamAdapter,type StreamAdapter,type StreamCallbacks } from "@/lib/streaming";
import type { InputFieldDefinition } from "@/lib/streaming/types";
import { cn } from "@/lib/utils";
import { useWorkflowRunStore } from "@/store/workflow-run-store";
import type { AgentSkill } from "@/types/agent-skill";
import { AnimatePresence,motion } from "framer-motion";
import {
AlertCircle,
ArrowLeft,
Brain,
Check,
CheckCircle,
ChevronDown,
ChevronLeft,
ChevronRight,
ChevronUp,
Clock,
Copy,
LayoutGrid,
Loader2,
Maximize2,
MessageSquare,
Minimize2,
Play,
RotateCcw,
Send,
Square,
Wrench,
XCircle
} from "lucide-react";
import { useSession } from "next-auth/react";
import { useRouter } from "next/navigation";
import React,{ useCallback,useEffect,useMemo,useRef,useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { WorkflowHistoryView } from "./WorkflowHistoryView";

interface SkillsRunnerProps {
  config: AgentSkill;
  onComplete?: (result: string) => void;
}

// Execution step parsed from execution_plan events
interface ExecutionStep {
  id: string;
  agent: string;
  description: string;
  status: "pending" | "in_progress" | "completed" | "failed";
  order: number;
}

interface WorkflowRunnerEvent {
  type: "content" | "tool_start" | "tool_end" | "plan_update" | "input_required" | "done" | "error";
  text?: string;
  tool?: string;
  description?: string;
  steps?: Array<{
    id?: string;
    agent?: string;
    description: string;
    status: string;
  }>;
  fields?: Array<{
    name: string;
    label: string;
    type: string;
    required?: boolean;
  }>;
  message?: string;
}

// Tool call being executed
interface ToolCall {
  id: string;
  tool: string;
  description: string; // Full descriptive text from tool notification
  agent: string;
  status: "running" | "completed";
  timestamp: number;
}

// Detected input field from natural language
interface DetectedInputField {
  name: string;
  label: string;
  description?: string;
  type: "text" | "select" | "boolean";
  options?: string[];
  required: boolean;
}

// Status icons and colors
const STATUS_CONFIG = {
  pending: {
    icon: Clock,
    color: "text-muted-foreground",
    bgColor: "bg-muted/50",
    emoji: "⏳",
  },
  in_progress: {
    icon: Loader2,
    color: "text-blue-500",
    bgColor: "bg-blue-500/10",
    emoji: "🔄",
  },
  completed: {
    icon: CheckCircle,
    color: "text-green-500",
    bgColor: "bg-green-500/10",
    emoji: "✅",
  },
  failed: {
    icon: XCircle,
    color: "text-red-500",
    bgColor: "bg-red-500/10",
    emoji: "❌",
  },
};

/**
 * Parse natural language to detect input fields
 * Handles patterns like:
 * - "Repository Name - What should the repository be named?"
 * - "Visibility - Should it be: Public / Private"
 * - "Required Information:" sections
 */
function parseInputFieldsFromText(text: string): DetectedInputField[] | null {
  const fields: DetectedInputField[] = [];
  const seenLabels = new Set<string>();
  
  // Check if this looks like an input request
  const inputIndicators = [
    /I need the following information/i,
    /Please provide/i,
    /Required Information/i,
    /What should/i,
    /Enter the/i,
    /Specify the/i,
    /need.*information.*from you/i,
  ];
  
  const hasInputIndicator = inputIndicators.some(pattern => pattern.test(text));
  if (!hasInputIndicator) return null;
  
  // Helper to add a field if not duplicate
  const addField = (field: DetectedInputField) => {
    const normalizedLabel = field.label.toLowerCase().trim();
    // Skip if we've seen this label or a very similar one
    if (seenLabels.has(normalizedLabel)) return;
    // Skip very short labels (likely parsing errors)
    if (field.label.length < 3) return;
    // Skip labels that are just fragments
    if (/^[A-Z][a-z]$/.test(field.label)) return;
    
    seenLabels.add(normalizedLabel);
    fields.push(field);
  };
  
  // Pattern 1: Markdown bold "**Field Name** - Description" or "**Field Name**: Description"
  // This is the most common format from LLMs
  const boldFieldPattern = /\*\*([^*]+)\*\*\s*[-–:]?\s*([^\n*]+)?/g;
  let match;
  
  while ((match = boldFieldPattern.exec(text)) !== null) {
    const [, rawName, description = ""] = match;
    const name = rawName.trim();
    
    // Skip common non-field patterns
    if (/^(Required|Optional|Note|Example|Step|Next|Important|Warning)/i.test(name)) continue;
    if (name.length > 60) continue; // Too long to be a field name
    if (name.length < 2) continue; // Too short
    
    // Detect field type from description
    let type: "text" | "select" | "boolean" = "text";
    let options: string[] | undefined;
    
    // Check for Public/Private options
    if (/\b(Public|Private)\b.*\b(Public|Private)\b/i.test(description) ||
        /should.*be.*(Public|Private)/i.test(description)) {
      type = "select";
      options = ["Public", "Private"];
    }
    // Check for Yes/No options
    else if (/\b(Yes|No)\b.*\b(Yes|No)\b/i.test(description) ||
             /\(Yes\/No\)/i.test(description)) {
      type = "boolean";
      options = ["Yes", "No"];
    }
    
    // Check if optional
    const isOptional = /\(optional\)/i.test(name) || /\(optional\)/i.test(description);
    const cleanName = name.replace(/\s*\(optional\)/i, "").trim();
    
    addField({
      name: cleanName.toLowerCase().replace(/[\s\/]+/g, "_").replace(/[^a-z0-9_]/g, ""),
      label: cleanName,
      description: description.replace(/\(.*?\)/g, "").trim() || undefined,
      type,
      options,
      required: !isOptional,
    });
  }
  
  // Pattern 2: Numbered list items "1. Repository Name - description" or "1. **Repository Name**"
  const numberedPattern = /^\s*\d+\.\s*\*?\*?([^*\n-]+?)\*?\*?\s*[-–:]?\s*([^\n]*)$/gm;
  while ((match = numberedPattern.exec(text)) !== null) {
    const [, rawName, description = ""] = match;
    const name = rawName.trim();
    
    // Skip if too short/long or already added
    if (name.length < 3 || name.length > 60) continue;
    if (seenLabels.has(name.toLowerCase())) continue;
    
    // Detect field type
    let type: "text" | "select" | "boolean" = "text";
    let options: string[] | undefined;
    
    if (/\b(Public|Private)\b/i.test(description)) {
      type = "select";
      options = ["Public", "Private"];
    } else if (/\b(Yes|No)\b/i.test(description) || /\(Yes\/No\)/i.test(description)) {
      type = "boolean";
      options = ["Yes", "No"];
    }
    
    const isOptional = /\(optional\)/i.test(name) || /\(optional\)/i.test(description);
    const cleanName = name.replace(/\s*\(optional\)/i, "").trim();
    
    addField({
      name: cleanName.toLowerCase().replace(/[\s\/]+/g, "_").replace(/[^a-z0-9_]/g, ""),
      label: cleanName,
      description: description.trim() || undefined,
      type,
      options,
      required: !isOptional,
    });
  }
  
  // Pattern 3: Bullet points "- Repository Name: description"
  const bulletPattern = /^\s*[-•]\s*\*?\*?([^*\n:]+?)\*?\*?\s*[:]\s*([^\n]*)$/gm;
  while ((match = bulletPattern.exec(text)) !== null) {
    const [, rawName, description = ""] = match;
    const name = rawName.trim();
    
    if (name.length < 3 || name.length > 60) continue;
    if (seenLabels.has(name.toLowerCase())) continue;
    
    let type: "text" | "select" | "boolean" = "text";
    let options: string[] | undefined;
    
    if (/\b(Public|Private)\b/i.test(description)) {
      type = "select";
      options = ["Public", "Private"];
    } else if (/\b(Yes|No)\b/i.test(description)) {
      type = "boolean";
      options = ["Yes", "No"];
    }
    
    const isOptional = /\(optional\)/i.test(name) || /\(optional\)/i.test(description);
    const cleanName = name.replace(/\s*\(optional\)/i, "").trim();
    
    addField({
      name: cleanName.toLowerCase().replace(/[\s\/]+/g, "_").replace(/[^a-z0-9_]/g, ""),
      label: cleanName,
      description: description.trim() || undefined,
      type,
      options,
      required: !isOptional,
    });
  }
  
  // Only return fields if we found at least 2 valid ones
  return fields.length >= 2 ? fields : null;
}

/**
 * UserInputForm - Renders detected input fields as a form
 */
function UserInputForm({
  fields,
  onSubmit,
  disabled,
}: {
  fields: DetectedInputField[];
  onSubmit: (data: Record<string, string>) => void;
  disabled?: boolean;
}) {
  const [formData, setFormData] = useState<Record<string, string>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  
  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    
    // Validate required fields
    const newErrors: Record<string, string> = {};
    fields.forEach(field => {
      if (field.required && !formData[field.name]?.trim()) {
        newErrors[field.name] = `${field.label} is required`;
      }
    });
    
    if (Object.keys(newErrors).length > 0) {
      setErrors(newErrors);
      return;
    }
    
    onSubmit(formData);
  };
  
  return (
    <motion.div
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      className="space-y-4"
    >
      <div className="flex items-center gap-2 p-3 rounded-lg bg-amber-500/10 border border-amber-500/30">
        <AlertCircle className="h-4 w-4 text-amber-400 shrink-0" />
        <span className="text-sm text-amber-400">
          Please provide the following information to continue
        </span>
      </div>
      
      <form onSubmit={handleSubmit} className="space-y-4">
        {fields.map((field, idx) => (
          <div key={field.name} className="space-y-1.5">
            <label className="text-sm font-medium flex items-center gap-1">
              {field.label}
              {field.required && <span className="text-red-400">*</span>}
            </label>
            
            {field.description && (
              <p className="text-xs text-muted-foreground">{field.description}</p>
            )}
            
            {field.type === "select" && field.options ? (
              <Select
                value={formData[field.name] || ""}
                onChange={(e) => {
                  setFormData(prev => ({ ...prev, [field.name]: e.target.value }));
                  if (errors[field.name]) setErrors(prev => ({ ...prev, [field.name]: "" }));
                }}
                disabled={disabled}
                className={cn(
                  "w-full h-10 px-3 rounded-lg text-sm bg-background border",
                  "focus:outline-none focus:ring-2 focus:ring-primary/50",
                  errors[field.name] ? "border-red-500" : "border-input"
                )}
              >
                <option value="">Select...</option>
                {field.options.map(opt => (
                  <option key={opt} value={opt}>{opt}</option>
                ))}
              </Select>
            ) : field.type === "boolean" ? (
              <div className="flex gap-4">
                {["Yes", "No"].map(opt => (
                  <label key={opt} className="flex items-center gap-2 cursor-pointer">
                    <input
                      type="radio"
                      name={field.name}
                      value={opt}
                      checked={formData[field.name] === opt}
                      onChange={(e) => {
                        setFormData(prev => ({ ...prev, [field.name]: e.target.value }));
                        if (errors[field.name]) setErrors(prev => ({ ...prev, [field.name]: "" }));
                      }}
                      disabled={disabled}
                      className="w-4 h-4"
                    />
                    <span className="text-sm">{opt}</span>
                  </label>
                ))}
              </div>
            ) : (
              <Input
                value={formData[field.name] || ""}
                onChange={(e) => {
                  setFormData(prev => ({ ...prev, [field.name]: e.target.value }));
                  if (errors[field.name]) setErrors(prev => ({ ...prev, [field.name]: "" }));
                }}
                placeholder={`Enter ${field.label.toLowerCase()}...`}
                disabled={disabled}
                autoFocus={idx === 0}
                className={cn(errors[field.name] && "border-red-500")}
              />
            )}
            
            {errors[field.name] && (
              <p className="text-xs text-red-400">{errors[field.name]}</p>
            )}
          </div>
        ))}
        
        <div className="pt-2">
          <Button type="submit" disabled={disabled} className="gap-2 gradient-primary text-white">
            <Send className="h-4 w-4" />
            Submit & Continue
          </Button>
        </div>
      </form>
    </motion.div>
  );
}

/**
 * ExecutionStepCard - Individual execution step display
 */
function ExecutionStepCard({
  step,
  isActive,
}: {
  step: ExecutionStep;
  isActive: boolean;
}) {
  const statusConfig = STATUS_CONFIG[step.status];
  const StatusIcon = statusConfig.icon;

  return (
    <motion.div
      layout
      initial={{ opacity: 0, x: -20 }}
      animate={{ opacity: 1, x: 0 }}
      transition={{ delay: step.order * 0.05 }}
      className={cn(
        "relative p-3 rounded-lg border transition-all",
        isActive
          ? "border-primary/50 bg-primary/5 shadow-md shadow-primary/10"
          : "border-border/50 bg-card/50",
        step.status === "failed" && "border-red-500/50"
      )}
    >
      {/* Connection Line */}
      {step.order > 0 && (
        <div className="absolute -top-3 left-5 w-0.5 h-3 bg-border/50" />
      )}

      <div className="flex items-start gap-3">
        {/* Status Icon */}
        <div
          className={cn(
            "w-7 h-7 rounded-full flex items-center justify-center shrink-0",
            statusConfig.bgColor
          )}
        >
          <StatusIcon
            className={cn(
              "h-3.5 w-3.5",
              statusConfig.color,
              step.status === "in_progress" && "animate-spin"
            )}
          />
        </div>

        {/* Content */}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-0.5">
            <Badge variant="outline" className="text-xs px-1.5 py-0">
              {step.agent}
            </Badge>
          </div>
          <p className="text-sm text-foreground">{step.description}</p>
        </div>
      </div>
    </motion.div>
  );
}

/**
 * ToolCallIndicator - Shows all tool calls (running and completed)
 */
function ToolCallIndicator({ toolCalls }: { toolCalls: ToolCall[] }) {
  if (toolCalls.length === 0) return null;

  return (
    <div className="space-y-2">
      <AnimatePresence mode="popLayout">
        {toolCalls.map((tool, index) => (
          <motion.div
            key={tool.id}
            initial={{ opacity: 0, x: -20 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: 20 }}
            transition={{ delay: index * 0.05 }}
            className={cn(
              "flex items-center gap-2 px-3 py-2 rounded-lg border",
              tool.status === "running"
                ? "bg-blue-500/10 border-blue-500/30"
                : "bg-green-500/10 border-green-500/30"
            )}
          >
            {tool.status === "running" ? (
              <Loader2 className="h-3.5 w-3.5 text-blue-500 animate-spin shrink-0" />
            ) : (
              <CheckCircle className="h-3.5 w-3.5 text-green-500 shrink-0" />
            )}
            <span className={cn(
              "text-xs font-medium flex-1",
              tool.status === "running" ? "text-blue-600 dark:text-blue-400" : "text-green-600 dark:text-green-400"
            )}>
              {tool.description}
            </span>
            {tool.status === "completed" && (
              <span className="text-[10px] text-muted-foreground ml-auto">
                ✓
              </span>
            )}
          </motion.div>
        ))}
      </AnimatePresence>
    </div>
  );
}

/**
 * ThinkingIndicator - Shows when the agent is thinking
 */
function ThinkingIndicator({ isThinking }: { isThinking: boolean }) {
  if (!isThinking) return null;

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      className="flex items-center gap-2 px-3 py-2 rounded-lg bg-primary/5 border border-primary/20"
    >
      <Brain className="h-3.5 w-3.5 text-primary animate-pulse" />
      <span className="text-xs text-primary">Thinking...</span>
    </motion.div>
  );
}

/**
 * StreamingOutputDisplay - Shows streaming content with copy and fullscreen
 */
function StreamingOutputDisplay({ 
  content, 
  isFullscreen,
  onExitFullscreen 
}: { 
  content: string;
  isFullscreen: boolean;
  onExitFullscreen: () => void;
}) {
  if (isFullscreen) {
    return (
      <div className="fixed left-2 right-2 top-[68px] bottom-2 z-[100] bg-background shadow-2xl rounded-lg border border-border flex flex-col">
        {/* Fullscreen header with exit button */}
        <div className="flex items-center justify-between px-3 py-2 border-b border-border/50 bg-background shrink-0">
          <h3 className="text-xs font-medium">Workflow Output</h3>
          <Button
            variant="outline"
            size="sm"
            onClick={onExitFullscreen}
            className="h-7 px-2 gap-1.5 text-xs"
          >
            <Minimize2 className="h-3.5 w-3.5" />
            <span>Exit Fullscreen</span>
          </Button>
        </div>
        
        {/* Content */}
        <div className="flex-1 overflow-auto p-4">
          <ReactMarkdown 
            remarkPlugins={[remarkGfm]}
            components={getMarkdownComponents()}
          >
            {content}
          </ReactMarkdown>
        </div>
      </div>
    );
  }
  
  return (
    <motion.div
      initial={{ opacity: 0, height: 0 }}
      animate={{ opacity: 1, height: "auto" }}
      className="rounded-lg bg-muted/30 border border-border/30"
    >
      <div className="p-3">
        <div
          className={cn(
            "prose prose-sm dark:prose-invert max-w-none",
            "prose-p:leading-7 prose-p:my-4",
            "prose-headings:mt-8 prose-headings:mb-4",
            "prose-ul:my-4 prose-ol:my-4",
            "prose-li:my-2",
            "prose-table:my-6",
            "prose-pre:my-6",
            "prose-blockquote:my-6"
          )}
        >
          <ReactMarkdown remarkPlugins={[remarkGfm]}>
            {content}
          </ReactMarkdown>
        </div>
      </div>
    </motion.div>
  );
}

/**
 * ResultOrInputForm - Renders either a form (if input is requested) or markdown result
 * Prioritizes structured input fields from backend over regex parsing
 */
function ResultOrInputForm({
  content,
  onSubmitInput,
  isSubmitting,
  structuredFields,
  structuredTitle,
  isFullscreen,
  onExitFullscreen,
}: {
  content: string;
  onSubmitInput: (data: Record<string, string>) => void;
  isSubmitting: boolean;
  structuredFields?: DetectedInputField[] | null;
  structuredTitle?: string;
  isFullscreen: boolean;
  onExitFullscreen: () => void;
}) {
  // Fallback: Try to detect input fields from the content using regex
  // (must be before any early returns to satisfy Rules of Hooks)
  const detectedFields = useMemo(
    () => (structuredFields && structuredFields.length > 0 ? null : parseInputFieldsFromText(content)),
    [structuredFields, content],
  );

  // Prioritize structured fields from backend (request_user_input tool)
  if (structuredFields && structuredFields.length > 0) {
    return (
      <motion.div
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
      >
        {structuredTitle && (
          <h3 className="text-lg font-semibold mb-4">{structuredTitle}</h3>
        )}
        <UserInputForm
          fields={structuredFields}
          onSubmit={onSubmitInput}
          disabled={isSubmitting}
        />
      </motion.div>
    );
  }
  
  if (detectedFields && detectedFields.length > 0) {
    return (
      <motion.div
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
      >
        <UserInputForm
          fields={detectedFields}
          onSubmit={onSubmitInput}
          disabled={isSubmitting}
        />
      </motion.div>
    );
  }
  
  // No input fields detected - render as markdown
  if (isFullscreen) {
    return (
      <div className="fixed left-2 right-2 top-[68px] bottom-2 z-[100] bg-background shadow-2xl rounded-lg border border-border flex flex-col">
        {/* Fullscreen header with exit button */}
        <div className="flex items-center justify-between px-3 py-2 border-b border-border/50 bg-background shrink-0">
          <h3 className="text-xs font-medium">Workflow Result</h3>
          <Button
            variant="outline"
            size="sm"
            onClick={onExitFullscreen}
            className="h-7 px-2 gap-1.5 text-xs"
          >
            <Minimize2 className="h-3.5 w-3.5" />
            <span>Exit Fullscreen</span>
          </Button>
        </div>
        
        {/* Content */}
        <div className="flex-1 overflow-auto p-4">
          <ReactMarkdown 
            remarkPlugins={[remarkGfm]}
            components={getMarkdownComponents()}
          >
            {content}
          </ReactMarkdown>
        </div>
      </div>
    );
  }
  
  return (
    <motion.div
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
    >
      <ReactMarkdown 
        remarkPlugins={[remarkGfm]}
        components={getMarkdownComponents()}
      >
        {content}
      </ReactMarkdown>
    </motion.div>
  );
}

/**
 * SkillsRunner - Main execution component with dynamic-agent streaming
 */
export function SkillsRunner({
  config,
  onComplete,
}: SkillsRunnerProps) {
  // Workflow state
  const [status, setStatus] = useState<
    "idle" | "running" | "completed" | "failed" | "cancelled"
  >("idle");
  const [steps, setSteps] = useState<ExecutionStep[]>([]);
  const [toolCalls, setToolCalls] = useState<ToolCall[]>([]);
  const [isThinking, setIsThinking] = useState(false);
  const [finalResult, setFinalResult] = useState<string>("");
  const [error, setError] = useState<string>("");
  const [streamingContent, setStreamingContent] = useState<string>("");
  const [showStreamingOutput, setShowStreamingOutput] = useState(true); // Expanded by default
  const [isSubmittingInput, setIsSubmittingInput] = useState(false);
  const [rightPanelTab, setRightPanelTab] = useState<"output" | "history">("output");
  const [currentRunId, setCurrentRunId] = useState<string | null>(null);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [copied, setCopied] = useState(false);
  const [isOutputExpanded, setIsOutputExpanded] = useState(false);
  const [isSavingWorkflow, setIsSavingWorkflow] = useState(false);
  
  // Structured user input state (from request_user_input tool)
  const [structuredInputFields, setStructuredInputFields] = useState<DetectedInputField[] | null>(null);
  const [structuredInputTitle, setStructuredInputTitle] = useState<string>("");
  
  // Workflow run store
  const { createRun, updateRun } = useWorkflowRunStore();

  // Auth - same pattern as ChatPanel
  const { data: session } = useSession();
  const ssoEnabled = getConfig('ssoEnabled');
  const accessToken = ssoEnabled ? session?.accessToken : undefined;

  // Router for navigation
  const router = useRouter();

  // Stream adapter ref
  const clientRef = useRef<StreamAdapter | null>(null);
  const abortedRef = useRef(false);
  const hasAutoStarted = useRef(false);
  const streamContextRef = useRef<{ conversationId: string; agentId: string } | null>(null);
  const toolNameByIdRef = useRef<Record<string, string>>({});
  
  // Workflow run tracking refs
  const runIdRef = useRef<string | null>(null);
  const startTimeRef = useRef<Date | null>(null);
  const workflowSavedRef = useRef(false);  // Track if we've already saved to avoid duplicates
  const stepsRef = useRef<ExecutionStep[]>([]);
  const toolCallsRef = useRef<ToolCall[]>([]);
  const streamingContentRef = useRef<string>("");
  const finalResultRef = useRef<string>("");

  // Sync refs with state to avoid closure issues
  useEffect(() => {
    stepsRef.current = steps;
  }, [steps]);

  useEffect(() => {
    toolCallsRef.current = toolCalls;
  }, [toolCalls]);

  useEffect(() => {
    streamingContentRef.current = streamingContent;
  }, [streamingContent]);

  useEffect(() => {
    finalResultRef.current = finalResult;
  }, [finalResult]);


  /**
   * Handle copy to clipboard
   */
  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(streamingContent || finalResult || "");
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (error) {
      console.error("Failed to copy:", error);
    }
  };

  /**
   * Handle escape key to exit fullscreen
   */
  useEffect(() => {
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && isFullscreen) {
        setIsFullscreen(false);
      }
    };
    
    window.addEventListener('keydown', handleEscape);
    return () => window.removeEventListener('keydown', handleEscape);
  }, [isFullscreen]);

  /**
   * Handle workflow streaming events
   */
  const handleEvent = useCallback(
    async (event: WorkflowRunnerEvent) => {
      const content = event.text || event.description || event.message || "";

      // Handle plan updates
      if (event.type === "plan_update" && event.steps) {
        const parsedSteps = event.steps.map((s, i) => ({
          id: s.id || `step-${i}`,
          agent: s.agent || "Agent",
          description: s.description,
          status: s.status as ExecutionStep["status"],
          order: i,
        }));
        if (parsedSteps.length > 0) {
          setSteps(parsedSteps);
          const hasInProgress = parsedSteps.some((s) => s.status === "in_progress");
          setIsThinking(hasInProgress);
        }
        return;
      }

      // Handle tool notifications
      if (event.type === "tool_start") {
        const toolName = event.tool || "tool";
        const toolId = `tool-${Date.now()}`;
        const description = event.description || `Calling ${toolName}`;

        setToolCalls((prev) => [
          ...prev,
          {
            id: toolId,
            tool: toolName,
            description: description,
            agent: "Agent",
            status: "running",
            timestamp: Date.now(),
          },
        ]);
        return;
      }

      if (event.type === "tool_end") {
        // Mark most recent running tool as completed
        setToolCalls((prev) => {
          const updated = [...prev];
          const runningIdx = updated.findIndex((t) => t.status === "running");
          if (runningIdx >= 0) {
            updated[runningIdx] = { ...updated[runningIdx], status: "completed" };
          }
          return updated;
        });
        return;
      }

      // Handle structured user input request (HITL)
      if (event.type === "input_required" && event.fields && event.fields.length > 0) {
        console.log("[SkillsRunner] 📝 Received user input request");

        const convertedFields: DetectedInputField[] = event.fields.map((f) => ({
          name: f.name,
          label: f.label || f.name,
          description: undefined,
          type: "text" as const,
          options: undefined,
          required: f.required ?? true,
        }));

        setStructuredInputFields(convertedFields);
        setStructuredInputTitle("User Input Required");
        setStatus("completed"); // Pause for user input
        setIsThinking(false);
        return;
      }

      // Handle stream completion — use accumulated streamingContent as final result
      if (event.type === "done") {
        const finalContent = streamingContentRef.current;
        if (finalContent) {
          setFinalResult(finalContent);
          setStatus("completed");
          setIsThinking(false);

          // Mark all remaining tool calls as completed
          setToolCalls((prev) => {
            const updated = prev.map(tool =>
              tool.status === "running"
                ? { ...tool, status: "completed" as const }
                : tool
            );
            return updated;
          });

          // Save execution artifacts to MongoDB
          const saveExecutionArtifacts = async () => {
            if (!runIdRef.current || !startTimeRef.current) {
              console.warn("[SkillsRunner] ⚠️ No runId or startTime available to save final result");
              return;
            }

            setIsSavingWorkflow(true);

            try {
              const endTime = new Date();
              const currentSteps = stepsRef.current;
              const currentToolCalls = toolCallsRef.current;
              const currentStreamingContent = streamingContentRef.current;

              const finalToolCalls = currentToolCalls.map(tool =>
                tool.status === "running"
                  ? { ...tool, status: "completed" as const }
                  : tool
              );

              console.log(`[SkillsRunner] 💾 Saving execution artifacts for run ${runIdRef.current}`, {
                stepsCount: currentSteps.length,
                toolCallsCount: finalToolCalls.length,
                contentLength: finalContent.length,
              });

              await updateRun(runIdRef.current, {
                status: "completed",
                completed_at: endTime,
                duration_ms: endTime.getTime() - startTimeRef.current.getTime(),
                result_summary: finalContent,
                steps_completed: currentSteps.filter(s => s.status === "completed").length,
                steps_total: currentSteps.length,
                tools_called: finalToolCalls.map(t => t.tool),
                execution_artifacts: {
                  steps: currentSteps.map(s => ({
                    id: s.id,
                    agent: s.agent,
                    description: s.description,
                    status: s.status,
                    order: s.order,
                  })),
                  tool_calls: finalToolCalls.map(t => ({
                    id: t.id,
                    tool: t.tool,
                    description: t.description,
                    agent: t.agent,
                    status: t.status,
                    timestamp: t.timestamp,
                  })),
                  streaming_content: currentStreamingContent,
                },
              });

              console.log(`[SkillsRunner] ✅ Successfully saved execution artifacts for run ${runIdRef.current}`);
              workflowSavedRef.current = true;
            } catch (error) {
              console.error("[SkillsRunner] ❌ Failed to save execution artifacts:", error);
              setError(`Failed to save workflow: ${error instanceof Error ? error.message : String(error)}`);
            } finally {
              setIsSavingWorkflow(false);
            }
          };

          await saveExecutionArtifacts();
          onComplete?.(finalContent);
        }
        return;
      }

      // Accumulate streaming content for display
      if (event.type === "content" && content) {
        setStreamingContent((prev) => prev + content);
      }
    },
    [onComplete, updateRun]
  );

  const createStreamCallbacks = useCallback((): StreamCallbacks => ({
    onContent: (text) => {
      if (!abortedRef.current) {
        void handleEvent({ type: "content", text });
      }
    },
    onToolStart: (toolCallId, toolName) => {
      toolNameByIdRef.current[toolCallId] = toolName;
      if (!abortedRef.current) {
        void handleEvent({
          type: "tool_start",
          tool: toolName,
          description: `Calling ${toolName}`,
        });
      }
    },
    onToolEnd: (toolCallId, toolName, error) => {
      const resolvedToolName = toolName || toolNameByIdRef.current[toolCallId] || "tool";
      delete toolNameByIdRef.current[toolCallId];
      if (!abortedRef.current) {
        void handleEvent({
          type: "tool_end",
          tool: resolvedToolName,
          message: error,
        });
      }
    },
    onInputRequired: (_interruptId, prompt, fields) => {
      if (!abortedRef.current) {
        void handleEvent({
          type: "input_required",
          message: prompt,
          fields: fields.map((field: InputFieldDefinition) => ({
            name: field.field_name,
            label: field.field_label || field.field_name,
            type: field.field_type,
            required: field.required,
          })),
        });
      }
    },
    onWarning: (message) => {
      if (!abortedRef.current) {
        void handleEvent({ type: "content", text: `\n\nWarning: ${message}\n\n` });
      }
    },
    onDone: () => {
      if (!abortedRef.current) {
        void handleEvent({ type: "done" });
      }
    },
    onError: (message) => {
      if (!abortedRef.current) {
        setError(message);
        setStatus("failed");
        setIsThinking(false);
      }
    },
  }), [handleEvent]);

  /**
   * Start workflow execution
   */
  const handleStart = useCallback(async () => {
    setStatus("running");
    setSteps([]);
    setToolCalls([]);
    setFinalResult("");
    setError("");
    setStreamingContent("");
    setIsThinking(true);
    abortedRef.current = false;
    workflowSavedRef.current = false;  // Reset saved flag for new workflow

    // Create workflow run history entry
    const startTime = new Date();
    let runId: string | null = null;
    try {
      runId = await createRun({
        workflow_id: config.id,
        workflow_name: config.name,
        input_prompt: config.is_quick_start && config.tasks.length > 0 
          ? config.tasks[0].llm_prompt 
          : config.description || config.name,
      });
      setCurrentRunId(runId);
      
      // Store in refs for access in event handlers
      runIdRef.current = runId;
      startTimeRef.current = startTime;
      
      console.log(`[SkillsRunner] Created workflow run: ${runId}`);
    } catch (error) {
      console.error("[SkillsRunner] Failed to create workflow run:", error);
      // Continue anyway - history is not critical
      runIdRef.current = null;
      startTimeRef.current = null;
    }

    // Build the prompt:
    // - For quick-start workflows, use the actual task prompt
    // - For multi-step workflows, use the workflow title/description
    let prompt: string;
    if (config.is_quick_start && config.tasks.length > 0 && config.tasks[0].llm_prompt) {
      prompt = config.tasks[0].llm_prompt;
    } else {
      prompt = config.description
        ? `${config.name}: ${config.description}`
        : config.name;
    }

    console.log(`[SkillsRunner] Starting workflow: "${prompt.substring(0, 100)}..."`);

    try {
      const agent = await resolveUsableChatAgent();
      const conversation = await apiClient.createConversation({
        title: `Workflow: ${config.name}`,
        client_type: "webui",
        agent_id: agent.id,
        metadata: {
          source: "skills-runner",
          workflow_id: config.id,
        },
      });
      streamContextRef.current = {
        conversationId: conversation.conversation._id,
        agentId: agent.id,
      };

      const client = createStreamAdapter({
        protocol: "custom",
        accessToken,
      });
      clientRef.current = client;

      await client.streamMessage({
        message: prompt,
        source: "web",
        conversationId: conversation.conversation._id,
        agentId: agent.id,
        clientContext: {
          userEmail: session?.user?.email ?? undefined,
          workflowId: config.id,
        },
      }, createStreamCallbacks());

      // Finalize
      if (!abortedRef.current) {
        setStatus("completed");
        setIsThinking(false);

        // Mark all remaining tool calls as completed
        setToolCalls((prev) =>
          prev.map(tool =>
            tool.status === "running" ? { ...tool, status: "completed" as const } : tool
          )
        );

        // Update workflow run as completed (only if not already saved by final_result handler)
        if (runId && !workflowSavedRef.current) {
          setIsSavingWorkflow(true);
          
          try {
            const endTime = new Date();
            
            // Use refs to get current state (avoid closure issues)
            const currentSteps = stepsRef.current;
            const currentToolCalls = toolCallsRef.current;
            const currentStreamingContent = streamingContentRef.current;
            const currentFinalResult = finalResultRef.current;
            
            const resultSummary = currentFinalResult || currentStreamingContent || "Workflow completed successfully";
            
            // Get the final tool calls state with all marked as completed
            const finalToolCalls = currentToolCalls.map(tool => 
              tool.status === "running" 
                ? { ...tool, status: "completed" as const }
                : tool
            );
            
            console.log(`[SkillsRunner] 💾 Finalizing workflow run ${runId}`, {
              finalResult: currentFinalResult?.substring(0, 100),
              streamingContent: currentStreamingContent?.substring(0, 100),
              resultLength: resultSummary.length,
              stepsCount: currentSteps.length,
              toolCallsCount: finalToolCalls.length,
              completedToolCalls: finalToolCalls.filter(t => t.status === "completed").length
            });
            
            // Store full execution artifacts for replay - CRITICAL: Wait for completion
            await updateRun(runId, {
              status: "completed",
              completed_at: endTime,
              duration_ms: endTime.getTime() - startTime.getTime(),
              result_summary: resultSummary,
              steps_completed: currentSteps.filter(s => s.status === "completed").length,
              steps_total: currentSteps.length,
              tools_called: finalToolCalls.map(t => t.tool),
              execution_artifacts: {
                steps: currentSteps.map(s => ({
                  id: s.id,
                  agent: s.agent,
                  description: s.description,
                  status: s.status,
                  order: s.order,
                })),
                tool_calls: finalToolCalls.map(t => ({
                  id: t.id,
                  tool: t.tool,
                  description: t.description,
                  agent: t.agent,
                  status: t.status,
                  timestamp: t.timestamp,
                })),
                streaming_content: currentStreamingContent,
              },
            });
            
            console.log(`[SkillsRunner] ✅ Successfully updated workflow run ${runId} with full execution artifacts`);
            workflowSavedRef.current = true;
          } catch (error) {
            console.error("[SkillsRunner] ❌ Failed to update workflow run:", error);
            console.error("[SkillsRunner] Error details:", {
              runId,
              error: error instanceof Error ? error.message : String(error),
              stack: error instanceof Error ? error.stack : undefined
            });
            
            // Show error to user
            setError(`Failed to save workflow: ${error instanceof Error ? error.message : String(error)}`);
          } finally {
            setIsSavingWorkflow(false);
          }
        } else if (workflowSavedRef.current) {
          console.log(`[SkillsRunner] ⏭️ Skipping duplicate save - workflow ${runId} already saved`);
        } else {
          console.warn("[SkillsRunner] ⚠️ No runId available to update completion status");
        }
      }
    } catch (err) {
      console.error("[SkillsRunner] Error:", err);
      if (!abortedRef.current) {
        const errorMessage = (err as Error).message || "Workflow execution failed";
        setError(errorMessage);
        setStatus("failed");
        setIsThinking(false);

        // Mark all remaining tool calls as completed (workflow failed)
        setToolCalls((prev) => {
          const updated = prev.map(tool => 
            tool.status === "running" 
              ? { ...tool, status: "completed" as const }
              : tool
          );
          const runningCount = prev.filter(t => t.status === "running").length;
          if (runningCount > 0) {
            console.log(`[SkillsRunner] ⚠️ Marking ${runningCount} remaining tool(s) as completed (workflow failed)`);
          }
          return updated;
        });

        // Update workflow run as failed
        if (runId) {
          try {
            const endTime = new Date();
            const currentSteps = stepsRef.current;
            
            await updateRun(runId, {
              status: "failed",
              completed_at: endTime,
              duration_ms: endTime.getTime() - startTime.getTime(),
              error_message: errorMessage,
              steps_completed: currentSteps.filter(s => s.status === "completed").length,
              steps_total: currentSteps.length,
            });
            console.log(`[SkillsRunner] Updated workflow run ${runId} as failed`);
          } catch (error) {
            console.error("[SkillsRunner] Failed to update workflow run:", error);
          }
        }
      }
    } finally {
      clientRef.current = null;
    }
  }, [config, accessToken, session?.user?.email, createStreamCallbacks, createRun, updateRun]);

  /**
   * Stop workflow execution
   */
  const handleStop = useCallback(async () => {
    abortedRef.current = true;
    if (clientRef.current) {
      clientRef.current.abort();
      clientRef.current = null;
    }
    setStatus("cancelled");
    setIsThinking(false);

    // Mark all remaining tool calls as completed (workflow cancelled)
    setToolCalls((prev) => {
      const updated = prev.map(tool => 
        tool.status === "running" 
          ? { ...tool, status: "completed" as const }
          : tool
      );
      const runningCount = prev.filter(t => t.status === "running").length;
      if (runningCount > 0) {
        console.log(`[SkillsRunner] ⚠️ Marking ${runningCount} remaining tool(s) as completed (workflow cancelled)`);
      }
      return updated;
    });

    // Update workflow run as cancelled
    if (currentRunId) {
      try {
        await updateRun(currentRunId, {
          status: "cancelled",
          completed_at: new Date(),
          steps_completed: steps.filter(s => s.status === "completed").length,
          steps_total: steps.length,
        });
        console.log(`[SkillsRunner] Updated workflow run ${currentRunId} as cancelled`);
      } catch (error) {
        console.error("[SkillsRunner] Failed to update workflow run:", error);
      }
    }
  }, [currentRunId, steps, updateRun]);

  /**
   * Reset workflow
   */
  const handleReset = useCallback(() => {
    setStatus("idle");
    setSteps([]);
    setToolCalls([]);
    setFinalResult("");
    setError("");
    setStreamingContent("");
    
    // Clear workflow run refs
    runIdRef.current = null;
    startTimeRef.current = null;
    streamContextRef.current = null;
    toolNameByIdRef.current = {};
    setIsThinking(false);
    setIsSubmittingInput(false);
    setStructuredInputFields(null);
    setStructuredInputTitle("");
    setCurrentRunId(null);
    abortedRef.current = false;
    // Don't reset hasAutoStarted - allow manual start after reset
  }, []);

  /**
   * Auto-start workflow when component mounts
   */
  useEffect(() => {
    if (!hasAutoStarted.current) {
      hasAutoStarted.current = true;
      console.log("[SkillsRunner] Auto-starting workflow on mount");
      // Small delay to ensure UI is ready
      setTimeout(() => handleStart(), 100);
    }
  }, [handleStart]); // Include handleStart to avoid stale closure

  /**
   * Cleanup: Finalize workflow run on unmount if it has results but wasn't saved
   */
  useEffect(() => {
    return () => {
      // On component unmount, finalize workflow if we have a final result but haven't saved
      const finalizeOnUnmount = async () => {
        const runId = runIdRef.current;
        const startTime = startTimeRef.current;
        const alreadySaved = workflowSavedRef.current;
        const hasFinalResult = finalResultRef.current || streamingContentRef.current;
        
        if (runId && startTime && !alreadySaved && hasFinalResult) {
          console.log(`[SkillsRunner] 🔄 Component unmounting - finalizing workflow ${runId}`);
          
          try {
            const endTime = new Date();
            const currentSteps = stepsRef.current;
            const currentToolCalls = toolCallsRef.current;
            const currentStreamingContent = streamingContentRef.current;
            const currentFinalResult = finalResultRef.current;
            
            const resultSummary = currentFinalResult || currentStreamingContent || "Workflow completed";
            
            const finalToolCalls = currentToolCalls.map(tool => 
              tool.status === "running" 
                ? { ...tool, status: "completed" as const }
                : tool
            );
            
            // CRITICAL: Use navigator.sendBeacon or fetch with keepalive for unmount saves
            // This ensures the request completes even if the page is closing
            const payload = {
              status: "completed",
              completed_at: endTime.toISOString(),
              duration_ms: endTime.getTime() - startTime.getTime(),
              result_summary: resultSummary,
              steps_completed: currentSteps.filter(s => s.status === "completed").length,
              steps_total: currentSteps.length,
              tools_called: finalToolCalls.map(t => t.tool),
              execution_artifacts: {
                steps: currentSteps.map(s => ({
                  id: s.id,
                  agent: s.agent,
                  description: s.description,
                  status: s.status,
                  order: s.order,
                })),
                tool_calls: finalToolCalls.map(t => ({
                  id: t.id,
                  tool: t.tool,
                  description: t.description,
                  agent: t.agent,
                  status: t.status,
                  timestamp: t.timestamp,
                })),
                streaming_content: currentStreamingContent,
              },
            };
            
            // Use fetch with keepalive to ensure request completes on unmount
            await fetch(`/api/workflow-runs?id=${runId}`, {
              method: "PUT",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(payload),
              keepalive: true, // CRITICAL: Keeps request alive even after page unload
            });
            
            console.log(`[SkillsRunner] ✅ Finalized workflow ${runId} on unmount (keepalive)`);
          } catch (error) {
            console.error("[SkillsRunner] ❌ Failed to finalize workflow on unmount:", error);
            console.error("[SkillsRunner] Error details:", {
              runId,
              error: error instanceof Error ? error.message : String(error)
            });
          }
        }
      };
      
      finalizeOnUnmount();
    };
  }, []); // Empty deps - only set up once, uses refs for current values

  /**
   * Handle user input form submission.
   * Resumes the paused dynamic-agent stream for this workflow run.
   */
  const handleUserInputSubmit = useCallback(async (data: Record<string, string>) => {
    setIsSubmittingInput(true);
    
    // Format the user input as a response message
    const formattedResponse = Object.entries(data)
      .map(([key, value]) => `${key.replace(/_/g, " ")}: ${value}`)
      .join("\n");
    
    console.log("[SkillsRunner] Submitting user input:", formattedResponse);
    
    // Reset state for continuation
    setFinalResult("");
    setStreamingContent("");
    setStatus("running");
    setIsThinking(true);
    abortedRef.current = false;
    
    try {
      const streamContext = streamContextRef.current;
      if (!streamContext) {
        throw new Error("Workflow stream context is missing; start the workflow again.");
      }

      const client = createStreamAdapter({
        protocol: "custom",
        accessToken,
      });
      clientRef.current = client;

      await client.resumeStream({
        conversationId: streamContext.conversationId,
        agentId: streamContext.agentId,
        resumeData: JSON.stringify({ type: "form_input", values: data }),
        source: "web",
        clientContext: {
          userEmail: session?.user?.email ?? undefined,
          workflowId: config.id,
        },
      }, createStreamCallbacks());

      // Finalize
      if (!abortedRef.current && status !== "completed") {
        setStatus("completed");
        setIsThinking(false);
      }
    } catch (err) {
      console.error("[SkillsRunner] Error:", err);
      if (!abortedRef.current) {
        setError((err as Error).message || "Failed to submit input");
        setStatus("failed");
        setIsThinking(false);
      }
    } finally {
      clientRef.current = null;
      setIsSubmittingInput(false);
    }
  }, [accessToken, session?.user?.email, config.id, createStreamCallbacks, status]);

  // Get current active step
  const activeStepIndex = steps.findIndex((s) => s.status === "in_progress");

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center justify-between mb-4 shrink-0">
        <div className="flex items-center gap-2">
          {/* Home button */}
          <Button 
            variant="ghost" 
            size="icon" 
            onClick={() => pushWithNavigationProgress(router,'/')}
            title="Go to home page"
          >
            <LayoutGrid className="h-5 w-5" />
          </Button>
          {/* Back to skills catalog */}
          <Button 
            variant="ghost" 
            size="icon" 
            onClick={() => pushWithNavigationProgress(router,'/skills')}
            title="Back to Skills"
          >
            <ArrowLeft className="h-5 w-5" />
          </Button>
          <div>
            <h1 className="text-lg font-semibold">{config.name}</h1>
            {config.description && (
              <p className="text-sm text-muted-foreground line-clamp-1">
                {config.description}
              </p>
            )}
          </div>
        </div>

        <div className="flex items-center gap-2">
          {status === "idle" && (
            <Button
              onClick={handleStart}
              className="gap-2 gradient-primary text-white"
            >
              <Play className="h-4 w-4" />
              Start Workflow
            </Button>
          )}
          {status === "running" && (
            <>
              <Badge variant="secondary" className="gap-1">
                <Loader2 className="h-3 w-3 animate-spin" />
                Running
              </Badge>
              <Button
                variant="outline"
                size="sm"
                onClick={handleStop}
                className="gap-1"
              >
                <Square className="h-3 w-3" />
                Stop
              </Button>
            </>
          )}
          {status === "completed" && (
            <>
              <Badge
                variant="secondary"
                className="gap-1 bg-green-500/10 text-green-500"
              >
                <CheckCircle className="h-3 w-3" />
                Completed
              </Badge>
              <Button
                variant="outline"
                size="sm"
                onClick={handleReset}
                className="gap-1"
              >
                <RotateCcw className="h-4 w-4" />
                Run Again
              </Button>
            </>
          )}
          {status === "failed" && (
            <>
              <Badge
                variant="secondary"
                className="gap-1 bg-red-500/10 text-red-500"
              >
                <XCircle className="h-3 w-3" />
                Failed
              </Badge>
              <Button
                variant="outline"
                size="sm"
                onClick={handleReset}
                className="gap-1"
              >
                <RotateCcw className="h-4 w-4" />
                Retry
              </Button>
            </>
          )}
          {status === "cancelled" && (
            <>
              <Badge variant="secondary" className="gap-1">
                <Square className="h-3 w-3" />
                Cancelled
              </Badge>
              <Button
                variant="outline"
                size="sm"
                onClick={handleReset}
                className="gap-1"
              >
                <RotateCcw className="h-4 w-4" />
                Restart
              </Button>
            </>
          )}
        </div>
      </div>

      {/* Main Content */}
      <div className="flex-1 flex gap-4 overflow-hidden min-h-0">
        {/* Left Panel - Execution Steps */}
        {!isOutputExpanded && (
          <div className="w-80 flex flex-col min-h-0 shrink-0">
            <h2 className="text-sm font-medium text-muted-foreground mb-3 shrink-0">
              Execution Plan
            </h2>

          <ScrollArea className="flex-1">
            <div className="space-y-3 pr-2">
              {status === "idle" && (
                <div className="flex flex-col items-center justify-center py-8 text-center">
                  <Play className="h-10 w-10 text-muted-foreground/30 mb-3" />
                  <p className="text-sm text-muted-foreground">
                    Click &quot;Start Workflow&quot; to begin
                  </p>
                </div>
              )}

              {status === "running" && steps.length === 0 && (
                <div className="flex flex-col items-center justify-center py-8 text-center">
                  <CAIPESpinner size="md" message="Planning execution..." />
                </div>
              )}

              <AnimatePresence mode="popLayout">
                {steps.map((step) => (
                  <ExecutionStepCard
                    key={step.id}
                    step={step}
                    isActive={step.order === activeStepIndex}
                  />
                ))}
              </AnimatePresence>

              {/* Tool calls section */}
              {toolCalls.length > 0 && (
                <div className="mt-4 pt-4 border-t border-border/30">
                  <h3 className="text-xs font-medium text-muted-foreground mb-3 flex items-center gap-2">
                    <Wrench className="h-3.5 w-3.5" />
                    Tool Calls ({toolCalls.length})
                  </h3>
                  <ToolCallIndicator toolCalls={toolCalls} />
                </div>
              )}

              {/* Thinking indicator */}
              <AnimatePresence>
                {isThinking && steps.length > 0 && (
                  <ThinkingIndicator key="thinking-indicator" isThinking={true} />
                )}
              </AnimatePresence>
            </div>
          </ScrollArea>
        </div>
        )}

        {/* Right Panel - Output & History Tabs */}
        <div className={cn(
          "flex-1 flex flex-col min-h-0",
          !isOutputExpanded && "border-l border-border/50 pl-4"
        )}>
          <div className="flex items-center justify-between mb-3 shrink-0">
            {/* Tab Switcher */}
            <div className="flex items-center gap-1 p-0.5 rounded-lg bg-muted/50">
              <button
                onClick={() => setRightPanelTab("output")}
                className={cn(
                  "px-3 py-1.5 text-xs font-medium rounded-md transition-colors",
                  rightPanelTab === "output"
                    ? "bg-background shadow-sm text-foreground"
                    : "text-muted-foreground hover:text-foreground"
                )}
              >
                {finalResult ? "Result" : "Output"}
              </button>
              <button
                onClick={() => setRightPanelTab("history")}
                className={cn(
                  "px-3 py-1.5 text-xs font-medium rounded-md transition-colors",
                  rightPanelTab === "history"
                    ? "bg-background shadow-sm text-foreground"
                    : "text-muted-foreground hover:text-foreground"
                )}
              >
                History
              </button>
            </div>
            <div className="flex items-center gap-1">
              {/* Expand/Collapse button */}
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setIsOutputExpanded(!isOutputExpanded)}
                className="h-7 px-2 gap-1"
                title={isOutputExpanded ? "Show execution plan" : "Expand output"}
              >
                {isOutputExpanded ? (
                  <>
                    <ChevronRight className="h-3.5 w-3.5" />
                    <span className="text-xs">Show Plan</span>
                  </>
                ) : (
                  <>
                    <ChevronLeft className="h-3.5 w-3.5" />
                    <span className="text-xs">Expand</span>
                  </>
                )}
              </Button>
              {/* Copy button */}
              {(streamingContent || finalResult) && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={handleCopy}
                  className="h-7 px-2 gap-1"
                  title="Copy to clipboard"
                >
                  {copied ? (
                    <>
                      <Check className="h-3.5 w-3.5 text-green-500" />
                      <span className="text-xs">Copied</span>
                    </>
                  ) : (
                    <>
                      <Copy className="h-3.5 w-3.5" />
                      <span className="text-xs">Copy</span>
                    </>
                  )}
                </Button>
              )}
              
              {/* Fullscreen button */}
              {(streamingContent || finalResult) && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setIsFullscreen(!isFullscreen)}
                  className="h-7 px-2 gap-1"
                  title={isFullscreen ? "Exit fullscreen" : "Fullscreen"}
                >
                  {isFullscreen ? (
                    <>
                      <Minimize2 className="h-3.5 w-3.5" />
                      <span className="text-xs">Exit</span>
                    </>
                  ) : (
                    <>
                      <Maximize2 className="h-3.5 w-3.5" />
                      <span className="text-xs">Fullscreen</span>
                    </>
                  )}
                </Button>
              )}
              
              {/* Hide/Show Stream toggle */}
              {streamingContent && !finalResult && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setShowStreamingOutput(!showStreamingOutput)}
                  className="gap-1 h-7 text-xs"
                >
                  {showStreamingOutput ? (
                    <>
                      <ChevronUp className="h-3 w-3" />
                      Hide Stream
                    </>
                  ) : (
                    <>
                      <ChevronDown className="h-3 w-3" />
                      Show Stream
                    </>
                  )}
                </Button>
              )}
            </div>
          </div>

          {/* Tab Content */}
          {rightPanelTab === "output" ? (
            <ScrollArea className="flex-1">
              <div className="pr-2">
                {/* Idle state */}
                {status === "idle" && (
                  <div className="flex flex-col items-center justify-center h-full py-12 text-center">
                    <MessageSquare className="h-12 w-12 text-muted-foreground/20 mb-4" />
                    <p className="text-muted-foreground">
                      Results will appear here
                    </p>
                  </div>
                )}

                {/* Running state - show streaming output */}
                {status === "running" && !finalResult && (
                  <div className="space-y-4">
                    {showStreamingOutput && streamingContent && (
                      <StreamingOutputDisplay 
                        content={streamingContent} 
                        isFullscreen={isFullscreen}
                        onExitFullscreen={() => setIsFullscreen(false)}
                      />
                    )}

                    {!showStreamingOutput && (
                      <div className="flex flex-col items-center justify-center py-12 text-center">
                        <CAIPESpinner 
                          size="md" 
                          message={
                            steps.length > 0 
                              ? `Executing workflow... (Step ${activeStepIndex + 1} of ${steps.length})`
                              : "Executing workflow..."
                          } 
                        />
                      </div>
                    )}
                  </div>
                )}

                {/* Completed state - show final result or input form */}
                {(status === "completed" || finalResult) && (
                  <ResultOrInputForm
                    content={finalResult || streamingContent || "Workflow completed."}
                    onSubmitInput={handleUserInputSubmit}
                    isSubmitting={isSubmittingInput}
                    structuredFields={structuredInputFields}
                    structuredTitle={structuredInputTitle}
                    isFullscreen={isFullscreen}
                    onExitFullscreen={() => setIsFullscreen(false)}
                  />
                )}

                {/* Failed state */}
                {status === "failed" && (
                  <motion.div
                    initial={{ opacity: 0, y: 10 }}
                    animate={{ opacity: 1, y: 0 }}
                    className="flex flex-col items-center justify-center py-12 text-center"
                  >
                    <XCircle className="h-12 w-12 text-red-500 mb-4" />
                    <p className="text-lg font-medium text-foreground mb-2">
                      Workflow Failed
                    </p>
                    <p className="text-sm text-muted-foreground max-w-md">
                      {error || "An error occurred during execution"}
                    </p>
                  </motion.div>
                )}

                {/* Cancelled state */}
                {status === "cancelled" && (
                  <motion.div
                    initial={{ opacity: 0, y: 10 }}
                    animate={{ opacity: 1, y: 0 }}
                    className="flex flex-col items-center justify-center py-12 text-center"
                  >
                    <Square className="h-12 w-12 text-muted-foreground mb-4" />
                    <p className="text-lg font-medium text-foreground mb-2">
                      Workflow Cancelled
                    </p>
                    <p className="text-sm text-muted-foreground">
                      The workflow was stopped before completion
                    </p>
                  </motion.div>
                )}
              </div>
            </ScrollArea>
          ) : (
            <div className="flex-1 overflow-hidden">
              <WorkflowHistoryView
                workflowId={config.id}
                onReRun={() => {
                  setRightPanelTab("output");
                  handleReset();
                  setTimeout(() => handleStart(), 100);
                }}
              />
            </div>
          )}
        </div>
      </div>
      
      {/* Fullscreen overlay backdrop */}
      <AnimatePresence>
        {isFullscreen && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed left-0 right-0 top-[64px] bottom-0 bg-black/60 backdrop-blur-sm z-[99]"
            onClick={() => setIsFullscreen(false)}
          />
        )}
      </AnimatePresence>
      
      {/* Saving workflow overlay */}
      <AnimatePresence>
        {isSavingWorkflow && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 bg-black/70 backdrop-blur-md z-[100] flex items-center justify-center"
          >
            <motion.div
              initial={{ scale: 0.9, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              exit={{ scale: 0.9, opacity: 0 }}
              className="bg-card p-8 rounded-lg border border-border shadow-2xl"
            >
              <CAIPESpinner size="lg" message="Saving workflow..." />
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
