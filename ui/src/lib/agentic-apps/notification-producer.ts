import { loadConfiguredAgenticApps } from "@/lib/agentic-apps/config";
import type { ConfiguredAgenticApp } from "@/types/agentic-app";

/** The platform capability an app declares to create notifications. */
export const NOTIFICATIONS_CAPABILITY = "host.notifications";

/**
 * The installed app a service-account caller is, if that app may create
 * notifications. Installing the app is the grant: it must be installed and
 * enabled, declare the capability in its manifest, and name the caller's
 * service-account client id in its installation bindings.
 */
export function findNotificationProducer(
  clientId: string | undefined,
  apps: ConfiguredAgenticApp[] = loadConfiguredAgenticApps(),
): ConfiguredAgenticApp | null {
  if (!clientId) return null;
  return (
    apps.find(
      ({ manifest, installation }) =>
        installation.installed &&
        installation.enabled &&
        installation.bindings?.serviceAccountClientId === clientId &&
        manifest.consumes.platformApis.some(
          (api) => api.id === NOTIFICATIONS_CAPABILITY && api.version === "1.0",
        ),
    ) ?? null
  );
}
