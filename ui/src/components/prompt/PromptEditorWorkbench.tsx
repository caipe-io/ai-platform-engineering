"use client";

import { Eye,Loader2,Pencil,Sparkles } from "lucide-react";
import React,{ useState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useTheme } from "@/components/theme-provider";
import { isLightColorTheme } from "@/lib/color-theme";
import { cn } from "@/lib/utils";

const CodeMirrorEditor = React.lazy(() => import("@uiw/react-codemirror"));

export type PromptSuggestStyle = "concise" | "comprehensive";

export interface PromptSuggestRequest {
  instruction?: string;
  enhanceExisting: boolean;
  style: PromptSuggestStyle;
}

interface PromptEditorWorkbenchProps {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  required?: boolean;
  readOnly?: boolean;
  height?: number;
  suggestLabel?: string;
  suggestInstructionLabel?: string;
  suggestInstructionPlaceholder?: string;
  suggestDisabled?: boolean;
  suggestTitle?: string;
  onSuggest?: (request: PromptSuggestRequest) => Promise<string | void>;
  className?: string;
}

export function PromptEditorWorkbench({
  id,
  label,
  value,
  onChange,
  placeholder = "Write instructions...",
  required = false,
  readOnly = false,
  height = 360,
  suggestLabel = "AI Suggest",
  suggestInstructionLabel = "What should the prompt cover?",
  suggestInstructionPlaceholder = "e.g., Be concise and include edge cases...",
  suggestDisabled = false,
  suggestTitle,
  onSuggest,
  className,
}: PromptEditorWorkbenchProps) {
  const { resolvedTheme } = useTheme();
  const editorIsLight = isLightColorTheme(resolvedTheme);
  const [tab, setTab] = useState<"edit" | "preview">("edit");
  const [showSuggest, setShowSuggest] = useState(false);
  const [instruction, setInstruction] = useState("");
  const [enhanceExisting, setEnhanceExisting] = useState(false);
  const [style, setStyle] = useState<PromptSuggestStyle>("concise");
  const [suggesting, setSuggesting] = useState(false);

  const canSuggest = Boolean(onSuggest) && !readOnly && !suggestDisabled && !suggesting;

  const runSuggest = async () => {
    if (!onSuggest) return;
    setSuggesting(true);
    try {
      const next = await onSuggest({
        instruction: instruction.trim() || undefined,
        enhanceExisting,
        style,
      });
      if (typeof next === "string") {
        onChange(next);
        setTab("preview");
      }
      setInstruction("");
      setShowSuggest(false);
    } finally {
      setSuggesting(false);
    }
  };

  return (
    <div className={cn("space-y-2", className)}>
      <div className="flex items-center justify-between gap-3">
        <Label htmlFor={id} className="block">
          {label}{required && <span className="text-destructive"> *</span>}
        </Label>
        {onSuggest && (
          <div className="relative">
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-7 gap-1 px-2 text-xs border-primary/30 text-primary hover:bg-primary/10"
              disabled={!canSuggest}
              title={suggestTitle}
              onClick={() => {
                setEnhanceExisting(Boolean(value.trim()));
                setShowSuggest((open) => !open);
              }}
            >
              {suggesting ? <Loader2 className="h-3 w-3 animate-spin" /> : <Sparkles className="h-3 w-3" />}
              {suggestLabel}
            </Button>
            {showSuggest && (
              <div className="absolute right-0 top-full z-50 mt-1 w-80 rounded-lg border border-border/50 bg-background p-3 shadow-xl">
                <label className="mb-1.5 block text-xs font-medium text-muted-foreground">
                  {suggestInstructionLabel}
                </label>
                <Input
                  autoFocus
                  value={instruction}
                  onChange={(event) => setInstruction(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") void runSuggest();
                    if (event.key === "Escape") setShowSuggest(false);
                  }}
                  placeholder={suggestInstructionPlaceholder}
                  className="mb-2 h-8 text-sm"
                />
                {value.trim() && (
                  <label className="mb-2 flex cursor-pointer items-center gap-2">
                    <input
                      type="checkbox"
                      checked={enhanceExisting}
                      onChange={(event) => setEnhanceExisting(event.target.checked)}
                      className="rounded border-muted"
                    />
                    <span className="text-xs text-muted-foreground">Enhance existing text</span>
                  </label>
                )}
                <div className="mb-2 flex items-center gap-1">
                  {(["concise", "comprehensive"] as PromptSuggestStyle[]).map((option) => (
                    <button
                      key={option}
                      type="button"
                      className={cn(
                        "rounded-full border px-2 py-0.5 text-xs capitalize transition-colors",
                        style === option
                          ? "border-primary bg-primary/10 text-primary"
                          : "border-border text-muted-foreground hover:border-primary/30",
                      )}
                      onClick={() => setStyle(option)}
                    >
                      {option}
                    </button>
                  ))}
                </div>
                <div className="flex justify-end gap-1.5">
                  <Button type="button" variant="ghost" size="sm" className="h-7 text-xs" onClick={() => setShowSuggest(false)}>
                    Cancel
                  </Button>
                  <Button type="button" size="sm" className="h-7 gap-1 text-xs gradient-primary text-white" onClick={() => void runSuggest()}>
                    <Sparkles className="h-3 w-3" />
                    Generate
                  </Button>
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      <div className="flex items-center gap-1 border-b border-border/30">
        <button
          type="button"
          onClick={() => setTab("edit")}
          className={cn(
            "flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium border-b-2 transition-colors -mb-px",
            tab === "edit" ? "border-primary text-primary" : "border-transparent text-muted-foreground hover:text-foreground",
          )}
        >
          <Pencil className="h-3 w-3" />
          Edit
        </button>
        <button
          type="button"
          onClick={() => setTab("preview")}
          className={cn(
            "flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium border-b-2 transition-colors -mb-px",
            tab === "preview" ? "border-primary text-primary" : "border-transparent text-muted-foreground hover:text-foreground",
          )}
        >
          <Eye className="h-3 w-3" />
          Preview
        </button>
      </div>

      {tab === "edit" ? (
        <div className={cn("overflow-hidden rounded-lg border", editorIsLight ? "border-border bg-white" : "border-border/30 bg-[#1e1e2e]")} style={{ height }}>
          <React.Suspense
            fallback={
              <div className="flex h-48 items-center justify-center text-zinc-500">
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                <span className="text-sm">Loading editor...</span>
              </div>
            }
          >
            <CodeMirrorEditor
              value={value}
              onChange={(next: string) => onChange(next)}
              theme={editorIsLight ? "light" : "dark"}
              height={`${height}px`}
              style={{ fontSize: "15px" }}
              basicSetup={{
                lineNumbers: true,
                foldGutter: true,
                highlightActiveLine: true,
                bracketMatching: true,
                autocompletion: false,
                indentOnInput: true,
              }}
              placeholder={placeholder}
              editable={!readOnly && !suggesting}
            />
          </React.Suspense>
        </div>
      ) : (
        <div className="overflow-y-auto rounded-lg border p-4 text-sm" style={{ height }}>
          {value.trim() ? (
            <div className="whitespace-pre-wrap leading-relaxed">{value}</div>
          ) : (
            <p className="text-sm italic text-muted-foreground">Nothing to preview. Switch to Edit to write your prompt.</p>
          )}
        </div>
      )}
    </div>
  );
}
