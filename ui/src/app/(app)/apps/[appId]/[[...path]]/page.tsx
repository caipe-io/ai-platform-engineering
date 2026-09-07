import { notFound } from "next/navigation";

import { AgenticAppShell } from "@/components/agentic-apps/AgenticAppShell";
import { AuthGuard } from "@/components/auth-guard";
import { isAgenticAppsEnabled } from "@/lib/agentic-apps/config";

export default async function AgenticAppPage({
  params,
}: {
  params: Promise<{ appId: string; path?: string[] }>;
}): Promise<React.ReactElement> {
  if (!isAgenticAppsEnabled()) notFound();
  const { appId, path = [] } = await params;
  if (appId === "embed") notFound();
  return (
    <AuthGuard>
      <AgenticAppShell appId={appId} path={path} />
    </AuthGuard>
  );
}
