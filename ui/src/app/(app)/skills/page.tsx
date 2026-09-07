"use client";

import { AuthGuard } from "@/components/auth-guard";
import { WorkspaceBreadcrumbs } from "@/components/layout/WorkspacePageHeader";
import {
SkillsGallery,
} from "@/components/skills";
import type { AgentSkill } from "@/types/agent-skill";
import { pushWithNavigationProgress } from "@/lib/navigation-progress";
import { useRouter } from "next/navigation";

export default function SkillsPage() {
  const router = useRouter();
  const handleEditConfig = (config: AgentSkill) => {
    pushWithNavigationProgress(router,`/skills/workspace/${encodeURIComponent(config.id)}`);
  };

  const handleCreateNew = () => {
    pushWithNavigationProgress(router,"/skills/workspace/new");
  };

  // Note: the Skills Gallery / Skills Gateway segmented toggle
  // is rendered inline inside `SkillsGallery`'s header toolbar (next
  // to "Scan history") rather than as a full-width row above the
  // gallery. That earlier full-width row was eating ~50px of
  // vertical space for two pills that fit naturally beside the
  // existing toolbar buttons. The Gateway page (`/skills/gateway`)
  // keeps its own row-style toggle since it doesn't have a gallery
  // header to host the inline version.
  return (
    <AuthGuard>
      <div className="flex flex-col h-full overflow-hidden">
        <div className="flex-1 overflow-y-auto px-4 pb-4 pt-3 sm:px-6">
          <WorkspaceBreadcrumbs
            breadcrumbs={[
              { label: "Home",href: "/" },
              { label: "Skills",href: "/skills" },
            ]}
          />
          <SkillsGallery
            onEditConfig={handleEditConfig}
            onCreateNew={handleCreateNew}
          />
        </div>
      </div>
    </AuthGuard>
  );
}
