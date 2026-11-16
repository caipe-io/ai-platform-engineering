"use client";

import { useEffect, useRef, type Dispatch, type RefObject, type SetStateAction } from "react";
import { parseAssistantDraft, type AssistantDraft } from "@/lib/agentic-apps/assistant-draft";

/** Applies a user-requested draft once after the composer is ready; never sends. */
export function useComposerDraft({ draft, enabled, setInput, inputRef, onAttachment, onApplied }: {
  draft?: AssistantDraft | null;
  enabled: boolean;
  setInput: Dispatch<SetStateAction<string>>;
  inputRef: RefObject<HTMLTextAreaElement | null>;
  onAttachment?: (id: string, file: File) => void;
  onApplied?: (id: string) => void;
}): void {
  const appliedId = useRef<string | null>(null);
  useEffect(() => {
    const valid = parseAssistantDraft(draft);
    if (!enabled || !valid || appliedId.current === valid.id) return;
    let cancelled = false;
    queueMicrotask(() => {
      if (cancelled || appliedId.current === valid.id) return;
      appliedId.current = valid.id;
      if (valid.text.trim()) setInput((current) => current ? `${current}\n\n${valid.text}` : valid.text);
      if (valid.attachment) onAttachment?.(valid.id, new File([valid.attachment.content], valid.attachment.name, { type: valid.attachment.mimeType }));
      inputRef.current?.focus();
      onApplied?.(valid.id);
    });
    return () => { cancelled = true; };
  }, [draft, enabled, setInput, inputRef, onAttachment, onApplied]);
}
