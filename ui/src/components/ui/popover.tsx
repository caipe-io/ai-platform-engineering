"use client";

import { cn } from "@/lib/utils";
import * as React from "react";
import { createPortal } from "react-dom";

/**
 * Consumed by PopoverContent to portal into the nearest dialog element instead
 * of document.body.  Radix Dialog's DismissableLayer prevents pointer events
 * on nodes outside its DOM subtree — portalling to body makes the popover
 * invisible to Radix, so scroll and focus are swallowed.  DialogContent
 * provides itself as the container so the popover stays inside the Radix
 * FocusScope while position:fixed lets it escape overflow-y:auto clipping.
 */
export const PortalContainerContext = React.createContext<HTMLElement | null>(null);

interface PopoverProps {
  children: React.ReactNode;
  className?: string;
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
}

interface PopoverContextValue {
  open: boolean;
  setOpen: (open: boolean) => void;
  triggerRef: React.RefObject<HTMLElement | null>;
}

const PopoverStateContext = React.createContext<PopoverContextValue>({
  open: false,
  setOpen: () => {},
  triggerRef: { current: null },
});

export function Popover({
  children,
  className,
  open: controlledOpen,
  defaultOpen = false,
  onOpenChange,
}: PopoverProps) {
  const [uncontrolledOpen, setUncontrolledOpen] = React.useState(defaultOpen);
  const isControlled = controlledOpen !== undefined;
  const open = isControlled ? controlledOpen : uncontrolledOpen;
  const triggerRef = React.useRef<HTMLElement | null>(null);

  const setOpen = React.useCallback((value: boolean) => {
    if (!isControlled) {
      setUncontrolledOpen(value);
    }
    onOpenChange?.(value);
  }, [isControlled, onOpenChange]);

  React.useEffect(() => {
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === "Escape" && open) {
        setOpen(false);
        triggerRef.current?.focus();
      }
    };
    document.addEventListener("keydown", handleEscape);
    return () => document.removeEventListener("keydown", handleEscape);
  }, [open, setOpen]);

  return (
    <PopoverStateContext.Provider value={{ open, setOpen, triggerRef }}>
      <div className={cn("relative inline-flex",className)}>{children}</div>
    </PopoverStateContext.Provider>
  );
}

interface PopoverTriggerProps {
  children: React.ReactNode;
  asChild?: boolean;
}

export function PopoverTrigger({ children, asChild }: PopoverTriggerProps) {
  const { open, setOpen, triggerRef } = React.useContext(PopoverStateContext);

  const handleClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (e.currentTarget.getAttribute("aria-disabled") === "true") return;
    setOpen(!open);
  };

  // Capture the rendered DOM node so PopoverContent can compute viewport
  // coordinates from it. Without this the popover has no anchor when it's
  // portaled to document.body.
  const setRef = React.useCallback(
    (node: HTMLElement | null) => {
      triggerRef.current = node;
    },
    [triggerRef],
  );

  if (asChild && React.isValidElement(children)) {
    type ChildProps = React.HTMLAttributes<HTMLElement> & {
      ref?: React.Ref<HTMLElement>;
    };
    const childWithRef = children as React.ReactElement<ChildProps> & {
      ref?: React.Ref<HTMLElement>;
    };
    const existingRef = childWithRef.props.ref;
    const mergedRef = (node: HTMLElement | null) => {
      setRef(node);
      if (typeof existingRef === "function") existingRef(node);
      else if (existingRef && typeof existingRef === "object")
        // eslint-disable-next-line react-hooks/immutability
        (existingRef as React.MutableRefObject<HTMLElement | null>).current = node;
    };
    return React.cloneElement(childWithRef, {
      onClick: handleClick,
      ref: mergedRef,
    } as ChildProps);
  }

  return (
    <button type="button" onClick={handleClick} ref={setRef as React.Ref<HTMLButtonElement>}>
      {children}
    </button>
  );
}

interface PopoverContentProps {
  children: React.ReactNode;
  side?: "top" | "bottom" | "left" | "right";
  align?: "start" | "center" | "end";
  sideOffset?: number;
  alignOffset?: number;
  className?: string;
  onBlurCapture?: React.FocusEventHandler<HTMLDivElement>;
  onFocusCapture?: React.FocusEventHandler<HTMLDivElement>;
  onMouseEnter?: React.MouseEventHandler<HTMLDivElement>;
  onMouseLeave?: React.MouseEventHandler<HTMLDivElement>;
  portalled?: boolean;
}

