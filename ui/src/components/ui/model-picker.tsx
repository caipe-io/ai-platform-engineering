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
  const selectedModel = selected ?? staleSelection;
  const pickerOptions: readonly ModelPickerOption[] = staleSelection
    ? [staleSelection, ...options]
    : options;
  const unavailable = disabled || loading || options.length === 0;

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
