"use client";

import type { ThemeProviderProps, UseThemeProps } from "next-themes";
import {
  useCallback,
  useEffect,
  useMemo,
  useSyncExternalStore,
  type SetStateAction,
} from "react";

const THEME_EVENT = "caipe:theme-change";
const CAIPE_THEMES = [
  "light",
  "legacy-light",
  "dark",
  "midnight",
  "nord",
  "tokyo",
  "cyberpunk",
  "tron",
  "matrix",
  "system",
];

function readThemePreference(): string | undefined {
  return document.documentElement.getAttribute("data-theme-preference") ?? undefined;
}

function readSystemTheme(): "dark" | "light" {
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

function subscribeTheme(onStoreChange: () => void): () => void {
  const media = window.matchMedia("(prefers-color-scheme: dark)");
  const onStorage = (event: StorageEvent) => {
    if (event.key === "theme") onStoreChange();
  };
  window.addEventListener(THEME_EVENT, onStoreChange);
  window.addEventListener("storage", onStorage);
  media.addEventListener("change", onStoreChange);
  return () => {
    window.removeEventListener(THEME_EVENT, onStoreChange);
    window.removeEventListener("storage", onStorage);
    media.removeEventListener("change", onStoreChange);
  };
}

function applyThemePreference(theme: string): void {
  const root = document.documentElement;
  const resolved = theme === "system" ? readSystemTheme() : theme;
  localStorage.setItem("theme",theme);
  root.setAttribute("data-theme-preference",theme);
  root.setAttribute("data-theme",resolved);
  root.style.removeProperty("color-scheme");
  window.dispatchEvent(new Event(THEME_EVENT));
}

export function useTheme(): UseThemeProps {
  const theme = useSyncExternalStore(subscribeTheme, readThemePreference, () => undefined);
  const systemTheme = useSyncExternalStore(subscribeTheme, readSystemTheme, () => undefined);
  const resolvedTheme = theme === "system" ? systemTheme : theme;
  const setTheme = useCallback((value: SetStateAction<string>) => {
    const current = readThemePreference() ?? "system";
    applyThemePreference(typeof value === "function" ? value(current) : value);
  }, []);

  useEffect(() => {
    if (!resolvedTheme) return;
    const root = document.documentElement;
    root.setAttribute("data-theme",resolvedTheme);
    root.style.removeProperty("color-scheme");
  }, [resolvedTheme]);

  return useMemo<UseThemeProps>(() => ({
    resolvedTheme,
    setTheme,
    systemTheme,
    theme,
    themes: CAIPE_THEMES,
  }), [resolvedTheme, setTheme, systemTheme, theme]);
}

export function ThemeProvider({
  children,
  defaultTheme = "system",
}: ThemeProviderProps): React.ReactElement {
  useEffect(() => {
    if (readThemePreference()) return;
    applyThemePreference(localStorage.getItem("theme") ?? defaultTheme);
  }, [defaultTheme]);

  return <>{children}</>;
}
