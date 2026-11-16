"use client";

import { Users } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { useConversationPresence } from "@/hooks/use-conversation-presence";
import { getStorageMode } from "@/lib/storage-config";

export function ConversationViewers({ conversationId, className }: { conversationId?: string; className?: string }) {
  const presence = useConversationPresence(getStorageMode() === "mongodb" ? conversationId : undefined);
  if (!presence?.viewers.length) return null;
  const label = `${presence.viewers.length} ${presence.viewers.length === 1 ? "viewer" : "viewers"} · ${presence.sessionCount} ${presence.sessionCount === 1 ? "session" : "sessions"}`;
  return (
    <Popover className={className}>
      <PopoverTrigger asChild>
        <Button variant="ghost" size="sm" className="h-8 gap-2 text-xs text-muted-foreground" aria-label={`Viewing this chat: ${label}`}>
          <Users className="h-4 w-4" aria-hidden="true" />
          {label}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-72 p-3">
        <p className="text-sm font-medium">Viewing this chat</p>
        <p className="mt-1 text-xs text-muted-foreground">Each open browser tab or window counts as a session.</p>
        <ul className="mt-3 max-h-60 space-y-2 overflow-y-auto text-sm">
          {presence.viewers.map(viewer => <li key={viewer.id} className="flex items-center justify-between gap-3">
            <span className="truncate" title={viewer.name}>{viewer.name}</span>
            <span className="shrink-0 text-xs text-muted-foreground">{viewer.sessions} {viewer.sessions === 1 ? "session" : "sessions"}</span>
          </li>)}
        </ul>
      </PopoverContent>
    </Popover>
  );
}
