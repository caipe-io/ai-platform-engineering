import { create } from "zustand";

interface UnsavedChangesState {
  hasUnsavedChanges: boolean;
  pendingNavigationHref: string | null;
  /** In-app action blocked until the user discards edits (e.g. switch workflow). */
  pendingDeferredAction: (() => void) | null;

  setUnsaved: (dirty: boolean) => void;
  requestNavigation: (href: string) => void;
  requestDeferredAction: (action: () => void) => void;
  cancelNavigation: () => void;
  confirmNavigation: () => string | null;
  confirmDeferredAction: () => void;
}

export const useUnsavedChangesStore = create<UnsavedChangesState>()((set, get) => ({
  hasUnsavedChanges: false,
  pendingNavigationHref: null,
  pendingDeferredAction: null,

  setUnsaved: (dirty) => set({ hasUnsavedChanges: dirty }),

  requestNavigation: (href) => set({ pendingNavigationHref: href }),

  requestDeferredAction: (action) => {
    if (get().hasUnsavedChanges) {
      set({ pendingDeferredAction: action });
      return;
    }
    action();
  },

  cancelNavigation: () =>
    set({ pendingNavigationHref: null, pendingDeferredAction: null }),

  confirmNavigation: () => {
    const href = get().pendingNavigationHref;
    set({
      hasUnsavedChanges: false,
      pendingNavigationHref: null,
      pendingDeferredAction: null,
    });
    // Canonical embedded app entries require a document request, including
    // navigation resumed after an editor's existing discard dialog.
    if (href?.startsWith("/apps/")) {
      window.location.assign(href);
      return null;
    }
    return href;
  },

  confirmDeferredAction: () => {
    const action = get().pendingDeferredAction;
    set({
      hasUnsavedChanges: false,
      pendingNavigationHref: null,
      pendingDeferredAction: null,
    });
    action?.();
  },
}));
