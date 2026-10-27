"use client";

import { useChatStore } from "@/store/chat-store";
import Link from "next/link";
import { useChatSessionRecovery } from "@/lib/agentic-apps/use-chat-session-recovery";
import { Radio } from "lucide-react";

/** Live host streams and authorized app turns remain visible across views. */
export function LiveStreamBanner() {
  useChatSessionRecovery();
  const external = useChatStore(s => s.externalActivity);
  const streamingConversations = useChatStore(
    (s) => s.streamingConversations
  );

  const ids = [...new Set([...streamingConversations.keys(), ...Object.entries(external)
    .filter(([, value]) => value.state !== "checking").map(([id]) => id)])];
  if (!ids.length) return null;
  const count = ids.length;
  const label =
    count === 1
      ? "1 live response in progress"
      : `${count} live responses in progress`;

  return (
    <div
      role="status"
      aria-live="polite"
      className="flex items-center justify-center gap-2 px-3 py-1.5 text-xs font-medium bg-emerald-500/10 border-b border-emerald-500/25 text-emerald-700 dark:text-emerald-300 select-none shrink-0"
    >
      <Radio className="h-3.5 w-3.5 animate-pulse" />
      <Link href={`/chat/${ids[0]}`} className="hover:underline">{label}</Link>
    </div>
  );
}
