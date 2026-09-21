"use client";

import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { useHomeWidgetsStore } from "@/store/home-widgets-store";
import { cn } from "@/lib/utils";
import { GripVertical, X } from "lucide-react";
import type { ReactNode } from "react";

interface HomeWidgetFrameProps {
  widgetId: string;
  fullWidth?: boolean;
  children: ReactNode;
}

/** Wraps a Home page content widget with shared reorder and remove controls. */
export function HomeWidgetFrame({ widgetId, fullWidth = false, children }: HomeWidgetFrameProps) {
  const removeWidget = useHomeWidgetsStore((s) => s.removeWidget);
  const { attributes,listeners,setNodeRef,setActivatorNodeRef,transform,transition,isDragging } =
    useSortable({ id: widgetId });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
  };

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={cn(
        "group/widget relative min-w-0",
        fullWidth && "lg:col-span-2",
        isDragging && "z-10 opacity-70",
      )}
      data-testid={`home-widget-${widgetId}`}
    >
      <div className="pointer-events-none absolute right-1 top-1 z-20 flex items-center gap-1 opacity-0 transition-opacity group-focus-within/widget:opacity-100 group-hover/widget:opacity-100">
        <button
          ref={setActivatorNodeRef}
          type="button"
          {...attributes}
          {...listeners}
          aria-label="Drag to reorder widget"
          title="Drag to reorder"
          data-testid={`home-widget-drag-${widgetId}`}
          className="pointer-events-auto flex h-6 w-6 cursor-grab items-center justify-center rounded-full border border-border/60 bg-background/90 text-muted-foreground shadow-sm backdrop-blur-sm hover:text-foreground active:cursor-grabbing"
        >
          <GripVertical className="h-3.5 w-3.5" />
        </button>
        <button
          type="button"
          onClick={() => removeWidget(widgetId)}
          aria-label="Remove widget"
          title="Remove widget"
          data-testid={`home-widget-remove-${widgetId}`}
          className="pointer-events-auto flex h-6 w-6 items-center justify-center rounded-full border border-border/60 bg-background/90 text-muted-foreground shadow-sm backdrop-blur-sm hover:text-foreground"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
      {children}
    </div>
  );
}
