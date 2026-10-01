"use client";

import {
  createContext,
  useContext,
  useMemo,
  useState,
  type ReactNode,
  type RefCallback,
} from "react";
import { createPortal } from "react-dom";

interface WorkspacePageActionsContextValue {
  setTarget: RefCallback<HTMLDivElement>;
  target: HTMLDivElement | null;
}

const WorkspacePageActionsContext = createContext<
  WorkspacePageActionsContextValue | undefined
>(undefined);

export function WorkspacePageActionsProvider({
  children,
}: {
  children: ReactNode;
}): ReactNode {
  const [target, setTarget] = useState<HTMLDivElement | null>(null);
  const value = useMemo(() => ({ setTarget, target }), [target]);

  return (
    <WorkspacePageActionsContext.Provider value={value}>
      {children}
    </WorkspacePageActionsContext.Provider>
  );
}

export function useWorkspacePageActionsTarget():
  | RefCallback<HTMLDivElement>
  | undefined {
  return useContext(WorkspacePageActionsContext)?.setTarget;
}

/** Places page-specific controls beside its shared workspace title. */
export function WorkspacePageActions({
  children,
}: {
  children: ReactNode;
}): ReactNode {
  const context = useContext(WorkspacePageActionsContext);

  if (!context) return children;
  return context.target ? createPortal(children, context.target) : null;
}
