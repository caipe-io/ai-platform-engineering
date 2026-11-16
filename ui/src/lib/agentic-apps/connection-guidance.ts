export interface AssistantConnectionGuide {
  id: string;
  enabled: boolean;
  label: string;
  logo?: "webex";
  title: string;
  markdown: string;
  action_label: string;
  action_url: string;
}

export function safeConnectionAction(value: string): boolean {
  if (!value || /[\x00-\x20\x7f\\]/.test(value)) return false;
  if (value.startsWith("/") && !value.startsWith("//")) return true;
  try { const url = new URL(value); return url.protocol === "https:" && !url.username && !url.password; }
  catch { return false; }
}

export function validateConnectionGuidance(value: unknown): AssistantConnectionGuide[] {
  if (!Array.isArray(value) || value.length > 5) throw new Error("Configure at most five connection guides.");
  const ids = new Set<string>();
  return value.map((raw: unknown) => {
    if (!raw || typeof raw !== "object") throw new Error("Invalid connection guide.");
    const item = raw as Record<string, unknown>;
    if (item.logo !== undefined && item.logo !== "webex") throw new Error("Unsupported connection guide logo.");
    const text = (key: string, max: number, trim = true) => {
      if (typeof item[key] !== "string" || (item[key] as string).length > max) throw new Error(`Invalid guide ${key}.`);
      return trim ? (item[key] as string).trim() : item[key] as string;
    };
    const guide = { id: text("id", 64), enabled: item.enabled === true, label: text("label", 60), ...(item.logo === "webex" ? { logo: "webex" as const } : {}), title: text("title", 120), markdown: text("markdown", 8192, false), action_label: text("action_label", 60), action_url: text("action_url", 2048) };
    if (!/^[a-z0-9-]+$/.test(guide.id) || ids.has(guide.id) || typeof item.enabled !== "boolean") throw new Error("Guide IDs must be unique and use lowercase letters, digits, or hyphens.");
    ids.add(guide.id);
    if (guide.enabled && (!guide.label || !guide.title || !guide.markdown.trim())) throw new Error("Enabled guides need a label, title, and instructions.");
    if (guide.action_url && (!guide.action_label || !safeConnectionAction(guide.action_url))) throw new Error("Set an action label and a safe HTTPS or local URL.");
    return guide;
  });
}
