"use client";

import { getConfig } from "@/lib/config";
import { debugLog } from "@/lib/debug-log";
import { useEffect } from "react";

/**
 * ThemeInjector component
 * 
 * Injects custom CSS variables for gradient colors and spinner at runtime.
 * This allows the theme to be customized via environment variables.
 */
export function ThemeInjector() {
  useEffect(() => {
    const gradientFrom = getConfig('gradientFrom');
    const gradientTo = getConfig('gradientTo');
    const spinnerColor = getConfig('spinnerColor');
    const defaultGradientTheme = getConfig('defaultGradientTheme');

    debugLog('[ThemeInjector] Applying theme:', { gradientFrom, gradientTo, spinnerColor, defaultGradientTheme });

    const root = document.documentElement;

    if (gradientFrom) {
      root.style.setProperty('--gradient-from', gradientFrom);
    }

    if (gradientTo) {
      root.style.setProperty('--gradient-to', gradientTo);
    }

    if (spinnerColor) {
      root.style.setProperty('--spinner-color', spinnerColor);
    }

    if (defaultGradientTheme && !root.getAttribute('data-gradient-theme')) {
      root.setAttribute('data-gradient-theme', defaultGradientTheme);
    }
  }, []);

  return null;
}
