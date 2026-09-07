import { notFound } from "next/navigation";

import { AuthGuard } from "@/components/auth-guard";
import { ProjectsHub } from "@/components/projects/ProjectsHub";
import { getProjectsEnabled } from "@/lib/projects-config";

export default async function ProjectsPage() {
  if (!(await getProjectsEnabled())) notFound();

  return (
    <AuthGuard>
      <ProjectsHub />
    </AuthGuard>
  );
}
