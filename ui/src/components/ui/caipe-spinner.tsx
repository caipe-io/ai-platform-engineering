"use client";

import { BrandLogo } from "@/components/brand/BrandLogo";
import { getConfig } from "@/lib/config";
import { cn } from "@/lib/utils";

interface CAIPESpinnerProps {
  /** Size of the spinner */
  size?: "sm" | "md" | "lg" | "xl";
  /** Optional message to display below the spinner */
  message?: string;
  /** Custom className for the container */
  className?: string;
}

const sizeConfig = {
  sm: {
    container: "w-8 h-8",
    logo: "h-4 w-4",
    ring: "inset-[-2px]",
    blur: "inset-[-1px] blur-sm",
  },
  md: {
    container: "w-12 h-12",
    logo: "h-6 w-6",
    ring: "inset-[-3px]",
    blur: "inset-[-2px] blur-md",
  },
  lg: {
    container: "w-16 h-16",
    logo: "h-8 w-8",
    ring: "inset-[-4px]",
    blur: "inset-[-3px] blur-lg",
  },
  xl: {
    container: "w-20 h-20",
    logo: "h-12 w-12",
    ring: "inset-[-8px]",
    blur: "inset-[-4px] blur-xl",
  },
};

/**
 * CAIPE branded spinner with animated glow ring
 * Uses the logo from NEXT_PUBLIC_LOGO_URL environment variable
 */
export function CAIPESpinner({ 
  size = "md", 
  message,
  className 
}: CAIPESpinnerProps) {
  const config = sizeConfig[size];
  
  return (
    <div className={cn("flex flex-col items-center gap-3", className)}>
      {/* Logo with spinning glow ring */}
      <div className="relative">
        {/* Spinning glow ring */}
        <div
          className={cn(
            "absolute rounded-2xl opacity-30 gradient-primary-br",
            config.ring
          )}
          style={{
            animation: 'spin 3s linear infinite',
          }}
        />
        {/* Blur glow */}
        <div
          className={cn(
            "absolute rounded-xl opacity-40 gradient-primary",
            config.blur
          )}
        />
        {/* Logo container */}
        <div className={cn(
          "relative rounded-xl gradient-primary-br flex items-center justify-center shadow-xl",
          config.container
        )}>
          <BrandLogo
            alt={getConfig('appName')}
            className={config.logo}
            logoStyle={getConfig('logoStyle')}
            size={48}
            themed={getConfig('logoThemed')}
            src={getConfig('logoUrl')}
            variant="on-accent"
          />
        </div>
      </div>

      {/* Optional message */}
      {message && (
        <p className={cn(
          "text-muted-foreground text-center",
          size === "sm" && "text-xs",
          size === "md" && "text-sm",
          size === "lg" && "text-base",
          size === "xl" && "text-lg"
        )}>
          {message}
        </p>
      )}
    </div>
  );
}
