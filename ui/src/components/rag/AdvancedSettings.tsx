"use client";

import { cn } from "@/lib/utils";
import type { ReactNode } from "react";

interface AdvancedSettingsProps {
  title?: string;
  className?: string;
  /** Applied alongside the default content spacing, for grid layouts. */
  contentClassName?: string;
  children: ReactNode;
}

/** Collapsible section used by every ingestion surface that hides advanced options. */
export function AdvancedSettings({
  title = "Advanced settings",
  className,
  contentClassName,
  children,
}: AdvancedSettingsProps) {
  return (
    <details className={cn("rounded-lg border border-border/50 p-3", className)}>
      <summary className="cursor-pointer text-sm font-medium">{title}</summary>
      <div className={cn("mt-3 space-y-3", contentClassName)}>{children}</div>
    </details>
  );
}

export default AdvancedSettings;
