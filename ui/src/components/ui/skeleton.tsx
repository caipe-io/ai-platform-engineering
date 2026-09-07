import { cn } from "@/lib/utils";
import * as React from "react";

/** Neutral loading placeholder that can be composed into page-specific shapes. */
function Skeleton({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      aria-hidden="true"
      className={cn("animate-pulse rounded-md bg-muted/50", className)}
      {...props}
    />
  );
}

export { Skeleton };
