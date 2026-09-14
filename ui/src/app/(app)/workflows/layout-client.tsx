"use client";

import { AuthGuard } from "@/components/auth-guard";
import { WorkspaceBreadcrumbs } from "@/components/layout/WorkspacePageHeader";
import { WorkflowSidebar } from "@/components/workflows/WorkflowSidebar";
import React,{ useState } from "react";

/**
 * Client-side workflows layout — manages sidebar collapse state.
 */
export function WorkflowsLayoutClient({
  children,
}: {
  children: React.ReactNode;
}) {
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);

  return (
    <AuthGuard>
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
        <WorkspaceBreadcrumbs
          breadcrumbs={[
            { label: "Home",href: "/" },
            { label: "Workflows",href: "/workflows" },
          ]}
        />

        <div className="flex min-h-0 flex-1">
          <WorkflowSidebar
            collapsed={sidebarCollapsed}
            onCollapse={setSidebarCollapsed}
          />
          <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
            {children}
          </div>
        </div>
      </div>
    </AuthGuard>
  );
}
