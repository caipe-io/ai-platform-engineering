"use client";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
Tooltip,
TooltipContent,
TooltipProvider,
TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import type {
BuiltinToolConfigField,
BuiltinToolDefinition,
BuiltinToolsConfig,
GenericToolConfig,
} from "@/types/dynamic-agent";
import { ChevronDown,ChevronRight,Globe,Info,Loader2,Settings } from "lucide-react";
import React from "react";

interface BuiltinToolsPickerProps {
  value: BuiltinToolsConfig | undefined;
  onChange: (value: BuiltinToolsConfig) => void;
  disabled?: boolean;
}

/**
 * Hook to fetch builtin tool definitions from the API.
 */
function useBuiltinToolDefinitions() {
  const [definitions, setDefinitions] = React.useState<BuiltinToolDefinition[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    async function fetchDefinitions() {
      try {
        const response = await fetch("/api/dynamic-agents/builtin-tools");
        if (!response.ok) {
          throw new Error(`Failed to fetch: ${response.status}`);
        }
        const data = await response.json();
        // Backend returns `{ success: true, data: { tools: [...] } }`.
        // Older proxy unwrapped to `{ success: true, data: [...] }`.
        // Accept both shapes for forward/backward compat.
        const tools = Array.isArray(data.data)
          ? data.data
          : (data.data?.tools ?? []);
        setDefinitions(tools);
        setError(null);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Unknown error");
        // Fallback to empty array - UI will still work, just without dynamic tools
        setDefinitions([]);
      } finally {
        setLoading(false);
      }
    }
    fetchDefinitions();
  }, []);

  return { definitions, loading, error };
}

/**
 * Get the default value for a config field.
 */
function getFieldDefault(field: BuiltinToolConfigField): string | number | boolean {
  if (field.default !== undefined) {
    return field.default;
  }
  switch (field.type) {
    case "string":
      return "";
    case "number":
      return 0;
    case "boolean":
      return false;
    default:
      return "";
  }
}

/**
 * Individual tool configuration component.
 */
function ToolConfig({
  definition,
  config,
  onChange,
  disabled,
}: {
  definition: BuiltinToolDefinition;
  config: GenericToolConfig | undefined;
  onChange: (config: GenericToolConfig) => void;
  disabled?: boolean;
}) {
  const [expanded, setExpanded] = React.useState(false);
  const isEnabled = config?.enabled ?? definition.enabled_by_default;
  const hasConfigFields = definition.config_fields.length > 0;

  const handleEnabledChange = (enabled: boolean) => {
    // Build default config with field defaults when enabling
    const defaults: Record<string, unknown> = {};
    for (const field of definition.config_fields) {
      defaults[field.name] = config?.[field.name] ?? getFieldDefault(field);
    }
    onChange({
      ...defaults,
      ...config,
      enabled,
    });
    // Auto-expand when enabling if there are config fields
    if (enabled && hasConfigFields) {
      setExpanded(true);
    }
  };

  const handleFieldChange = (fieldName: string, value: unknown) => {
    onChange({
      ...config,
      enabled: isEnabled,
      [fieldName]: value,
    });
  };

  return (
    <div
      className={cn(
        "border rounded-lg transition-colors",
        isEnabled ? "border-primary bg-primary/5" : "border-border"
      )}
    >
      {/* Tool Header Row */}
      <div className="flex items-center justify-between px-3 py-1">
        <div className="flex items-center gap-2">
          {/* Toggle Switch */}
          <button
            type="button"
            onClick={() => handleEnabledChange(!isEnabled)}
            disabled={disabled}
            className={cn(
              "relative inline-flex h-5 w-9 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none",
              isEnabled ? "bg-green-500" : "bg-muted-foreground/30",
              disabled && "opacity-50 cursor-not-allowed"
            )}
            role="switch"
            aria-checked={isEnabled}
            aria-label={`Enable ${definition.name}`}
          >
            <span
              className={cn(
                "pointer-events-none inline-block h-4 w-4 transform rounded-full bg-white shadow ring-0 transition duration-200 ease-in-out",
                isEnabled ? "translate-x-4" : "translate-x-0"
              )}
            />
          </button>

          <div>
            <span className="font-mono text-sm font-medium">{definition.id}</span>
            <span className="text-xs text-muted-foreground ml-2">
              {definition.description}
            </span>
          </div>
        </div>

        {isEnabled && hasConfigFields && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => setExpanded(!expanded)}
            className="h-7 px-2"
          >
            {expanded ? (
              <ChevronDown className="h-3 w-3 mr-1" />
            ) : (
              <ChevronRight className="h-3 w-3 mr-1" />
            )}
            <Settings className="h-3 w-3 mr-1" />
            <span className="text-xs">Configure</span>
          </Button>
        )}
      </div>

      {/* Expanded Configuration */}
      {isEnabled && hasConfigFields && expanded && (
        <div className="border-t px-3 py-1 bg-muted/30 space-y-2">
          {definition.config_fields.map((field) => (
            <ConfigField
              key={field.name}
              field={field}
              value={config?.[field.name] ?? getFieldDefault(field)}
              onChange={(value) => handleFieldChange(field.name, value)}
              disabled={disabled}
            />
          ))}
        </div>
      )}

    </div>
  );
}

