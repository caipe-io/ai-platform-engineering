import Image from "next/image";
import { useId } from "react";

import { cn } from "@/lib/utils";

/** LOGO_URL values that are the grid mark. Only these are redrawn as the themed inline SVG. */
const GRID_LOGO_URLS = new Set(["/grid-neon-logo.svg"]);

export function isGridLogo(src?: string): boolean {
  return GRID_LOGO_URLS.has(src ?? "");
}

/**
 * Whether to draw the inline mark: only for the grid logo, unless LOGO_THEMED=false.
 * The default CAIPE logo and custom logos always render as the configured image.
 */
export function shouldTheme(src: string | undefined, themed: boolean | null): boolean {
  return themed !== false && isGridLogo(src);
}

const TILE_POSITIONS = [76, 204, 332];
const NODE_CENTERS = [128, 256, 384];
const CONNECTORS = [
  "M256 128V200",
  "M128 256H200",
  "M312 256H384",
  "M256 312V384",
  "M128 128L236 236",
  "M384 128L276 236",
  "M128 384L236 276",
  "M384 384L276 276",
];
const STROKE_WIDTH = 12;

export interface BrandLogoProps {
  /** Accessible name. Leave empty when the app name is shown next to the logo. */
  alt?: string;
  className?: string;
  /** Configured LOGO_URL. Shown as an image unless it is a grid logo. */
  src?: string;
  /** LOGO_STYLE. "white" draws the logo in white, for use on a colored tile. */
  logoStyle?: "default" | "white";
  /** "accent" follows the accent gradient. "on-accent" is white, for use on a gradient tile. */
  variant?: "accent" | "on-accent";
  /** Pixel size, used for the intrinsic width and height. */
  size: number;
  /** LOGO_THEMED: false keeps the grid logo as an image. true and null (default) theme it. */
  themed?: boolean | null;
}

/**
 * The logo. The configured LOGO_URL image with the LOGO_STYLE filter, unchanged,
 * except for the grid logo: that is drawn as inline SVG so it stays sharp at every
 * size and follows the theme. The default CAIPE logo is never redrawn.
 * Colors come from the --brand-* tokens in globals.css, which follow the
 * selected accent gradient and the light or dark theme.
 */
export function BrandLogo({
  alt = "",
  className,
  src,
  logoStyle = "default",
  variant = "accent",
  size,
  themed = null,
}: BrandLogoProps) {
  const gradientId = useId().replace(/:/g, "");

  if (!shouldTheme(src, themed)) {
    return (
      <Image
        alt={alt}
        aria-hidden={alt ? undefined : true}
        className={cn(className, logoStyle === "white" && "brightness-0 invert")}
        height={size}
        src={src as string}
        unoptimized
        width={size}
      />
    );
  }

  const white = variant === "on-accent" || logoStyle === "white";
  const stroke = white ? "#fff" : `url(#${gradientId}-stroke)`;
  const fill = white ? "#fff" : `url(#${gradientId}-node)`;

  return (
    <svg
      aria-hidden={alt ? undefined : true}
      aria-label={alt || undefined}
      className={cn("brand-logo", !white && "brand-logo-glow", className)}
      data-testid="brand-logo"
      fill="none"
      height={size}
      role={alt ? "img" : undefined}
      shapeRendering="geometricPrecision"
      viewBox="0 0 512 512"
      width={size}
    >
      {!white && (
        <defs>
          <linearGradient gradientUnits="userSpaceOnUse" id={`${gradientId}-stroke`} x1="64" x2="448" y1="64" y2="448">
            <stop offset="0" style={{ stopColor: "var(--brand-a)" }} />
            <stop offset="0.5" style={{ stopColor: "var(--brand-b)" }} />
            <stop offset="1" style={{ stopColor: "var(--brand-c)" }} />
          </linearGradient>
          <linearGradient gradientUnits="userSpaceOnUse" id={`${gradientId}-node`} x1="0" x2="512" y1="0" y2="0">
            <stop offset="0" style={{ stopColor: "var(--brand-a)" }} />
            <stop offset="1" style={{ stopColor: "var(--brand-c)" }} />
          </linearGradient>
        </defs>
      )}
      {TILE_POSITIONS.flatMap((y) =>
        TILE_POSITIONS.map((x) => (
          <rect height="104" key={`${x}-${y}`} rx="26" stroke={stroke} strokeWidth={STROKE_WIDTH} width="104" x={x} y={y} />
        )),
      )}
      {CONNECTORS.map((d) => (
        <path d={d} key={d} stroke={stroke} strokeLinecap="round" strokeWidth={STROKE_WIDTH} />
      ))}
      <rect height="48" rx="14" stroke={stroke} strokeWidth={STROKE_WIDTH} width="48" x="232" y="232" />
      <rect fill={fill} height="24" rx="8" width="24" x="244" y="244" />
      {NODE_CENTERS.flatMap((cy) =>
        NODE_CENTERS.filter((cx) => !(cx === 256 && cy === 256)).map((cx) => (
          <circle cx={cx} cy={cy} fill={fill} key={`${cx}-${cy}`} r={cx === 256 || cy === 256 ? 11 : 13} />
        )),
      )}
    </svg>
  );
}