/**
 * Popover content rendered via React portal — to `document.body` by default,
 * or into a `PortalContainerContext` element (e.g. a Radix Dialog) when one is
 * present.
 *
 * Fixed positioning and coordinates from the trigger's
 * `getBoundingClientRect()` keep the popover anchored without being clipped by
 * an ancestor's overflow. Viewport clamping also keeps the content on-screen
 * when the trigger lives in a narrow panel.
 *
 * When portalled into a container that has a CSS transform (Radix Dialog uses
 * `translate-*-[-50%]` to center itself), that container — not the viewport —
 * becomes the containing block for our `position: fixed` node, so we translate
 * the viewport coordinates into the container's frame (see computeCoords).
 *
 * Recomputed on open, on resize, and on scroll so it tracks the trigger
 * even when the user resizes the workspace pane or scrolls a dialog body
 * while the popover is open.
 */
const VIEWPORT_PADDING = 8;

export function PopoverContent({
  children,
  side = "bottom",
  align = "center",
  sideOffset = 8,
  alignOffset = 0,
  className,
  onBlurCapture,
  onFocusCapture,
  onMouseEnter,
  onMouseLeave,
  portalled = true,
}: PopoverContentProps) {
  const { open, setOpen, triggerRef } = React.useContext(PopoverStateContext);
  const portalContainer = React.useContext(PortalContainerContext);
  const contentRef = React.useRef<HTMLDivElement>(null);
  const [coords, setCoords] = React.useState<{ top: number; left: number } | null>(null);
  const [mounted, setMounted] = React.useState(false);

  React.useEffect(() => {
    setMounted(true);
  }, []);

  const computeCoords = React.useCallback(() => {
    const trigger = triggerRef.current;
    const content = contentRef.current;
    if (!trigger || !content) return;
    const tRect = trigger.getBoundingClientRect();
    const cRect = content.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;

    let top = 0;
    let left = 0;

    let effectiveSide = side;
    const spaceBelow = vh - tRect.bottom - sideOffset - VIEWPORT_PADDING;
    const spaceAbove = tRect.top - sideOffset - VIEWPORT_PADDING;

    if (side === "bottom" && cRect.height > spaceBelow && spaceAbove > spaceBelow) {
      effectiveSide = "top";
    } else if (side === "top" && cRect.height > spaceAbove && spaceBelow > spaceAbove) {
      effectiveSide = "bottom";
    }

    if (effectiveSide === "top") {
      top = tRect.top - cRect.height - sideOffset;
    } else if (effectiveSide === "bottom") {
      top = tRect.bottom + sideOffset;
    } else if (side === "left") {
      left = tRect.left - cRect.width - sideOffset;
    } else if (side === "right") {
      left = tRect.right + sideOffset;
    }

    if (effectiveSide === "top" || effectiveSide === "bottom") {
      if (align === "start") left = tRect.left + alignOffset;
      else if (align === "end") left = tRect.right - cRect.width - alignOffset;
      else left = tRect.left + tRect.width / 2 - cRect.width / 2;
    } else {
      if (align === "start") top = tRect.top + alignOffset;
      else if (align === "end") top = tRect.bottom - cRect.height - alignOffset;
      else top = tRect.top + tRect.height / 2 - cRect.height / 2;
    }

    // Viewport clamp — prevents the popover from disappearing off the
    // left/right edge of the screen on narrow side panels.
    left = Math.max(
      VIEWPORT_PADDING,
      Math.min(left, vw - cRect.width - VIEWPORT_PADDING),
    );
    top = Math.max(
      VIEWPORT_PADDING,
      Math.min(top, vh - cRect.height - VIEWPORT_PADDING),
    );

    const availableHeight = vh - 2 * VIEWPORT_PADDING;
    if (cRect.height > availableHeight) {
      content.style.maxHeight = `${availableHeight}px`;
      content.style.overflowY = "auto";
    } else {
      content.style.maxHeight = "";
      content.style.overflowY = "";
    }

    // `top`/`left` above are viewport coordinates, correct for a
    // `position: fixed` element whose containing block IS the viewport.  But
    // when we portal into a `portalContainer` (a Dialog), that container has a
    // CSS transform (`translate-*-[-50%]`), which makes it — not the viewport —
    // the containing block for our fixed element.  A fixed element trapped by a
    // transformed ancestor behaves like `absolute`: it resolves against the
    // container's padding box AND lives in the container's *scrolled* content
    // space.  So we (1) subtract the container's padding-box origin and
    // (2) add back its scroll offset.  Adding scrollTop makes the result
    // scroll-independent, so the popover rides the dialog's native scroll in
    // lockstep with the trigger instead of drifting by the scroll delta.
    if (portalContainer) {
      const pRect = portalContainer.getBoundingClientRect();
      top -= pRect.top + portalContainer.clientTop - portalContainer.scrollTop;
      left -= pRect.left + portalContainer.clientLeft - portalContainer.scrollLeft;
    }

    setCoords({ top, left });
  }, [align, alignOffset, side, sideOffset, triggerRef, portalContainer]);

  React.useLayoutEffect(() => {
    if (!open) {
      setCoords(null);
      return;
    }
    // Two-pass: first render off-screen so we can measure, then position.
    computeCoords();
    const onChange = () => computeCoords();
    window.addEventListener("resize", onChange);
    window.addEventListener("scroll", onChange, true);

    // Popover contents can grow after opening (for example, once permission-
    // gated navigation finishes loading). Recompute from the final dimensions
    // so every consumer gets the same viewport-aware placement without having
    // to predict its content height or implement its own flyout logic.
    const resizeObserver = typeof ResizeObserver === "undefined"
      ? null
      : new ResizeObserver(onChange);
    if (contentRef.current) resizeObserver?.observe(contentRef.current);
    if (triggerRef.current) resizeObserver?.observe(triggerRef.current);

    return () => {
      window.removeEventListener("resize", onChange);
      window.removeEventListener("scroll", onChange, true);
      resizeObserver?.disconnect();
    };
  }, [open,computeCoords,triggerRef]);

  React.useEffect(() => {
    if (!open) return;

    const handleClickOutside = (e: MouseEvent) => {
      const target = e.target as Node;
      if (contentRef.current?.contains(target)) return;
      if (triggerRef.current?.contains(target)) return;
      setOpen(false);
    };

    const id = window.setTimeout(() => {
      document.addEventListener("mousedown", handleClickOutside);
    }, 0);

    return () => {
      window.clearTimeout(id);
      document.removeEventListener("mousedown", handleClickOutside);
    };
  }, [open, setOpen, triggerRef]);

  if (!open || !mounted) return null;

  if (!portalled) {
    return (
      <div
        ref={contentRef}
        data-popover-content=""
        onBlurCapture={onBlurCapture}
        onFocusCapture={onFocusCapture}
        onMouseEnter={onMouseEnter}
        onMouseLeave={onMouseLeave}
        className={cn(
          "absolute left-0 top-full z-[60] mt-2 pointer-events-auto rounded-lg bg-popover text-popover-foreground shadow-lg border border-border",
          "animate-in fade-in-0 zoom-in-95 slide-in-from-top-2",
          className,
        )}
      >
        {children}
      </div>
    );
  }

  const node = (
    <div
      ref={contentRef}
      data-popover-content=""
      onBlurCapture={onBlurCapture}
      onFocusCapture={onFocusCapture}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
      style={{
        position: "fixed",
        top: coords?.top ?? -9999,
        left: coords?.left ?? -9999,
        visibility: coords ? "visible" : "hidden",
      }}
      className={cn(
        "z-[60] pointer-events-auto rounded-lg bg-popover text-popover-foreground shadow-lg border border-border",
        "animate-in fade-in-0 zoom-in-95",
        side === "bottom" && "slide-in-from-top-2",
        side === "top" && "slide-in-from-bottom-2",
        side === "left" && "slide-in-from-right-2",
        side === "right" && "slide-in-from-left-2",
        className,
      )}
    >
      {children}
    </div>
  );

  return createPortal(node, portalContainer ?? document.body);
}