/**
 * Individual config field renderer.
 */
function ConfigField({
  field,
  value,
  onChange,
  disabled,
}: {
  field: BuiltinToolConfigField;
  value: unknown;
  onChange: (value: unknown) => void;
  disabled?: boolean;
}) {
  // Render based on field type
  if (field.type === "string") {
    const stringValue = typeof value === "string" ? value : String(value ?? "");
    return (
      <div className="space-y-1.5">
        <div className="flex items-center gap-2">
          <Label htmlFor={field.name} className="text-xs">
            {field.label}
          </Label>
          <TooltipProvider>
            <Tooltip>
              <TooltipTrigger>
                <Info className="h-3 w-3 text-muted-foreground cursor-help" />
              </TooltipTrigger>
              <TooltipContent side="right" className="max-w-xs">
                <p className="text-xs">{field.description}</p>
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>
        </div>
        <Input
          id={field.name}
          value={stringValue}
          onChange={(e) => onChange(e.target.value)}
          placeholder={field.default !== undefined ? String(field.default) : undefined}
          disabled={disabled}
          className="font-mono text-xs h-8"
        />
        {field.name === "allowed_domains" && (
          <p className="text-xs text-muted-foreground">
            {stringValue === "*" ? (
              <span className="text-amber-500">All domains allowed</span>
            ) : stringValue.trim() === "" ? (
              <span className="text-red-500">No domains allowed</span>
            ) : (
              <span>
                {stringValue.split(",").filter((d) => d.trim()).length} pattern(s)
              </span>
            )}
          </p>
        )}
      </div>
    );
  }

  if (field.type === "number") {
    const numValue = typeof value === "number" ? value : Number(value ?? field.default ?? 0);
    return (
      <div className="space-y-1.5">
        <div className="flex items-center gap-2">
          <Label htmlFor={field.name} className="text-xs">
            {field.label}
          </Label>
          <TooltipProvider>
            <Tooltip>
              <TooltipTrigger>
                <Info className="h-3 w-3 text-muted-foreground cursor-help" />
              </TooltipTrigger>
              <TooltipContent side="right" className="max-w-xs">
                <p className="text-xs">{field.description}</p>
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>
        </div>
        <Input
          id={field.name}
          type="number"
          value={numValue}
          onChange={(e) => onChange(Number(e.target.value))}
          disabled={disabled}
          className="font-mono text-xs h-8 w-32"
        />
      </div>
    );
  }

  if (field.type === "boolean") {
    const boolValue = typeof value === "boolean" ? value : Boolean(value);
    return (
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={() => onChange(!boolValue)}
          disabled={disabled}
          className={cn(
            "relative inline-flex h-5 w-9 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none",
            boolValue ? "bg-green-500" : "bg-muted-foreground/30",
            disabled && "opacity-50 cursor-not-allowed"
          )}
          role="switch"
          aria-checked={boolValue}
        >
          <span
            className={cn(
              "pointer-events-none inline-block h-4 w-4 transform rounded-full bg-white shadow ring-0 transition duration-200 ease-in-out",
              boolValue ? "translate-x-4" : "translate-x-0"
            )}
          />
        </button>
        <Label htmlFor={field.name} className="text-xs">
          {field.label}
        </Label>
        <TooltipProvider>
          <Tooltip>
            <TooltipTrigger>
              <Info className="h-3 w-3 text-muted-foreground cursor-help" />
            </TooltipTrigger>
            <TooltipContent side="right" className="max-w-xs">
              <p className="text-xs">{field.description}</p>
            </TooltipContent>
          </Tooltip>
        </TooltipProvider>
      </div>
    );
  }

  return null;
}

