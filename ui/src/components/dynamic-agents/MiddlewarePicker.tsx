"use client";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ModelPicker } from "@/components/ui/model-picker";
import { Select } from "@/components/ui/select";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import type {
  FeaturesConfig,
  MiddlewareDefinition,
  MiddlewareEntry,
} from "@/types/dynamic-agent";
import {
  ChevronDown,
  ChevronRight,
  CopyPlus,
  Info,
  Loader2,
  Trash2,
} from "lucide-react";
import React from "react";

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface MiddlewarePickerProps {
  value: FeaturesConfig | undefined;
  onChange: (value: FeaturesConfig) => void;
  disabled?: boolean;
  /** Available models for middleware that need model selection. */
  availableModels?: { model_id: string; name: string; provider: string }[];
  /** Called when the middleware definitions fetch error state changes. */
  onError?: (hasError: boolean) => void;
}

// ---------------------------------------------------------------------------
// Fetch hook
// ---------------------------------------------------------------------------

function useMiddlewareDefinitions(): {
  definitions: MiddlewareDefinition[];
  loading: boolean;
  error: string | null;
  retry: () => void;
} {
  const [definitions, setDefinitions] = React.useState<MiddlewareDefinition[]>(
    [],
  );
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  const [attempt, setAttempt] = React.useState(0);

  React.useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);

    async function fetchDefinitions() {
      try {
        const response = await fetch("/api/dynamic-agents/middleware");
        if (!response.ok) {
          throw new Error(`HTTP ${response.status}`);
        }
        const json = await response.json();
        if (!cancelled) {
          // API returns { success: true, data: [...] }
          setDefinitions(json.data || []);
          setLoading(false);
        }
      } catch (err) {
        if (!cancelled) {
          setError(
            err instanceof Error
              ? err.message
              : "Failed to load middleware definitions",
          );
          setLoading(false);
        }
      }
    }

    fetchDefinitions();
    return () => {
      cancelled = true;
    };
  }, [attempt]);

  const retry = React.useCallback(() => setAttempt((n) => n + 1), []);

  return { definitions, loading, error, retry };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Convert snake_case to Title Case for param labels. */
