/** Stable within a chat: saved membership order never depends on the selected agent. */
const MENTION_COLORS = [
  "text-pink-700 dark:text-pink-300",
  "text-violet-700 dark:text-violet-300",
  "text-cyan-700 dark:text-cyan-300",
  "text-amber-800 dark:text-amber-300",
  "text-fuchsia-700 dark:text-fuchsia-300",
  "text-lime-800 dark:text-lime-300",
  "text-orange-800 dark:text-orange-300",
  "text-indigo-700 dark:text-indigo-300",
] as const;

export function agentMentionColor(handle: string, handles: readonly string[]): string {
  const index = handles.indexOf(handle);
  return handle === "primary" || index < 0
    ? "text-blue-700 dark:text-blue-300"
    : MENTION_COLORS[index % MENTION_COLORS.length];
}
