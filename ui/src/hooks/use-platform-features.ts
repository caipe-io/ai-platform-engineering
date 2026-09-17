"use client";

import { getConfig } from "@/lib/config";
import { useCallback, useEffect, useState } from "react";

export type PlatformFeatureKey = "workflows" | "schedules" | "autonomous_agents" | "apps";

export interface PlatformFeatureState {
  deployed: boolean;
  enabled: boolean;
}

export type PlatformFeatures = Record<PlatformFeatureKey, PlatformFeatureState>;

const FEATURE_KEYS: PlatformFeatureKey[] = [
  "workflows",
  "schedules",
  "autonomous_agents",
  "apps",
];

function deploymentDefaults(): PlatformFeatures {
  return {
    workflows: {
      deployed: Boolean(getConfig("workflowsEnabled") && getConfig("workflowRunnerEnabled")),
      enabled: Boolean(getConfig("workflowsEnabled") && getConfig("workflowRunnerEnabled")),
    },
    schedules: {
      deployed: Boolean(getConfig("schedulerEnabled")),
      enabled: Boolean(getConfig("schedulerEnabled")),
    },
    autonomous_agents: {
      deployed: Boolean(getConfig("autonomousAgentsEnabled")),
      enabled: Boolean(getConfig("autonomousAgentsEnabled")),
    },
    apps: {
      deployed: Boolean(getConfig("agenticAppsEnabled")),
      enabled: Boolean(getConfig("agenticAppsEnabled")),
    },
  };
}

function mergeFeatures(value: unknown, fallback: PlatformFeatures): PlatformFeatures {
  if (!value || typeof value !== "object" || Array.isArray(value)) return fallback;
  const source = value as Record<string, unknown>;
  return Object.fromEntries(
    FEATURE_KEYS.map((key) => {
      const item = source[key];
      if (!item || typeof item !== "object" || Array.isArray(item)) return [key, fallback[key]];
      const state = item as Record<string, unknown>;
      return [key, {
        deployed: state.deployed === true,
        enabled: state.enabled === true,
      }];
    }),
  ) as PlatformFeatures;
}

export function usePlatformFeatures(): PlatformFeatures {
  const [features, setFeatures] = useState<PlatformFeatures>(deploymentDefaults);

  const load = useCallback(async () => {
    const fallback = deploymentDefaults();
    try {
      const response = await fetch("/api/platform/features", { cache: "no-store" });
      if (!response.ok) return;
      const payload = await response.json() as { data?: { features?: unknown } };
      setFeatures(mergeFeatures(payload.data?.features, fallback));
    } catch {
      // Deployment flags remain the safe fallback when the persisted preference
      // endpoint is unavailable during startup.
    }
  }, []);

  useEffect(() => {
    // Load the persisted admin preference after mounting; deployment defaults
    // are already available synchronously for the first render.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
    const listener = () => void load();
    window.addEventListener("caipe:platform-features-updated", listener);
    return () => window.removeEventListener("caipe:platform-features-updated", listener);
  }, [load]);

  return features;
}
