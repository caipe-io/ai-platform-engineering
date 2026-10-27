import { getServerSession } from "next-auth";
import { notFound, redirect } from "next/navigation";

import { AgenticAppShell } from "@/components/agentic-apps/AgenticAppShell";
import { authOptions } from "@/lib/auth-config";
import { canLaunchAgenticApp, agenticAppUserContextFromSession } from "@/lib/agentic-apps/access";
import { getConfiguredAgenticApp } from "@/lib/agentic-apps/config";
import { agenticAppHostPaths, ownsAppPath } from "@/lib/agentic-apps/host-routes";

/** Rewrites preserve the public URL; direct requests still require an active approved claim. */
export default async function AgenticAppHostRoute({ params }: {
  params: Promise<{ appId: string; path: string[] }>;
}): Promise<React.ReactElement> {
  const { appId, path } = await params;
  const app = getConfiguredAgenticApp(appId);
  const pathname = `/${path.join("/")}`;
  if (!app || !agenticAppHostPaths(app).some(root => ownsAppPath(root, pathname)) ||
      app.manifest.ui.profiles.find(p => p.id === app.installation.selectedUiProfile)?.mode !== "iframe") notFound();
  const session = await getServerSession(authOptions);
  if (!session) redirect(`/login?callbackUrl=${encodeURIComponent(pathname)}`);
  if (!canLaunchAgenticApp(app, agenticAppUserContextFromSession(session as unknown as Record<string, unknown>)))
    redirect("/unauthorized");
  return <AgenticAppShell appId={appId} path={path} hostRoute />;
}
