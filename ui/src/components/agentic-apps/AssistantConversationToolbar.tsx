"use client";

import { ExternalLink, Maximize2, MoreVertical, Plus, RotateCcw, Trash2, X } from "lucide-react";
import type { ReactNode } from "react";

import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

interface Props {
  viewTabs: ReactNode;
  menuOpen: boolean;
  onMenuOpenChange: (open: boolean) => void;
  expanded: boolean;
  pending: boolean;
  canClear: boolean;
  canStart: boolean;
  onExpand: () => void;
  onNewChat: () => void;
  onResetSize: () => void;
  onClear: () => void;
  chatHref?: string;
  onMinimize: () => void;
  context?: ReactNode;
}

/** The same conversation commands and presentation for every hosted app. */
export function AssistantConversationToolbar(props: Props) {
  function run(action: () => void) {
    props.onMenuOpenChange(false);
    action();
  }
  return <div className="flex shrink-0 items-center gap-1">
    {props.viewTabs}
    <Popover open={props.menuOpen} onOpenChange={props.onMenuOpenChange}>
      <PopoverTrigger asChild>
        <Button variant="ghost" size="icon" className="h-8 w-8" aria-label="Conversation actions" aria-expanded={props.menuOpen}>
          <MoreVertical className="h-5 w-5" aria-hidden />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="z-50 w-60 space-y-2 p-2">
        <div role="group" aria-label="Conversation actions" className="flex flex-col">
          <Button variant="ghost" className="justify-start gap-2" aria-label="Start new assistant chat" disabled={props.pending || !props.canStart} onClick={() => run(props.onNewChat)}><Plus className="h-4 w-4" aria-hidden />New chat</Button>
          <Button variant="ghost" className="justify-start gap-2" aria-label="Expand assistant" disabled={props.expanded} onClick={() => run(props.onExpand)}><Maximize2 className="h-4 w-4" aria-hidden />Expand chat</Button>
          <Button variant="ghost" className="justify-start gap-2" aria-label="Reset assistant size" onClick={() => run(props.onResetSize)}><RotateCcw className="h-4 w-4" aria-hidden />Reset size</Button>
          <Button variant="ghost" className="justify-start gap-2 text-destructive hover:text-destructive" aria-label="Clear assistant chat" disabled={props.pending || !props.canClear} onClick={() => run(props.onClear)}><Trash2 className="h-4 w-4" aria-hidden />Clear chat</Button>
        </div>
        {props.context}
      </PopoverContent>
    </Popover>
    <Tooltip><TooltipTrigger asChild>
      {props.chatHref ? <Button asChild variant="ghost" size="icon" className="h-8 w-8">
        <a href={props.chatHref} target="_blank" rel="noopener noreferrer" aria-label="Open in chat (new tab)"><ExternalLink className="h-5 w-5" aria-hidden /></a>
      </Button> : <Button variant="ghost" size="icon" className="h-8 w-8" aria-label="Open in chat (new tab)" disabled><ExternalLink className="h-5 w-5" aria-hidden /></Button>}
    </TooltipTrigger><TooltipContent>Open in chat (new tab)</TooltipContent></Tooltip>
    <Tooltip><TooltipTrigger asChild>
      <Button variant="ghost" size="icon" className="h-8 w-8" aria-label="Minimize chat" onClick={props.onMinimize}><X className="h-5 w-5" aria-hidden /></Button>
    </TooltipTrigger><TooltipContent>Minimize chat</TooltipContent></Tooltip>
  </div>;
}
