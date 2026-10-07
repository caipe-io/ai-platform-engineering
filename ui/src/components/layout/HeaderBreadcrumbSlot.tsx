"use client";

/**
 * Lets a page layout (e.g. chat/layout.tsx) render its breadcrumb trail
 * *inside* AppHeader's row instead of in its own padded block underneath
 * it. Same portal-into-a-context-target idea already used by
 * `WorkspacePageActions`, just running in the other direction: here the
 * header owns the slot, and pages portal content into it.
 */

import {
  useCallback,
  createContext,
  useContext,
  useId,
  useLayoutEffect,
  useMemo,
  useState,
  type ReactNode,
  type RefCallback,
} from "react";
import { createPortal } from "react-dom";

interface HeaderBreadcrumbSlotContextValue {
  hasPortalContent: boolean;
  registerPortal: (id: string) => () => void;
  setTarget: RefCallback<HTMLDivElement>;
  target: HTMLDivElement | null;
}

const HeaderBreadcrumbSlotContext = createContext<
  HeaderBreadcrumbSlotContextValue | undefined
>(undefined);

/** Mount once, high in the tree (AppLayoutClient), alongside AppHeader. */
export function HeaderBreadcrumbSlotProvider({
  children,
}: {
  children: ReactNode;
}) {
  const [target, setTarget] = useState<HTMLDivElement | null>(null);
  const [activePortalIds, setActivePortalIds] = useState<Set<string>>(
    () => new Set(),
  );
  const registerPortal = useCallback((id: string) => {
    setActivePortalIds((current) => {
      const next = new Set(current);
      next.add(id);
      return next;
    });

    return () => {
      setActivePortalIds((current) => {
        const next = new Set(current);
        next.delete(id);
        return next;
      });
    };
  }, []);
  const value = useMemo(
    () => ({
      hasPortalContent: activePortalIds.size > 0,
      registerPortal,
      setTarget,
      target,
    }),
    [activePortalIds.size, registerPortal, target],
  );

  return (
    <HeaderBreadcrumbSlotContext.Provider value={value}>
      {children}
    </HeaderBreadcrumbSlotContext.Provider>
  );
}

/** Read the slot state when the header also needs to render a route fallback. */
export function useHeaderBreadcrumbSlot():
  | HeaderBreadcrumbSlotContextValue
  | undefined {
  return useContext(HeaderBreadcrumbSlotContext);
}

/**
 * Used by a page layout to render its breadcrumb into the header slot.
 * Renders nothing until AppHeader has mounted and registered the target
 * (same brief-flash tradeoff WorkspacePageActions already accepts).
 */
export function HeaderBreadcrumbPortal({
  children,
}: {
  children: ReactNode;
}) {
  const context = useContext(HeaderBreadcrumbSlotContext);
  const portalId = useId();
  const registerPortal = context?.registerPortal;

  useLayoutEffect(() => {
    if (!registerPortal) return;
    return registerPortal(portalId);
  }, [portalId, registerPortal]);

  // Component tests and reusable fragments may render outside the app shell.
  // Preserve the breadcrumb inline in that case instead of hiding navigation.
  if (!context) return <>{children}</>;
  if (!context.target) return null;
  return createPortal(children, context.target);
}
