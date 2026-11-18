import type { CustomThemeConfig } from "@/types/dynamic-agent";

/**
 * Shared gradient theme definitions for the application.
 * Used by settings panel (global theme) and dynamic agents (per-agent theme).
 */

export interface GradientTheme {
  id: string;
  label: string;
  description: string;
  from: string;
  to: string;
  preview: string;  // Tailwind classes for preview rendering
}

/**
 * All available gradient themes.
 * These can be used globally (via settings) or per-agent.
 */
export const gradientThemes: readonly GradientTheme[] = [
  {
    id: "default",
    label: "Default (Teal → Purple)",
    description: "Original vibrant gradient",
    from: "hsl(173,80%,40%)",
    to: "hsl(270,75%,60%)",
    preview: "from-[hsl(173,80%,40%)] to-[hsl(270,75%,60%)]"
  },
  {
    id: "neon",
    label: "Neon (Cyan → Magenta)",
    description: "Bright, electric grid glow",
    from: "hsl(187,85%,53%)",
    to: "hsl(292,85%,60%)",
    preview: "from-[hsl(187,85%,53%)] to-[hsl(292,85%,60%)]"
  },
  {
    id: "minimal",
    label: "Minimal (Gray → Dark Gray)",
    description: "Subtle, professional",
    from: "hsl(220,10%,40%)",
    to: "hsl(220,10%,25%)",
    preview: "from-gray-600 to-gray-800"
  },
  {
    id: "professional",
    label: "Professional (Blue → Navy)",
    description: "Corporate, trustworthy",
    from: "hsl(210,60%,50%)",
    to: "hsl(210,80%,30%)",
    preview: "from-blue-500 to-blue-800"
  },
  {
    id: "ocean",
    label: "Ocean (Cyan → Blue)",
    description: "Cool, calming",
    from: "hsl(195,80%,45%)",
    to: "hsl(220,80%,45%)",
    preview: "from-cyan-500 to-blue-600"
  },
  {
    id: "sunset",
    label: "Sunset (Orange → Pink)",
    description: "Warm, energetic",
    from: "hsl(30,80%,55%)",
    to: "hsl(340,70%,55%)",
    preview: "from-orange-500 to-pink-500"
  },
  {
    id: "cyberpunk",
    label: "Cyberpunk (Pink → Cyan)",
    description: "Neon-soaked, high-contrast",
    from: "hsl(330,100%,50%)",
    to: "hsl(180,100%,50%)",
    preview: "from-[hsl(330,100%,50%)] to-[hsl(180,100%,50%)]"
  },
  {
    id: "tron",
    label: "Tron (Cyan → Blue)",
    description: "Electric glow, digital frontier",
    from: "hsl(190,100%,50%)",
    to: "hsl(210,80%,40%)",
    preview: "from-[hsl(190,100%,50%)] to-[hsl(210,80%,40%)]"
  },
  {
    id: "matrix",
    label: "Matrix (Green → Dark Green)",
    description: "Phosphor glow, digital rain",
    from: "hsl(120,100%,45%)",
    to: "hsl(140,60%,25%)",
    preview: "from-[hsl(120,100%,45%)] to-[hsl(140,60%,25%)]"
  },
  // New themes
  {
    id: "forest",
    label: "Forest (Green → Teal)",
    description: "Natural, earthy",
    from: "hsl(140,50%,40%)",
    to: "hsl(170,50%,35%)",
    preview: "from-[hsl(140,50%,40%)] to-[hsl(170,50%,35%)]"
  },
  {
    id: "lavender",
    label: "Lavender (Purple → Indigo)",
    description: "Calm, creative",
    from: "hsl(270,60%,65%)",
    to: "hsl(240,50%,50%)",
    preview: "from-[hsl(270,60%,65%)] to-[hsl(240,50%,50%)]"
  },
  {
    id: "ember",
    label: "Ember (Red → Orange)",
    description: "Bold, attention-grabbing",
    from: "hsl(0,70%,50%)",
    to: "hsl(30,80%,50%)",
    preview: "from-[hsl(0,70%,50%)] to-[hsl(30,80%,50%)]"
  },
] as const;

export type GradientThemeId = typeof gradientThemes[number]["id"];

/**
 * Get gradient colors for a theme ID.
 * If themeId is "custom", uses the provided customConfig.
 * If themeId is empty/null, returns the current global theme from CSS variables.
 * If themeId is not found, returns the default theme colors.
 */
export function getGradientColors(themeId?: string | null, customConfig?: CustomThemeConfig | null): { from: string; to: string } {
  // Custom theme — use provided colors
  if (themeId === "custom" && customConfig) {
    return { from: customConfig.gradient_from, to: customConfig.gradient_to };
  }

  // If no theme specified, try to get global theme from CSS variables
  if (!themeId) {
    if (typeof window !== "undefined") {
      const root = document.documentElement;
      const from = getComputedStyle(root).getPropertyValue("--gradient-from").trim();
      const to = getComputedStyle(root).getPropertyValue("--gradient-to").trim();
      if (from && to) {
        return { from, to };
      }
    }
    // Fallback to default theme colors
    return { from: "hsl(173,80%,40%)", to: "hsl(270,75%,60%)" };
  }

  // Look up theme by ID
  const theme = gradientThemes.find((t) => t.id === themeId);
  if (theme) {
    return { from: theme.from, to: theme.to };
  }

  // Fallback to default
  return { from: "hsl(173,80%,40%)", to: "hsl(270,75%,60%)" };
}

/**
 * Get inline style object for a gradient background.
 * Useful for applying gradients to elements via style prop.
 */
export function getGradientStyle(themeId?: string | null, customConfig?: CustomThemeConfig | null): React.CSSProperties {
  const { from, to } = getGradientColors(themeId, customConfig);
  return {
    background: `linear-gradient(to bottom right, ${from}, ${to})`,
  };
}

/**
 * Get the accent color for the bot avatar SVG tint.
 * Returns the accent_color from custom config, or null for presets (use default white).
 */
export function getAccentColor(themeId?: string | null, customConfig?: CustomThemeConfig | null): string | null {
  if (themeId === "custom" && customConfig?.accent_color) {
    return customConfig.accent_color;
  }
  return null;
}

/**
 * Find a theme by ID.
 */
export function getThemeById(themeId: string): GradientTheme | undefined {
  return gradientThemes.find((t) => t.id === themeId);
}
