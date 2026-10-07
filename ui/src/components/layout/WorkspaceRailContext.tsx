"use client";

import {
  useCallback,
  createContext,
  useContext,
  useMemo,
  useState,
} from "react";
import { WORKSPACE_RAIL_COOKIE_MAX_AGE_SECONDS } from "@/lib/workspace-rail";

interface WorkspaceRailState {
  collapsed: boolean;
  collapsible: boolean;
  toggle: () => void;
}

const WorkspaceRailContext = createContext<WorkspaceRailState>({
  collapsed: false,
  collapsible: false,
  toggle: () => undefined,
});

export function WorkspaceRailProvider({
  children,
  collapsible,
  cookieName = "workspace-navigation-collapsed",
  initialCollapsed = false,
}: {
  children: React.ReactNode;
  collapsible: boolean;
  cookieName?: string;
  initialCollapsed?: boolean;
}): React.ReactElement {
  const [collapsed,setCollapsed] = useState(
    collapsible && initialCollapsed,
  );
  const toggle = useCallback(() => {
    if (!collapsible) return;
    const next = !collapsed;
    const secure = window.location.protocol === "https:" ? "; Secure" : "";
    document.cookie = `${encodeURIComponent(cookieName)}=${String(next)}; Path=/; Max-Age=${WORKSPACE_RAIL_COOKIE_MAX_AGE_SECONDS}; SameSite=Lax${secure}`;
    setCollapsed(next);
  },[collapsed,collapsible,cookieName]);

  const value = useMemo<WorkspaceRailState>(() => ({
    collapsed,
    collapsible,
    toggle,
  }),[collapsed,collapsible,toggle]);

  return (
    <WorkspaceRailContext.Provider value={value}>
      {children}
    </WorkspaceRailContext.Provider>
  );
}

export function useWorkspaceRail(): WorkspaceRailState {
  return useContext(WorkspaceRailContext);
}
