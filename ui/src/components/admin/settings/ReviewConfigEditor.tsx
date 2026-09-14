"use client";

/**
 * ReviewConfigEditor — admin form for one fixed `review_configs` document.
 *
 * Each instance is pinned to a single target (e.g. "agent-system-prompt"),
 * loads the persisted config (which the backend self-seeds with built-in
 * defaults on first read), and saves via PUT. There is no create or delete
 * path — the set of targets is fixed in `lib/server/ai-review/defaults.ts`.
 *
 * Controlled-state only — the codebase does not use react-hook-form.
 */

import { SaveButton } from "@/components/admin/shared/SaveButton";
import {
type GradeThresholds,
type ReviewConfig,
type ReviewConfigUpdate,
type ReviewCriterion,
type ReviewEnforcement,
type ReviewSeverity,
DEFAULT_GRADE_THRESHOLDS,
} from "@/components/ai-review";
import { Button } from "@/components/ui/button";
import {
Card,
CardContent,
CardDescription,
CardHeader,
CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ModelPicker } from "@/components/ui/model-picker";
import { Select } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/components/ui/toast";
import { cn } from "@/lib/utils";
import {
AlertCircle,
Loader2,
Plus,
Trash2,
} from "lucide-react";
import * as React from "react";

const ID_SLUG_RE = /^[a-zA-Z0-9][a-zA-Z0-9._/-]*$/;
const MICRO_PROMPT_SOFT_LIMIT = 500;

export interface ReviewConfigEditorProps {
  /** Stable target id (e.g. "agent-system-prompt"). */
  target: string;
  /** Render the configuration without allowing changes. */
  readOnly?: boolean;
  /** Notified after a successful save so the parent can refresh adjacent state. */
  onSaved?: (config: ReviewConfig) => void;
  /** Hide the editor-local save button when the parent renders one in its header. */
  showInlineSave?: boolean;
  /** Lets a parent header button mirror this editor's saving state. */
  onSavingChange?: (saving: boolean) => void;
  /** Lets a parent header button avoid saving while the editor is still loading. */
  onReadyChange?: (ready: boolean) => void;
  /** Lets a parent header button gate itself on unsaved changes. */
  onDirtyChange?: (dirty: boolean) => void;
}

export interface ReviewConfigEditorHandle {
  save: () => Promise<void>;
}

interface FormState {
  enabled: boolean;
  enforcement: ReviewEnforcement;
  min_score: number;
  grade_thresholds: GradeThresholds;
  model_id: string;
  model_provider: string;
  criteria: ReviewCriterion[];
}

function emptyState(): FormState {
  return {
    enabled: true,
    enforcement: "informational",
    min_score: 0.85,
    grade_thresholds: { ...DEFAULT_GRADE_THRESHOLDS },
    model_id: "",
    model_provider: "",
    criteria: [],
  };
}

function configToState(cfg: ReviewConfig): FormState {
  return {
    enabled: cfg.enabled,
    enforcement: cfg.enforcement,
    min_score: cfg.min_score,
    grade_thresholds: { ...cfg.grade_thresholds },
    model_id: cfg.model?.id ?? "",
    model_provider: cfg.model?.provider ?? "",
    criteria: cfg.criteria.map((c) => ({ ...c })),
  };
}

function makeCriterion(): ReviewCriterion {
  // Random suffix prevents collisions if user clicks Add repeatedly.
  const suffix = Math.random().toString(36).slice(2, 6);
  return {
    id: `criterion-${suffix}`,
    name: "",
    severity: "warning",
    weight: 1,
    micro_prompt: "",
    expects_fix: false,
  };
}

function unwrapApiBody<T>(body: unknown): T {
  if (
    typeof body === "object" &&
    body !== null &&
    "data" in (body as Record<string, unknown>) &&
    (body as { data?: unknown }).data !== undefined
  ) {
    return (body as { data: T }).data;
  }
  return body as T;
}

