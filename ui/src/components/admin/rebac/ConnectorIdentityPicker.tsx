"use client";

import { SearchablePicker } from "@/components/ui/searchable-picker";

export interface ConnectorIdentityPickerOption {
  id: string;
  label: string;
  disabled?: boolean;
}

interface ConnectorIdentityPickerProps {
  options: readonly ConnectorIdentityPickerOption[];
  value: string;
  onChange: (value: string) => void;
  ariaLabel: string;
  loading?: boolean;
  disabled?: boolean;
  allowClear?: boolean;
  placeholder?: string;
  emptyLabel?: string;
  triggerClassName?: string;
}

export function ConnectorIdentityPicker({
  options,
  value,
  onChange,
  ariaLabel,
  loading = false,
  disabled = false,
  allowClear = false,
  placeholder = "Select a bot",
  emptyLabel = "No bots available",
  triggerClassName,
}: ConnectorIdentityPickerProps) {
  const selected = options.find((option) => option.id === value);
  const staleSelection: ConnectorIdentityPickerOption | undefined =
    value && !selected ? { id: value, label: value } : undefined;
  const selectedOption = selected ?? staleSelection;
  const pickerOptions: readonly ConnectorIdentityPickerOption[] = staleSelection
    ? [staleSelection, ...options]
    : options;

  return (
    <SearchablePicker
      options={pickerOptions}
      selected={selectedOption}
      onSelect={(option) => onChange(option.id)}
      getOptionKey={(option) => option.id}
      getOptionLabel={(option) => option.label}
      getSearchText={(option) => [option.id, option.label]}
      isOptionDisabled={(option) => Boolean(option.disabled)}
      placeholder={loading ? "Loading..." : placeholder}
      searchPlaceholder="Search bots..."
      emptyLabel={emptyLabel}
      loading={loading}
      loadingLabel="Loading bots..."
      disabled={disabled || loading || options.length === 0}
      required={!allowClear}
      ariaLabel={ariaLabel}
      onClear={allowClear ? () => onChange("") : undefined}
      clearLabel={`Clear ${ariaLabel.toLocaleLowerCase()}`}
      triggerClassName={triggerClassName}
    />
  );
}
