"use client";

import { useLayoutEffect, useState, type RefObject } from "react";

/** Spring Glide keeps the chat mounted while its window settles into the launcher. */
export function useAssistantDockMotion(
  open: boolean,
  enabled: boolean,
  panelRef: RefObject<HTMLElement | null>,
  launcherRef: RefObject<HTMLButtonElement | null>,
) {
  const [visited, setVisited] = useState(open);
  if (enabled && open && !visited) setVisited(true);

  useLayoutEffect(() => {
    if (!enabled) return;
    const panel = panelRef.current, launcher = launcherRef.current;
    if (!panel || !launcher) return;
    let disposed = false;
    const animations: Animation[] = [];
    const focusWasInside = panel.contains(document.activeElement);
    panel.style.display = "";
    panel.inert = !open;
    if (open) panel.removeAttribute("aria-hidden");
    else panel.setAttribute("aria-hidden", "true");
    const settle = () => {
      if (disposed) return;
      panel.style.display = open ? "" : "none";
      if (!open && focusWasInside) launcher.focus({ preventScroll: true });
    };
    const from = panel.getBoundingClientRect(), to = launcher.getBoundingClientRect();
    const reduced = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    if (reduced || !panel.animate || !from.width || !from.height || !to.width || !to.height) {
      settle();
      return;
    }
    const dx = to.left - from.left, dy = to.top - from.top;
    const sx = to.width / from.width, sy = to.height / from.height;
    const frames: Keyframe[] = [
      { transform: "none", opacity: 1, borderRadius: "24px", offset: 0 },
      { transform: `translate(${dx * .45}px,${dy * .25 - 28}px) scale(.88,.88)`, opacity: 1, borderRadius: "28px", offset: .38 },
      { transform: `translate(${dx - 9}px,${dy + 3}px) scale(${sx * .96},${sy * .96})`, opacity: .8, borderRadius: "40px", offset: .84 },
      { transform: `translate(${dx}px,${dy}px) scale(${sx},${sy})`, opacity: 0, borderRadius: "40px", offset: 1 },
    ];
    // Reverse the flight when opening; a new direction cancels the previous flight.
    const flight = open ? frames.map(frame => ({ ...frame, offset: 1 - Number(frame.offset) })).reverse() : frames;
    try {
      const animation = panel.animate(flight.map(frame => ({ ...frame, transformOrigin: "top left" })), {
        duration: open ? 750 : 1050, easing: "cubic-bezier(.4,0,.2,1)", fill: "both",
      });
      animations.push(animation);
      void animation.finished.then(() => {
        if (disposed) return;
        settle();
        animation.cancel();
        if (!open && launcher.animate) {
          animations.push(launcher.animate([
            { transform: "scale(1)", boxShadow: "0 0 0 0 rgba(34,211,238,.25)" },
            { transform: "scale(1.07)", boxShadow: "0 0 0 10px rgba(34,211,238,0)", offset: .45 },
            { transform: "scale(1)", boxShadow: "0 0 0 0 rgba(34,211,238,0)" },
          ], { duration: 450, easing: "cubic-bezier(.22,1,.36,1)" }));
        }
      }).catch(() => {}); // Cancellation is expected when reopening or leaving the app.
    } catch {
      settle(); // Unsupported animation implementations keep the launcher functional.
    }
    return () => {
      disposed = true;
      animations.forEach(animation => animation.cancel());
    };
  }, [open, enabled, panelRef, launcherRef]);

  return open || (enabled && visited);
}
