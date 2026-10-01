"use client";

import { AgentSelector } from "@/components/chat/AgentSelector";
import {
  AttachmentChips,
  type PendingAttachment,
} from "@/components/chat/AttachmentChips";
import { Button } from "@/components/ui/button";
import { useToast } from "@/components/ui/toast";
import { resolveUsableChatAgent,resolveUsableChatAgentId } from "@/lib/chat-agent-selection";
import {
  ACCEPT_ATTRIBUTE,
  fileToInputFile,
  validateFiles,
} from "@/lib/file-attachments";
import { setPendingFirstMessage } from "@/lib/pending-first-message";
import { cn } from "@/lib/utils";
import { useChatStore } from "@/store/chat-store";
import { Paperclip,Send,Sparkles } from "lucide-react";
import { useRouter } from "next/navigation";
import {
  type ChangeEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
  useTransition,
} from "react";

export function HeroComposer() {
  const router = useRouter();
  const { toast } = useToast();
  const [, startTransition] = useTransition();
  const [text, setText] = useState("");
  const [selectedAgentId, setSelectedAgentId] = useState<string | undefined>(undefined);
  const [submitting, setSubmitting] = useState(false);
  const [attachments, setAttachments] = useState<PendingAttachment[]>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let cancelled = false;
    resolveUsableChatAgent()
      .then((agent) => {
        if (!cancelled) setSelectedAgentId(agent.id);
      })
      .catch(() => {
        // No usable default — AgentSelector will just show nothing to pick from.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const addFiles = useCallback((incoming: File[]) => {
    if (incoming.length === 0) return;
    setAttachments((current) => {
      const { accepted, rejected } = validateFiles(
        current.map((attachment) => attachment.file),
        incoming,
      );
      if (rejected.length > 0) {
        const detail = rejected
          .map((rejection) => `${rejection.name}: ${rejection.reason}`)
          .join("\n");
        toast(
          `${rejected.length} file${rejected.length === 1 ? "" : "s"} not attached\n${detail}`,
          "error",
          6000,
        );
      }
      return [
        ...current,
        ...accepted.map((file) => ({
          id: `att-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
          file,
        })),
      ];
    });
  }, [toast]);

  const handleFileInputChange = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => {
      if (event.target.files) addFiles(Array.from(event.target.files));
      event.target.value = "";
    },
    [addFiles],
  );

  const removeAttachment = useCallback((id: string) => {
    setAttachments((current) =>
      current.filter((attachment) => attachment.id !== id),
    );
  }, []);

  const handleSubmit = async () => {
    const trimmed = text.trim();
    if ((!trimmed && attachments.length === 0) || submitting) return;
    setSubmitting(true);
    try {
      const files = await Promise.all(
        attachments.map((attachment) => fileToInputFile(attachment.file)),
      );
      const agentId = selectedAgentId ?? (await resolveUsableChatAgentId());
      const conversationId = await useChatStore.getState().createConversation(agentId);
      setPendingFirstMessage(conversationId, trimmed, files);
      startTransition(() => {
        router.push(`/chat/${conversationId}`);
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to start a chat";
      toast(message, "error");
      setSubmitting(false);
    }
  };

  return (
    <div
      data-testid="hero-composer"
      className="home-hero-surface rounded-xl border border-primary/25 bg-card/60 p-6 shadow-sm [@media(max-height:800px)]:p-4"
    >
      <div className="flex items-center gap-3 [@media(max-height:800px)]:gap-2">
        <span
          aria-hidden="true"
          className="home-composer-prompt-icon flex h-9 w-9 shrink-0 items-center justify-center rounded-lg [@media(max-height:800px)]:h-8 [@media(max-height:800px)]:w-8"
        >
          <Sparkles className="h-[18px] w-[18px]" />
        </span>
        <h1 className="home-composer-prompt text-2xl font-semibold tracking-tight text-foreground [@media(max-height:800px)]:text-xl">
          What would you like to do today?
        </h1>
      </div>
      <div className="home-composer-field mt-4 rounded-lg border border-border/60 bg-background/60 p-3 transition-colors focus-within:border-foreground/50 [@media(max-height:800px)]:mt-3 [@media(max-height:800px)]:p-2">
        <input
          ref={fileInputRef}
          type="file"
          multiple
          accept={ACCEPT_ATTRIBUTE}
          className="hidden"
          data-testid="hero-composer-file-input"
          onChange={handleFileInputChange}
        />
        <AttachmentChips
          attachments={attachments}
          onRemove={removeAttachment}
          disabled={submitting}
        />
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              void handleSubmit();
            }
          }}
          placeholder="Ask a question or describe what you want to get done…"
          rows={3}
          data-testid="hero-composer-input"
          className="w-full resize-none bg-transparent text-sm text-foreground outline-none placeholder:text-muted-foreground [@media(max-height:800px)]:h-10"
        />
        <div className="mt-2 flex items-center justify-between">
          <div className="flex items-center gap-1">
            <AgentSelector selectedAgentId={selectedAgentId} onSelectAgent={setSelectedAgentId} />
          </div>
          <div className="flex items-center gap-1">
            <Button
              type="button"
              size="icon"
              variant="ghost"
              className="h-8 w-8 shrink-0 rounded-full"
              title="Attach files"
              aria-label="Attach files"
              disabled={submitting}
              onClick={() => fileInputRef.current?.click()}
            >
              <Paperclip className="h-4 w-4" />
            </Button>
            <button
              type="button"
              onClick={() => void handleSubmit()}
              disabled={(!text.trim() && attachments.length === 0) || submitting}
              aria-label="Send"
              data-testid="hero-composer-send"
              className={cn(
                "flex h-8 w-8 items-center justify-center rounded-full bg-primary text-primary-foreground transition-opacity",
                ((!text.trim() && attachments.length === 0) || submitting) && "opacity-50",
              )}
            >
              <Send className="h-4 w-4" />
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
