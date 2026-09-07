"use client";

import { AuthGuard } from "@/components/auth-guard";
import { NavigationProgressLink } from "@/components/layout/NavigationProgressLink";
import { TrySkillsGateway } from "@/components/skills";
import { cn } from "@/lib/utils";
import { Waypoints } from "lucide-react";

export default function SkillsGatewayPage() {
  return (
    <AuthGuard>
      <div className="flex flex-col h-full overflow-hidden">
        <div className="shrink-0 border-b border-border px-6 pt-4 pb-2 flex gap-2">
          <NavigationProgressLink
            href="/skills"
            className="px-3 py-1.5 text-sm rounded-md text-muted-foreground hover:bg-muted transition-colors"
          >
            Skills Gallery
          </NavigationProgressLink>
          <button
            type="button"
            className={cn(
              "inline-flex items-center gap-2 px-3 py-1.5 text-sm rounded-md font-semibold",
              "text-white shadow-md shadow-cyan-500/30 border border-white/25",
              "bg-gradient-to-r from-sky-600 via-cyan-600 to-teal-600",
            )}
          >
            <Waypoints className="h-4 w-4 shrink-0" strokeWidth={2.25} />
            Skills Gateway
          </button>
        </div>
        <div className="flex-1 overflow-y-auto p-6">
          <TrySkillsGateway />
        </div>
      </div>
    </AuthGuard>
  );
}
