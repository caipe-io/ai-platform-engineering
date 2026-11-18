"use client";

import { SearchablePicker } from "@/components/ui/searchable-picker";
import type { SavedProviderSecret } from "@/lib/llm-provider-credentials";

export function SavedSecretPicker({
  secrets,
  value,
  onChange,
  disabled,
  label,
  id,
}: {
  secrets: SavedProviderSecret[];
  value?: string;
  onChange: (id: string) => void;
  disabled?: boolean;
  label: string;
  id: string;
}): React.ReactElement {
  const selected =
    secrets.find((secret) => secret.id === value) ??
    (value
      ? { id: value, name: "Unavailable saved secret", type: "custom" }
      : undefined);
  return (
    <SearchablePicker
      id={id}
      ariaLabel={label}
      options={secrets}
      selected={selected}
      onSelect={(secret) => onChange(secret.id)}
      getOptionKey={(secret) => secret.id}
      getOptionLabel={(secret) => secret.name}
      getSearchText={(secret) => [secret.name, secret.type]}
      renderOption={(secret) => (
        <span className="flex min-w-0 flex-col">
          <span className="truncate">{secret.name}</span>
          <span className="text-xs text-muted-foreground">
            {secret.type}
            {secret.maskedPreview ? ` · ${secret.maskedPreview}` : ""}
          </span>
        </span>
      )}
      placeholder="Choose a saved secret"
      searchPlaceholder="Search saved secrets..."
      emptyLabel="No compatible saved secrets. Choose Enter a new value to create one."
      disabled={disabled}
    />
  );
}
