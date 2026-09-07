"use client";

import { cn } from "@/lib/utils";
import * as React from "react";
import { createPortal } from "react-dom";

interface TooltipProviderProps {
  children: React.ReactNode;
  delayDuration?: number;
}

const TooltipContext = React.createContext<{
  delayDuration: number;
}>({ delayDuration: 300 });

export function TooltipProvider({
  children,
  delayDuration = 300,
}: TooltipProviderProps) {
  return (
    <TooltipContext.Provider value={{ delayDuration }}>
      {children}
    </TooltipContext.Provider>
  );
}

interface TooltipProps {
  children: React.ReactNode;
  className?: string;
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
}

const TooltipStateContext = React.createContext<{
  open: boolean;
  setOpen: (open: boolean) => void;
  triggerRef: React.MutableRefObject<HTMLElement | null>;
  /**
   * Counter incremented while the cursor is over the tooltip content
   * itself. When > 0, the trigger's `mouseleave` does not close the
   * tooltip — the cursor has "landed" on the tooltip and the admin is
   * presumably reading or scrolling the body. This makes long-form
   * explainer tooltips actually usable: without it, the moment the
   * cursor leaves the small `?` trigger to scroll the tooltip body,
   * `pointer-events-none` + immediate close would yank the tooltip
   * away mid-read.
   */
  hoverHoldRef: React.MutableRefObject<number>;
  cancelPendingClose: () => void;
  scheduleClose: () => void;
}>({
  open: false,
  setOpen: () => {},
  triggerRef: { current: null },
  hoverHoldRef: { current: 0 },
  cancelPendingClose: () => {},
  scheduleClose: () => {},
});

export function Tooltip({
  children,
  className,
  open: controlledOpen,
  defaultOpen = false,
  onOpenChange,
}: TooltipProps) {
  const [uncontrolledOpen, setUncontrolledOpen] = React.useState(defaultOpen);
  const isControlled = controlledOpen !== undefined;
  const open = isControlled ? controlledOpen : uncontrolledOpen;
  const triggerRef = React.useRef<HTMLElement | null>(null);
  // Hover hold: count of active "I'm reading the tooltip body" hovers
  // (the trigger and the tooltip content each contribute). The
  // tooltip stays open whenever this is > 0, even after the
  // trigger's `mouseleave` fires.
  const hoverHoldRef = React.useRef<number>(0);
  // Short close grace period so the cursor can travel from the
  // trigger to the tooltip body without the tooltip slamming shut
  // in the gap.
  const closeTimeoutRef = React.useRef<NodeJS.Timeout | null>(null);

  const setOpen = React.useCallback(
    (value: boolean) => {
      if (!isControlled) {
        setUncontrolledOpen(value);
      }
      onOpenChange?.(value);
    },
    [isControlled, onOpenChange],
  );

  const cancelPendingClose = React.useCallback(() => {
    if (closeTimeoutRef.current) {
      clearTimeout(closeTimeoutRef.current);
      closeTimeoutRef.current = null;
    }
  }, []);

  const scheduleClose = React.useCallback(() => {
    cancelPendingClose();
    closeTimeoutRef.current = setTimeout(() => {
      if (hoverHoldRef.current === 0) {
        setOpen(false);
      }
    }, 120);
  }, [cancelPendingClose, setOpen]);

  React.useEffect(
    () => () => {
      cancelPendingClose();
    },
    [cancelPendingClose],
  );

  return (
    <TooltipStateContext.Provider
      value={{ open, setOpen, triggerRef, hoverHoldRef, cancelPendingClose, scheduleClose }}
    >
      <span
        ref={(node) => {
          const firstChild = node?.firstElementChild;
          triggerRef.current = firstChild instanceof HTMLElement ? firstChild : node;
        }}
        className={cn("relative inline-block",className)}
      >
        {children}
      </span>
    </TooltipStateContext.Provider>
  );
}

interface TooltipTriggerProps {
  children: React.ReactNode;
  asChild?: boolean;
}

type TooltipTriggerChildProps = React.HTMLAttributes<HTMLElement>;

interface TooltipTriggerSlotProps {
  child: React.ReactElement<TooltipTriggerChildProps>;
  onBlur: React.FocusEventHandler<HTMLElement>;
  onFocus: React.FocusEventHandler<HTMLElement>;
  onMouseEnter: React.MouseEventHandler<HTMLElement>;
  onMouseLeave: React.MouseEventHandler<HTMLElement>;
}

