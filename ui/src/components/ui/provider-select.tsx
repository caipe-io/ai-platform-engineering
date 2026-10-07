"use client";

import { Select } from "@/components/ui/select";
import { cn } from "@/lib/utils";

export interface ProviderOption {
  provider: string;
  name: string;
}

interface ProviderSelectProps {
  options: ProviderOption[];
  value: string;
  onChange: (provider: string) => void;
  disabled?: boolean;
  ariaLabel?: string;
  placeholder?: string;
  className?: string;
}

/** Thin provider adapter for the native-backed small-value Select. */
export function ProviderSelect({
  options,
  value,
  onChange,
  disabled = false,
  ariaLabel = "Provider",
  placeholder = "Select a provider…",
  className,
}: ProviderSelectProps) {
  return (
    <Select
      aria-label={ariaLabel}
      value={value}
      onChange={(event) => onChange(event.target.value)}
      disabled={disabled || options.length === 0}
      className={cn("h-9 min-w-[10rem]", className)}
    >
      <option value="" disabled>
        {options.length === 0 ? "No providers available" : placeholder}
      </option>
      {options.map((option) => (
        <option key={option.provider} value={option.provider}>
          {option.name}
        </option>
      ))}
    </Select>
  );
}
