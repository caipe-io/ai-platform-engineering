"use client";

import { Check,Copy, type LucideIcon } from "lucide-react";
import { useCallback,useState } from "react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/**
 * Copy a string to the clipboard with a `document.execCommand("copy")` fallback
 * for non-secure contexts (e.g. HTTP localhost behind a port-forward) where
 * `navigator.clipboard` is not available. Exported so callers can reuse the
 * same fallback semantics without importing the button.
 */
export async function copyTextToClipboard(value: string): Promise<boolean> {
  if (typeof window === "undefined") return false;
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(value);
      return true;
    }
  } catch {
    // fall through to legacy path
  }
  try {
    const textarea = document.createElement("textarea");
    textarea.value = value;
    textarea.setAttribute("readonly", "");
    textarea.style.position = "fixed";
    textarea.style.top = "-1000px";
    textarea.style.opacity = "0";
    document.body.appendChild(textarea);
    textarea.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(textarea);
    return ok;
  } catch {
    return false;
  }
}

type CopyButtonValue = string | (() => string | Promise<string>);

export interface CopyButtonProps {
  /** Static string or a lazy resolver. Lazy resolvers run on click only. */
  value: CopyButtonValue;
  /** Accessible label for screen readers + tooltip. */
  label?: string;
  /** Optional inline label rendered next to the icon. */
  children?: React.ReactNode;
  size?: "icon" | "sm" | "default";
  variant?: "ghost" | "outline" | "secondary" | "default";
  className?: string;
  /** Override the success label (e.g. "Copied JSON"). */
  copiedLabel?: string;
  /** Optional disabled flag. */
  disabled?: boolean;
  /** Override the idle icon without changing success feedback or clipboard behavior. */
  icon?: LucideIcon;
}

export function CopyButton({
  value,
  label = "Copy",
  children,
  size,
  variant = "ghost",
  className,
  copiedLabel = "Copied",
  disabled,
  icon,
}: CopyButtonProps) {
  const [state, setState] = useState<"idle" | "copied" | "error">("idle");
  const inlineLabel = children ?? null;
  const buttonSize = size ?? (inlineLabel ? "sm" : "icon");

  const onClick = useCallback(async () => {
    const resolved = typeof value === "function" ? await value() : value;
    const ok = await copyTextToClipboard(resolved ?? "");
    setState(ok ? "copied" : "error");
    window.setTimeout(() => setState("idle"), 1800);
  }, [value]);

  const Icon = state === "copied" ? Check : icon ?? Copy;
  const ariaLive = state === "copied" ? copiedLabel : state === "error" ? "Copy failed" : label;

  return (
    <Button
      type="button"
      variant={variant}
      size={buttonSize}
      onClick={onClick}
      disabled={disabled}
      title={ariaLive}
      aria-label={ariaLive}
      className={cn(
        "gap-1.5",
        buttonSize === "icon" ? "h-7 w-7" : undefined,
        state === "copied" ? "text-emerald-600" : undefined,
        state === "error" ? "text-destructive" : undefined,
        className,
      )}
    >
      <Icon className="h-3.5 w-3.5" aria-hidden="true" />
      {inlineLabel ? <span className="text-xs">{inlineLabel}</span> : null}
      <span className="sr-only" role="status" aria-live="polite">
        {state === "copied" ? copiedLabel : state === "error" ? "Copy failed" : ""}
      </span>
    </Button>
  );
}
