"use client";

import { SearchablePicker } from "@/components/ui/searchable-picker";
import * as React from "react";

export interface ModelPickerOption {
  model_id: string;
  name: string;
  provider: string;
  description?: string;
}

export interface ModelPickerProps {
  options: readonly ModelPickerOption[];
  modelId?: string;
  modelProvider?: string;
  onChange: (modelId: string, modelProvider: string) => void;
  loading?: boolean;
  disabled?: boolean;
  required?: boolean;
  id?: string;
  ariaLabel?: string;
  ariaInvalid?: boolean;
  ariaDescribedBy?: string;
  placeholder?: string;
  loadingLabel?: string;
  emptyLabel?: string;
  triggerClassName?: string;
  contentSide?: "top" | "bottom";
  /**
   * Label for an option that defers to the Platform LLM rather than pinning a
   * model, e.g. `Use Platform LLM (Claude Haiku 4.5)`. Selecting it reports an
   * empty id and provider, which callers persist as "no model of my own".
   * Omit to require an explicit model, as the per-agent pickers do.
   */
  platformLlmLabel?: string | null;
}

function modelKey(model: ModelPickerOption): string {
  return `${model.model_id}::${model.provider}`;
}

function modelLabel(model: ModelPickerOption): string {
  return model.provider && model.provider !== "default"
    ? `${model.name} (${model.provider})`
    : model.name;
}

export function ModelPicker({
  options,
  modelId = "",
  modelProvider = "",
  onChange,
  loading = false,
  disabled = false,
  required = true,
  id,
  ariaLabel = "LLM Model",
  ariaInvalid,
  ariaDescribedBy,
  placeholder = "Select a model...",
  loadingLabel = "Loading models...",
  emptyLabel = "No models available",
  triggerClassName,
  contentSide,
  platformLlmLabel,
}: ModelPickerProps) {
  const selected = options.find(
    (model) =>
      model.model_id === modelId && model.provider === modelProvider,
  );
  const staleSelection: ModelPickerOption | undefined =
    !selected && modelId && modelProvider
      ? {
          model_id: modelId,
          name: modelId,
          provider: modelProvider,
        }
      : undefined;
  // An empty id and provider means "no model of my own", which this option
  // represents so the deferral is a visible choice rather than a blank field.
  const platformOption: ModelPickerOption | undefined = platformLlmLabel
    ? { model_id: "", provider: "", name: platformLlmLabel }
    : undefined;
  const selectedModel =
    selected ??
    staleSelection ??
    (platformOption && !modelId && !modelProvider ? platformOption : undefined);
  const pickerOptions: readonly ModelPickerOption[] = [
    ...(platformOption ? [platformOption] : []),
    ...(staleSelection ? [staleSelection] : []),
    ...options,
  ];
  const unavailable =
    disabled || loading || (options.length === 0 && !platformOption);

  return (
    <SearchablePicker
      options={pickerOptions}
      selected={selectedModel}
      onSelect={(model) => onChange(model.model_id, model.provider)}
      getOptionKey={modelKey}
      getOptionLabel={modelLabel}
      getSearchText={(model) => [
        model.model_id,
        model.name,
        model.provider,
        model.description ?? "",
      ]}
      placeholder={
        loading ? loadingLabel : options.length === 0 ? emptyLabel : placeholder
      }
      searchPlaceholder="Search models..."
      emptyLabel="No models match"
      loading={loading}
      loadingLabel={loadingLabel}
      disabled={unavailable}
      required={required}
      id={id}
      ariaLabel={ariaLabel}
      ariaInvalid={ariaInvalid}
      ariaDescribedBy={ariaDescribedBy}
      triggerClassName={triggerClassName}
      contentSide={contentSide}
    />
  );
}
