"use client";

import { create } from "zustand";
import { isCaipeTourEnabled, normalizeEnabledTours, ALL_PRODUCT_TOUR_IDS } from "@/lib/caipe-tour-policy";
import type { ProductTourId } from "@/lib/product-tour-catalog";
import type { ProductTourPayload } from "@/lib/product-tour";

interface CaipeTourPreferences {
  loaded: boolean;
  enabled: boolean;
  platformEnabled: boolean;
  setPlatformEnabled: (enabled: boolean) => void;
  enabledTours: ProductTourId[];
  error: string | null;
  receive: (payload: ProductTourPayload) => void;
  refresh: () => Promise<void>;
  reset: () => void;
}
let requestVersion = 0;

export const useCaipeTourStore = create<CaipeTourPreferences>((set, get) => ({
  loaded: false,
  enabled: true,
  platformEnabled: true,
  setPlatformEnabled: (platformEnabled) => { requestVersion++; set({ platformEnabled }); },
  enabledTours: [...ALL_PRODUCT_TOUR_IDS],
  error: null,
  receive: (payload) => {
    requestVersion++;
    set({ loaded: true, enabled: payload.tours_enabled !== false, platformEnabled: isCaipeTourEnabled(payload.platform_enabled), enabledTours: normalizeEnabledTours(payload.enabled_tours), error: null });
  },
  refresh: async () => {
    const version = ++requestVersion;
    try {
      const response = await fetch("/api/onboarding/product-tour", { cache: "no-store" });
      const payload = await response.json();
      if (!response.ok || payload?.success !== true || !payload.data?.state) throw new Error(payload?.error || "Could not load CAIPE Tour settings");
      if (version === requestVersion) get().receive(payload.data);
    } catch (error) {
      if (version === requestVersion) set({ error: error instanceof Error ? error.message : "Could not load CAIPE Tour settings" });
    }
  },
  reset: () => {
    requestVersion++;
    set({ loaded: false, enabled: true, platformEnabled: true, enabledTours: [...ALL_PRODUCT_TOUR_IDS], error: null });
  },
}));
