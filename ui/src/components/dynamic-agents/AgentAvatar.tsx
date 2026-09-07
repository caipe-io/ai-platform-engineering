"use client";

/**
 * AgentAvatar — Shared avatar component for dynamic agents.
 *
 * Accepts the agent object (or any subset with theme fields) and resolves
 * the gradient internally. Handles loading skeleton, streaming pulse,
 * and fallback styling.
 *
 * Theme resolution:
 * 1. agent.ui.gradient_theme + agent.ui.custom_theme_config (current)
 * 2. agent.gradient_theme + agent.custom_theme_config (legacy, no ui wrapper)
 */

import { getAccentColor,getGradientStyle } from "@/lib/gradient-themes";
import { cn } from "@/lib/utils";
import type { CustomThemeConfig } from "@/types/dynamic-agent";
import { Bot,Loader2 } from "lucide-react";
import React from "react";

/** Minimal shape the avatar needs — accepts full agent or any subset */
export interface AgentAvatarAgent {
  ui?: {
    gradient_theme?: string;
    custom_theme_config?: CustomThemeConfig;
  } | null;
  /** Legacy: gradient_theme at top level (before ui field existed) */
  gradient_theme?: string | null;
  /** Legacy: custom_theme_config at top level */
  custom_theme_config?: CustomThemeConfig | null;
}

export interface AgentAvatarProps {
  /** Agent object — component extracts theme from agent.ui (or legacy agent.gradient_theme) */
  agent?: AgentAvatarAgent | null;
  /** Override gradient theme (used when agent is null, e.g. editor live preview) */
  gradientTheme?: string | null;
  /** Override custom theme config (used when agent is null, e.g. editor live preview) */
  customThemeConfig?: CustomThemeConfig | null;
  /** Use the user's global accent for application-level avatar treatments. */
  useGlobalTheme?: boolean;
  /** Border radius — exact Tailwind class (e.g. "rounded-full", "rounded-xl") */
  rounded?: string;
  /** Container size — exact Tailwind classes (e.g. "w-9 h-9") */
  size?: string;
  /** Icon size — exact Tailwind classes (e.g. "h-4 w-4") */
  iconSize?: string;
  /** Show neutral pulsing skeleton (agent info not yet loaded) */
  isLoading?: boolean;
  /** Pulse the avatar (agent is currently streaming) */
  isStreaming?: boolean;
  /** Override the default Bot icon (receives resolved iconSize and color via className/style on wrapper) */
  icon?: React.ComponentType<{ className?: string; style?: React.CSSProperties }>;
  /** Additional classes on the container */
  className?: string;
}

export function AgentAvatar({
  agent,
  gradientTheme: gradientThemeOverride,
  customThemeConfig: customThemeConfigOverride,
  useGlobalTheme = false,
  rounded = "rounded-xl",
  size = "w-9 h-9",
  iconSize = "h-4 w-4",
  isLoading = false,
  isStreaming = false,
  icon,
  className,
}: AgentAvatarProps) {
  if (isLoading) {
    return (
      <div
        className={cn(
          "flex items-center justify-center shrink-0 bg-muted animate-pulse",
          rounded,
          size,
          className,
        )}
      />
    );
  }

  // Resolve theme: explicit overrides > agent.ui > legacy top-level fields > null
  const resolvedGradientTheme = gradientThemeOverride ?? agent?.ui?.gradient_theme ?? agent?.gradient_theme ?? null;
  const resolvedCustomThemeConfig = customThemeConfigOverride ?? agent?.ui?.custom_theme_config ?? agent?.custom_theme_config ?? null;

  const gradientStyle = !useGlobalTheme && resolvedGradientTheme
    ? getGradientStyle(resolvedGradientTheme, resolvedCustomThemeConfig)
    : null;
  const iconColor = useGlobalTheme
    ? "white"
    : resolvedGradientTheme
    ? (getAccentColor(resolvedGradientTheme, resolvedCustomThemeConfig) || "white")
    : null;

  // Default fallback: light gray background with dark gray icon
  const isDefault = !gradientStyle;

  const resolvedIconColor = iconColor || (isDefault ? "#6b7280" : "white");

  // Determine which icon to render: streaming spinner > explicit override > default Bot
  const IconComponent = isStreaming ? Loader2 : (icon ?? Bot);
  const renderedIcon = (
    <IconComponent
      className={cn(iconSize, isStreaming && "animate-spin")}
      style={{ color: resolvedIconColor }}
    />
  );

  return (
    <div
      className={cn(
        "flex items-center justify-center shrink-0",
        rounded,
        size,
        useGlobalTheme
          ? "gradient-primary-br text-white shadow-sm"
          : isDefault
            ? "bg-gray-100 dark:bg-gray-800 border border-gray-300 dark:border-gray-600"
            : "shadow-sm",
        isStreaming && "animate-pulse",
        className,
      )}
      style={gradientStyle || undefined}
    >
      {renderedIcon}
    </div>
  );
}
