"use client";

import { MoonStar, Settings, Sun, Sunrise, Sunset } from "lucide-react";
import { useSession } from "next-auth/react";

interface WelcomeBannerProps {
  onOpenPreferences?: () => void;
}

export type SunPhase = "dawn" | "day" | "sunset" | "night";

const SUN_PHASE_ICONS = {
  dawn: Sunrise,
  day: Sun,
  sunset: Sunset,
  night: MoonStar,
} satisfies Record<SunPhase, typeof Sun>;

export function WelcomeBanner({ onOpenPreferences }: WelcomeBannerProps = {}) {
  const { data: session } = useSession();
  const userName = session?.user?.name;
  const greeting = getGreeting();
  const displayName = userName?.split(" ")[0] || userName;
  const sunPhase = getSunPhase();
  const SunPhaseIcon = SUN_PHASE_ICONS[sunPhase];

  return (
    <div
      className="welcome-banner relative isolate overflow-hidden rounded-xl px-4 py-3"
      data-sun-phase={sunPhase}
      data-testid="welcome-banner"
    >
      <div className="relative z-10 flex min-h-7 items-center justify-between gap-3">
        <div
          className="flex min-w-0 flex-1 items-center gap-2.5 overflow-hidden"
          data-testid="welcome-banner-copy"
        >
          <span className="welcome-banner-icon flex h-6 w-6 shrink-0 items-center justify-center rounded-full">
            <SunPhaseIcon className="h-3.5 w-3.5" aria-hidden="true" />
          </span>
          <h1 className="welcome-banner-title truncate whitespace-nowrap text-base font-medium leading-none">
            {displayName ? `${greeting}, ${displayName}.` : `${greeting}.`}
          </h1>
        </div>
        {onOpenPreferences && (
          <button
            onClick={onOpenPreferences}
            data-testid="preferences-shortcut"
            className="welcome-banner-action flex shrink-0 items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm font-medium backdrop-blur-sm transition-colors"
          >
            <Settings className="h-3.5 w-3.5" />
            Preferences
          </button>
        )}
      </div>
    </div>
  );
}

function getGreeting(): string {
  const hour = new Date().getHours();
  if (hour >= 5 && hour < 12) return "Good morning";
  if (hour >= 12 && hour < 17) return "Good afternoon";
  return "Good evening";
}

function getSunPhase(): SunPhase {
  const hour = new Date().getHours();
  if (hour >= 5 && hour < 9) return "dawn";
  if (hour >= 9 && hour < 17) return "day";
  if (hour >= 17 && hour < 20) return "sunset";
  return "night";
}

export { getGreeting, getSunPhase };
