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
  closedAppSections: ReadonlySet<string>;
  mobileNavigationOpen: boolean;
  openMobileNavigation: () => void;
  registration: ApplicationNavigationRegistration | null;
  registerNavigation: (
    registration: ApplicationNavigationRegistration,
  ) => () => void;
  setAppSectionCollapsed: (appKey: string, collapsed: boolean) => void;
  setMobileNavigationOpen: (open: boolean) => void;
  updateNavigation: (registration: ApplicationNavigationRegistration) => void;
}

const ApplicationNavigationContext =
  React.createContext<ApplicationNavigationContextValue | null>(null);

const CLOSED_APP_SECTIONS_KEY = "caipe:closed-app-sections";

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
  const [closedAppSections,setClosedAppSections] = React.useState<ReadonlySet<string>>(() => new Set());
  const registrationGenerationRef = React.useRef(0);

  React.useEffect(() => {
    try {
      const stored: unknown = JSON.parse(window.sessionStorage.getItem(CLOSED_APP_SECTIONS_KEY) ?? "[]");
      if (Array.isArray(stored)) {
        setClosedAppSections(new Set(stored.filter((key): key is string => typeof key === "string")));
      }
    } catch {
      // Default to open when browser storage is unavailable or unreadable.
    }
  }, []);

  const setAppSectionCollapsed = React.useCallback((appKey: string, collapsed: boolean) => {
    const next = new Set(closedAppSections);
    if (collapsed) next.add(appKey);
    else next.delete(appKey);
    setClosedAppSections(next);
    try {
      window.sessionStorage.setItem(CLOSED_APP_SECTIONS_KEY, JSON.stringify([...next]));
    } catch {
      // Keep the in-memory preference usable when browser storage is unavailable.
    }
  }, [closedAppSections]);

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
      closedAppSections,
      mobileNavigationOpen,
      openMobileNavigation,
      registration,
      registerNavigation,
      setAppSectionCollapsed,
      setMobileNavigationOpen,
      updateNavigation,
    }),
    [
      closeMobileNavigation,
      closedAppSections,
      mobileNavigationOpen,
      openMobileNavigation,
      registration,
      registerNavigation,
      setAppSectionCollapsed,
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
