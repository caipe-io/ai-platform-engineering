import { getServerSession } from "next-auth";

import { authOptions } from "@/lib/auth-config";
import { agenticAppUserContextFromSession, canLaunchAgenticApp } from "@/lib/agentic-apps/access";
import { getConfiguredAgenticApp, isAgenticAppsEnabled } from "@/lib/agentic-apps/config";
import { nativeExtensionById } from "./runtime";

export async function canEnterNativeExtension(extensionId: string): Promise<boolean> {
  if (!isAgenticAppsEnabled()) return false;
  const app = getConfiguredAgenticApp(extensionId);
  const extension = nativeExtensionById(extensionId);
  if (!app || !extension || app.manifest.auth.mode !== extension.auth.mode) return false;
  const session = await getServerSession(authOptions);
  if (!session) return false;
  return canLaunchAgenticApp(
    app,
    agenticAppUserContextFromSession(session as unknown as Record<string, unknown>),
    { requireVisible: false },
  );
}
