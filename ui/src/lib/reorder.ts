/**
 * Pure reorder computation for a dnd-kit `onDragEnd` handler — kept separate
 * from the component so it's testable without dnd-kit's DndContext/pointer
 * internals, which don't run meaningfully under jsdom.
 */
export function computeReorder(
  ids: string[],
  activeId: string,
  overId: string,
): string[] | null {
  if (activeId === overId) return null;
  const oldIndex = ids.indexOf(activeId);
  const newIndex = ids.indexOf(overId);
  if (oldIndex === -1 || newIndex === -1) return null;

  const next = [...ids];
  next.splice(oldIndex, 1);
  next.splice(newIndex, 0, activeId);
  return next;
}
