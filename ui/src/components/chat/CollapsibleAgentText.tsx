"use client";

import { useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { ChevronDown, ChevronUp } from "lucide-react";
import { Button } from "@/components/ui/button";

/** Clamp rendered prose, preserving Markdown, selection, and inline expansion during streaming. */
export function CollapsibleAgentText({ children }: { children: ReactNode }) {
  const id = useId();
  const ref = useRef<HTMLDivElement>(null);
  const [expanded, setExpanded] = useState(false);
  const [overflowing, setOverflowing] = useState(false);
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    const measure = () => setOverflowing(element.scrollHeight > 192);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    if (element.firstElementChild) observer.observe(element.firstElementChild);
    return () => observer.disconnect();
  }, [children]);
  return <div>
    <div id={id} ref={ref} className="select-text"
      style={overflowing && !expanded ? { maxHeight: 168, overflow: "hidden", maskImage: "linear-gradient(to bottom, black calc(100% - 3.5rem), transparent)" } : undefined}>
      {children}
    </div>
    {overflowing && <Button type="button" size="sm" variant="ghost" className="mt-1 h-7 px-0 text-xs text-muted-foreground"
      aria-controls={id} aria-expanded={expanded} onClick={() => setExpanded(value => !value)}>
      {expanded ? "Show less" : "Show more"}{expanded ? <ChevronUp className="ml-1 h-3 w-3" /> : <ChevronDown className="ml-1 h-3 w-3" />}
    </Button>}
  </div>;
}
