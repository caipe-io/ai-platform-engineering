import { notFound } from "next/navigation";

import { isAgenticAppsEnabled } from "@/lib/agentic-apps/config";

export default async function AgenticAppPage({
  params,
}: {
  params: Promise<{ appId: string; path?: string[] }>;
}): Promise<null> {
  if (!isAgenticAppsEnabled()) notFound();
  const { appId } = await params;
  if (appId === "embed") notFound();
  return null;
}
