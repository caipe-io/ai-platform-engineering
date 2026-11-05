"use client";

import { useId, useState } from "react";
import { usePathname, useRouter } from "next/navigation";

import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { useChatSessionRecovery } from "@/lib/agentic-apps/use-chat-session-recovery";
import { pushWithNavigationProgress } from "@/lib/navigation-progress";
import { useChatStore } from "@/store/chat-store";
import { useUnsavedChangesStore } from "@/store/unsaved-changes-store";

/** Background chat navigation; the visible chat already shows its own progress. */
export function RunningChats() {
  useChatSessionRecovery();
  const pathname = usePathname();
  const router = useRouter();
  const panelId = useId();
  const [open, setOpen] = useState(false);
  const streams = useChatStore(state => state.streamingConversations);
  const external = useChatStore(state => state.externalActivity);
  const conversations = useChatStore(state => state.conversations);
  const { hasUnsavedChanges, requestNavigation } = useUnsavedChangesStore();
  const ids = [...new Set([...streams.keys(), ...Object.entries(external)
    .filter(([, value]) => value.state !== "checking").map(([id]) => id)])]
    .filter(id => pathname !== `/chat/${encodeURIComponent(id)}`);

  if (!ids.length) return null;
  const label = `${ids.length} background chat${ids.length === 1 ? "" : "s"}`;

  const openChat = (id: string) => {
    const href = `/chat/${encodeURIComponent(id)}`;
    if (hasUnsavedChanges) requestNavigation(href);
    else pushWithNavigationProgress(router, href);
    setOpen(false);
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          className="h-8 shrink-0 gap-1.5 px-2 text-xs text-muted-foreground"
          aria-label={`${label}. View running chats`}
          aria-expanded={open}
          aria-controls={panelId}
          title={label}
        >
          <span aria-hidden="true" className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
          <span>{ids.length} running</span>
        </Button>
      </PopoverTrigger>
      <PopoverContent side="bottom" align="end" className="w-80 max-w-[calc(100vw-1rem)] p-2">
        <section id={panelId} aria-label="Background chats">
          <div className="border-b px-2 py-1.5">
            <h2 className="text-sm font-medium">Background chats</h2>
            <p className="text-xs text-muted-foreground">Open a chat to follow its progress.</p>
          </div>
          <ul className="mt-1 max-h-72 overflow-y-auto">
            {ids.map(id => {
              const title = conversations.find(conversation => conversation.id === id)?.title || "Running chat";
              const saving = !streams.has(id) && external[id]?.state === "saving";
              return (
                <li key={id}>
                  <button
                    type="button"
                    aria-label={`Open ${title}`}
                    title={title}
                    onClick={() => openChat(id)}
                    className="block w-full min-w-0 rounded-md px-2 py-2 text-left hover:bg-muted focus-visible:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    <span className="block truncate text-sm font-medium">{title}</span>
                    <span className="block text-xs text-muted-foreground">{saving ? "Saving response…" : "Running"}</span>
                  </button>
                </li>
              );
            })}
          </ul>
        </section>
      </PopoverContent>
    </Popover>
  );
}
