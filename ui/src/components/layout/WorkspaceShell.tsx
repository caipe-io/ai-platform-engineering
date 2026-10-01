"use client";

import { useRegisterApplicationNavigation } from "@/components/layout/ApplicationNavigationContext";
import { WorkspacePageActionsProvider } from "@/components/layout/WorkspacePageActions";
import { cn } from "@/lib/utils";

interface WorkspaceShellProps {
  children: React.ReactNode;
  className?: string;
  containerClassName?: string;
  contentClassName?: string;
  header: React.ReactNode;
  maxWidthClassName?: string;
  navigation: React.ReactNode;
  navigationAreaKey?: string;
  navigationVersion?: string;
}

/** Shared page frame for routed workspaces with responsive section navigation. */
export function WorkspaceShell({
  children,
  className,
  containerClassName,
  contentClassName,
  header,
  maxWidthClassName = "max-w-none",
  navigation,
  navigationAreaKey,
  navigationVersion,
}: WorkspaceShellProps): React.ReactElement {
  const registeredWithApplicationShell = useRegisterApplicationNavigation({
    areaKey: navigationAreaKey,
    content: navigation,
    version: navigationVersion,
  });

  return (
    <WorkspacePageActionsProvider>
      <main className={cn("min-h-0 flex-1 overflow-y-auto", className)}>
        <div
          className={cn(
            "mx-auto flex min-h-full w-full flex-col gap-4 px-4 pb-6 pt-3 sm:px-6 lg:pb-8",
            maxWidthClassName,
            containerClassName,
          )}
        >
          <div className="[&>header]:mb-0">
            {header}
          </div>
          {!registeredWithApplicationShell ? navigation : null}
          <section
            className={cn("min-h-0 min-w-0 flex-1",contentClassName)}
          >
            {children}
          </section>
        </div>
      </main>
    </WorkspacePageActionsProvider>
  );
}
