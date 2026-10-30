"use client";

import { SettingsSwitch } from "@/components/settings/shared/SettingsSwitch";

export function NotificationPreferenceSwitch(
  props: React.ComponentProps<typeof SettingsSwitch> & {
    visibleLabel?: string;
  },
) {
  const { visibleLabel, ...control } = props;
  return (
    <div className="flex w-full items-center justify-between gap-3">
      <span className="text-sm font-medium">
        {visibleLabel ?? control.label}
      </span>
      <SettingsSwitch {...control} />
    </div>
  );
}
