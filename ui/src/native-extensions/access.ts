import { getServerSession } from "next-auth";

import { authOptions } from "@/lib/auth-config";
import { agenticAppUserContextFromSession, canLaunchAgenticApp } from "@/lib/agentic-apps/access";
import { getConfiguredAgenticApp, isAgenticAppsEnabled } from "@/lib/agentic-apps/config";
import { nativeExtensionById } from "./runtime";
import { deriveAgenticAppSubjectId } from "@/lib/agentic-apps/identity";
import { evaluateAgenticAppCasCompatibility } from "@/lib/agentic-apps/cas-compat";

export async function canEnterNativeExtension(extensionId: string): Promise<boolean> {
  if (!isAgenticAppsEnabled()) return false;
  const app = getConfiguredAgenticApp(extensionId);
  const extension = nativeExtensionById(extensionId);
  if (!app || !extension || app.manifest.auth.mode !== extension.auth.mode) return false;
  const profile = app.manifest.ui.profiles.find((candidate) => candidate.id === app.installation.selectedUiProfile);
  if (profile && profile.mode !== "native-package") return false;
  const session = await getServerSession(authOptions);
  if (!session) return false;
  const localAllowed = canLaunchAgenticApp(
    app,
    agenticAppUserContextFromSession(session as unknown as Record<string, unknown>),
    { requireVisible: false },
  );
  if (!localAllowed || !app.manifest.authorization) return localAllowed;
  const subjectId = deriveAgenticAppSubjectId(session as unknown as Record<string, unknown>);
  if (!subjectId) return false;
  const decision = await evaluateAgenticAppCasCompatibility({
    appId: extensionId, subjectId, localEffect: "allow", correlationId: crypto.randomUUID(), action: "use",
  });
  return decision.effectiveEffect === "allow";
}
