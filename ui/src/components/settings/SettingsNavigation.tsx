"use client";

import {
  PERSONAL_SETTINGS_ROUTES,
  type SettingsRouteDefinition,
} from "@/components/settings/settings-routes";
import {
  WorkspaceNavigationList,
  type WorkspaceNavigationGroup,
} from "@/components/layout/WorkspaceNavigation";

interface SettingsNavigationProps {
  activeRoute?: SettingsRouteDefinition;
}

export const SETTINGS_NAVIGATION_GROUPS: WorkspaceNavigationGroup[] = [
  {
    id: "personal",
    items: PERSONAL_SETTINGS_ROUTES.map((route) => ({
      ...route,
      href: route.href,
    })),
  },
];

export function SettingsNavigation({
  activeRoute,
}: SettingsNavigationProps): React.ReactElement {
  return (
    <>
      <WorkspaceNavigationList
        activeItemId={activeRoute?.id ?? ""}
        ariaLabel="Settings sections"
        groups={SETTINGS_NAVIGATION_GROUPS}
      />
      <span className="sr-only">
        {SETTINGS_NAVIGATION_GROUPS.reduce(
          (count,group) => count + group.items.length,
          0,
        )} settings sections available
      </span>
    </>
  );
}
