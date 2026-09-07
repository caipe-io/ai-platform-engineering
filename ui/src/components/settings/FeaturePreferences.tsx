"use client";

import { AutoSaveStatus } from "@/components/settings/shared/AutoSaveStatus";
import { SettingsSwitch } from "@/components/settings/shared/SettingsSwitch";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { useKeyedAutoSave } from "@/hooks/use-keyed-auto-save";
import { cn } from "@/lib/utils";
import {
  FEATURE_FLAGS,
  persistFeatureFlag,
  useFeatureFlagStore,
  type FeatureFlag,
  type FeatureFlagCategory,
  type FeatureFlagIcon,
} from "@/store/feature-flag-store";
import { ArrowDownToLine,Brain,Bug,Clock,Eye,Info } from "lucide-react";
import { useEffect,useRef } from "react";

const FLAG_ICONS: Record<FeatureFlagIcon,React.ReactNode> = {
  Brain: <Brain className="h-4 w-4" />,
  Bug: <Bug className="h-4 w-4" />,
  Eye: <Eye className="h-4 w-4" />,
  ArrowDownToLine: <ArrowDownToLine className="h-4 w-4" />,
  Clock: <Clock className="h-4 w-4" />,
};

interface FeaturePreferencesProps {
  categories?: FeatureFlagCategory[];
  ids?: string[];
}

function PreferenceRow({
  flag,
  onChange,
  onRetry,
  saveState,
  value,
}: {
  flag: FeatureFlag;
  onChange: (value: boolean) => void;
  onRetry: () => void;
  saveState: ReturnType<ReturnType<typeof useKeyedAutoSave<string,boolean>>["stateFor"]>;
  value: boolean;
}): React.ReactElement {
  return (
    <div className="rounded-lg border border-border/70">
      <div className="flex items-center gap-3 px-4 py-3">
        <span
          className={cn(
            "shrink-0 rounded-lg p-1.5",
            value ? "bg-primary/10 text-primary" : "bg-muted/50 text-muted-foreground",
          )}
        >
          {FLAG_ICONS[flag.icon]}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <span className="text-sm font-medium">{flag.label}</span>
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  aria-label={`More about ${flag.label}`}
                  className="rounded p-0.5 text-muted-foreground/50 transition-colors hover:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
                  type="button"
                >
                  <Info className="h-3 w-3" />
                </button>
              </TooltipTrigger>
              <TooltipContent
                className="max-w-xs whitespace-normal px-3 py-2 text-xs font-normal leading-relaxed"
                side="top"
                sideOffset={6}
              >
                {flag.detail}
              </TooltipContent>
            </Tooltip>
          </div>
          <p className="text-xs text-muted-foreground">{flag.description}</p>
          <AutoSaveStatus
            className="mt-1"
            onRetry={onRetry}
            state={saveState}
          />
        </div>
        <SettingsSwitch
          checked={value}
          label={flag.label}
          onCheckedChange={onChange}
          testId={`preference-${flag.id}`}
        />
      </div>
    </div>
  );
}

export function FeaturePreferences({
  categories,
  ids,
}: FeaturePreferencesProps): React.ReactElement {
  const { flags,initialize,setEnabled } = useFeatureFlagStore();
  const committedRef = useRef<Record<string,boolean>>({});

  useEffect(() => {
    initialize();
  }, [initialize]);

  const autoSave = useKeyedAutoSave<string,boolean>({
    persist: persistFeatureFlag,
    onSuccess: (id,value) => {
      committedRef.current[id] = value;
    },
    onError: (id) => {
      const committed = committedRef.current[id];
      if (typeof committed === "boolean") setEnabled(id,committed);
    },
  });

  const visibleFlags = FEATURE_FLAGS.filter((flag) => {
    if (ids) return ids.includes(flag.id);
    if (categories) return categories.includes(flag.category);
    return true;
  });

  const handleChange = (flag: FeatureFlag,value: boolean) => {
    const current = flags[flag.id] ?? flag.defaultValue;
    if (current === value) return;
    if (typeof committedRef.current[flag.id] !== "boolean") {
      committedRef.current[flag.id] = current;
    }
    setEnabled(flag.id,value);
    autoSave.enqueue(flag.id,value);
  };
  const retry = (id: string) => {
    const pendingValue = autoSave.pendingValueFor(id);
    if (pendingValue !== undefined) setEnabled(id,pendingValue);
    autoSave.retry(id);
  };

  return (
    <TooltipProvider delayDuration={150}>
      <div className="space-y-3">
        {visibleFlags.map((flag) => (
          <PreferenceRow
            flag={flag}
            key={flag.id}
            onChange={(value) => handleChange(flag,value)}
            onRetry={() => retry(flag.id)}
            saveState={autoSave.stateFor(flag.id)}
            value={flags[flag.id] ?? flag.defaultValue}
          />
        ))}
      </div>
    </TooltipProvider>
  );
}
