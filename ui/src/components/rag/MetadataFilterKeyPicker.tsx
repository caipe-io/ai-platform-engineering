"use client";

import { SearchablePicker } from "@/components/ui/searchable-picker";

interface FilterKeyOption {
  key: string;
  label: string;
}

interface MetadataFilterKeyPickerProps {
  keys: readonly string[];
  value: string;
  onChange: (value: string) => void;
  ariaLabel?: string;
  triggerClassName?: string;
}

const CUSTOM_FILTER_KEY = "__custom__";

export function MetadataFilterKeyPicker({
  keys,
  value,
  onChange,
  ariaLabel = "Metadata filter key",
  triggerClassName,
}: MetadataFilterKeyPickerProps) {
  const options: FilterKeyOption[] = [
    ...keys.map((key) => ({ key, label: key })),
    { key: CUSTOM_FILTER_KEY, label: "Custom key (metadata.*)" },
  ];

  return (
    <SearchablePicker
      options={options}
      selected={options.find((option) => option.key === value)}
      onSelect={(option) => onChange(option.key)}
      getOptionKey={(option) => option.key}
      getOptionLabel={(option) => option.label}
      placeholder="Add filter..."
      searchPlaceholder="Search filter keys..."
      emptyLabel="No filter keys match"
      ariaLabel={ariaLabel}
      onClear={() => onChange("")}
      clearLabel="Clear filter key"
      triggerClassName={triggerClassName}
    />
  );
}
