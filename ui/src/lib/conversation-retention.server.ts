import { PHASE_PRODUCTION_BUILD } from "next/constants";

import { purgeExpiredConversations } from "@/app/api/chat/conversations/delete-permanently";
import { isMongoDBConfigured } from "@/lib/mongodb";

const TICK_INTERVAL_MS = 60_000;
const BATCH_SIZE = 100;

let timer: ReturnType<typeof setInterval> | null = null;
let running = false;

function canRun(): boolean {
  return isMongoDBConfigured && process.env.NEXT_PHASE !== PHASE_PRODUCTION_BUILD;
}

/** Retention is platform maintenance, independent of which owners visit Trash. */
export async function tickConversationRetention(now = new Date()): Promise<void> {
  if (!canRun() || running) return;
  running = true;
  try {
    const result = await purgeExpiredConversations(now, BATCH_SIZE);
    if (result.examined > 0) {
      console.log(`[ConversationRetention] Examined ${result.examined}, deleted ${result.deleted}, retryable failures ${result.failed}`);
    }
  } catch (error) {
    console.error("[ConversationRetention] Cleanup pass failed; will retry on the next tick", error instanceof Error ? error.message : "Unknown error");
  } finally {
    running = false;
  }
}

/** Per-conversation MongoDB claims coordinate cleanup across server replicas. */
export function startConversationRetention(): void {
  if (timer || !canRun()) return;
  timer = setInterval(() => void tickConversationRetention(), TICK_INTERVAL_MS);
  timer.unref?.();
  void tickConversationRetention();
}

/** Stop scheduling new passes; an already claimed cleanup may finish safely. */
export function stopConversationRetention(): void {
  if (!timer) return;
  clearInterval(timer);
  timer = null;
}
