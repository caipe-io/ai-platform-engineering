export const LIGHT_COLOR_THEME_IDS = ["light", "legacy-light"] as const;

export function isLightColorTheme(theme: string | null | undefined): boolean {
  return LIGHT_COLOR_THEME_IDS.some((lightTheme) => lightTheme === theme);
}
