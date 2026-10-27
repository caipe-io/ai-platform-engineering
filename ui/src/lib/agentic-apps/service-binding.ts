import type { PlatformIdentity } from "@/lib/auth/platform-identity";
import type { ConfiguredAgenticApp } from "@/types/agentic-app";
import { loadConfiguredAgenticApps } from "./config";

export const RESOURCE_REGISTRATION_CAPABILITY = "host.access.resources";

/** Installation policy establishes custody, never permission to read app data. */
export function resourceApp(
  appId: string,
  apps: ConfiguredAgenticApp[] = loadConfiguredAgenticApps(),
): ConfiguredAgenticApp | null {
  return apps.find(({ manifest, installation }) => installation.appId === appId &&
    installation.installed && installation.enabled && !!installation.bindings?.serviceAccountClientId &&
    manifest.consumes.platformApis.some(({ id, version }) => id === RESOURCE_REGISTRATION_CAPABILITY && version === "1.0")) ?? null;
}

/** Call only after platform credential verification; a client ID is not a subject. */
export function resolveAppService(
  identity: PlatformIdentity,
  apps: ConfiguredAgenticApp[] = loadConfiguredAgenticApps(),
): ConfiguredAgenticApp | null {
  if (identity.subject.type !== "service_account" || identity.issuer !== process.env.OIDC_ISSUER?.trim() ||
    !Number.isFinite(identity.expiresAt) || identity.expiresAt * 1000 <= Date.now()) return null;
  const app = apps.find(({ installation }) => installation.bindings?.serviceAccountClientId === identity.clientId);
  return app ? resourceApp(app.installation.appId, apps) : null;
}
