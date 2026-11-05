"use client";

import { BrandLogo } from "@/components/brand/BrandLogo";
import { config } from "@/lib/config";

interface LoadingScreenProps {
  message?: string;
  onCancel?: () => void;
  showCancel?: boolean;
}

/**
 * Branded loading screen with CAIPE logo
 * Used across login, logout, and auth guard screens
 */
export function LoadingScreen({
  message = "Loading...",
  onCancel,
  showCancel = false
}: LoadingScreenProps) {

  return (
    <div className="min-h-screen flex-1 w-full flex flex-col items-center justify-center bg-background relative overflow-hidden">
      {/* Background gradient */}
      <div
        className="absolute inset-0"
        style={{
          background: `linear-gradient(to bottom right, color-mix(in srgb, var(--gradient-from) 10%, transparent), transparent, color-mix(in srgb, var(--gradient-to) 10%, transparent))`
        }}
      />
      <div
        className="absolute inset-0"
        style={{
          background: `radial-gradient(ellipse at center, color-mix(in srgb, var(--gradient-from) 5%, transparent), transparent)`
        }}
      />

      <div className="relative z-10 flex flex-col items-center gap-6">
        {/* Logo with glow effect */}
        <div className="relative">
          {/* Spinning glow ring */}
          <div
            className="absolute inset-[-8px] rounded-3xl opacity-30 gradient-primary-br"
            style={{
              animation: 'spin 3s linear infinite',
            }}
          />
          {/* Blur glow */}
          <div
            className="absolute inset-[-4px] rounded-2xl blur-xl opacity-40 gradient-primary"
          />
          {/* Logo container */}
          <div className="relative w-20 h-20 rounded-2xl gradient-primary-br flex items-center justify-center shadow-2xl">
            <BrandLogo
              alt={config.appName}
              className="h-12 w-12"
              logoStyle={config.logoStyle}
              size={48}
              themed={config.logoThemed}
              src={config.logoUrl}
              variant="on-accent"
            />
          </div>
        </div>

        {/* Brand name */}
        <div className="text-center">
          <div className="flex items-center justify-center gap-2">
            <h1 className="text-2xl font-bold gradient-text">{config.appName}</h1>
            {config.envBadge && (
              <span className="px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider bg-amber-500/20 text-amber-500 border border-amber-500/30 rounded">
                {config.envBadge}
              </span>
            )}
          </div>
          <p className="text-xs text-muted-foreground mt-1">
            {config.tagline}
          </p>
        </div>

        {/* Loading indicator */}
        <div className="flex flex-col items-center gap-3 mt-2">
          <div className="flex items-center gap-3">
            {/* Custom spinner */}
            <div className="relative w-5 h-5">
              <div
                className="absolute inset-0 rounded-full border-2 border-primary/20"
                style={{ borderColor: config.spinnerColor ? `${config.spinnerColor}33` : undefined }}
              />
              <div
                className="absolute inset-0 rounded-full border-2 border-transparent border-t-primary"
                style={{
                  animation: 'spin 0.8s linear infinite',
                  borderTopColor: config.spinnerColor || undefined
                }}
              />
            </div>
            <span className="text-sm text-muted-foreground">{message}</span>
          </div>

          {/* Emergency reset button */}
          {showCancel && onCancel && (
            <div className="flex flex-col items-center gap-2 mt-4">
              <button
                onClick={onCancel}
                className="px-6 py-2 text-sm font-medium bg-destructive text-destructive-foreground rounded-md hover:bg-destructive/90 transition-colors shadow-lg"
              >
                Clear Session & Retry
              </button>
              <p className="text-xs text-muted-foreground max-w-xs text-center">
                This will clear all cookies and storage
              </p>
            </div>
          )}
        </div>
      </div>

      {/* Footer */}
      {config.showPoweredBy && (
        <p className="absolute bottom-6 text-center text-xs text-muted-foreground">
          Powered by OSS{" "}
          <a
            href="https://caipe.io"
            target="_blank"
            rel="noopener noreferrer"
            className="text-primary hover:underline"
          >
            caipe.io
          </a>
        </p>
      )}
    </div>
  );
}
