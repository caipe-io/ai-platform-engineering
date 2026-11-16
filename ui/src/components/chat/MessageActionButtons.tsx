"use client";

import { Bookmark, CheckCircle2, Clipboard, Flag, Loader2, Send, Star, type LucideIcon } from "lucide-react";
import React, { useRef, useState } from "react";

import type { MessageActionDeclaration } from "../../../app-sdk/assistant-options.mjs";
import { Button } from "@/components/ui/button";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/components/ui/toast";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { postAssistantAction } from "@/lib/api-client";

const ICONS: Record<MessageActionDeclaration["icon"], LucideIcon> = {
  flag: Flag, bookmark: Bookmark, check: CheckCircle2, star: Star, clipboard: Clipboard, send: Send,
};

interface MessageActionButtonsProps {
  /** Actions the app declared and enabled for this user. */
  actions: MessageActionDeclaration[];
  conversationId: string;
  agentId: string;
  messageId: string;
  /** The answer text, used to prefill a dialog field. */
  messageContent: string;
}

/** Declared actions render as plain text; the app never supplies markup or code. */
export function MessageActionButtons({ actions, conversationId, agentId, messageId, messageContent }: MessageActionButtonsProps) {
  return (
    <>
      {actions.map((action) => (
        <MessageActionButton
          key={action.id}
          action={action}
          conversationId={conversationId}
          agentId={agentId}
          messageId={messageId}
          messageContent={messageContent}
        />
      ))}
    </>
  );
}

function MessageActionButton({ action, conversationId, agentId, messageId, messageContent }:
  Omit<MessageActionButtonsProps, "actions"> & { action: MessageActionDeclaration }) {
  const { toast } = useToast();
  const [pending, setPending] = useState(false);
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const [error, setError] = useState("");
  // State updates are asynchronous; the ref stops a second click before the first renders.
  const inFlight = useRef(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const dialog = action.dialog;
  const Icon = ICONS[action.icon];
  const tooLong = Boolean(dialog && text.length > dialog.field.maxLength);
  const missing = Boolean(dialog && !dialog.field.optional && !text.trim());

  const run = async (value?: string) => {
    if (inFlight.current) return;
    inFlight.current = true;
    setPending(true);
    setError("");
    const result = await postAssistantAction({ conversationId, agentId, messageId, actionId: action.id, text: value });
    inFlight.current = false;
    setPending(false);
    if (result.ok) {
      setOpen(false);
      toast(result.message ?? `${action.label}: done`, "success");
    } else {
      const message = result.error ?? "The action could not be completed";
      if (dialog) setError(message);
      else toast(message, "error");
    }
  };

  const handleClick = () => {
    if (!dialog) { void run(); return; }
    setText(dialog.field.prefill === "message" ? messageContent : "");
    setError("");
    setOpen(true);
  };

  return (
    <>
      <TooltipProvider>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              ref={triggerRef}
              variant="ghost"
              size="icon"
              className="h-7 w-7 text-muted-foreground hover:text-foreground hover:bg-muted"
              onClick={handleClick}
              disabled={pending && !dialog}
              aria-label={action.label}
              aria-busy={pending}
              aria-haspopup={dialog ? "dialog" : undefined}
            >
              {pending && !dialog ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Icon className="h-3.5 w-3.5" />}
            </Button>
          </TooltipTrigger>
          <TooltipContent>{action.label}</TooltipContent>
        </Tooltip>
      </TooltipProvider>
      {dialog && (
        <Dialog open={open} onOpenChange={(next) => { if (!pending) setOpen(next); }}>
          {/* Some browsers do not focus a button on click, so return focus explicitly. */}
          <DialogContent onCloseAutoFocus={(event) => { event.preventDefault(); triggerRef.current?.focus(); }}>
            <form
              onSubmit={(event) => { event.preventDefault(); if (!tooLong && !missing) void run(text); }}
              className="space-y-4"
            >
              <DialogHeader>
                <DialogTitle>{dialog.title}</DialogTitle>
                {dialog.description && <DialogDescription>{dialog.description}</DialogDescription>}
              </DialogHeader>
              <div className="space-y-2">
                <Label htmlFor={`message-action-${action.id}-${messageId}`}>{dialog.field.label}</Label>
                <Textarea
                  id={`message-action-${action.id}-${messageId}`}
                  value={text}
                  onChange={(event) => setText(event.target.value)}
                  rows={8}
                  aria-invalid={tooLong || undefined}
                  aria-describedby={`message-action-${action.id}-${messageId}-status`}
                  disabled={pending}
                />
                <p
                  id={`message-action-${action.id}-${messageId}-status`}
                  role={tooLong || error ? "alert" : undefined}
                  className={tooLong || error ? "text-xs text-destructive" : "text-xs text-muted-foreground"}
                >
                  {tooLong
                    ? `Shorten the text to ${dialog.field.maxLength} characters or fewer (now ${text.length}).`
                    : error || `${text.length} / ${dialog.field.maxLength}`}
                </p>
              </div>
              <DialogFooter>
                <Button type="button" variant="ghost" onClick={() => setOpen(false)} disabled={pending}>Cancel</Button>
                <Button type="submit" disabled={pending || tooLong || missing}>
                  {pending && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}
                  {dialog.submitLabel}
                </Button>
              </DialogFooter>
            </form>
          </DialogContent>
        </Dialog>
      )}
    </>
  );
}
