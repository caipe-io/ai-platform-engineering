import type { GradientThemeId } from "@/lib/gradient-themes";

/**
 * Pick a stable avatar theme for agents without an explicit theme.
 * The palette is limited to themes available in the UI.
 */
const AGENT_THEME_PALETTE: readonly GradientThemeId[] = [
  "ocean",
  "sunset",
  "forest",
  "lavender",
  "ember",
  "professional",
  "cyberpunk",
  "tron",
  "matrix",
  "default",
];

export function getDeterministicAgentThemeId(agentId: string): GradientThemeId {
  let hash = 0x811c9dc5;

  for (let index = 0; index < agentId.length; index += 1) {
    hash ^= agentId.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }

  return AGENT_THEME_PALETTE[(hash >>> 0) % AGENT_THEME_PALETTE.length];
}
