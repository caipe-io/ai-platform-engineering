/** Presentation-only values shared with same-origin app frames. */
const PALETTE_TOKENS = {
  background: "--background",
  foreground: "--foreground",
  card: "--card",
  cardForeground: "--card-foreground",
  primary: "--primary",
  primaryForeground: "--primary-foreground",
  secondary: "--secondary",
  mutedForeground: "--muted-foreground",
  border: "--border",
  destructive: "--destructive",
} as const;

export type AgenticAppPalette = Record<keyof typeof PALETTE_TOKENS, string>;

/** Only the HSL components used by Grid's palette are allowed in the bridge. */
export function readAgenticAppPalette(style: CSSStyleDeclaration): AgenticAppPalette | undefined {
  const entries = Object.entries(PALETTE_TOKENS).map(([key, property]) => [key, style.getPropertyValue(property).trim()] as const);
  if (entries.some(([, value]) => !/^-?\d{1,3}(?:\.\d+)?\s+\d{1,3}(?:\.\d+)?%\s+\d{1,3}(?:\.\d+)?%$/.test(value))) return undefined;
  return Object.fromEntries(entries) as AgenticAppPalette;
}
