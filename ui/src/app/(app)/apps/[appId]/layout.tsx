import { notFound } from "next/navigation";

import { AuthGuard } from "@/components/auth-guard";
import { RoutedAgenticAppShell } from "@/components/agentic-apps/RoutedAgenticAppShell";
import { isAgenticAppsEnabled } from "@/lib/agentic-apps/config";

export default async function AppLayout({ children, params }: {
  children: React.ReactNode; params: Promise<{ appId: string }>;
}) {
  const { appId } = await params;
  if (!isAgenticAppsEnabled() || appId === "embed") notFound();
  return <AuthGuard>{children}<RoutedAgenticAppShell appId={appId} /></AuthGuard>;
}
