"use client";

import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { useChatStore } from "@/store/chat-store";
import { useChatSessionRecovery } from "@/lib/agentic-apps/use-chat-session-recovery";
import { ChevronRight, MessageSquare, Radio } from "lucide-react";
import Link from "next/link";
import { useId, useState, type ReactNode } from "react";
import { useShallow } from "zustand/react/shallow";

interface LiveResponseDestination {
  id: string;
  href: string;
  label: string;
}

const TRIGGER_CLASS_NAME = "flex w-full items-center justify-center gap-2 px-3 py-1.5 transition-colors hover:bg-emerald-500/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-emerald-500";

/**
 * Host streams and authorized app turns remain visible across views.
 * Navigation opens the existing conversation without restarting or canceling a run.
 */
export function LiveStreamBanner() {
  useChatSessionRecovery();
  const external = useChatStore(s => s.externalActivity);
  const streamingConversations = useChatStore(
    (s) => s.streamingConversations
  );
  // Stream tokens update conversation objects, but only titles affect this UI.
  const conversationTitles = useChatStore(useShallow((state) =>
    new Map<string, string>(state.conversations.map(({ id, title }) => [id, title])),
  ));

  const ids = [...new Set([...streamingConversations.keys(), ...Object.entries(external)
    .filter(([, value]) => value.state !== "checking").map(([id]) => id)])];
  if (!ids.length) return null;
  const count = ids.length;
  const label =
    count === 1
      ? "1 live response in progress"
      : `${count} live responses in progress`;
  const destinations = ids.map((id) => ({
    id,
    href: `/chat/${encodeURIComponent(id)}`,
    label: conversationTitles.get(id)?.trim() || "Conversation",
  }));
  const bannerContent = (
    <>
      <Radio className="h-3.5 w-3.5 animate-pulse" aria-hidden />
      <span>{label}</span>
      <ChevronRight className="h-3.5 w-3.5" aria-hidden />
    </>
  );

  return (
    <div
      role="status"
      aria-live="polite"
      className="shrink-0 border-b border-emerald-500/25 bg-emerald-500/10 text-xs font-medium text-emerald-700 dark:text-emerald-300"
    >
      {count === 1 ? (
        <Link href={destinations[0].href} className={TRIGGER_CLASS_NAME} aria-label={`${label}. Go to ${destinations[0].label}`}>
          {bannerContent}
        </Link>
      ) : (
        <LiveResponseChooser destinations={destinations} label={label}>{bannerContent}</LiveResponseChooser>
      )}
    </div>
  );
}

/** Unmounting the multi-response chooser clears its transient open state. */
function LiveResponseChooser({ destinations, label, children }: {
  destinations: LiveResponseDestination[];
  label: string;
  children: ReactNode;
}): React.ReactElement {
  const [open, setOpen] = useState(false);
  const chooserId = useId();
  return (
    <Popover open={open} onOpenChange={setOpen} className="w-full">
      <PopoverTrigger asChild>
        <button type="button" className={TRIGGER_CLASS_NAME} aria-label={`${label}. Choose a response`} aria-expanded={open} aria-controls={open ? chooserId : undefined}>
          {children}
        </button>
      </PopoverTrigger>
      <PopoverContent side="bottom" align="center" className="w-80 max-w-[calc(100vw-1rem)] p-2">
        <p className="px-2 pb-1.5 text-xs font-medium text-muted-foreground">Live responses</p>
        <nav id={chooserId} aria-label="Live responses" className="max-h-64 space-y-1 overflow-y-auto">
          {destinations.map((destination) => (
            <Link
              key={destination.id}
              href={destination.href}
              onClick={() => setOpen(false)}
              className="flex items-center gap-2 rounded-md px-2 py-2 hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <MessageSquare className="h-4 w-4 shrink-0 text-emerald-500" aria-hidden />
              <span className="min-w-0 flex-1 truncate text-sm text-foreground">{destination.label}</span>
              <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
            </Link>
          ))}
        </nav>
      </PopoverContent>
    </Popover>
  );
}
