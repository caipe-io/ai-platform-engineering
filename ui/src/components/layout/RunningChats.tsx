"use client";

import { useId, useState, type ReactNode } from "react";
import { usePathname } from "next/navigation";

import { GuardedNavigationLink } from "@/components/layout/GuardedNavigationLink";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { useChatSessionRecovery } from "@/lib/agentic-apps/use-chat-session-recovery";
import { useChatStore } from "@/store/chat-store";

const controlClass = "h-8 shrink-0 gap-2 rounded-full border border-emerald-500/25 bg-emerald-500/10 px-2.5 text-xs text-emerald-700 hover:bg-emerald-500/15 hover:text-emerald-800 dark:text-emerald-300 dark:hover:text-emerald-200";

interface LiveChatDestination {
  id: string;
  href: string;
  title: string;
  saving: boolean;
}

/** Global live-chat navigation, including the chat currently being viewed. */
export function RunningChats() {
  useChatSessionRecovery();
  const pathname = usePathname();
  const streams = useChatStore(state => state.streamingConversations);
  const external = useChatStore(state => state.externalActivity);
  const conversations = useChatStore(state => state.conversations);
  const ids = [...new Set([...streams.keys(), ...Object.entries(external)
    .filter(([, value]) => value.state !== "checking").map(([id]) => id)])];

  if (!ids.length) return null;
  const label = `Live Agent Chat (${ids.length})`;
  const destinations = ids.map(id => ({
    id,
    href: `/chat/${encodeURIComponent(id)}`,
    title: conversations.find(conversation => conversation.id === id)?.title || "Untitled chat",
    saving: !streams.has(id) && external[id]?.state === "saving",
  }));
  const indicator = (
    <>
      <span aria-hidden="true" className="h-2 w-2 shrink-0 rounded-full bg-emerald-500 motion-safe:animate-pulse" />
      <span>{label}</span>
    </>
  );

  return <LiveChatsMenu destinations={destinations} pathname={pathname} label={label} indicator={indicator} />;
}

// Mount menu state only while there are live chats, so a completed run cannot
// leave a stale open menu when a later run starts.
function LiveChatsMenu({ destinations, pathname, label, indicator }: {
  destinations: LiveChatDestination[];
  pathname: string;
  label: string;
  indicator: ReactNode;
}) {
  const panelId = useId();
  const [open, setOpen] = useState(false);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          className={controlClass}
          aria-label={`${label}. Choose a chat`}
          aria-expanded={open}
          aria-controls={panelId}
          title={label}
        >
          {indicator}
        </Button>
      </PopoverTrigger>
      <PopoverContent
        side="bottom"
        align="end"
        className="w-80 max-w-[calc(100vw-1rem)] p-2"
        onOpenAutoFocus={content => content.querySelector<HTMLAnchorElement>("a[href]")?.focus({ preventScroll: true })}
      >
        <section id={panelId} aria-label="Live Agent Chat">
          <div className="border-b px-2 py-1.5">
            <h2 className="text-sm font-medium">Live Agent Chat</h2>
            <p className="text-xs text-muted-foreground">Open a chat to follow its progress.</p>
          </div>
          <ul className="mt-1 max-h-72 overflow-y-auto">
            {destinations.map(({ id, href, title, saving }) => (
                <li key={id}>
                  <GuardedNavigationLink
                    href={href}
                    aria-label={`Open ${title}`}
                    aria-current={pathname === href ? "page" : undefined}
                    title={title}
                    onClick={() => setOpen(false)}
                    className="block w-full min-w-0 rounded-md px-2 py-2 text-left hover:bg-muted focus-visible:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    <span className="block whitespace-normal break-words text-sm font-medium">{title}</span>
                    <span className="block text-xs text-muted-foreground">
                      {saving ? "Saving response…" : "Streaming"}{pathname === href ? " · Current chat" : ""}
                    </span>
                  </GuardedNavigationLink>
                </li>
            ))}
          </ul>
        </section>
      </PopoverContent>
    </Popover>
  );
}
