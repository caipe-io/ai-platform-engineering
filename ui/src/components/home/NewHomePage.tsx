"use client";

import { HomeWidgetFrame } from "@/components/home/HomeWidgetFrame";
import { FavoriteAppsWidget, useHomeFavoriteApps } from "@/components/home/FavoriteAppsWidget";
import { HOME_WIDGET_COMPONENTS } from "@/components/home/widget-registry";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { getHomeWidgetDefinition, useHomeWidgetsStore } from "@/store/home-widgets-store";
import { getStorageMode } from "@/lib/storage-config";
import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  rectSortingStrategy,
  sortableKeyboardCoordinates,
} from "@dnd-kit/sortable";
import { computeReorder } from "@/lib/reorder";
import { SlidersHorizontal } from "lucide-react";

export function NewHomePage() {
  const widgets = useHomeWidgetsStore((s) => s.widgets);
  const addWidget = useHomeWidgetsStore((s) => s.addWidget);
  const reorderWidgets = useHomeWidgetsStore((s) => s.reorderWidgets);
  const favoriteApps = useHomeFavoriteApps(getStorageMode() === "mongodb");
  const visibleWidgets = widgets.filter((id) => id !== "favoriteApps" || favoriteApps.length > 0);
  const sensors = useSensors(
    useSensor(PointerSensor),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const handleDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;
    if (!over) return;
    const next = computeReorder(widgets, String(active.id), String(over.id));
    if (next) reorderWidgets(next);
  };
  const availableToAdd = useHomeWidgetsStore.getState().availableToAdd()
    .filter((widget) => widget.id !== "favoriteApps" || favoriteApps.length > 0);

  return (
    <div className="space-y-3 [@media(max-height:800px)]:space-y-2">
      <div
        className="flex min-h-7 items-center justify-end gap-1 [@media(max-height:800px)]:min-h-6"
        data-testid="home-toolbar"
      >
        {availableToAdd.length > 0 && (
          <Popover>
            <PopoverTrigger asChild>
              <Button
                variant="ghost"
                size="sm"
                className="h-7 gap-1 px-2 text-[11px] font-medium tracking-tight text-muted-foreground/70 hover:text-muted-foreground"
                data-testid="add-widget-trigger"
              >
                <SlidersHorizontal className="h-3 w-3" />
                Customize
              </Button>
            </PopoverTrigger>
            <PopoverContent side="bottom" align="end" className="w-56 p-1">
              {availableToAdd.map((widget) => (
                <button
                  key={widget.id}
                  type="button"
                  onClick={() => addWidget(widget.id)}
                  data-testid={`add-widget-${widget.id}`}
                  className="flex w-full items-center rounded-md px-2 py-1.5 text-left text-sm hover:bg-muted"
                >
                  {widget.label}
                </button>
              ))}
            </PopoverContent>
          </Popover>
        )}
      </div>

      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
        <SortableContext items={visibleWidgets} strategy={rectSortingStrategy}>
          <div
            className="grid grid-cols-1 gap-4 lg:grid-cols-2 [@media(max-height:800px)]:gap-3"
            data-testid="home-widget-grid"
          >
            {visibleWidgets.map((widgetId) => {
              if (widgetId === "favoriteApps") {
                return (
                  <HomeWidgetFrame key={widgetId} widgetId={widgetId} fullWidth>
                    <FavoriteAppsWidget apps={favoriteApps} />
                  </HomeWidgetFrame>
                );
              }
              const Widget = HOME_WIDGET_COMPONENTS[widgetId];
              if (!Widget) return null;
              const definition = getHomeWidgetDefinition(widgetId);
              return (
                <HomeWidgetFrame
                  key={widgetId}
                  widgetId={widgetId}
                  fullWidth={definition?.width !== "half"}
                >
                  <Widget />
                </HomeWidgetFrame>
              );
            })}
          </div>
        </SortableContext>
      </DndContext>

      <p className="pb-2 pt-4 text-center text-xs text-muted-foreground/50 [@media(max-height:800px)]:pt-2">
        ⚡ Powered by{" "}
        <a
          href="https://caipe.io"
          target="_blank"
          rel="noopener noreferrer"
          className="hover:text-muted-foreground/70 transition-colors"
        >
          caipe.io
        </a>
      </p>
    </div>
  );
}
