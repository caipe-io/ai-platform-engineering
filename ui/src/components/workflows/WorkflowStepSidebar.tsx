"use client";

import type { AgentAvatarAgent } from "@/components/dynamic-agents/AgentAvatar";
import type { Extension } from "@codemirror/state";
import { AgentPicker,type AgentPickerOption } from "@/components/ui/agent-picker";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import type { WorkflowStep } from "@/types/workflow-config";
import {
AlertCircle,
ChevronDown,
ChevronUp,
Code,
Loader2,
Lock,
MousePointerClick,
Plus,
Trash2,
} from "lucide-react";
import dynamic from "next/dynamic";
import { useCallback,useEffect,useRef,useState } from "react";
import { StepToolOverridePicker } from "./StepToolOverridePicker";

// Lazy-load CodeMirror to avoid SSR issues
const CodeMirrorEditor = dynamic(() => import("@uiw/react-codemirror"), {
  ssr: false,
  loading: () => <div className="h-[200px] rounded-md border border-input bg-muted/30 animate-pulse" />,
});

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SidebarAgent {
  _id: string;
  name: string;
  description?: string;
  ui?: AgentAvatarAgent["ui"];
}

interface WorkflowStepSidebarProps {
  step: WorkflowStep | null;
  stepIndex: number;
  onChange: (updates: Partial<WorkflowStep>) => void;
  onDelete: (stepIndex: number) => void;
  onAddStep?: () => void;
  agents: SidebarAgent[];
  agentsLoading: boolean;

  readOnly?: boolean;
  readOnlyHint?: string;
}


// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function WorkflowStepSidebar({
  step,
  stepIndex,
  onChange,
  onDelete,
  onAddStep,
  agents,
  agentsLoading,
  readOnly,
  readOnlyHint,
}: WorkflowStepSidebarProps) {
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [configOverrideJson, setConfigOverrideJson] = useState(
    step?.config_override ? JSON.stringify(step.config_override, null, 2) : "",
  );
  const [configOverrideError, setConfigOverrideError] = useState<string | null>(null);

  // CodeMirror extensions (loaded async to avoid SSR)
  const [cmExtensions, setCmExtensions] = useState<Extension[]>([]);

  useEffect(() => {
    let cancelled = false;
    Promise.all([
      import("@codemirror/lang-markdown"),
      import("@codemirror/language-data"),
      import("@codemirror/view"),
      import("@/lib/codemirror/jinja2-highlight"),
    ]).then(([mdMod, langDataMod, viewMod, jinja2Mod]) => {
      if (!cancelled) {
        setCmExtensions([
          mdMod.markdown({ codeLanguages: langDataMod.languages }),
          viewMod.EditorView.lineWrapping,
          jinja2Mod.jinja2Highlight,
        ]);
      }
    });
    return () => { cancelled = true; };
  }, []);

  // Reset local JSON state when step changes
  const lastStepIndexRef = useRef(stepIndex);
  if (stepIndex !== lastStepIndexRef.current) {
    lastStepIndexRef.current = stepIndex;
    setConfigOverrideJson(step?.config_override ? JSON.stringify(step.config_override, null, 2) : "");
    setConfigOverrideError(null);
  }

  const handleConfigOverrideChange = useCallback(
    (value: string) => {
      setConfigOverrideJson(value);
      if (!value.trim()) {
        setConfigOverrideError(null);
        onChange({ config_override: null });
        return;
      }
      try {
        const parsed = JSON.parse(value);
        setConfigOverrideError(null);
        onChange({ config_override: parsed });
      } catch {
        setConfigOverrideError("Invalid JSON");
      }
    },
    [onChange],
  );

  /** Called by StepToolOverridePicker — merges tool keys into config_override */
  const handleToolOverrideChange = useCallback(
    (toolOverride: Record<string, unknown> | null) => {
      if (!toolOverride) {
        // Remove tool keys from existing override
        const existing = step?.config_override ? { ...step.config_override } : null;
        if (existing) {
          delete (existing as Record<string, unknown>).allowed_tools;
          delete (existing as Record<string, unknown>).builtin_tools;
          delete (existing as Record<string, unknown>).disabled_builtin_tools;
          const cleaned = Object.keys(existing).length > 0 ? existing : null;
          onChange({ config_override: cleaned });
          setConfigOverrideJson(cleaned ? JSON.stringify(cleaned, null, 2) : "");
        }
      } else {
        const merged = { ...(step?.config_override || {}), ...toolOverride };
        onChange({ config_override: merged });
        setConfigOverrideJson(JSON.stringify(merged, null, 2));
      }
    },
    [step?.config_override, onChange],
  );

  if (!step) {
    // No steps at all — prompt to add first step
    if (onAddStep && !readOnly) {
      return (
        <div className="w-[624px] border-l border-border bg-card/50 flex items-center justify-center">
          <div className="text-center px-6">
            <Plus className="h-8 w-8 text-muted-foreground/30 mx-auto mb-3" />
            <p className="text-sm text-muted-foreground mb-4">
              No steps yet. Add your first step to get started.
            </p>
            <Button variant="outline" size="sm" onClick={onAddStep} className="gap-1.5">
              <Plus className="h-3.5 w-3.5" />
              Add Step
            </Button>
          </div>
        </div>
      );
    }

    // Steps exist but none selected
    return (
      <div className="w-[624px] border-l border-border bg-card/50 flex items-center justify-center">
        <div className="text-center px-6 max-w-sm">
          {readOnly ? (
            <>
              <Lock className="h-8 w-8 text-amber-500/60 mx-auto mb-3" />
              <p className="text-sm text-foreground font-medium mb-1">View only</p>
              <p className="text-xs text-muted-foreground leading-relaxed">
                {readOnlyHint ??
                  "This workflow cannot be edited here. Use Clone to edit to create your own copy."}
              </p>
            </>
          ) : (
            <>
              <MousePointerClick className="h-8 w-8 text-muted-foreground/30 mx-auto mb-3" />
              <p className="text-sm text-muted-foreground">
                Select a step on the canvas to edit its properties
              </p>
            </>
          )}
        </div>
      </div>
    );
  }


  return (
    <div className="w-[624px] border-l border-border bg-card/50 flex flex-col overflow-hidden">
      {/* Header */}
      <div className="p-4 border-b border-border shrink-0 flex items-center justify-between">
        <div>
          <h3 className="text-sm font-bold text-foreground">Step #{stepIndex + 1}</h3>
          <p className="text-xs text-muted-foreground mt-0.5">Edit step properties</p>
        </div>
        <Button
          variant="outline"
          size="sm"
          className="h-7 gap-1 text-xs text-destructive border-destructive/30 hover:bg-destructive hover:text-destructive-foreground"
          onClick={() => onDelete(stepIndex)}
          title="Delete step"
          disabled={readOnly}
        >
          <Trash2 className="h-3 w-3" />
           Delete Step
        </Button>
      </div>

      {/* Read-only banner for config-driven workflows */}
      {readOnly && (
        <div className="px-4 py-2.5 bg-amber-500/10 border-b border-amber-500/20 flex items-center gap-2 shrink-0">
          <Lock className="h-3.5 w-3.5 text-amber-500 shrink-0" />
          <p className="text-xs text-amber-600 dark:text-amber-400">
            {readOnlyHint ??
              "This workflow is seeded from config and is not editable."}
          </p>
        </div>
      )}

      {/* Scrollable content */}
      <fieldset disabled={!!readOnly} className="flex-1 overflow-y-auto p-4 space-y-4 disabled:opacity-60">
        {/* Agent */}
        <div className="space-y-2">
          <Label className="text-xs font-semibold">Agent</Label>
          {agentsLoading ? (
            <div className="flex items-center gap-2 h-9 px-3 text-xs text-muted-foreground">
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              Loading agents...
            </div>
          ) : (
            <AgentPicker
              value={step.agent_id}
              onChange={(agentId) => onChange({ agent_id: agentId })}
              placeholder="Select an agent..."
              options={agents.map<AgentPickerOption>((a) => ({ value: a._id, label: a.name }))}
              hideIdSuffix
            />
          )}
        </div>

        {/* Prompt */}
        <div className="space-y-2">
          <Label htmlFor="prompt" className="text-xs font-semibold">
            Prompt
          </Label>
          <div className="rounded-md border border-input overflow-hidden">
            <CodeMirrorEditor
              value={step.prompt}
              onChange={(val: string) => onChange({ prompt: val })}
              extensions={cmExtensions}
              theme="dark"
              height="200px"
              style={{ fontSize: "13px" }}
              basicSetup={{
                lineNumbers: false,
                foldGutter: false,
                highlightActiveLine: true,
                bracketMatching: true,
                autocompletion: false,
                indentOnInput: true,
              }}
              placeholder="e.g. Create a GitHub repo.&#10;Context: {{ previous_output }}"
            />
          </div>
        </div>

        {/* Display Text */}
        <div className="space-y-2">
          <Label htmlFor="display_text" className="text-xs font-semibold">
            Step Name
          </Label>
          <Input
            id="display_text"
            value={step.display_text}
            onChange={(e) => onChange({ display_text: e.target.value })}
            placeholder="e.g., Create the repository"
            className="text-sm"
          />
        </div>

        {/* Error Handling + Retry */}
        <div className="flex gap-3">
          <div className="flex-1 space-y-2">
            <Label htmlFor="on_error" className="text-xs font-semibold">
              Error Handling
            </Label>
            <Select
              id="on_error"
              value={step.on_error}
              onChange={(e) => {
                const v = e.target.value as "abort" | "skip" | "retry";
                onChange({
                  on_error: v,
                  retry: v === "retry" ? { max_attempts: 3 } : null,
                });
              }}
              className={cn(
                "flex h-8 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm",
                "transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
              )}
            >
              <option value="abort">Abort workflow</option>
              <option value="skip">Skip step</option>
              <option value="retry">Retry step</option>
            </Select>
          </div>
          {step.on_error === "retry" && (
            <div className="w-24 space-y-2">
              <Label htmlFor="max_attempts" className="text-xs font-semibold">
                Retries
              </Label>
              <Input
                id="max_attempts"
                type="number"
                min={1}
                max={10}
                value={step.retry?.max_attempts || 3}
                onChange={(e) =>
                  onChange({ retry: { max_attempts: parseInt(e.target.value) || 3 } })
                }
                className="text-sm"
              />
            </div>
          )}
        </div>

        {/* Tool Access (collapsible) */}
        <StepToolOverridePicker
          agentId={step.agent_id}
          configOverride={step.config_override as Record<string, unknown> | null}
          onConfigOverrideChange={handleToolOverrideChange}
          readOnly={readOnly}
        />

        {/* Additional Overrides (Advanced, collapsible) */}
        <div>
          <button
            onClick={() => setShowAdvanced(!showAdvanced)}
            className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors"
          >
            <Code className="h-3 w-3" />
            Additional Overrides
            {showAdvanced ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
          </button>
          {showAdvanced && (
            <div className="mt-2 space-y-2">
              <Label className="text-xs font-semibold">Config Override (JSON)</Label>
              <Textarea
                value={configOverrideJson}
                onChange={(e) => handleConfigOverrideChange(e.target.value)}
                placeholder='{"system_prompt": "...", "model": {...}}'
                className={cn(
                  "text-xs font-mono min-h-[100px] resize-y",
                  configOverrideError && "border-destructive focus-visible:ring-destructive",
                )}
              />
              {configOverrideError && (
                <p className="text-[10px] text-destructive flex items-center gap-1">
                  <AlertCircle className="h-3 w-3" />
                  {configOverrideError}
                </p>
              )}
              <p className="text-[10px] text-muted-foreground">
                Override system_prompt, model, or other config for this step.
                Setting allowed_tools here takes precedence over the Tool Access picker above.
              </p>
            </div>
          )}
        </div>
      </fieldset>
    </div>
  );
}
