"use client";

import { cn } from "@/lib/utils";

interface SettingsSwitchProps {
  checked: boolean;
  disabled?: boolean;
  label: string;
  onCheckedChange: (checked: boolean) => void;
  testId?: string;
}

export function SettingsSwitch({
  checked,
  disabled = false,
  label,
  onCheckedChange,
  testId,
}: SettingsSwitchProps): React.ReactElement {
  return (
    <button
      aria-checked={checked}
      aria-label={label}
      className="inline-flex min-h-11 min-w-11 shrink-0 items-center justify-center rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
      data-testid={testId}
      disabled={disabled}
      onClick={() => onCheckedChange(!checked)}
      role="switch"
      type="button"
    >
      <span
        className={cn(
          "relative block h-6 w-10 rounded-full transition-colors",
          checked ? "bg-primary" : "bg-muted-foreground/30",
        )}
      >
        <span
          className={cn(
            "absolute left-0 top-0.5 h-5 w-5 rounded-full bg-white shadow transition-transform",
            checked ? "translate-x-[18px]" : "translate-x-0.5",
          )}
        />
      </span>
    </button>
  );
}
