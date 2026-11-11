"use client";

import { Code2 } from "lucide-react";
import { useId, useState } from "react";

import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";

export function ApiConversationIndicator({ readOnly }: { readOnly: boolean }) {
  const [open, setOpen] = useState(false);
  const detailsId = useId();
  return (
    <Popover open={open} onOpenChange={setOpen} className="shrink-0">
      <PopoverTrigger asChild>
        <Button type="button" variant="ghost" size="sm" className="h-8 gap-1.5 px-2 text-xs text-muted-foreground"
          aria-label="API-connected chat" aria-expanded={open} aria-controls={detailsId} title="API-connected chat">
          <Code2 className="h-3.5 w-3.5" aria-hidden="true" />
          <span>API</span>
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-72 max-w-[calc(100vw-1rem)] p-4">
        <div id={detailsId} className="space-y-2">
          <p className="text-sm font-medium">API-connected chat</p>
          <p className="text-xs text-muted-foreground">Messages and responses are shared with the connected API client.</p>
          {!readOnly && <p className="text-xs text-muted-foreground">Send from one client at a time to keep the conversation in order.</p>}
        </div>
      </PopoverContent>
    </Popover>
  );
}
