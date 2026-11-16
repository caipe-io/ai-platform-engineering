"use client";

import { useRef, useState, type PointerEvent } from "react";
import { ArrowDown, ArrowUp, GripVertical } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";

export type GroupDrop = { key: string; position: "before" | "after" };

/** A dedicated handle keeps group reordering separate from moving chats into folders. */
export function ChatHistoryGroupReorder({ groupKey, label, keys, scope, disabled, onMove, onTarget, viewport }: {
  groupKey: string; label: string; keys: string[]; scope: string; disabled: boolean;
  onMove: (source: string, target: GroupDrop) => void;
  onTarget: (target: GroupDrop | null) => void; viewport: HTMLElement | null;
}) {
  const handle = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [dragging, setDragging] = useState(false);
  const drag = useRef<{ pointerId: number; x: number; y: number; scope: string; moved: boolean } | null>(null);
  const suppressClick = useRef(false);
  const index = keys.indexOf(groupKey);
  const clear = () => { drag.current = null; setDragging(false); onTarget(null); };
  const targetAt = (event: PointerEvent<HTMLButtonElement>): GroupDrop | null => {
    const header = event.currentTarget.ownerDocument.elementFromPoint(event.clientX, event.clientY)?.closest("[data-chat-group-key]");
    const key = header?.getAttribute("data-chat-group-key");
    if (!header || !key || key === groupKey || !keys.includes(key)) return null;
    const bounds = header.getBoundingClientRect();
    return { key, position: event.clientY < bounds.top + bounds.height / 2 ? "before" : "after" };
  };
  const moveBy = (offset: number) => {
    const target = keys[index + offset];
    if (disabled || index < 0 || !target) return;
    setOpen(false);
    handle.current?.focus();
    onMove(groupKey, { key: target, position: offset < 0 ? "before" : "after" });
  };
  return <Popover open={open} onOpenChange={next => { if (!next || !disabled) setOpen(next); }}>
    <PopoverTrigger asChild>
      <Button ref={handle} type="button" size="icon" variant="ghost" disabled={keys.length < 2} aria-disabled={disabled}
        aria-label={`Reorder group ${label}`} aria-haspopup="dialog" aria-expanded={open}
        title="Drag to reorder, or open Move up/down. Keyboard: Alt + Arrow Up/Down."
        className={`h-6 w-6 shrink-0 touch-none cursor-grab opacity-0 group-hover:opacity-100 focus:opacity-100 ${dragging ? "opacity-100 cursor-grabbing" : ""}`}
        onPointerDown={event => {
          suppressClick.current = false;
          if (event.button !== 0 || disabled || keys.length < 2) return;
          drag.current = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, scope, moved: false };
          event.currentTarget.setPointerCapture(event.pointerId);
        }}
        onPointerMove={event => {
          const source = drag.current;
          if (!source || source.pointerId !== event.pointerId) return;
          if (disabled || source.scope !== scope) { clear(); return; }
          if (!source.moved && Math.hypot(event.clientX - source.x, event.clientY - source.y) < 6) return;
          source.moved = true; suppressClick.current = true; setDragging(true); setOpen(false); event.preventDefault();
          onTarget(targetAt(event));
          if (viewport) {
            const bounds = viewport.getBoundingClientRect();
            if (event.clientY < bounds.top + 24) viewport.scrollBy({ top: -12 });
            else if (event.clientY > bounds.bottom - 24) viewport.scrollBy({ top: 12 });
          }
        }}
        onPointerUp={event => {
          const source = drag.current;
          const target = targetAt(event);
          clear();
          if (source?.moved && source.pointerId === event.pointerId && source.scope === scope && !disabled && target) onMove(groupKey, target);
        }}
        onPointerCancel={clear} onLostPointerCapture={clear}
        onClickCapture={event => {
          if (suppressClick.current) { suppressClick.current = false; event.preventDefault(); event.stopPropagation(); }
        }}
        onKeyDown={event => {
          if (event.key === "Escape") { suppressClick.current = !!drag.current?.moved; clear(); }
          if (event.altKey && (event.key === "ArrowUp" || event.key === "ArrowDown")) {
            event.preventDefault(); moveBy(event.key === "ArrowUp" ? -1 : 1);
          }
        }}>
        <GripVertical className="h-3.5 w-3.5" />
      </Button>
    </PopoverTrigger>
    <PopoverContent align="start" className="w-44 p-1">
      <div role="dialog" aria-label={`Reorder ${label}`}>
        <Button variant="ghost" className="h-8 w-full justify-start gap-2 text-xs" autoFocus={index > 0} disabled={disabled || index <= 0} onClick={() => moveBy(-1)}>
          <ArrowUp className="h-3.5 w-3.5" />Move up
        </Button>
        <Button variant="ghost" className="h-8 w-full justify-start gap-2 text-xs" autoFocus={index === 0} disabled={disabled || index < 0 || index === keys.length - 1} onClick={() => moveBy(1)}>
          <ArrowDown className="h-3.5 w-3.5" />Move down
        </Button>
      </div>
    </PopoverContent>
  </Popover>;
}
