"use client";

import { AppHeader } from "@/components/layout/AppHeader";
import { SetupWizardGate } from "@/components/admin/settings/SetupWizard";
import { ProductTourGate } from "@/components/onboarding/ProductTour";
import {
  ApplicationNavigationDrawer,
  ApplicationNavigationRail,
} from "@/components/layout/ApplicationNavigation";
import { ApplicationNavigationProvider } from "@/components/layout/ApplicationNavigationContext";
import { HeaderBreadcrumbSlotProvider } from "@/components/layout/HeaderBreadcrumbSlot";
import { useUserInit } from "@/hooks/use-user-init";
import { finishNavigationProgress } from "@/lib/navigation-progress";
import { usePathname } from "next/navigation";
import React from "react";

export function AppLayoutClient({
  children,
  initialNavigationCollapsed,
}: {
  children: React.ReactNode;
  initialNavigationCollapsed: boolean;
}): React.ReactElement {
  const pathname = usePathname();

  // Initialize user in MongoDB on first login
  useUserInit();

  React.useEffect(() => {
    finishNavigationProgress();
  }, [pathname]);

  return (
    <ApplicationNavigationProvider
      initialCollapsed={initialNavigationCollapsed}
    >
      <HeaderBreadcrumbSlotProvider>
        {/* Clip rather than hide overflow: iframe anchors/focus must never scroll Grid's chrome. */}
        <div className="app-shell-canvas fixed inset-0 flex h-dvh overflow-clip bg-background noise-overlay">
          <ApplicationNavigationRail />
          <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-clip">
            <AppHeader />
            <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-clip">
              {children}
            </div>
          </div>
          <ApplicationNavigationDrawer />
          <SetupWizardGate />
          <ProductTourGate />
        </div>
      </HeaderBreadcrumbSlotProvider>
    </ApplicationNavigationProvider>
  );
}
