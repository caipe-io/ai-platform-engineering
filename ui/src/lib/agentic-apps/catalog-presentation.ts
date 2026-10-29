/** Shared color treatments for catalog categories; no app IDs or deployment names. */
const PALETTES = {
  violet: {
    tile: "from-violet-400 via-cyan-300 to-indigo-500",
    glow: "from-violet-300/35 to-cyan-500/10",
    badge: "bg-violet-700 text-white",
    icon: "default",
  },
  emerald: {
    tile: "from-emerald-300 via-cyan-300 to-teal-500",
    glow: "from-emerald-300/40 to-cyan-500/10",
    badge: "bg-emerald-700 text-white",
    icon: "finance",
  },
  sky: {
    tile: "from-sky-300 via-cyan-300 to-blue-500",
    glow: "from-sky-300/40 to-cyan-500/10",
    badge: "bg-sky-700 text-white",
    icon: "weather",
  },
} as const;

export function catalogPresentation(category?: string) {
  const name = category?.trim().toLocaleLowerCase() ?? "";
  if (/\b(weather|forecast|climate)\b/.test(name)) return PALETTES.sky;
  if (/\b(cloud|finance|finops|cost)\b/.test(name)) return PALETTES.emerald;
  return PALETTES.violet;
}
