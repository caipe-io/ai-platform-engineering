"use client";

import { WorkspaceRailProvider } from "@/components/layout/WorkspaceRailContext";
import { APPLICATION_NAVIGATION_COLLAPSED_COOKIE } from "@/lib/workspace-rail";
import React from "react";

interface ApplicationNavigationRegistration {
  areaKey: string;
  content: React.ReactNode;
}

interface ApplicationNavigationContextValue {
  closeMobileNavigation: () => void;
  mobileNavigationOpen: boolean;
  openMobileNavigation: () => void;
  registration: ApplicationNavigationRegistration | null;
  registerNavigation: (
    registration: ApplicationNavigationRegistration,
  ) => () => void;
  setMobileNavigationOpen: (open: boolean) => void;
  updateNavigation: (registration: ApplicationNavigationRegistration) => void;
}

const ApplicationNavigationContext =
  React.createContext<ApplicationNavigationContextValue | null>(null);

export function ApplicationNavigationProvider({
  children,
  initialCollapsed = false,
}: {
  children: React.ReactNode;
  initialCollapsed?: boolean;
}): React.ReactElement {
  const [registration,setRegistration] =
    React.useState<ApplicationNavigationRegistration | null>(null);
  const [mobileNavigationOpen,setMobileNavigationOpen] = React.useState(false);
  const registrationGenerationRef = React.useRef(0);

  const registerNavigation = React.useCallback(
    (nextRegistration: ApplicationNavigationRegistration) => {
      const generation = ++registrationGenerationRef.current;
      setRegistration(nextRegistration);
      return () => {
        queueMicrotask(() => {
          if (registrationGenerationRef.current !== generation) return;
          setRegistration((current) =>
            current?.areaKey === nextRegistration.areaKey ? null : current,
          );
        });
      };
    },
    [],
  );
  const updateNavigation = React.useCallback(
    (nextRegistration: ApplicationNavigationRegistration) => {
      setRegistration((current) =>
        current?.areaKey === nextRegistration.areaKey
          ? nextRegistration
          : current,
      );
    },
    [],
  );
  const openMobileNavigation = React.useCallback(
    () => setMobileNavigationOpen(true),
    [],
  );
  const closeMobileNavigation = React.useCallback(
    () => setMobileNavigationOpen(false),
    [],
  );

  const value = React.useMemo<ApplicationNavigationContextValue>(
    () => ({
      closeMobileNavigation,
      mobileNavigationOpen,
      openMobileNavigation,
      registration,
      registerNavigation,
      setMobileNavigationOpen,
      updateNavigation,
    }),
    [
      closeMobileNavigation,
      mobileNavigationOpen,
      openMobileNavigation,
      registration,
      registerNavigation,
      updateNavigation,
    ],
  );

  return (
    <ApplicationNavigationContext.Provider value={value}>
      <WorkspaceRailProvider
        collapsible
        cookieName={APPLICATION_NAVIGATION_COLLAPSED_COOKIE}
        initialCollapsed={initialCollapsed}
      >
        {children}
      </WorkspaceRailProvider>
    </ApplicationNavigationContext.Provider>
  );
}

export function useApplicationNavigation():
  | ApplicationNavigationContextValue
  | null {
  return React.useContext(ApplicationNavigationContext);
}

export function useRegisterApplicationNavigation({
  areaKey,
  content,
  version,
}: {
  areaKey?: string;
  content?: React.ReactNode;
  version?: string;
}): boolean {
  const context = useApplicationNavigation();
  const contentRef = React.useRef(content);
  const registerNavigation = context?.registerNavigation;
  const updateNavigation = context?.updateNavigation;

  React.useLayoutEffect(() => {
    contentRef.current = content;
  },[content]);

  React.useLayoutEffect(() => {
    if (!registerNavigation || !areaKey || !contentRef.current) return;
    return registerNavigation({ areaKey,content: contentRef.current });
  }, [areaKey,registerNavigation]);

  React.useLayoutEffect(() => {
    if (!updateNavigation || !areaKey || !contentRef.current) return;
    updateNavigation({ areaKey,content: contentRef.current });
  },[areaKey,updateNavigation,version]);

  return Boolean(context && areaKey && content != null);
}
