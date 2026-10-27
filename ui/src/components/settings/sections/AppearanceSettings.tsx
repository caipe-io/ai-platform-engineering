"use client";

import { AutoSaveStatus } from "@/components/settings/shared/AutoSaveStatus";
import { SettingsCard } from "@/components/settings/shared/SettingsCard";
import { SettingsSwitch } from "@/components/settings/shared/SettingsSwitch";
import { Select } from "@/components/ui/select";
import { apiClient } from "@/lib/api-client";
import {
  COLOR_THEMES,
  FONT_FAMILIES,
  FONT_SIZES,
  applyCachedAppearance,
  applyColorTheme,
  applyFontFamily,
  applyFontSize,
  applyGradientTheme,
  applyInterfaceShadows,
  applyAssistantFontScale,
  isAssistantFontScale,
  getDefaultAppearancePreferences,
  markAppearanceInteraction,
  mergeUnchangedServerAppearance,
  normalizeServerAppearancePreferences,
  readCachedAppearancePreferences,
  snapshotAppearanceInteractions,
  type AppearancePreferenceKey,
  type AppearancePreferences,
  type ColorTheme,
  type FontFamily,
  type FontSize,
  type GradientTheme,
} from "@/lib/appearance-preferences";
import { gradientThemes } from "@/lib/gradient-themes";
import { cn } from "@/lib/utils";
import { useKeyedAutoSave } from "@/hooks/use-keyed-auto-save";
import { useTheme } from "@/components/theme-provider";
import { Check,Monitor,Palette,Type } from "lucide-react";
import { useEffect,useState } from "react";

const THEME_SWATCHES: Record<ColorTheme,string> = {
  system: "bg-gray-400 border-gray-600",
  light: "border-teal-200 bg-gradient-to-br from-teal-50 via-sky-50 to-violet-100",
  "legacy-light": "bg-white border-gray-200",
  dark: "bg-[#0a0b0f] border-[#1e2028]",
  midnight: "bg-black border-gray-800",
  nord: "bg-[#2e3440] border-[#3b4252]",
  tokyo: "bg-[#1a1b26] border-[#24283b]",
  cyberpunk: "bg-[#120818] border-[#ff3399]",
  tron: "bg-[#080f12] border-[#00ccff]",
  matrix: "bg-[#081208] border-[#00e600]",
};

function ChoiceButton({
  active,
  children,
  onClick,
}: {
  active: boolean;
  children: React.ReactNode;
  onClick: () => void;
}): React.ReactElement {
  return (
    <button
      aria-pressed={active}
      className={cn(
        "flex min-h-12 w-full items-center justify-between rounded-lg border px-3 py-2.5 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        active
          ? "border-primary bg-primary/10"
          : "border-border hover:border-primary/50 hover:bg-muted/50",
      )}
      onClick={onClick}
      type="button"
    >
      {children}
      {active ? <Check className="ml-3 h-4 w-4 shrink-0 text-primary" /> : null}
    </button>
  );
}

