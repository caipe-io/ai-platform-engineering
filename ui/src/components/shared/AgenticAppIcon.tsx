"use client";

import { createLucideIcon, type LucideIcon, type LucideProps } from "lucide-react";
import { forwardRef } from "react";

const AppTileMark = createLucideIcon("app-tile", [["path", {
  d: "M6 2h12a4 4 0 0 1 4 4v12a4 4 0 0 1-4 4H6a4 4 0 0 1-4-4V6a4 4 0 0 1 4-4Z M12 6l1.6 4.4L18 12l-4.4 1.6L12 18l-1.6-4.4L6 12l4.4-1.6L12 6Z",
  fillRule: "evenodd",
  clipRule: "evenodd",
  stroke: "none",
  key: "tile",
}]]);

/** Filled app fallback with one large cutout that remains legible at 16px. */
export const AgenticAppIcon: LucideIcon = forwardRef<SVGSVGElement, LucideProps>(function AgenticAppIcon(
  { color = "currentColor", ...props },
  ref,
) {
  return (
    <AppTileMark {...props} ref={ref} color={color} fill={color} />
  );
});
