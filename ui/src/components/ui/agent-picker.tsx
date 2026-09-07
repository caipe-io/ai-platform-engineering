"use client";

import { SearchablePicker } from "@/components/ui/searchable-picker";

export interface AgentPickerOption {
  value: string;
  label?: string;
  disabled?: boolean;
}

function labelOf(option: AgentPickerOption): string {
  return option.label?.trim() || option.value;
}

interface AgentPickerProps {
  options: AgentPickerOption[];
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  searchPlaceholder?: string;
  emptyLabel?: string;
  disabled?: boolean;
  required?: boolean;
  triggerClassName?: string;
  contentClassName?: string;
  id?: string;
  ariaLabel?: string;
  ariaInvalid?: boolean;
  ariaDescribedBy?: string;
  hideIdSuffix?: boolean;
  clearValue?: string;
  allowClear?: boolean;
  helperText?: string;
  loading?: boolean;
  loadingLabel?: string;
  error?: string | null;
  onRetry?: () => void;
  hasMore?: boolean;
  loadingMore?: boolean;
  onLoadMore?: () => void;
  searchValue?: string;
  onSearchChange?: (query: string) => void;
  filterOptions?: boolean;
  portalled?: boolean;
  contentSide?: "top" | "bottom";
}

export function AgentPicker({
  options,
  value,
  onChange,
  placeholder = "Select agent...",
  searchPlaceholder = "Search agents...",
  emptyLabel = "No agents match",
  disabled = false,
  required = false,
  triggerClassName,
  contentClassName,
  id,
  ariaLabel,
  ariaInvalid,
  ariaDescribedBy,
  hideIdSuffix = false,
  clearValue = "",
  allowClear = true,
  helperText,
  loading,
  loadingLabel,
  error,
  onRetry,
  hasMore,
  loadingMore,
  onLoadMore,
  searchValue,
  onSearchChange,
  filterOptions,
  portalled,
  contentSide,
}: AgentPickerProps) {
  const selected = options.find((option) => option.value === value);

  const renderOption = (option: AgentPickerOption) => (
    <>
      <span className="min-w-0 flex-1 truncate">{labelOf(option)}</span>
      {!hideIdSuffix && (
        <code className="min-w-0 shrink-[9999] truncate text-[10px] text-muted-foreground">
          agent:{option.value}
        </code>
      )}
    </>
  );

  return (
    <SearchablePicker
      options={options}
      selected={selected}
      onSelect={(option) => onChange(option.value)}
      getOptionKey={(option) => option.value}
      getOptionLabel={labelOf}
      getSearchText={(option) => [option.value, option.label ?? ""]}
      isOptionDisabled={(option) => Boolean(option.disabled)}
      renderValue={renderOption}
      renderOption={renderOption}
      placeholder={placeholder}
      searchPlaceholder={searchPlaceholder}
      emptyLabel={emptyLabel}
      disabled={disabled}
      required={required}
      id={id}
      ariaLabel={ariaLabel}
      ariaInvalid={ariaInvalid}
      ariaDescribedBy={ariaDescribedBy}
      triggerClassName={triggerClassName}
      contentClassName={contentClassName}
      clearLabel="Clear agent selection"
      onClear={
        allowClear && selected?.value !== clearValue
          ? () => onChange(clearValue)
          : undefined
      }
      helperText={helperText}
      loading={loading}
      loadingLabel={loadingLabel}
      error={error}
      onRetry={onRetry}
      hasMore={hasMore}
      loadingMore={loadingMore}
      onLoadMore={onLoadMore}
      searchValue={searchValue}
      onSearchChange={onSearchChange}
      filterOptions={filterOptions}
      portalled={portalled}
      contentSide={contentSide}
    />
  );
}