export function AppearanceSettings(): React.ReactElement {
  const { setTheme } = useTheme();
  // Keep the server and first client render identical. next-themes applies the
  // cached palette before paint; the settings controls adopt the cached values
  // after hydration so React does not discard and repaint this subtree.
  const [preferences,setPreferences] = useState<AppearancePreferences>(
    getDefaultAppearancePreferences,
  );
  const [loading,setLoading] = useState(true);
  const [loadError,setLoadError] = useState<string | null>(null);

  const autoSave = useKeyedAutoSave<AppearancePreferenceKey,string | boolean>({
    persist: async (key,value) => {
      await apiClient.updatePreferences({ [key]: value });
    },
  });

  useEffect(() => {
    let cancelled = false;
    const cached = {
      ...getDefaultAppearancePreferences(),
      ...readCachedAppearancePreferences(),
    };
    const interactionSnapshot = snapshotAppearanceInteractions();
    void (async () => {
      // Yield past hydration before reflecting browser-only storage in React.
      await Promise.resolve();
      if (cancelled) return;
      setPreferences(current => {
        const initial = mergeUnchangedServerAppearance(current,cached,interactionSnapshot);
        return initial;
      });

      try {
        const settings = await apiClient.getSettings();
        if (cancelled) return;
        const serverPreferences = normalizeServerAppearancePreferences(
          settings.preferences as unknown as Record<string,unknown>,
        );
        setPreferences((current) => {
          const server = mergeUnchangedServerAppearance(
            current,
            serverPreferences,
            interactionSnapshot,
          );
          return server;
        });
      } catch (reason: unknown) {
        if (!cancelled) {
          setLoadError(
            reason instanceof Error
              ? `Using settings from this device. ${reason.message}`
              : "Using settings from this device because account preferences could not be loaded.",
          );
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!loading) applyCachedAppearance(preferences);
  }, [loading,preferences]);

  useEffect(() => {
    if (loading) return;
    applyColorTheme(preferences.theme);
    setTheme(preferences.theme);
  }, [loading,preferences.theme,setTheme]);

  const changeFontSize = (value: FontSize) => {
    markAppearanceInteraction("fontSize");
    setPreferences((current) => ({ ...current,fontSize: value }));
    applyFontSize(value);
    autoSave.enqueue("font_size",value);
  };

  const changeFontFamily = (value: FontFamily) => {
    markAppearanceInteraction("fontFamily");
    setPreferences((current) => ({ ...current,fontFamily: value }));
    applyFontFamily(value);
    autoSave.enqueue("font_family",value);
  };

  const changeTheme = (value: ColorTheme) => {
    markAppearanceInteraction("theme");
    setPreferences((current) => ({ ...current,theme: value }));
    applyColorTheme(value);
    setTheme(value);
    autoSave.enqueue("theme",value);
  };

  const changeGradient = (value: GradientTheme) => {
    markAppearanceInteraction("gradientTheme");
    setPreferences((current) => ({ ...current,gradientTheme: value }));
    applyGradientTheme(value);
    autoSave.enqueue("gradient_theme",value);
  };

  const changeShadows = (value: boolean) => {
    markAppearanceInteraction("shadowsEnabled");
    setPreferences(current => ({ ...current,shadowsEnabled: value }));
    applyInterfaceShadows(value);
    autoSave.enqueue("shadows_enabled",value);
  };

  const changeAssistantFont = (value: string) => {
    if (!isAssistantFontScale(value)) return;
    markAppearanceInteraction("assistantFontScale");
    setPreferences(current => ({ ...current,assistantFontScale: value }));
    applyAssistantFontScale(value);
    autoSave.enqueue("assistant_font_scale",value);
  };

  return (
    <div className="space-y-6">
      {loadError ? (
        <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm text-amber-700 dark:text-amber-300">
          {loadError}
        </div>
      ) : null}

      <SettingsCard
        description="Adjust the base size used throughout the interface."
        title={<span className="flex items-center gap-2"><Type className="h-5 w-5 text-primary" />Font size</span>}
      >
        <div aria-busy={loading} className="grid gap-2 sm:grid-cols-2">
          {FONT_SIZES.map((option) => (
            <ChoiceButton
              active={preferences.fontSize === option.id}
              key={option.id}
              onClick={() => changeFontSize(option.id)}
            >
              <span>
                <span className="block text-sm font-medium">{option.label}</span>
                <span className="text-xs text-muted-foreground">{option.size}</span>
              </span>
            </ChoiceButton>
          ))}
        </div>
        <AutoSaveStatus
          className="mt-3"
          onRetry={() => autoSave.retry("font_size")}
          state={autoSave.stateFor("font_size")}
        />
      </SettingsCard>

      <SettingsCard
        description="Choose the typeface used by the application."
        title={<span className="flex items-center gap-2"><Type className="h-5 w-5 text-primary" />Font family</span>}
      >
        <div className="grid gap-2 sm:grid-cols-2">
          {FONT_FAMILIES.map((option) => (
            <ChoiceButton
              active={preferences.fontFamily === option.id}
              key={option.id}
              onClick={() => changeFontFamily(option.id)}
            >
              <span>
                <span className="block text-sm font-medium">{option.label}</span>
                <span className="text-xs text-muted-foreground">{option.description}</span>
              </span>
            </ChoiceButton>
          ))}
        </div>
        <AutoSaveStatus
          className="mt-3"
          onRetry={() => autoSave.retry("font_family")}
          state={autoSave.stateFor("font_family")}
        />
      </SettingsCard>

      <SettingsCard
        description="Use your device setting or choose a color theme."
        title={<span className="flex items-center gap-2"><Palette className="h-5 w-5 text-primary" />Color theme</span>}
      >
        <div className="grid gap-2 sm:grid-cols-2">
          {COLOR_THEMES.map((option) => (
            <ChoiceButton
              active={preferences.theme === option.id}
              key={option.id}
              onClick={() => changeTheme(option.id)}
            >
              <span className="flex items-center gap-3">
                <span className={cn("h-7 w-7 rounded-full border-2",THEME_SWATCHES[option.id])} />
                <span>
                  <span className="block text-sm font-medium">{option.label}</span>
                  <span className="text-xs text-muted-foreground">{option.description}</span>
                </span>
              </span>
            </ChoiceButton>
          ))}
        </div>
        <AutoSaveStatus
          className="mt-3"
          onRetry={() => autoSave.retry("theme")}
          state={autoSave.stateFor("theme")}
        />
      </SettingsCard>

      <SettingsCard
        description="Choose the accent gradient used for branded interface elements."
        title={<span className="flex items-center gap-2"><Palette className="h-5 w-5 text-primary" />Accent gradient</span>}
      >
        <div className="grid gap-2 sm:grid-cols-2">
          {gradientThemes.map((option) => (
            <ChoiceButton
              active={preferences.gradientTheme === option.id}
              key={option.id}
              onClick={() => changeGradient(option.id)}
            >
              <span className="flex min-w-0 items-center gap-3">
                <span className={cn("h-10 w-10 shrink-0 rounded-lg bg-gradient-to-br",option.preview)} />
                <span className="min-w-0">
                  <span className="block truncate text-sm font-medium">{option.label}</span>
                  <span className="block truncate text-xs text-muted-foreground">{option.description}</span>
                </span>
              </span>
            </ChoiceButton>
          ))}
        </div>
        <AutoSaveStatus
          className="mt-3"
          onRetry={() => autoSave.retry("gradient_theme")}
          state={autoSave.stateFor("gradient_theme")}
        />
      </SettingsCard>

      <SettingsCard title="Interface shadows" description="Show decorative shadows and glow around panels, cards, and chat. Borders and keyboard focus remain visible.">
        <div className="flex items-center justify-between gap-4">
          <span className="text-sm">Show shadows</span>
          <SettingsSwitch checked={preferences.shadowsEnabled} label="Show interface shadows" onCheckedChange={changeShadows} />
        </div>
        <AutoSaveStatus className="mt-3" onRetry={() => autoSave.retry("shadows_enabled")} state={autoSave.stateFor("shadows_enabled")} />
      </SettingsCard>

      <SettingsCard title="Assistant appearance" description="Your display preferences apply to the shared assistant across apps.">
        <label className="mt-4 block text-sm font-medium">Chat text size
          <Select className="mt-2 max-w-xs" value={preferences.assistantFontScale} onChange={event => changeAssistantFont(event.target.value)}>
            <option value="auto">App default</option><option value="compact">Small</option><option value="default">Default</option><option value="large">Large</option>
          </Select>
        </label>
        <AutoSaveStatus className="mt-3" onRetry={() => autoSave.retry("assistant_font_scale")} state={autoSave.stateFor("assistant_font_scale")} />
      </SettingsCard>

      <SettingsCard
        description="This sample updates immediately as you change typography."
        title={<span className="flex items-center gap-2"><Monitor className="h-5 w-5 text-primary" />Preview</span>}
      >
        <div
          className="rounded-lg border border-border bg-background p-4"
          style={{
            fontFamily: preferences.fontFamily === "inter"
              ? "var(--font-inter), system-ui, sans-serif"
              : preferences.fontFamily === "source-sans"
                ? "var(--font-source-sans), system-ui, sans-serif"
                : preferences.fontFamily === "ibm-plex"
                  ? "var(--font-ibm-plex), system-ui, sans-serif"
                  : "system-ui, sans-serif",
            fontSize: FONT_SIZES.find((option) => option.id === preferences.fontSize)?.size,
          }}
        >
          <p className="mb-2">The quick brown fox jumps over the lazy dog.</p>
          <p className="mb-3 text-muted-foreground" style={{ fontSize: "0.85em" }}>
            ABCDEFGHIJKLMNOPQRSTUVWXYZ abcdefghijklmnopqrstuvwxyz 0123456789
          </p>
          <code className="rounded bg-muted px-2 py-1 font-mono" style={{ fontSize: "0.85em" }}>
            const agent = new DynamicAgent();
          </code>
        </div>
      </SettingsCard>
    </div>
  );
}