export const ReviewConfigEditor = React.forwardRef<ReviewConfigEditorHandle, ReviewConfigEditorProps>(
  function ReviewConfigEditor(
    {
      target,
      readOnly = false,
      onSaved,
      showInlineSave = true,
      onSavingChange,
      onReadyChange,
      onDirtyChange,
    },
    ref,
  ) {
  const { toast } = useToast();
  const [loading, setLoading] = React.useState(true);
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [state, setState] = React.useState<FormState>(emptyState);
  // Last-persisted snapshot so the Save button only enables on real edits.
  const [savedState, setSavedState] = React.useState<FormState>(emptyState);
  const [availableModels, setAvailableModels] = React.useState<
    { model_id: string; name: string; provider: string }[]
  >([]);
  const [modelsLoading, setModelsLoading] = React.useState(true);

  const dirty = JSON.stringify(state) !== JSON.stringify(savedState);

  React.useEffect(() => {
    onSavingChange?.(saving);
  }, [onSavingChange, saving]);

  React.useEffect(() => {
    onReadyChange?.(!loading);
  }, [loading, onReadyChange]);

  React.useEffect(() => {
    onDirtyChange?.(dirty);
  }, [dirty, onDirtyChange]);

  // Mirror DynamicAgentEditor: pull the platform's configured LLMs so admins
  // pick from the same dropdown instead of typing free-form ids/providers.
  React.useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/dynamic-agents/models");
        if (!res.ok) throw new Error(`(${res.status}) ${res.statusText}`);
        const body = (await res.json()) as {
          data?: { model_id: string; name: string; provider: string }[];
        };
        if (!cancelled) setAvailableModels(body.data ?? []);
      } catch (err) {
        if (!cancelled) console.error("Failed to fetch models:", err);
      } finally {
        if (!cancelled) setModelsLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Default the picker to the first available model when the persisted
  // config didn't pin one. Mirrors DynamicAgentEditor's first-in-list default.
  React.useEffect(() => {
    if (availableModels.length === 0) return;
    setState((s) => {
      if (s.model_id && s.model_provider) return s;
      const first = availableModels[0];
      return { ...s, model_id: first.model_id, model_provider: first.provider };
    });
  }, [availableModels]);

  // Load the persisted config (which self-seeds defaults on first read).
  React.useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    (async () => {
      try {
        const res = await fetch(
          `/api/review-configs/${encodeURIComponent(target)}`,
        );
        if (!res.ok) {
          throw new Error(
            `Failed to load review config (${res.status} ${res.statusText})`,
          );
        }
        const body = (await res.json()) as unknown;
        const cfg = unwrapApiBody<ReviewConfig>(body);
        if (cancelled) return;
        const loaded = configToState(cfg);
        setState(loaded);
        setSavedState(loaded);
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : String(err));
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [target]);

  // ─────────────────────────────────────────────────────────────
  // Validation
  // ─────────────────────────────────────────────────────────────

  function validate(s: FormState): string | null {
    const t = s.grade_thresholds;
    if (!(t.A > t.B && t.B > t.C && t.C > t.D)) {
      return "Grade thresholds must be strictly descending: A > B > C > D";
    }
    for (const v of [t.A, t.B, t.C, t.D]) {
      if (!Number.isFinite(v) || v < 0 || v > 1) {
        return "Grade thresholds must each be in [0, 100]";
      }
    }
    const seen = new Set<string>();
    for (let i = 0; i < s.criteria.length; i++) {
      const c = s.criteria[i];
      if (!c.id.trim()) return `Criterion #${i + 1}: id is required`;
      if (!ID_SLUG_RE.test(c.id)) {
        return `Criterion #${i + 1}: id must be a slug (alphanumerics, dot, slash, hyphen, underscore)`;
      }
      if (seen.has(c.id)) {
        return `Criterion #${i + 1}: id "${c.id}" is duplicated`;
      }
      seen.add(c.id);
      if (!c.name.trim()) return `Criterion #${i + 1}: name is required`;
      if (!c.micro_prompt.trim()) {
        return `Criterion #${i + 1}: micro prompt is required`;
      }
      if (!Number.isFinite(c.weight) || c.weight < 0) {
        return `Criterion #${i + 1}: weight must be ≥ 0`;
      }
    }
    return null;
  }

  // ─────────────────────────────────────────────────────────────
  // Save
  // ─────────────────────────────────────────────────────────────

  async function handleSave() {
    if (readOnly) return;
    const validationError = validate(state);
    if (validationError) {
      setError(validationError);
      toast(validationError, "error");
      return;
    }
    setError(null);
    setSaving(true);
    try {
      const modelObj =
        state.model_id && state.model_provider
          ? { id: state.model_id, provider: state.model_provider }
          : undefined;

      const payload: ReviewConfigUpdate = {
        enabled: state.enabled,
        enforcement: state.enforcement,
        min_score: state.min_score,
        grade_thresholds: state.grade_thresholds,
        model: modelObj,
        criteria: state.criteria.map((c) => ({
          ...c,
          id: c.id.trim(),
          name: c.name.trim(),
          micro_prompt: c.micro_prompt,
        })),
      };

      const res = await fetch(
        `/api/review-configs/${encodeURIComponent(target)}`,
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        },
      );
      const body = (await res.json()) as unknown;
      if (!res.ok) {
        const msg =
          (body as { error?: string })?.error ||
          `Save failed: ${res.status} ${res.statusText}`;
        throw new Error(msg);
      }
      const saved = unwrapApiBody<ReviewConfig>(body);
      const persisted = configToState(saved);
      setState(persisted);
      setSavedState(persisted);
      toast("Review config saved", "success");
      onSaved?.(saved);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(msg);
      toast(msg, "error");
    } finally {
      setSaving(false);
    }
  }

  React.useImperativeHandle(ref, () => ({ save: handleSave }));

  // ─────────────────────────────────────────────────────────────
  // Criteria mutations
  // ─────────────────────────────────────────────────────────────

  function updateCriterion(idx: number, patch: Partial<ReviewCriterion>) {
    setState((s) => {
      const next = [...s.criteria];
      next[idx] = { ...next[idx], ...patch };
      return { ...s, criteria: next };
    });
  }

  function removeCriterion(idx: number) {
    setState((s) => ({
      ...s,
      criteria: s.criteria.filter((_, i) => i !== idx),
    }));
  }

  function addCriterion() {
    setState((s) => ({ ...s, criteria: [...s.criteria, makeCriterion()] }));
  }

  // ─────────────────────────────────────────────────────────────
  // Render
  // ─────────────────────────────────────────────────────────────

  if (loading) {
    return (
      <div className="flex justify-center py-12">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <fieldset disabled={readOnly} className="space-y-4">
      {showInlineSave && (
        <SaveButton
          onSave={handleSave}
          saving={saving}
          dirty={dirty}
          wrapperClassName="justify-end"
        />
      )}

      {error && (
        <div className="flex items-start gap-2 px-3 py-2 rounded-md bg-red-500/10 text-red-600 dark:text-red-400 text-sm">
          <AlertCircle className="h-4 w-4 shrink-0 mt-0.5" />
          <span className="break-words">{error}</span>
        </div>
      )}

      {/* Enforcement */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Enforcement</CardTitle>
          <CardDescription>
            Master switch and how failures affect consumer flows.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <label className="flex items-start gap-2 cursor-pointer">
            <input
              type="checkbox"
              className="mt-1 h-4 w-4 accent-primary"
              checked={state.enabled}
              onChange={(e) =>
                setState((s) => ({ ...s, enabled: e.target.checked }))
              }
            />
            <div>
              <div className="text-sm font-medium">Enabled</div>
              <div className="text-[11px] text-muted-foreground">
                When off, the AI Review button is hidden in the consumer UI.
              </div>
            </div>
          </label>

          <div className="space-y-2">
            <Label>Mode</Label>
            <div className="flex flex-col sm:flex-row gap-2">
              {(
                [
                  {
                    value: "blocking" as const,
                    title: "Blocking",
                    desc: "Failing review prevents Next/Save until fixed",
                  },
                  {
                    value: "informational" as const,
                    title: "Informational",
                    desc: "Show the score; never block the user",
                  },
                ]
              ).map((opt) => {
                const active = state.enforcement === opt.value;
                return (
                  <label
                    key={opt.value}
                    className={cn(
                      "flex-1 cursor-pointer rounded-md border p-3 text-sm transition-colors",
                      active
                        ? "border-primary bg-primary/5"
                        : "border-border hover:bg-muted/30",
                    )}
                  >
                    <input
                      type="radio"
                      name={`rc-enforcement-${target}`}
                      value={opt.value}
                      checked={active}
                      onChange={() =>
                        setState((s) => ({ ...s, enforcement: opt.value }))
                      }
                      className="sr-only"
                    />
                    <div className="font-medium">{opt.title}</div>
                    <div className="text-[11px] text-muted-foreground mt-0.5">
                      {opt.desc}
                    </div>
                  </label>
                );
              })}
            </div>
          </div>

          {state.enforcement === "blocking" && (
            <div className="space-y-1.5">
              <Label htmlFor={`rc-min-score-${target}`}>
                Min score (0–100)
              </Label>
              <Input
                id={`rc-min-score-${target}`}
                type="number"
                min={0}
                max={100}
                step={1}
                value={Math.round(state.min_score * 100)}
                onChange={(e) =>
                  setState((s) => ({
                    ...s,
                    min_score:
                      Math.max(0, Math.min(100, Number(e.target.value))) / 100,
                  }))
                }
                className="max-w-[10rem]"
              />
              <p className="text-[11px] text-muted-foreground">
                Reviews scoring below this threshold block Next/Save.
              </p>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Grade thresholds */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Grade thresholds (0–100)</CardTitle>
          <CardDescription>
            Score buckets for the letter grade. Must be strictly descending: A
            &gt; B &gt; C &gt; D.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            {(["A", "B", "C", "D"] as const).map((k) => (
              <div key={k} className="space-y-1.5">
                <Label htmlFor={`rc-thr-${target}-${k}`}>{k}</Label>
                <Input
                  id={`rc-thr-${target}-${k}`}
                  type="number"
                  min={0}
                  max={100}
                  step={1}
                  value={Math.round(state.grade_thresholds[k] * 100)}
                  onChange={(e) =>
                    setState((s) => ({
                      ...s,
                      grade_thresholds: {
                        ...s.grade_thresholds,
                        [k]:
                          Math.max(0, Math.min(100, Number(e.target.value))) /
                          100,
                      },
                    }))
                  }
                />
              </div>
            ))}
          </div>
        </CardContent>
      </Card>

      {/* Model */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Model</CardTitle>
          <CardDescription>
            The LLM that runs each criterion against submitted content.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="space-y-1.5 max-w-md">
            <Label htmlFor={`rc-model-${target}`}>LLM Model</Label>
            <ModelPicker
              id={`rc-model-${target}`}
              options={availableModels}
              modelId={state.model_id}
              modelProvider={state.model_provider}
              onChange={(modelId, modelProvider) => {
                setState((s) => ({
                  ...s,
                  model_id: modelId,
                  model_provider: modelProvider,
                }));
              }}
              loading={modelsLoading}
            />
          </div>
        </CardContent>
      </Card>

      {/* Criteria */}
      <Card>
        <CardHeader>
          <div className="flex items-start justify-between gap-2">
            <div>
              <CardTitle className="text-base">Criteria</CardTitle>
              <CardDescription>
                Each criterion is a small prompt asking for a single yes/no
                judgment. Keep prompts short for parallelism.
              </CardDescription>
            </div>
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={addCriterion}
              className="gap-1.5"
            >
              <Plus className="h-3.5 w-3.5" />
              Add criterion
            </Button>
          </div>
        </CardHeader>
        <CardContent className="space-y-3">
          {state.criteria.length === 0 && (
            <div className="rounded-md border border-dashed p-4 text-center text-xs text-muted-foreground">
              No criteria yet. Click <span className="font-medium">Add criterion</span> to start.
            </div>
          )}
          {state.criteria.map((c, idx) => {
            const charCount = c.micro_prompt.length;
            const overSoftLimit = charCount > MICRO_PROMPT_SOFT_LIMIT;
            return (
              <div
                key={idx}
                className="rounded-md border bg-muted/10 p-3 space-y-3"
              >
                <div className="grid grid-cols-1 md:grid-cols-12 gap-2">
                  <div className="md:col-span-3 space-y-1">
                    <Label className="text-[11px]">id</Label>
                    <Input
                      value={c.id}
                      onChange={(e) =>
                        updateCriterion(idx, { id: e.target.value })
                      }
                      placeholder="my-custom-rule"
                      className="font-mono text-xs h-8"
                    />
                  </div>
                  <div className="md:col-span-4 space-y-1">
                    <Label className="text-[11px]">Name</Label>
                    <Input
                      value={c.name}
                      onChange={(e) =>
                        updateCriterion(idx, { name: e.target.value })
                      }
                      placeholder="Short human label"
                      className="h-8 text-xs"
                    />
                  </div>
                  <div className="md:col-span-2 space-y-1">
                    <Label className="text-[11px]">Severity</Label>
                    <Select
                      value={c.severity}
                      onChange={(e) =>
                        updateCriterion(idx, {
                          severity: e.target.value as ReviewSeverity,
                        })
                      }
                      className="h-8 w-full rounded-md border border-input bg-background px-2 text-xs"
                    >
                      <option value="error">error</option>
                      <option value="warning">warning</option>
                      <option value="info">info</option>
                    </Select>
                  </div>
                  <div className="md:col-span-2 space-y-1">
                    <Label className="text-[11px]">Weight</Label>
                    <Input
                      type="number"
                      min={0}
                      step={0.1}
                      value={c.weight}
                      onChange={(e) =>
                        updateCriterion(idx, {
                          weight: Number(e.target.value),
                        })
                      }
                      className="h-8 text-xs"
                    />
                  </div>
                  <div className="md:col-span-1 flex items-end justify-end">
                    <Button
                      type="button"
                      size="icon"
                      variant="ghost"
                      onClick={() => removeCriterion(idx)}
                      title="Remove criterion"
                      className="h-8 w-8 text-muted-foreground hover:text-red-500"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                </div>

                <label className="flex items-center gap-2 text-xs">
                  <input
                    type="checkbox"
                    className="h-3.5 w-3.5 accent-primary"
                    checked={c.expects_fix}
                    onChange={(e) =>
                      updateCriterion(idx, { expects_fix: e.target.checked })
                    }
                  />
                  Allow suggested fix (one-click apply)
                </label>

                <div className="space-y-1">
                  <div className="flex items-center justify-between gap-2">
                    <Label className="text-[11px]">Micro prompt</Label>
                    <span
                      className={cn(
                        "text-[10px]",
                        overSoftLimit
                          ? "text-amber-600 dark:text-amber-400"
                          : "text-muted-foreground",
                      )}
                    >
                      {charCount}/{MICRO_PROMPT_SOFT_LIMIT}
                    </span>
                  </div>
                  <Textarea
                    value={c.micro_prompt}
                    onChange={(e) =>
                      updateCriterion(idx, { micro_prompt: e.target.value })
                    }
                    placeholder="Check that the prompt does NOT start with 'You are an AI…' preamble."
                    className="font-mono text-xs min-h-[80px] resize-y"
                  />
                </div>
              </div>
            );
          })}
        </CardContent>
      </Card>
    </fieldset>
  );
  },
);