function snakeToTitle(s: string): string {
  return s
    .split("_")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

/** Parse a param_schema value into a type and optional options. */
function parseParamSchema(schema: string): {
  type: "number" | "boolean" | "string" | "select";
  options?: string[];
} {
  if (schema === "number") return { type: "number" };
  if (schema === "boolean") return { type: "boolean" };
  if (schema === "string") return { type: "string" };
  if (schema.includes("|"))
    return { type: "select", options: schema.split("|") };
  return { type: "string" };
}

/**
 * Materialize every registered middleware so the UI matches its toggle model.
 * A missing/empty feature list means the runtime defaults are active; once an
 * agent has an explicit list, any missing definition is genuinely off.
 */
function materializeEntries(
  definitions: MiddlewareDefinition[],
  value: FeaturesConfig | undefined,
): MiddlewareEntry[] {
  const configured = value?.middleware ?? [];
  const usesRuntimeDefaults = configured.length === 0;
  const entries = configured.map((entry) => ({
    ...entry,
    params: { ...entry.params },
  }));
  const present = new Set(entries.map((entry) => entry.type));

  for (const definition of definitions) {
    if (present.has(definition.key)) continue;
    entries.push({
      type: definition.key,
      enabled: usesRuntimeDefaults && definition.enabled_by_default,
      params: { ...definition.default_params },
    });
  }
  return entries;
}

/** Get the definition for a middleware type key. */
function getDefinition(
  definitions: MiddlewareDefinition[],
  type: string,
): MiddlewareDefinition | undefined {
  return definitions.find((d) => d.key === type);
}

// ---------------------------------------------------------------------------
// MiddlewareEntryCard
// ---------------------------------------------------------------------------

function MiddlewareEntryCard({
  entry,
  index,
  definition,
  disabled,
  availableModels,
  onUpdate,
  onRemove,
  onDuplicate,
  onToggle,
  defaultExpanded,
}: {
  entry: MiddlewareEntry;
  index: number;
  definition: MiddlewareDefinition | undefined;
  disabled?: boolean;
  availableModels?: { model_id: string; name: string; provider: string }[];
  onUpdate: (index: number, params: Record<string, unknown>) => void;
  onRemove?: (index: number) => void;
  onDuplicate?: (index: number) => void;
  onToggle: (index: number) => void;
  defaultExpanded?: boolean;
}) {
  const [expanded, setExpanded] = React.useState(defaultExpanded ?? false);
  const label = definition?.label ?? entry.type;
  const description = definition?.description ?? "";

  const handleParamChange = (key: string, value: unknown) => {
    onUpdate(index, { ...entry.params, [key]: value });
  };

  // Determine which params to render (exclude model_id/model_provider — handled separately)
  const paramKeys = Object.keys(entry.params).filter(
    (k) => k !== "model_id" && k !== "model_provider",
  );

  return (
    <div
      className={cn(
        "rounded-lg border transition-colors",
        entry.enabled ? "border-border" : "border-border/50 opacity-60",
      )}
    >
      {/* Header row */}
      <div className="flex items-center gap-2 px-3 py-2">
        <button
          type="button"
          onClick={() => setExpanded(!expanded)}
          aria-label={`${expanded ? "Collapse" : "Configure"} ${label}`}
          className="flex items-center gap-1 text-muted-foreground hover:text-foreground"
        >
          {expanded ? (
            <ChevronDown className="h-3.5 w-3.5" />
          ) : (
            <ChevronRight className="h-3.5 w-3.5" />
          )}
        </button>

        {/* Toggle */}
        <label className="relative inline-flex items-center cursor-pointer">
          <input
            type="checkbox"
            checked={entry.enabled}
            onChange={() => onToggle(index)}
            disabled={disabled}
            aria-label={`${entry.enabled ? "Disable" : "Enable"} ${label}`}
            className="sr-only peer"
          />
          <div className="w-8 h-4 bg-muted rounded-full peer peer-checked:bg-primary transition-colors peer-focus-visible:ring-2 peer-focus-visible:ring-ring">
            <div
              className={cn(
                "w-3 h-3 bg-background rounded-full transition-transform mt-0.5 ml-0.5",
                entry.enabled && "translate-x-4",
              )}
            />
          </div>
        </label>

        <span className="text-sm font-medium flex-1 min-w-0 truncate">
          {label}
        </span>

        {description && (
          <TooltipProvider delayDuration={300}>
            <Tooltip>
              <TooltipTrigger asChild>
                <Info className="h-3.5 w-3.5 text-muted-foreground/50 shrink-0" />
              </TooltipTrigger>
              <TooltipContent side="top" className="max-w-xs text-xs">
                {description}
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>
        )}

        {onDuplicate && (
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="h-6 w-6 shrink-0 text-muted-foreground hover:text-foreground"
            onClick={() => onDuplicate(index)}
            disabled={disabled}
            aria-label={`Add another ${label} configuration`}
            title={`Add another ${label} configuration`}
          >
            <CopyPlus className="h-3.5 w-3.5" />
          </Button>
        )}

        {onRemove && (
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="h-6 w-6 shrink-0 text-muted-foreground hover:text-destructive"
            onClick={() => onRemove(index)}
            disabled={disabled}
            aria-label={`Remove this ${label} configuration`}
          >
            <Trash2 className="h-3.5 w-3.5" />
          </Button>
        )}
      </div>

      {/* Expanded params */}
      {expanded && (
        <div className="px-3 pb-3 pt-1 border-t space-y-2">
          {/* Model selection for middleware that need it */}
          {definition?.model_params && availableModels && (
            <div className="space-y-1">
              <Label className="text-xs" htmlFor={`middleware-model-${index}`}>
                Model
              </Label>
              <ModelPicker
                id={`middleware-model-${index}`}
                options={availableModels}
                modelId={String(entry.params.model_id ?? "")}
                modelProvider={String(entry.params.model_provider ?? "")}
                onChange={(modelId, modelProvider) => {
                  onUpdate(index, {
                    ...entry.params,
                    model_id: modelId,
                    model_provider: modelProvider,
                  });
                }}
                disabled={disabled}
                ariaLabel="Middleware model"
                ariaInvalid={!entry.params.model_id}
                triggerClassName={cn(
                  "h-8 px-2 py-1 text-xs",
                  !entry.params.model_id
                    ? "border-destructive"
                    : "border-input",
                )}
              />
              {!entry.params.model_id && (
                <p className="text-xs text-destructive">
                  A model is required for this middleware to function.
                </p>
              )}
            </div>
          )}

          {/* Regular params — rendered based on param_schema from backend */}
          {paramKeys.map((key) => {
            const schemaHint = definition?.param_schema?.[key];
            const parsed = schemaHint ? parseParamSchema(schemaHint) : null;
            const paramType =
              parsed?.type ??
              (typeof entry.params[key] === "number" ? "number" : "string");
            const paramLabel = snakeToTitle(key);
            const val = entry.params[key];

            if (paramType === "select" && parsed?.options) {
              return (
                <div key={key} className="space-y-1">
                  <Label className="text-xs">{paramLabel}</Label>
                  <Select
                    value={String(val ?? "")}
                    onChange={(e) => handleParamChange(key, e.target.value)}
                    disabled={disabled}
                    className="flex h-8 w-full rounded-md border border-input bg-background px-2 py-1 text-xs shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:opacity-50"
                  >
                    {parsed.options.map((opt) => (
                      <option key={opt} value={opt}>
                        {opt}
                      </option>
                    ))}
                  </Select>
                </div>
              );
            }

            if (paramType === "number") {
              return (
                <div key={key} className="space-y-1">
                  <Label className="text-xs">{paramLabel}</Label>
                  <Input
                    type="number"
                    value={val !== undefined ? String(val) : ""}
                    onChange={(e) =>
                      handleParamChange(
                        key,
                        e.target.value ? Number(e.target.value) : undefined,
                      )
                    }
                    disabled={disabled}
                    className="h-8 text-xs"
                  />
                </div>
              );
            }

            if (paramType === "boolean") {
              return (
                <div key={key} className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={!!val}
                    onChange={(e) => handleParamChange(key, e.target.checked)}
                    disabled={disabled}
                    className="h-3.5 w-3.5"
                  />
                  <Label className="text-xs">{paramLabel}</Label>
                </div>
              );
            }

            return (
              <div key={key} className="space-y-1">
                <Label className="text-xs">{paramLabel}</Label>
                <Input
                  type="text"
                  value={String(val ?? "")}
                  onChange={(e) => handleParamChange(key, e.target.value)}
                  disabled={disabled}
                  className="h-8 text-xs"
                />
              </div>
            );
          })}

          {paramKeys.length === 0 && !definition?.model_params && (
            <p className="text-xs text-muted-foreground italic">
              No configurable parameters
            </p>
          )}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// MiddlewarePicker (main export)
// ---------------------------------------------------------------------------

export function MiddlewarePicker({
  value,
  onChange,
  disabled,
  availableModels,
  onError,
}: MiddlewarePickerProps) {
  const { definitions, loading, error, retry } = useMiddlewareDefinitions();

  // Notify parent of error state changes
  React.useEffect(() => {
    onError?.(!!error);
  }, [error, onError]);

  const entries: MiddlewareEntry[] = loading
    ? []
    : materializeEntries(definitions, value);
  const [lastAddedIndex, setLastAddedIndex] = React.useState<number | null>(
    null,
  );

  // Clear lastAddedIndex after it's been consumed by the render
  React.useEffect(() => {
    if (lastAddedIndex !== null) {
      setLastAddedIndex(null);
    }
  }, [lastAddedIndex]);

  const updateEntries = (newEntries: MiddlewareEntry[]) => {
    onChange({ middleware: newEntries });
  };

  const handleToggle = (index: number) => {
    const updated = [...entries];
    updated[index] = { ...updated[index], enabled: !updated[index].enabled };
    updateEntries(updated);
  };

  const handleUpdateParams = (
    index: number,
    params: Record<string, unknown>,
  ) => {
    const updated = [...entries];
    updated[index] = { ...updated[index], params };
    updateEntries(updated);
  };

  const handleRemove = (index: number) => {
    const updated = entries.filter((_, i) => i !== index);
    updateEntries(updated);
  };

  const handleDuplicate = (index: number) => {
    const current = entries[index];
    const def = getDefinition(definitions, current.type);
    if (!def) return;
    const newEntry: MiddlewareEntry = {
      type: current.type,
      enabled: true,
      params: { ...def.default_params },
    };
    const newEntries = [...entries];
    newEntries.splice(index + 1, 0, newEntry);
    setLastAddedIndex(index + 1);
    updateEntries(newEntries);
  };

  return (
    <div className="space-y-3">
      {/* Loading / error states */}
      {loading && (
        <div className="flex items-center gap-2 py-4 text-xs text-muted-foreground">
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
          Loading middleware definitions...
        </div>
      )}
      {error && (
        <div className="rounded-md border border-destructive/50 bg-destructive/10 p-3 text-xs text-destructive">
          <p className="font-medium">Unable to connect to the agents backend</p>
          <p className="mt-1 text-destructive/80">
            Middleware definitions could not be loaded. Saving is disabled until
            this is resolved.
          </p>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="mt-2 h-7 text-xs"
            onClick={retry}
          >
            Retry
          </Button>
        </div>
      )}

      {!loading && !error && (
        <>
          <p className="text-xs text-muted-foreground">
            Every available middleware is shown below. Turn on what this agent
            needs, then expand it to adjust its settings. Middleware that
            supports multiple rules includes a duplicate button.
          </p>

          {/* Middleware entries list */}
          <div className="space-y-2">
            {entries.length === 0 ? (
              <p className="text-xs text-muted-foreground italic py-4 text-center">
                No middleware configured. The agent will run without any
                middleware.
              </p>
            ) : (
              entries.map((entry, index) => {
                const definition = getDefinition(definitions, entry.type);
                const sameTypeIndexes = entries.flatMap(
                  (candidate, itemIndex) =>
                    candidate.type === entry.type ? [itemIndex] : [],
                );
                return (
                  <MiddlewareEntryCard
                    key={`${entry.type}-${index}`}
                    entry={entry}
                    index={index}
                    definition={definition}
                    disabled={disabled}
                    availableModels={availableModels}
                    onUpdate={handleUpdateParams}
                    onRemove={
                      definition?.allow_multiple && sameTypeIndexes.length > 1
                        ? handleRemove
                        : undefined
                    }
                    onDuplicate={
                      definition?.allow_multiple && sameTypeIndexes[0] === index
                        ? handleDuplicate
                        : undefined
                    }
                    onToggle={handleToggle}
                    defaultExpanded={index === lastAddedIndex}
                  />
                );
              })
            )}
          </div>
        </>
      )}
    </div>
  );
}
