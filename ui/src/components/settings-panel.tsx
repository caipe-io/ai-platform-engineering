"use client";

import {
  COLOR_THEMES,
  applyCachedAppearance,
  getDefaultAppearancePreferences,
  mergeUnchangedServerAppearance,
  normalizeServerAppearancePreferences,
  readCachedAppearancePreferences,
  snapshotAppearanceInteractions,
} from "@/lib/appearance-preferences";
import { apiClient } from "@/lib/api-client";
import { GuardedNavigationLink } from "@/components/layout/GuardedNavigationLink";
import { useTheme } from "@/components/theme-provider";
import { useHydrated } from "@/hooks/use-hydrated";
import { Palette } from "lucide-react";
import { useEffect,useRef } from "react";

/**
 * Header shortcut plus the global appearance hydrator.
 *
 * The controls themselves live on the routed Appearance settings page so there
 * is only one canonical editing surface.
 */
export function SettingsPanel(): React.ReactElement {
  const { theme,setTheme } = useTheme();
  const hydrated = useHydrated();
  const setThemeRef = useRef(setTheme);

  useEffect(() => {
    setThemeRef.current = setTheme;
  }, [setTheme]);

  useEffect(() => {
    let cancelled = false;
    const defaults = getDefaultAppearancePreferences();
    const cached = { ...defaults,...readCachedAppearancePreferences() };
    const interactionSnapshot = snapshotAppearanceInteractions();
    applyCachedAppearance(cached);

    void apiClient.getSettings()
      .then((settings) => {
        if (cancelled) return;
        const current = { ...cached,...readCachedAppearancePreferences() };
        const server = mergeUnchangedServerAppearance(
          current,
          normalizeServerAppearancePreferences(
            settings.preferences as unknown as Record<string,unknown>,
          ),
          interactionSnapshot,
        );
        applyCachedAppearance(server);
        setThemeRef.current(server.theme);
      })
      .catch((error: unknown) => {
        console.warn("[SettingsPanel] Account appearance could not be loaded; using this device",error);
      });

    return () => {
      cancelled = true;
    };
  }, []);

  const currentTheme = COLOR_THEMES.find((option) => option.id === theme);

  return (
    <GuardedNavigationLink
      aria-label="Appearance settings"
      className="flex h-8 items-center gap-1.5 rounded-md px-2 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
      href="/settings/appearance"
      title="Appearance settings"
    >
      <Palette className="h-3.5 w-3.5 shrink-0" />
      <span className="hidden whitespace-nowrap sm:block">
        {hydrated ? currentTheme?.label ?? "Appearance" : "Appearance"}
      </span>
    </GuardedNavigationLink>
  );
}