function TooltipTriggerSlot({
  child,
  onBlur,
  onFocus,
  onMouseEnter,
  onMouseLeave,
}: TooltipTriggerSlotProps) {
  return React.cloneElement(child, {
    onBlur,
    onFocus,
    onMouseEnter,
    onMouseLeave,
  });
}

export function TooltipTrigger({ children, asChild }: TooltipTriggerProps) {
  const { setOpen, triggerRef, hoverHoldRef, cancelPendingClose, scheduleClose } =
    React.useContext(TooltipStateContext);
  const { delayDuration } = React.useContext(TooltipContext);
  const openTimeoutRef = React.useRef<NodeJS.Timeout | null>(null);

  const handleMouseEnter = (event: React.MouseEvent<HTMLElement>) => {
    triggerRef.current = event.currentTarget;
    // Cursor is on the trigger — make sure no pending close fires.
    cancelPendingClose();
    hoverHoldRef.current += 1;
    openTimeoutRef.current = setTimeout(() => setOpen(true), delayDuration);
  };

  const handleMouseLeave = () => {
    if (openTimeoutRef.current) {
      clearTimeout(openTimeoutRef.current);
      openTimeoutRef.current = null;
    }
    // Trigger lost the cursor, but the user may be on their way to
    // the tooltip body. Decrement the hold counter and schedule a
    // delayed close; the tooltip content's own mouseenter will
    // re-bump the counter before the close timer fires.
    hoverHoldRef.current = Math.max(0, hoverHoldRef.current - 1);
    scheduleClose();
  };

  React.useEffect(() => {
    return () => {
      if (openTimeoutRef.current) clearTimeout(openTimeoutRef.current);
    };
  }, []);

  if (asChild && React.isValidElement<TooltipTriggerChildProps>(children)) {
    return (
      <TooltipTriggerSlot
        child={children}
        onMouseEnter={handleMouseEnter}
        onMouseLeave={handleMouseLeave}
        onFocus={(event) => {
        triggerRef.current = event.currentTarget;
        cancelPendingClose();
        setOpen(true);
        }}
        onBlur={() => {
        // Focus left the trigger; let the close timer decide. The
        // tooltip body is not focusable by default, so for a11y the
        // focus path is straightforward: close on blur.
        setOpen(false);
        }}
      />
    );
  }

  return (
    <span
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
      onFocus={(event) => {
        triggerRef.current = event.currentTarget;
        cancelPendingClose();
        setOpen(true);
      }}
      onBlur={() => setOpen(false)}
    >
      {children}
    </span>
  );
}

interface TooltipContentProps {
  children: React.ReactNode;
  side?: "top" | "bottom" | "left" | "right";
  sideOffset?: number;
  className?: string;
}

