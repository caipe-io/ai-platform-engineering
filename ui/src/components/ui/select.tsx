import { cn } from "@/lib/utils";
import * as React from "react";

export type SelectProps = React.ComponentProps<"select">;

/**
 * Native-backed single select for small, static option sets.
 *
 * Browser semantics are intentional: mobile pickers, form participation, and
 * type-ahead keyboard behavior are more useful than search for short lists.
 */
const Select = React.forwardRef<HTMLSelectElement, SelectProps>(
  ({ className, ...props }, ref) => (
    <select
      ref={ref}
      className={cn(
        "flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
        "disabled:cursor-not-allowed disabled:opacity-50",
        className,
      )}
      {...props}
    />
  ),
);

Select.displayName = "Select";

export { Select };
