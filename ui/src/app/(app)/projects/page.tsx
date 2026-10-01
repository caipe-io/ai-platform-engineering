import { notFound } from "next/navigation";

import { AuthGuard } from "@/components/auth-guard";
import { ProjectsHub } from "@/components/projects/ProjectsHub";
import { getServerConfig } from "@/lib/config";

export default function ProjectsPage() {
  if (!getServerConfig().projectsEnabled) notFound();

  return (
    <AuthGuard>
      <ProjectsHub />
    </AuthGuard>
  );
}