export function TooltipContent({
  children,
  side = "top",
  sideOffset = 4,
  className,
}: TooltipContentProps) {
  const { open, triggerRef, hoverHoldRef, cancelPendingClose, scheduleClose } =
    React.useContext(TooltipStateContext);
  const [position, setPosition] = React.useState({ top: 0, left: 0 });
  const contentRef = React.useRef<HTMLDivElement | null>(null);

  React.useEffect(() => {
    if (!open || !triggerRef.current) return;

    // Viewport gutter so the tooltip never hugs the edge.
    const VIEWPORT_MARGIN = 8;

    const updatePosition = () => {
      const trigger = triggerRef.current;
      if (!trigger) return;

      const rect = trigger.getBoundingClientRect();
      const viewportH = window.innerHeight;
      const contentEl = contentRef.current;
      const contentH = contentEl?.offsetHeight ?? 0;

      let top = 0;
      let left = 0;

      switch (side) {
        case "top":
          top = rect.top - sideOffset;
          left = rect.left + rect.width / 2;
          break;
        case "bottom":
          top = rect.bottom + sideOffset;
          left = rect.left + rect.width / 2;
          break;
        case "left":
          top = rect.top + rect.height / 2;
          left = rect.left - sideOffset;
          break;
        case "right":
          top = rect.top + rect.height / 2;
          left = rect.right + sideOffset;
          break;
      }

      // Clamp to viewport. The translate applied via Tailwind in
      // the content `<div>` shifts the actual rendered position:
      // top      → -translate-y-full        (body bottom == top)
      // bottom   → no Y translate           (body top    == top)
      // left/right → -translate-y-1/2       (body centered on top)
      //
      // We measure `contentH` from the rendered element and clamp
      // so the body stays inside [margin, viewportH - margin]. If
      // the body is taller than the viewport (long invariant
      // explainer near a viewport edge), the `max-h-[60vh] +
      // overflow-y-auto` class handles the rest — we just need to
      // make sure the *top* of the visible body is on screen so
      // admins can scroll the rest.
      if (contentH > 0) {
        const effectiveH = Math.min(contentH, viewportH - 2 * VIEWPORT_MARGIN);
        if (side === "top") {
          // Body top = top - contentH; clamp so body top >= margin.
          const bodyTop = top - effectiveH;
          if (bodyTop < VIEWPORT_MARGIN) {
            top = VIEWPORT_MARGIN + effectiveH;
          }
        } else if (side === "bottom") {
          // Body top = top; clamp so body bottom <= viewport - margin.
          if (top + effectiveH > viewportH - VIEWPORT_MARGIN) {
            top = Math.max(VIEWPORT_MARGIN, viewportH - VIEWPORT_MARGIN - effectiveH);
          }
        } else {
          // left / right — Y is centered on `top`. Clamp so the
          // half-height fits both above and below.
          const half = effectiveH / 2;
          top = Math.min(
            Math.max(top, VIEWPORT_MARGIN + half),
            viewportH - VIEWPORT_MARGIN - half,
          );
        }
      }

      setPosition({ top, left });
    };

    // Initial position, then again on the next frame so the
    // measurement step sees the actual rendered height (otherwise
    // `contentRef.current.offsetHeight` is 0 on first paint).
    updatePosition();
    const raf = requestAnimationFrame(updatePosition);

    // Update position on scroll/resize
    window.addEventListener('scroll', updatePosition, true);
    window.addEventListener('resize', updatePosition);

    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('scroll', updatePosition, true);
      window.removeEventListener('resize', updatePosition);
    };
  }, [open, side, sideOffset, triggerRef]);

  if (!open) return null;

  // Hover handlers on the tooltip content itself: bump the shared
  // hover-hold counter so the trigger's `mouseleave` does not close
  // the tooltip while the cursor is on the body. This is what makes
  // long-form explainer tooltips actually readable — without it,
  // moving the cursor 1px off the trigger collapses the tooltip
  // mid-scroll, mid-read.
  const handleContentMouseEnter = () => {
    cancelPendingClose();
    hoverHoldRef.current += 1;
  };

  const handleContentMouseLeave = () => {
    hoverHoldRef.current = Math.max(0, hoverHoldRef.current - 1);
    scheduleClose();
  };

  const content = (
    <div
      ref={contentRef}
      onMouseEnter={handleContentMouseEnter}
      onMouseLeave={handleContentMouseLeave}
      // role/aria-live so screen readers announce the body when it
      // appears. Not focusable yet — focus management for long-form
      // tooltips is a separate concern (we'd want a different
      // primitive, e.g. a popover, for genuinely interactive content).
      role="tooltip"
      className={cn(
        // Base style: positioned, popover surface, small text. We
        // intentionally drop `pointer-events-none` (the previous
        // default) so the cursor can land on the tooltip and read
        // / scroll the body — keeping the tooltip open via the
        // hover-hold counter above.
        "fixed z-[9999] px-2 py-1 text-xs font-medium text-popover-foreground bg-popover border border-border rounded-md shadow-lg whitespace-nowrap",
        // Cap the tooltip height to ~60% of the viewport (with a
        // hard upper bound) and scroll internally when the body
        // overflows. Short tooltips are well under this cap, so
        // they render exactly as before; long ones (the invariant
        // explainers and the structured warning tooltips) now
        // expose a scrollbar instead of clipping off-screen. The
        // `overscroll-contain` keeps the page from scrolling
        // underneath when the admin reaches the bottom of the
        // tooltip body.
        "max-h-[min(60vh,480px)] overflow-y-auto overscroll-contain",
        side === "top" && "-translate-x-1/2 -translate-y-full",
        side === "bottom" && "-translate-x-1/2",
        side === "left" && "-translate-x-full -translate-y-1/2",
        side === "right" && "-translate-y-1/2",
        className
      )}
      style={{
        top: `${position.top}px`,
        left: `${position.left}px`,
      }}
    >
      {children}
    </div>
  );

  // Use portal to render outside overflow containers
  if (typeof window !== 'undefined') {
    return createPortal(content, document.body);
  }

  return null;
}
