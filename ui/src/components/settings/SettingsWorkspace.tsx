"use client";

import {
  DEFAULT_SETTINGS_ROUTE_ID,
  findSettingsRouteById,
  type SettingsRouteDefinition,
  type SettingsRouteId,
} from "@/components/settings/settings-routes";
import { AccessSettings } from "@/components/settings/sections/AccessSettings";
import { AppearanceSettings } from "@/components/settings/sections/AppearanceSettings";
import { ChatSettings } from "@/components/settings/sections/ChatSettings";
import { DeveloperSettings } from "@/components/settings/sections/DeveloperSettings";
import { NotificationsSettings } from "@/components/settings/sections/NotificationsSettings";

function SettingsContent({ route }: { route: SettingsRouteDefinition }): React.ReactElement {
  switch (route.id) {
    case "appearance":
      return <AppearanceSettings />;
    case "chat":
      return <ChatSettings />;
    case "notifications":
      return <NotificationsSettings />;
    case "access":
      return (
        <div className="space-y-10">
          <AccessSettings />
          <section aria-labelledby="developer-settings-heading" className="space-y-6 border-t border-border pt-8">
            <div className="space-y-1">
              <h2 className="text-xl font-semibold tracking-tight" id="developer-settings-heading">
                Developer (Dangerous)
              </h2>
              <p className="text-sm text-muted-foreground">
                Debugging and session tools can expose sensitive access information.
              </p>
            </div>
            <DeveloperSettings />
          </section>
        </div>
      );
  }
}

export function SettingsWorkspace({
  activeRouteId,
}: {
  activeRouteId: SettingsRouteId;
}): React.ReactElement {
  const requestedRoute = findSettingsRouteById(activeRouteId);
  const defaultRoute = findSettingsRouteById(DEFAULT_SETTINGS_ROUTE_ID)!;
  const matchedRoute = requestedRoute ?? defaultRoute;

  return (
    <section
      aria-label={`${matchedRoute.label} settings`}
      className="min-w-0 max-w-4xl"
    >
      <SettingsContent route={matchedRoute} />
    </section>
  );
}
