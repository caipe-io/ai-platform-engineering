"use client";

import { useSyncExternalStore } from "react";

const subscribe = (): (() => void) => () => undefined;
const getClientSnapshot = (): boolean => true;
const getServerSnapshot = (): boolean => false;

/**
 * Reports whether React has crossed the server-hydration boundary.
 *
 * Browser-backed stores can already contain persisted values during the first
 * client render. Mask those values until hydration completes so the initial
 * DOM always matches the server output.
 */
export function useHydrated(): boolean {
  return useSyncExternalStore(
    subscribe,
    getClientSnapshot,
    getServerSnapshot,
  );
}