export function BuiltinToolsPicker({ value, onChange, disabled }: BuiltinToolsPickerProps) {
  const { definitions, loading, error } = useBuiltinToolDefinitions();

  // Track whether we've initialized defaults for the current definitions.
  // This prevents infinite loops since onChange updates value.
  const initializedRef = React.useRef(false);
  const definitionsKey = definitions.map((d) => d.id).join(",");

  // Reset initialization flag when definitions change
  React.useEffect(() => {
    initializedRef.current = false;
  }, [definitionsKey]);

  // Initialize default-enabled tools in the config when definitions load.
  // This ensures tools with enabled_by_default: true get persisted to MongoDB
  // even if the user never explicitly toggles them.
  React.useEffect(() => {
    if (definitions.length === 0 || initializedRef.current) return;

    // Check if any default-enabled tools are missing from the config
    const missingDefaults: Record<string, GenericToolConfig> = {};

    for (const definition of definitions) {
      // Cast to access config by dynamic key
      const toolConfig = (value as Record<string, GenericToolConfig | undefined>)?.[definition.id];
      if (definition.enabled_by_default && !toolConfig) {
        // Build default config with field defaults
        const defaults: Record<string, unknown> = {};
        for (const field of definition.config_fields) {
          defaults[field.name] = getFieldDefault(field);
        }
        missingDefaults[definition.id] = {
          ...defaults,
          enabled: true,
        };
      }
    }

    // Mark as initialized regardless of whether we needed to add defaults
    initializedRef.current = true;

    // Only call onChange if there are missing defaults to add
    if (Object.keys(missingDefaults).length > 0) {
      onChange({
        ...value,
        ...missingDefaults,
      } as BuiltinToolsConfig);
    }
  }, [definitions, value, onChange]);

  const handleToolChange = (
    toolId: string,
    config: GenericToolConfig
  ) => {
    onChange({
      ...value,
      [toolId]: config,
    } as BuiltinToolsConfig);
  };

  if (loading) {
    return (
      <div className="space-y-2">
        <Label className="flex items-center gap-2 text-sm">
          <Globe className="h-4 w-4 text-purple-400" />
          Built-in Tools
        </Label>
        <div className="flex items-center gap-2 text-sm text-muted-foreground p-3 border rounded-lg">
          <Loader2 className="h-4 w-4 animate-spin" />
          Loading tools...
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="space-y-2">
        <Label className="flex items-center gap-2 text-sm">
          <Globe className="h-4 w-4 text-purple-400" />
          Built-in Tools
        </Label>
        <div className="text-sm text-red-500 p-3 border border-red-500/30 rounded-lg">
          Failed to load tools: {error}
        </div>
      </div>
    );
  }

  if (definitions.length === 0) {
    return (
      <div className="space-y-2">
        <Label className="flex items-center gap-2 text-sm">
          <Globe className="h-4 w-4 text-purple-400" />
          Built-in Tools
        </Label>
        <div className="text-sm text-muted-foreground p-3 border rounded-lg">
          No built-in tools available.
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <Label className="flex items-center gap-2 text-sm">
        <Globe className="h-4 w-4 text-purple-400" />
        Built-in Tools
      </Label>

      <div className="space-y-1.5">
        {definitions.map((definition) => (
          <ToolConfig
            key={definition.id}
            definition={definition}
            config={(value as Record<string, GenericToolConfig | undefined>)?.[definition.id]}
            onChange={(config) => handleToolChange(definition.id, config)}
            disabled={disabled}
          />
        ))}
      </div>
    </div>
  );
}
