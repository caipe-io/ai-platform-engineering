import { RoutedAgenticAppShell } from "@/components/agentic-apps/RoutedAgenticAppShell";

export default async function AppRouteLayout({ children, params }: {
  children: React.ReactNode; params: Promise<{ appId: string }>;
}) {
  const { appId } = await params;
  return <>{children}<RoutedAgenticAppShell appId={appId} hostRoute /></>;
}
