export type ChatHistoryOrganizationScope = "chats" | "autonomous" | "scheduled";
export interface RunHistoryGrouping {
  view: "ungrouped" | "agents";
  collapsed: string[];
  groupOrder?: string[];
}

/** Personal presentation preferences; never confer access to a conversation. */
export interface ChatHistoryOrganization {
  view: "ungrouped" | "agents" | "folders";
  folders: Array<{ id: string; name: string }>;
  assignments: Record<string, string>;
  collapsed: string[];
  groupOrder?: string[];
  runViews?: Partial<Record<"autonomous" | "scheduled", RunHistoryGrouping>>;
}
export const EMPTY_CHAT_ORGANIZATION: ChatHistoryOrganization = {
  view: "ungrouped", folders: [], assignments: {}, collapsed: [],
};

export function parseChatHistoryOrganization(input: unknown): ChatHistoryOrganization {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Invalid chat organization");
  const v = input as ChatHistoryOrganization;
  if (!["ungrouped", "agents", "folders"].includes(v.view) || !Array.isArray(v.folders) || v.folders.length > 100 ||
      !Array.isArray(v.collapsed) || v.collapsed.length > 1000 || !v.assignments ||
      typeof v.assignments !== "object" || Array.isArray(v.assignments) || Object.keys(v.assignments).length > 10000) {
    throw new Error("Chat organization exceeds supported limits");
  }
  const ids = new Set<string>();
  const names = new Set<string>();
  const folders = v.folders.map(f => {
    if (!f || typeof f.id !== "string" || !/^[a-zA-Z0-9_-]{1,128}$/.test(f.id) || ids.has(f.id) ||
        typeof f.name !== "string" || !f.name.trim() || f.name.trim().length > 80 || names.has(f.name.trim().toLowerCase())) {
      throw new Error("Use unique folder names of 1–80 characters");
    }
    ids.add(f.id); names.add(f.name.trim().toLowerCase());
    return { id: f.id, name: f.name.trim() };
  });
  const assignments = Object.fromEntries(Object.entries(v.assignments).map(([id, folder]) => {
    if (!/^[a-zA-Z0-9_-]{1,200}$/.test(id) || ["__proto__", "constructor", "prototype"].includes(id) || !ids.has(folder)) {
      throw new Error("Invalid chat folder assignment");
    }
    return [id, folder];
  }));
  if (v.collapsed.some(k => typeof k !== "string" || !/^[a-zA-Z0-9:_-]{1,240}$/.test(k))) throw new Error("Invalid collapsed group");
  if (v.groupOrder !== undefined && (!Array.isArray(v.groupOrder) || v.groupOrder.length > 1100 ||
      v.groupOrder.some(key => typeof key !== "string" || !/^(agent|folder):[a-zA-Z0-9:_-]{1,230}$/.test(key)) ||
      new Set(v.groupOrder).size !== v.groupOrder.length)) throw new Error("Invalid chat group order");
  let runViews: ChatHistoryOrganization["runViews"];
  if (v.runViews !== undefined) {
    if (!v.runViews || typeof v.runViews !== "object" || Array.isArray(v.runViews) ||
        Object.keys(v.runViews).some(key => !["autonomous", "scheduled"].includes(key))) throw new Error("Invalid run history preferences");
    runViews = {};
    for (const scope of ["autonomous", "scheduled"] as const) {
      const run = v.runViews[scope];
      if (run === undefined) continue;
      if (!run || !["ungrouped", "agents"].includes(run.view) || !Array.isArray(run.collapsed) || run.collapsed.length > 1000 ||
          run.collapsed.some(key => typeof key !== "string" || !/^agent:[a-zA-Z0-9:_-]{1,230}$/.test(key)) ||
          (run.groupOrder !== undefined && (!Array.isArray(run.groupOrder) || run.groupOrder.length > 1000 ||
            run.groupOrder.some(key => typeof key !== "string" || !/^agent:[a-zA-Z0-9:_-]{1,230}$/.test(key)) ||
            new Set(run.groupOrder).size !== run.groupOrder.length))) throw new Error("Invalid run history grouping");
      runViews[scope] = { view: run.view, collapsed: [...new Set(run.collapsed)],
        ...(run.groupOrder !== undefined ? { groupOrder: [...run.groupOrder] } : {}) };
    }
  }
  return { view: v.view, folders, assignments, collapsed: [...new Set(v.collapsed)],
    ...(v.groupOrder !== undefined ? { groupOrder: [...v.groupOrder] } : {}),
    ...(runViews !== undefined ? { runViews } : {}) };

}

/** Reorder visible groups without discarding positions for other filters or grouping views. */
export function reorderChatHistoryGroups(saved: readonly string[], visible: readonly string[], source: string,
  target: string, position: "before" | "after"): string[] {
  const order = [...new Set([...saved, ...visible])];
  if (source === target || !visible.includes(source) || !visible.includes(target)) return order;
  const visibleSet = new Set(visible);
  const moved = order.filter(key => visibleSet.has(key) && key !== source);
  const destination = moved.indexOf(target) + (position === "after" ? 1 : 0);
  moved.splice(destination, 0, source);
  let index = 0;
  return order.map(key => visibleSet.has(key) ? moved[index++] : key);
}

/** Run views never inherit personal folders or the chat grouping selection. */
export function chatHistoryOrganizationForScope(value: ChatHistoryOrganization, scope: ChatHistoryOrganizationScope): ChatHistoryOrganization {
  if (scope === "chats") return value;
  const run = value.runViews?.[scope];
  return { ...value, view: run?.view ?? "ungrouped", folders: [], assignments: {},
    collapsed: run?.collapsed ?? [], groupOrder: run?.groupOrder ?? [] };
}

/** Merge the selected presentation scope while retaining every other saved scope. */
export function mergeChatHistoryOrganizationScope(value: ChatHistoryOrganization, scope: ChatHistoryOrganizationScope,
  next: ChatHistoryOrganization): ChatHistoryOrganization {
  if (scope === "chats") return parseChatHistoryOrganization(next);
  if (next.view === "folders") throw new Error("Folders are not available for run history");
  return parseChatHistoryOrganization({ ...value, runViews: { ...value.runViews,
    [scope]: { view: next.view, collapsed: next.collapsed, groupOrder: next.groupOrder ?? [] } } });
}
