import { Suspense } from "react";
import { notFound } from "next/navigation";

import { AgenticAppsHub } from "@/components/agentic-apps/AgenticAppsHub";
import { AuthGuard } from "@/components/auth-guard";
import { isAgenticAppsEnabled } from "@/lib/agentic-apps/config";

export default function AppsPage(): React.ReactElement {
  if (!isAgenticAppsEnabled()) notFound();
  return (
    <AuthGuard>
      <Suspense fallback={<p className="p-6 text-muted-foreground">Loading Apps…</p>}>
        <AgenticAppsHub />
      </Suspense>
    </AuthGuard>
  );
}
